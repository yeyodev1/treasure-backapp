import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { Account } from "../models/account.model";
import { User } from "../models/user.model";
import { StockCount } from "../models/stockCount.model";
import { ShipStop } from "../models/shipStop.model";
import { AgencyInvoice } from "../models/agencyInvoice.model";
import { CommissionPayment } from "../models/commissionPayment.model";
import { badRequest, notFound } from "../errors/httpError";
import { addDaysKey, commercialDateKey, parseRangeEdge } from "../utils/dates";
import { round2 } from "../utils/units";
import { goalsAt, wetsuitRate, type Goals } from "./goals.service";
import { isGenericName, liveUnits, productIndex, type ProductInfo, type SaleLine } from "./lines.service";
import { commissionSummary } from "./commission.service";
import { agencySummary, REMINDER_DAY } from "./agency.service";
import { isTestOrTeamEmail, teamEmails } from "./emailRules.service";

/**
 * Resumen de Gerencia (especificación del 24-nov-2026): dos vistas, Bar
 * (solo Gerencia) y Operación (sin dinero, va en PDF a los socios), con un
 * filtro de período Año · Mes · Crucero.
 *
 * Reglas de fechas: el crucero, sus pasajeros y su ocupación cuentan en el mes
 * y el año en que zarpa; consumos, cobros y noches cuentan por su fecha real.
 */

export type PeriodKind = "ano" | "mes" | "crucero";
const CAPACITY_PER_CRUISE = 16;
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

type LeanCruise = {
  _id: Types.ObjectId;
  code: string;
  leg: string;
  name: string;
  routeFrom: string;
  routeTo: string;
  startDate: Date;
  endDate: Date | null;
  status: "planificado" | "abordo" | "cerrado";
  bartender: Types.ObjectId | null;
  bartenderName: string;
  agency?: { name?: string; ruc?: string; email?: string };
  cabins: Array<{ number: number; passengers: Array<{ name: string; country: string; nationality: string; isPayer: boolean }> }>;
};

export interface Period {
  kind: PeriodKind;
  value: string;
  label: string;
  /** Inicio y fin del período (días completos en Galápagos). */
  from: Date;
  to: Date;
  fromKey: string;
  toKey: string;
  cruise: LeanCruise | null;
}

const startKey = (c: LeanCruise) => commercialDateKey(new Date(c.startDate));
const endKey = (c: LeanCruise) => commercialDateKey(new Date(c.endDate ?? c.startDate));
const paxOf = (c: LeanCruise) => c.cabins.reduce((s, cb) => s + cb.passengers.length, 0);
/** Noches con pasajeros: fin − inicio (A y B = 4, C = 6). */
const nightsOf = (c: LeanCruise) => Math.max(0, Math.round((Date.parse(endKey(c)) - Date.parse(startKey(c))) / 86_400_000));
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

async function allCruises(): Promise<LeanCruise[]> {
  return (await Cruise.find()
    .select("code leg name routeFrom routeTo startDate endDate status bartender bartenderName agency cabins.number cabins.passengers")
    .sort({ startDate: 1 })
    .lean()) as unknown as LeanCruise[];
}

/** Período desde la URL: ano=2026, mes=2026-11, crucero=<id o código>. */
export async function resolvePeriod(kind: unknown, value: unknown, cruises?: LeanCruise[]): Promise<Period> {
  const today = commercialDateKey();
  const v = String(value ?? "");
  if (kind === "crucero") {
    const list = cruises ?? (await allCruises());
    const cruise =
      list.find((c) => c._id.toString() === v) ??
      list.find((c) => c.code.toLowerCase() === v.toLowerCase()) ??
      [...list].reverse().find((c) => c.status !== "planificado");
    if (!cruise) throw notFound("Todavía no hay cruceros");
    const fromKey = startKey(cruise);
    const toKey = endKey(cruise);
    return {
      kind: "crucero",
      value: cruise._id.toString(),
      label: cruise.code || cruise.name,
      from: parseRangeEdge(fromKey, "start")!,
      to: parseRangeEdge(toKey, "end")!,
      fromKey,
      toKey,
      cruise,
    };
  }
  if (kind === "mes") {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : today.slice(0, 7);
    const fromKey = `${month}-01`;
    const toKey = addDaysKey(`${nextMonth(month)}-01`, -1);
    return { kind: "mes", value: month, label: monthLabel(month), from: parseRangeEdge(fromKey, "start")!, to: parseRangeEdge(toKey, "end")!, fromKey, toKey, cruise: null };
  }
  if (kind && kind !== "ano") throw badRequest("Período inválido: año, mes o crucero");
  const year = /^\d{4}$/.test(v) ? v : today.slice(0, 4);
  const fromKey = `${year}-01-01`;
  const toKey = `${year}-12-31`;
  return { kind: "ano", value: year, label: year, from: parseRangeEdge(fromKey, "start")!, to: parseRangeEdge(toKey, "end")!, fromKey, toKey, cruise: null };
}

function nextMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
}
function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Cruceros del período: zarpan dentro de él (el crucero de un período de crucero es él mismo). */
function cruisesOf(period: Period, cruises: LeanCruise[]) {
  if (period.cruise) return [period.cruise];
  return cruises.filter((c) => c.status !== "planificado" && startKey(c) >= period.fromKey && startKey(c) <= period.toKey);
}

/** Primer mes con operación (zarpe del primer crucero): antes es «sin registro». */
function firstMonth(cruises: LeanCruise[]) {
  const first = cruises.find((c) => c.status !== "planificado");
  return first ? startKey(first).slice(0, 7) : null;
}

/** Año que no tiene datos desde enero: «Año parcial: desde noviembre». */
function partialYear(year: string, cruises: LeanCruise[]) {
  const first = firstMonth(cruises);
  if (!first || first.slice(0, 4) !== year || first.endsWith("-01")) return null;
  return { since: first, label: `Año parcial: desde ${MONTHS[Number(first.slice(5, 7)) - 1]}` };
}

/* ───────────────────────── Ventas por línea ───────────────────────── */

interface Sale {
  orderId: string;
  cruise: string;
  cabin: number;
  at: Date;
  dayKey: string;
  line: SaleLine;
  productId: string;
  name: string;
  units: number;
  amount: number;
  courtesy: boolean;
  courtesyKind: string;
  cost: number;
  costComplete: boolean;
  by: string;
  paid: boolean;
  unitPrice: number;
}

async function loadSales(filter: Record<string, unknown>, products: Map<string, ProductInfo>, livePaymentIds: Set<string>) {
  const orders = await Order.find({ status: { $in: ["entregada", "pendiente"] }, ...filter })
    .select("cruise cabinNumber items payment createdAt createdBy annulments")
    .lean();
  const sales: Sale[] = [];
  for (const o of orders) {
    const at = o.createdAt as Date;
    for (const i of o.items) {
      const units = liveUnits(i);
      if (!units) continue;
      const product = products.get(i.product.toString());
      sales.push({
        orderId: o._id.toString(),
        cruise: o.cruise.toString(),
        cabin: o.cabinNumber,
        at,
        dayKey: commercialDateKey(at),
        line: product?.line ?? "bar",
        productId: i.product.toString(),
        name: i.name,
        units,
        amount: units * i.unitPrice,
        courtesy: i.courtesy,
        courtesyKind: i.courtesyKind ?? "casa",
        cost: units * (i.unitCost ?? 0),
        // Un servicio no tiene insumos: su costo $0 está completo.
        costComplete: Boolean(i.costComplete) || !i.applied?.length,
        by: o.createdBy?.toString() ?? "",
        paid: Boolean(o.payment && livePaymentIds.has(o.payment.toString())),
        unitPrice: i.unitPrice,
      });
    }
  }
  return { sales, orders };
}

const sum = <T>(list: T[], f: (x: T) => number) => round2(list.reduce((s, x) => s + f(x), 0));
const sold = (sales: Sale[], line: SaleLine) => sum(sales.filter((s) => s.line === line && !s.courtesy), (s) => s.amount);

/** Bar por pasajero por día de un grupo de cruceros: bar ÷ (pasajeros × noches). */
function perPaxDay(cruises: LeanCruise[], barByCruise: Map<string, number>) {
  const paxDays = cruises.reduce((s, c) => s + paxOf(c) * nightsOf(c), 0);
  const bar = cruises.reduce((s, c) => s + (barByCruise.get(c._id.toString()) ?? 0), 0);
  return paxDays ? round2(bar / paxDays) : null;
}

/** Verde ≥ meta; amarillo hasta 10 % menos; rojo más abajo. Sin meta: sin color. */
function toneVsGoal(value: number | null, goal: number | null): "verde" | "amarillo" | "rojo" | "gris" {
  if (value === null || goal === null || goal <= 0) return "gris";
  if (value >= goal) return "verde";
  return value >= goal * 0.9 ? "amarillo" : "rojo";
}

/* ───────────────────────── Vista Bar ───────────────────────── */

export async function barSummary(kind: unknown, value: unknown) {
  const now = new Date();
  const [cruises, products] = await Promise.all([allCruises(), productIndex()]);
  const period = await resolvePeriod(kind, value, cruises);
  const goals: Goals = await goalsAt(period.kind === "crucero" ? period.from : now < period.to ? now : period.to);
  const scopeCruises = cruisesOf(period, cruises);
  const scopeIds = scopeCruises.map((c) => c._id);
  const cruiseById = new Map(cruises.map((c) => [c._id.toString(), c]));
  const label = (id: string) => cruiseById.get(id)?.code || cruiseById.get(id)?.name || "";

  const livePayments = await Payment.find({ status: "vigente" })
    .select("cruise cabinNumber cabins total method line invoiceStatus invoiceEmail billing createdAt deposit settled")
    .lean();
  const liveIds = new Set(livePayments.map((p) => p._id.toString()));

  // Consumos por fecha real (año y mes) o del crucero; y, aparte, todo lo de los cruceros del período.
  const dateFilter = period.cruise ? { cruise: period.cruise._id } : { createdAt: { $gte: period.from, $lte: period.to } };
  const [{ sales }, { sales: cruiseSales, orders: cruiseOrders }] = await Promise.all([
    loadSales(dateFilter, products, liveIds),
    loadSales({ cruise: { $in: scopeIds } }, products, liveIds),
  ]);
  const inScope = (d: Date) => (period.cruise ? true : d >= period.from && d <= period.to);
  const payments = livePayments.filter((p) =>
    period.cruise ? p.cruise.toString() === period.cruise._id.toString() : inScope(p.createdAt as Date),
  );

  // ---- 3. Cuatro cifras
  const bar = sold(sales, "bar");
  const wetsuits = sold(sales, "wetsuit");
  const services = sold(sales, "servicio");
  const collected = sum(payments, (p) => p.total);
  const consumed = round2(bar + wetsuits + services);
  const barSales = sales.filter((s) => s.line === "bar");
  const servedCost = sum(barSales, (s) => s.cost);
  const costMissing = barSales.some((s) => !s.costComplete);
  const catalogWithoutCost = [...products.values()].filter((p) => p.active && p.kind === "fisico" && !(p.costPerUnit > 0)).length;
  const commissionCost = round2(
    barSales.filter((s) => !s.courtesy && s.paid).reduce((t, s) => t + s.amount, 0) * 0.1 / (goals.commissionDivisor || 1.21),
  );

  // ---- Por cobrar por cabina (cruceros con consumos en el período, o el crucero)
  const dueCruises = period.cruise ? [period.cruise] : cruises.filter((c) => sales.some((s) => s.cruise === c._id.toString()) || scopeIds.some((id) => id.equals(c._id)));
  const dueIds = dueCruises.map((c) => c._id);
  const [dueOrders, accounts] = await Promise.all([
    loadSales({ cruise: { $in: dueIds } }, products, liveIds),
    Account.find({ cruise: { $in: dueIds } }).select("cruise cabinNumber status").lean(),
  ]);
  const cabinRows = new Map<string, { cruise: string; cabin: number; consumed: number; paid: number; status: string }>();
  for (const s of dueOrders.sales) {
    if (s.courtesy) continue;
    const key = `${s.cruise}-${s.cabin}`;
    const row = cabinRows.get(key) ?? { cruise: s.cruise, cabin: s.cabin, consumed: 0, paid: 0, status: "abierta" };
    row.consumed += s.amount;
    cabinRows.set(key, row);
  }
  for (const p of livePayments) {
    if (!dueIds.some((id) => id.equals(p.cruise))) continue;
    const key = `${p.cruise.toString()}-${p.cabinNumber}`;
    const row = cabinRows.get(key) ?? { cruise: p.cruise.toString(), cabin: p.cabinNumber, consumed: 0, paid: 0, status: "cobrada" };
    row.paid += p.total;
    cabinRows.set(key, row);
  }
  for (const a of accounts) {
    const row = cabinRows.get(`${a.cruise.toString()}-${a.cabinNumber}`);
    if (row) row.status = a.status;
  }
  const dueCabins = [...cabinRows.values()].filter((r) => r.consumed - r.paid > 0.005);
  const pendingCollection = sum(dueCabins, (r) => r.consumed - r.paid);
  const openCruises = [...new Set(dueCabins.map((r) => r.cruise))];

  // ---- 6. Comisiones y 7. Agencia (lógica existente, con las reglas nuevas)
  const [commission, agency, commissionPayments] = await Promise.all([
    commissionSummary(),
    agencySummary(now),
    CommissionPayment.find({ status: "vigente" }).select("amount paidAt").lean(),
  ]);
  const scopeKeys = new Set(scopeCruises.map((c) => c._id.toString()));
  const commissionRows = commission.cruises.filter((r) => scopeKeys.has(r.id));
  const yearKey = period.fromKey.slice(0, 4);
  const paidInYear = sum(
    commissionPayments.filter((p) => commercialDateKey(new Date(p.paidAt)).startsWith(yearKey)),
    (p) => p.amount,
  );

  // ---- 4. ¿Se cobró todo lo consumido? (por crucero)
  const collectedRows = scopeCruises.map((c) => {
    const id = c._id.toString();
    const list = cruiseSales.filter((s) => s.cruise === id && !s.courtesy);
    const consumedC = sum(list, (s) => s.amount);
    const paid = sum(livePayments.filter((p) => p.cruise.toString() === id), (p) => p.total);
    const noInvoice = sum(
      livePayments.filter((p) => p.cruise.toString() === id && (p.invoiceStatus === "pendiente" || p.invoiceStatus === "error")),
      (p) => p.total,
    );
    const diff = round2(paid - consumedC);
    const cruisePayments = livePayments.filter((p) => p.cruise.toString() === id);
    const byMethod = (m: string) => sum(cruisePayments.filter((p) => p.method === m), (p) => p.total);
    return {
      id,
      code: c.code,
      start: startKey(c),
      end: endKey(c),
      methods: { tarjeta: byMethod("tarjeta"), efectivo: byMethod("efectivo"), transferencia: byMethod("transferencia") + byMethod("online") },
      status: c.status,
      consumed: consumedC,
      collected: paid,
      diff,
      noInvoice,
      tone: c.status === "abordo" ? "gris" : Math.abs(diff) > 0.005 ? "rojo" : noInvoice > 0 ? "amarillo" : "verde",
    };
  });

  // ---- 5. Wetsuits
  const wetSales = cruiseSales.filter((s) => s.line === "wetsuit");
  const wetRows = scopeCruises.map((c) => {
    const id = c._id.toString();
    const list = wetSales.filter((s) => s.cruise === id);
    const rented = list.reduce((t, s) => t + s.units, 0);
    const income = sum(list.filter((s) => !s.courtesy), (s) => s.amount);
    const byAgency = list.some((s) => s.courtesy && s.courtesyKind === "agencia");
    const byCabin = list.some((s) => !s.courtesy);
    const rate = wetsuitRate(goals, c.leg);
    const offRate = rate !== null && list.some((s) => !s.courtesy && Math.abs(s.unitPrice - rate) > 0.005);
    // Wetsuits de una cabina por encima de sus pasajeros.
    const overCabins = c.cabins
      .map((cb) => ({ cabin: cb.number, pax: cb.passengers.length, rented: list.filter((s) => s.cabin === cb.number).reduce((t, s) => t + s.units, 0) }))
      .filter((x) => x.rented > x.pax);
    const wetPayments = livePayments.filter((p) => p.cruise.toString() === id && p.line === "wetsuit");
    const unpaid = list.some((s) => !s.courtesy && !s.paid);
    const noInvoice = wetPayments.filter((p) => p.invoiceStatus === "pendiente" || p.invoiceStatus === "error");
    const state = !rented
      ? "Sin alquiler"
      : unpaid
        ? "Por cobrar"
        : noInvoice.length
          ? "Cobrado, sin factura"
          : "Cobrado y facturado";
    return {
      id,
      code: c.code,
      rented,
      passengers: paxOf(c),
      income,
      payer: byCabin && byAgency ? "Cabina y agencia" : byAgency ? "Agencia" : byCabin ? "Cabina" : "—",
      payerCabins: [...new Set(list.filter((s) => !s.courtesy).map((s) => s.cabin))],
      state,
      noInvoice: sum(noInvoice, (p) => p.total),
      offRate,
      overCabins,
      tone: noInvoice.length || offRate ? "rojo" : overCabins.length || unpaid ? "amarillo" : rented ? "verde" : "gris",
    };
  });
  const rentedTotal = sales.filter((s) => s.line === "wetsuit").reduce((t, s) => t + s.units, 0);
  const paidRented = sales.filter((s) => s.line === "wetsuit" && !s.courtesy).reduce((t, s) => t + s.units, 0);
  const scopePax = scopeCruises.reduce((t, c) => t + paxOf(c), 0);
  const wetNoInvoice = sum(
    payments.filter((p) => p.line === "wetsuit" && (p.invoiceStatus === "pendiente" || p.invoiceStatus === "error")),
    (p) => p.total,
  );

  // ---- 8. Dónde está la plata
  const methods = ["tarjeta", "efectivo", "transferencia", "online"].map((m) => {
    const list = payments.filter((p) => p.method === m);
    return { method: m, count: list.length, total: sum(list, (p) => p.total) };
  }).filter((m) => m.count);
  const cashUndeposited = livePayments.filter((p) => p.method === "efectivo" && !p.deposit);
  const oldestCash = cashUndeposited.reduce<Date | null>((o, p) => (!o || (p.createdAt as Date) < o ? (p.createdAt as Date) : o), null);
  const cashDays = oldestCash ? Math.floor((now.getTime() - oldestCash.getTime()) / 86_400_000) : 0;
  const deposits = livePayments.filter((p) => p.deposit).length;

  // ---- 9. Consumo por pasajero por día
  const barByCruise = new Map<string, number>();
  for (const s of cruiseSales) if (s.line === "bar" && !s.courtesy) barByCruise.set(s.cruise, (barByCruise.get(s.cruise) ?? 0) + s.amount);
  const perCruise = scopeCruises.map((c) => ({
    id: c._id.toString(),
    code: c.code,
    leg: (c.code.charAt(0) || c.leg || "?").toUpperCase(),
    value: perPaxDay([c], barByCruise),
  }));
  const perMonth: Array<{ month: string; value: number | null }> = [];
  if (period.kind === "ano") {
    const first = firstMonth(cruises);
    for (let m = 1; m <= 12; m++) {
      const month = `${period.value}-${String(m).padStart(2, "0")}`;
      if (!first || month < first || month > commercialDateKey().slice(0, 7)) continue;
      const list = scopeCruises.filter((c) => startKey(c).startsWith(month));
      perMonth.push({ month, value: perPaxDay(list, barByCruise) });
    }
  }
  const paxDayValue = perPaxDay(scopeCruises, barByCruise);
  let paxDayCompare: { label: string; value: number | null } | null = null;
  if (period.cruise) {
    const prev = [...cruises].reverse().find((c) => c.leg === period.cruise!.leg && c.status === "cerrado" && startKey(c) < startKey(period.cruise!));
    if (prev) {
      const { sales: ps } = await loadSales({ cruise: prev._id }, products, liveIds);
      const m = new Map<string, number>([[prev._id.toString(), sold(ps, "bar")]]);
      paxDayCompare = { label: prev.code, value: perPaxDay([prev], m) };
    }
  }
  const byLeg = ["A", "B", "C"]
    .map((leg) => ({ leg, value: perPaxDay(scopeCruises.filter((c) => (c.code.charAt(0) || c.leg).toUpperCase() === leg), barByCruise) }))
    .filter((l) => l.value !== null);

  // ---- 10. Merma: conteo de cierre de cada crucero finalizado
  const finished = scopeCruises.filter((c) => c.status === "cerrado");
  const counts = await StockCount.find({ location: "abordo", status: { $in: ["enviado", "gerencia", "aprobado"] } })
    .select("cruise cutAt status lines kind wasteTotal")
    .sort({ cutAt: -1 })
    .lean();
  const closingCount = (c: LeanCruise) =>
    counts.find((k) => (k.cruise && k.cruise.equals(c._id)) || commercialDateKey(new Date(k.cutAt)) === endKey(c)) ?? null;
  let wasteAmount = 0;
  let wasteMissingCost = false;
  let countedCruises = 0;
  for (const c of finished) {
    const k = closingCount(c);
    if (!k) continue;
    countedCruises += 1;
    // Conteo de cierre de Bar-stock: su merma ya viene verificada (con el recuento de la directora).
    if (k.kind === "cierre") {
      wasteAmount += k.wasteTotal ?? 0;
      if (k.lines.some((l) => l.result === "merma" && !l.unitCost)) wasteMissingCost = true;
      continue;
    }
    for (const line of k.lines) {
      if (line.physical === null) continue;
      const diff = line.digitalAtCut - line.physical;
      if (diff <= 0) continue;
      const cost = products.get(line.product.toString())?.costPerUnit ?? 0;
      if (!cost) wasteMissingCost = true;
      wasteAmount += diff * cost;
    }
  }
  const belowZero = [...products.values()].filter((p) => p.active && p.kind === "fisico" && p.onboardStock < 0);
  const lastCount = counts[0]?.cutAt ?? null;
  const wastePct = countedCruises && !wasteMissingCost && bar > 0 ? round2((wasteAmount / bar) * 100) : null;
  const wasteValue = countedCruises && !wasteMissingCost ? round2(wasteAmount) : null;

  // ---- Margen (gris si algún producto vendido no tiene costo)
  const margin = costMissing ? null : round2(bar - servedCost - commissionCost - (wasteValue ?? 0));
  const marginPct = margin !== null && bar > 0 ? round2((margin / bar) * 100) : null;

  // ---- 12. Equipo
  const users = await User.find().select("name role active").lean();
  const userName = new Map(users.map((u) => [u._id.toString(), u.name]));
  const annulmentsBy = new Map<string, number>();
  for (const o of cruiseOrders) {
    for (const a of o.annulments ?? []) {
      if (a.status === "rechazada") continue;
      if (!period.cruise && !inScope(a.requestedAt as Date)) continue;
      const k = a.requestedBy.toString();
      annulmentsBy.set(k, (annulmentsBy.get(k) ?? 0) + a.qty);
    }
  }
  const teamMap = new Map<string, { id: string; name: string; bar: number; wetsuits: number }>();
  for (const s of sales) {
    if (s.courtesy || s.line === "servicio") continue;
    const row = teamMap.get(s.by) ?? { id: s.by, name: userName.get(s.by) ?? "Sin nombre", bar: 0, wetsuits: 0 };
    if (s.line === "bar") row.bar += s.amount;
    else row.wetsuits += s.amount;
    teamMap.set(s.by, row);
  }
  const unapprovedBy = new Map<string, number>();
  for (const c of scopeCruises) {
    if (!c.bartender) continue;
    const n = [...cabinRows.values()].filter(
      (r) => r.cruise === c._id.toString() && r.consumed > 0 && (r.status === "abierta" || r.status === "en_revision"),
    ).length;
    unapprovedBy.set(c.bartender.toString(), (unapprovedBy.get(c.bartender.toString()) ?? 0) + n);
  }
  const team = [...teamMap.values()]
    .map((t) => {
      const annulled = annulmentsBy.get(t.id) ?? 0;
      const generic = isGenericName(t.name);
      return {
        ...t,
        bar: round2(t.bar),
        wetsuits: round2(t.wetsuits),
        annulments: generic ? null : annulled,
        unapproved: unapprovedBy.get(t.id) ?? 0,
        generic,
        tone: generic || (goals.annulmentsMax !== null && annulled > goals.annulmentsMax) ? "rojo" : "verde",
      };
    })
    .sort((a, b) => b.bar + b.wetsuits - (a.bar + a.wetsuits));

  // ---- 2. Qué hacer: rojo primero, luego por monto en juego
  type Action = { tone: "rojo" | "amarillo"; text: string; amount?: number; count?: number; to: string; label: string };
  const actions: Action[] = [];
  const hoursBefore = goals.accountsHoursBefore ?? 24;
  for (const id of openCruises) {
    const c = cruiseById.get(id);
    if (!c) continue;
    const rows = dueCabins.filter((r) => r.cruise === id);
    const amount = sum(rows, (r) => r.consumed - r.paid);
    const end = new Date(c.endDate ?? c.startDate);
    const endsToday = endKey(c) === commercialDateKey(now);
    if (c.status === "cerrado") {
      actions.push({ tone: "rojo", text: `Cobrar ${rows.length} cuenta${rows.length === 1 ? "" : "s"} de ${c.code} (ya desembarcó)`, amount, to: `/cuentas?crucero=${id}`, label: "Ir a Cuentas" });
    } else if (c.status === "abordo" && end.getTime() - now.getTime() <= hoursBefore * 3_600_000) {
      const what = period.cruise ? `Aprobar y cobrar ${rows.length} cuentas antes del desembarque` : `Aprobar y cobrar ${rows.length} cuenta${rows.length === 1 ? "" : "s"} de ${c.code}${endsToday ? " (cierra hoy)" : ""}`;
      actions.push({ tone: "rojo", text: what, amount, to: `/cuentas?crucero=${id}`, label: "Ir a Cuentas" });
    }
  }
  for (const r of commissionRows) {
    if (r.state === "retenida") {
      actions.push({ tone: "rojo", text: `Asignar bartender a las ventas de ${r.code} (comisión retenida)`, amount: r.pending, to: "#comisiones", label: "Ir a Comisiones" });
    }
  }
  const orphanInvoices = agency.invoices.filter(
    (i) => i.status === "vigente" && i.items.some((it) => !cruiseById.has(it.cruiseId)),
  );
  for (const inv of period.cruise ? [] : orphanInvoices) {
    const gone = inv.items.filter((it) => !cruiseById.has(it.cruiseId)).map((it) => it.code);
    actions.push({ tone: "rojo", text: `Anular prefactura antigua a la agencia (${gone.join(", ")} no existe${gone.length > 1 ? "n" : ""})`, amount: inv.amount, to: "#agencia", label: "Ir a Agencia" });
  }
  const agencyMaxDays = goals.agencyMaxDays ?? 30;
  const agencyInvoices = await AgencyInvoice.find({ status: "vigente" }).lean();
  const invoicePaid = (i: { payments?: Array<{ amount: number }> }) => sum(i.payments ?? [], (p) => p.amount);
  for (const inv of period.cruise ? [] : agencyInvoices) {
    if (orphanInvoices.some((o) => o.id === inv._id.toString())) continue;
    const due = round2(inv.amount - invoicePaid(inv));
    const days = Math.floor((now.getTime() - new Date(inv.createdAt!).getTime()) / 86_400_000);
    if (due > 0 && days > agencyMaxDays) {
      actions.push({ tone: "rojo", text: `Cobrar a la agencia la factura ${inv.invoiceNumber || inv.month} (${days} días)`, amount: due, to: "#agencia", label: "Ir a Agencia" });
    }
  }
  for (const w of wetRows) {
    if (w.noInvoice > 0) actions.push({ tone: "rojo", text: `Emitir factura de wetsuits de ${w.code}`, amount: w.noInvoice, to: "/admin/pagos?factura=pendiente", label: "Ir a Wetsuits" });
    if (w.offRate) actions.push({ tone: "rojo", text: `Revisar precio de wetsuits fuera de tarifa en ${w.code}`, to: "#wetsuits", label: "Ir a Wetsuits" });
    if (period.cruise) {
      for (const o of w.overCabins) {
        const amount = sum(wetSales.filter((s) => s.cruise === w.id && s.cabin === o.cabin && !s.courtesy), (s) => s.amount);
        actions.push({ tone: "amarillo", text: `Revisar ${o.rented} wetsuits en cabina ${o.cabin} (${o.pax} pasajero${o.pax === 1 ? "" : "s"})`, amount, to: "#wetsuits", label: "Ir a Wetsuits" });
      }
    }
  }
  for (const c of finished) {
    if (!closingCount(c)) {
      actions.push({ tone: "rojo", text: `${c.code} cerró sin conteo del bar: no se puede saber la merma`, to: "/inventario/conteos", label: "Ir a Conteos" });
    }
  }
  for (const r of collectedRows) {
    if (r.status === "cerrado" && Math.abs(r.diff) > 0.005) {
      actions.push({ tone: "rojo", text: `Revisar cobro de ${r.diff > 0 ? "más" : "menos"} en ${r.code}`, amount: Math.abs(r.diff), to: `/admin/pagos?crucero=${r.id}`, label: "Ir a Cobros" });
    }
  }
  if (!period.cruise && cashUndeposited.length && cashDays > (goals.cashMaxDays ?? 7)) {
    actions.push({ tone: "rojo", text: `Depositar el efectivo: ${cashUndeposited.length} cobro${cashUndeposited.length === 1 ? "" : "s"}, el más antiguo de hace ${cashDays} días`, amount: sum(cashUndeposited, (p) => p.total), to: "/admin/pagos?metodo=efectivo", label: "Ir a Cobros" });
  }
  for (const r of commissionRows) {
    if (r.state === "pendiente" || r.state === "parcial") {
      actions.push({ tone: "amarillo", text: `Pagar comisión de ${r.code} a ${r.bartenderName}`, amount: r.pending, to: "#comisiones", label: "Ir a Comisiones" });
    }
  }
  // Facturas emitidas con un correo que no le llega al cliente (inválido, de prueba o del equipo).
  const team_ = await teamEmails();
  const badEmail = payments.filter(
    (p) =>
      p.invoiceStatus === "emitida" &&
      (p.invoiceEmail?.status === "error" || (!p.billing?.noEmail && isTestOrTeamEmail(p.billing?.email ?? "", team_))),
  );
  if (badEmail.length && !period.cruise) {
    actions.push({ tone: "amarillo", text: `Reenviar ${badEmail.length} factura${badEmail.length === 1 ? "" : "s"} con correo inválido`, count: badEmail.length, to: "/admin/pagos", label: "Ir a Cobros" });
  }
  const runningWithoutCount = period.cruise && period.cruise.status === "abordo";
  if ((!period.cruise && belowZero.length) || runningWithoutCount) {
    actions.push({
      tone: "amarillo",
      text: runningWithoutCount
        ? `Contar el bar antes de finalizar${belowZero.length ? `: ${belowZero.length} productos bajo cero` : ""}`
        : `Contar el bar: ${belowZero.length} producto${belowZero.length === 1 ? "" : "s"} bajo cero`,
      count: belowZero.length || undefined,
      to: "/inventario/conteos",
      label: "Ir a Conteos",
    });
  }
  const agencyPendingScope = agency.cruises.filter((r) => r.pending > 0 && r.status === "cerrado");
  if (Number(commercialDateKey(now).slice(8, 10)) >= REMINDER_DAY && agencyPendingScope.length && !period.cruise) {
    actions.push({ tone: "amarillo", text: `Facturar a la agencia ${agencyPendingScope.length} crucero${agencyPendingScope.length === 1 ? "" : "s"}`, amount: sum(agencyPendingScope, (r) => r.pending), to: "#agencia", label: "Ir a Agencia" });
  }
  actions.sort((a, b) => (a.tone === b.tone ? (b.amount ?? 0) - (a.amount ?? 0) : a.tone === "rojo" ? -1 : 1));

  // ---- Comparación de «Vendido bar»
  const compare = await barComparisons(period, cruises, products, liveIds);

  // ---- Gráfico de tiempo
  const byMonth: Array<{ month: string; bar: number; wetsuits: number }> = [];
  if (period.kind === "ano") {
    const first = firstMonth(cruises);
    for (let m = 1; m <= 12; m++) {
      const month = `${period.value}-${String(m).padStart(2, "0")}`;
      if (!first || month < first) continue;
      const list = sales.filter((s) => s.dayKey.startsWith(month) && !s.courtesy);
      byMonth.push({ month, bar: sum(list.filter((s) => s.line === "bar"), (s) => s.amount), wetsuits: sum(list.filter((s) => s.line === "wetsuit"), (s) => s.amount) });
    }
  }
  const byDay: Array<{ day: string; total: number }> = [];
  if (period.cruise) {
    for (let d = period.fromKey; d <= period.toKey; d = addDaysKey(d, 1)) {
      byDay.push({ day: d, total: sum(sales.filter((s) => s.dayKey === d && !s.courtesy && s.line === "bar"), (s) => s.amount) });
    }
  }

  // ---- Crucero: cuentas por cabina y lo servido
  const cabins = period.cruise
    ? [...cabinRows.values()]
        .filter((r) => r.cruise === period.cruise!._id.toString())
        .map((r) => ({ cabin: r.cabin, consumed: round2(r.consumed), paid: round2(r.paid), due: round2(r.consumed - r.paid), status: r.status }))
        .sort((a, b) => b.consumed - a.consumed)
    : [];
  const servedMap = new Map<string, { name: string; qty: number; amount: number }>();
  if (period.cruise) {
    for (const s of sales.filter((x) => x.line === "bar")) {
      const row = servedMap.get(s.productId) ?? { name: s.name.replace(/ \(.*?\+.*\)$/, ""), qty: 0, amount: 0 };
      row.qty += s.units;
      if (!s.courtesy) row.amount += s.amount;
      servedMap.set(s.productId, row);
    }
  }
  // Agencia: los cruceros del período y cualquiera que aún tenga algo por facturar.
  const agencyRows = agency.cruises.filter((r) => scopeKeys.has(r.id) || (period.kind !== "crucero" && r.pending > 0));

  return {
    period: { kind: period.kind, value: period.value, label: period.label, from: period.fromKey, to: period.toKey },
    partial: period.kind === "ano" ? partialYear(period.value, cruises) : null,
    cruise: period.cruise
      ? {
          id: period.cruise._id.toString(),
          code: period.cruise.code,
          route: period.cruise.routeFrom && period.cruise.routeTo ? `${period.cruise.routeFrom} → ${period.cruise.routeTo}` : "",
          leg: (period.cruise.code.charAt(0) || period.cruise.leg).toUpperCase(),
          status: period.cruise.status,
          start: period.fromKey,
          end: period.toKey,
          bartender: period.cruise.bartenderName || "",
          agency: period.cruise.agency?.name || "",
        }
      : null,
    cruises: scopeCruises.map((c) => ({ id: c._id.toString(), code: c.code, status: c.status, start: startKey(c), end: endKey(c) })),
    goals,
    figures: {
      bar,
      wetsuits,
      services,
      consumed,
      collected,
      collectedPct: consumed > 0 ? Math.round((collected / consumed) * 100) : null,
      pendingCollection,
      pendingCabins: dueCabins.length,
      openCruises: openCruises.map(label),
      margin,
      marginPct,
      marginTone: margin === null ? "gris" : toneVsGoal(marginPct, goals.marginMinPct),
      servedCost: costMissing ? null : servedCost,
      commissionCost,
      productsWithoutCost: catalogWithoutCost,
      compare,
    },
    actions,
    byMonth,
    byDay,
    collectedRows,
    cabins,
    wetsuits: {
      income: wetsuits,
      rented: rentedTotal,
      passengers: scopePax,
      rentPct: scopePax ? Math.round((rentedTotal / scopePax) * 100) : null,
      avgPrice: paidRented ? round2(wetsuits / paidRented) : null,
      rates: { ab: goals.wetsuitAB, c: goals.wetsuitC },
      noInvoice: wetNoInvoice,
      rows: wetRows,
    },
    commissions: {
      rate: commission.rate,
      divisor: goals.commissionDivisor,
      generated: sum(commissionRows.filter((r) => r.state !== "en_curso"), (r) => r.commission),
      paid: sum(commissionRows, (r) => r.paid),
      pending: sum(commissionRows.filter((r) => r.state === "pendiente" || r.state === "parcial"), (r) => r.pending),
      retained: sum(commissionRows.filter((r) => r.state === "retenida"), (r) => r.pending),
      projected: sum(commissionRows, (r) => r.projected),
      projectedFrom: commissionRows.filter((r) => r.state === "en_curso").map((r) => r.code),
      paidInYear,
      rows: commissionRows.map((r) => ({
        id: r.id,
        code: r.code,
        bartenderId: r.bartenderId,
        bartenderName: r.bartenderName,
        generic: r.retained,
        sales: r.sales,
        salesAll: r.salesAll,
        commission: r.commission,
        projected: r.projected,
        paid: r.paid,
        pending: r.pending,
        state: r.state,
      })),
      payments: commission.payments.filter((p) => p.status === "vigente" || commercialDateKey(new Date(p.paidAt)).startsWith(yearKey)),
    },
    agency: {
      rows: agencyRows.map((r) => {
        const c = cruiseById.get(r.id);
        const wet = r.items.filter((i) => products.get(i.productId)?.line === "wetsuit");
        return {
          id: r.id,
          code: r.code,
          start: commercialDateKey(new Date(r.startDate)),
          end: r.endDate ? commercialDateKey(new Date(r.endDate)) : null,
          status: r.status,
          agency: c?.agency?.name || "",
          agencyRuc: c?.agency?.ruc || "",
          agencyEmail: c?.agency?.email || "",
          bar: round2(r.items.filter((i) => !wet.includes(i)).reduce((t, i) => t + i.total, 0)),
          barCount: r.items.filter((i) => !wet.includes(i)).reduce((t, i) => t + i.qty, 0),
          wetsuits: round2(wet.reduce((t, i) => t + i.total, 0)),
          wetsuitCount: wet.reduce((t, i) => t + i.qty, 0),
          total: r.total,
          pending: r.pending,
          state: r.state,
        };
      }),
      toInvoice: sum(agency.cruises.filter((r) => r.status === "cerrado"), (r) => r.pending),
      invoicedUnpaid: sum(agencyInvoices.filter((i) => !orphanInvoices.some((o) => o.id === i._id.toString())), (i) => Math.max(0, i.amount - invoicePaid(i))),
      collected: sum(agencyInvoices, (i) => invoicePaid(i)),
      invoices: agencyInvoices.map((i) => {
        const orphan = orphanInvoices.some((o) => o.id === i._id.toString());
        const paid = invoicePaid(i);
        const days = Math.floor((now.getTime() - new Date(i.createdAt!).getTime()) / 86_400_000);
        return {
          id: i._id.toString(),
          number: i.invoiceNumber,
          month: i.month,
          agency: i.agency?.name || "",
          cruises: i.items.map((it) => it.code),
          amount: i.amount,
          paid,
          due: round2(i.amount - paid),
          days,
          orphan,
          createdAt: i.createdAt,
          tone: orphan || (i.amount - paid > 0.005 && days > agencyMaxDays) ? "rojo" : "gris",
        };
      }),
      maxDays: agencyMaxDays,
    },
    money: {
      methods,
      cashUndeposited: { count: cashUndeposited.length, total: sum(cashUndeposited, (p) => p.total), oldestDays: cashDays },
      depositsRegistered: deposits,
      tone: cashUndeposited.length && cashDays > (goals.cashMaxDays ?? 7) ? "rojo" : "verde",
    },
    perPaxDay: {
      value: paxDayValue,
      goal: goals.barPerPaxDay,
      tone: toneVsGoal(paxDayValue, goals.barPerPaxDay),
      perCruise: perCruise.map((r) => ({ ...r, tone: toneVsGoal(r.value, goals.barPerPaxDay) })),
      perMonth: perMonth.map((r) => ({ ...r, tone: toneVsGoal(r.value, goals.barPerPaxDay) })),
      byLeg,
      compare: paxDayCompare,
    },
    waste: {
      value: wasteValue,
      pct: wastePct,
      finished: finished.length,
      counted: countedCruises,
      missingCost: wasteMissingCost,
      belowZero: belowZero.length,
      belowZeroNames: belowZero.slice(0, 10).map((p) => p.name),
      lastCount,
      tone: wastePct === null ? "rojo" : goals.wasteMaxPct !== null && wastePct > goals.wasteMaxPct ? "rojo" : belowZero.length ? "amarillo" : "verde",
    },
    team,
    served: [...servedMap.values()].map((r) => ({ ...r, amount: round2(r.amount) })).sort((a, b) => b.amount - a.amount),
    commissionCruise: period.cruise ? commissionRows[0] ?? null : null,
    agencyCruise: period.cruise ? agency.cruises.find((r) => r.id === period.cruise!._id.toString())?.pending ?? 0 : null,
  };
}

/** «Vendido bar» contra el período anterior: año (mismo tramo), mes (anterior y mismo del año pasado), crucero (último del tipo). */
async function barComparisons(period: Period, cruises: LeanCruise[], products: Map<string, ProductInfo>, liveIds: Set<string>) {
  const barIn = async (fromKey: string, toKey: string) => {
    const { sales } = await loadSales(
      { createdAt: { $gte: parseRangeEdge(fromKey, "start")!, $lte: parseRangeEdge(toKey, "end")! } },
      products,
      liveIds,
    );
    return sales.length ? sold(sales, "bar") : null;
  };
  const first = firstMonth(cruises);
  const today = commercialDateKey();
  if (period.kind === "ano") {
    const y = Number(period.value);
    // Mismo tramo: hasta hoy (si es el año en curso) y desde el mes en que empezó un año parcial.
    let fromMd = "01-01";
    if (first && Number(first.slice(0, 4)) === y - 1) fromMd = `${first.slice(5, 7)}-01`;
    const toMd = period.value === today.slice(0, 4) ? today.slice(5) : "12-31";
    const value = await barIn(`${y - 1}-${fromMd}`, `${y - 1}-${toMd}`);
    return [{ label: String(y - 1), value }];
  }
  if (period.kind === "mes") {
    const prev = shiftMonth(period.value, -1);
    const lastYear = shiftMonth(period.value, -12);
    const end = (m: string) => addDaysKey(`${nextMonth(m)}-01`, -1);
    return [
      { label: monthLabel(prev), value: await barIn(`${prev}-01`, end(prev)) },
      { label: monthLabel(lastYear), value: await barIn(`${lastYear}-01`, end(lastYear)) },
    ];
  }
  const c = period.cruise!;
  const prev = [...cruises].reverse().find((x) => x.leg === c.leg && x.status === "cerrado" && startKey(x) < startKey(c));
  if (!prev) return [{ label: `crucero ${c.leg} anterior`, value: null }];
  const { sales } = await loadSales({ cruise: prev._id }, products, liveIds);
  return [{ label: prev.code, value: sold(sales, "bar") }];
}

/* ───────────────────────── Vista Operación ───────────────────────── */

type DayState = "navegando" | "para" | "dique" | "por_venir" | "sin_registro";

/** Estado de cada día: noches con crucero, dique, para (día sin crucero), por venir y sin registro. */
export function dayStates(fromKey: string, toKey: string, cruises: LeanCruise[], diqueDays: Set<string>) {
  const today = commercialDateKey();
  const first = firstMonth(cruises);
  const nights = new Map<string, LeanCruise>();
  // Ordenados por zarpe: el que sale después pisa el día de cambio («cuenta para el crucero que zarpa»).
  for (const c of [...cruises].sort((a, b) => startKey(a).localeCompare(startKey(b)))) {
    // Solo navegó lo que se inició: un crucero programado no cuenta (B-002 zarpa hoy pero aún no inicia).
    if (c.status === "planificado") continue;
    for (let d = startKey(c); d < endKey(c); d = addDaysKey(d, 1)) nights.set(d, c);
  }
  const out: Array<{ day: string; state: DayState; code: string; departs: boolean; arrives: boolean; today: boolean }> = [];
  for (let d = fromKey; d <= toKey; d = addDaysKey(d, 1)) {
    const c = nights.get(d);
    const state: DayState = !first || d.slice(0, 7) < first
      ? "sin_registro"
      : diqueDays.has(d)
        ? "dique"
        : c
          ? "navegando"
          : d > today
            ? "por_venir"
            : "para";
    out.push({
      day: d,
      state,
      code: c?.code ?? "",
      departs: Boolean(c && startKey(c) === d),
      arrives: cruises.some((x) => endKey(x) === d && x.status !== "planificado"),
      today: d === today,
    });
  }
  return out;
}

function countriesOf(cruises: LeanCruise[]) {
  const map = new Map<string, number>();
  for (const c of cruises) for (const cb of c.cabins) for (const p of cb.passengers) {
    const k = (p.country || p.nationality || "Sin país").trim() || "Sin país";
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  const total = [...map.values()].reduce((s, n) => s + n, 0);
  const sorted = [...map].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([country, count]) => ({ country, count, pct: total ? Math.round((count / total) * 100) : 0 }));
  const rest = sorted.slice(5);
  if (rest.length) {
    const count = rest.reduce((s, [, n]) => s + n, 0);
    top.push({ country: `Otros ${rest.length} países`, count, pct: total ? Math.round((count / total) * 100) : 0 });
  }
  return { total: map.size - (map.has("Sin país") ? 1 : 0), rows: top };
}

export async function operationSummary(kind: unknown, value: unknown) {
  const cruises = await allCruises();
  const period = await resolvePeriod(kind, value, cruises);
  const scope = cruisesOf(period, cruises);
  const stops = await ShipStop.find({ kind: "dique" }).lean();
  const diqueDays = new Set<string>();
  for (const s of stops) for (let d = commercialDateKey(new Date(s.from)); d <= commercialDateKey(new Date(s.to)); d = addDaysKey(d, 1)) diqueDays.add(d);

  const days = dayStates(period.fromKey, period.toKey, cruises, diqueDays);
  const count = (st: DayState) => days.filter((d) => d.state === st).length;
  const pax = scope.reduce((s, c) => s + paxOf(c), 0);
  const seats = scope.length * CAPACITY_PER_CRUISE;
  const legs = ["A", "B", "C"].map((leg) => ({ leg, pax: scope.filter((c) => (c.code.charAt(0) || c.leg).toUpperCase() === leg).reduce((s, c) => s + paxOf(c), 0) })).filter((l) => l.pax);

  // Comparación (año: mismo tramo del año anterior; mes: anterior y mismo mes del año pasado).
  const compareOf = async (k: PeriodKind, v: string) => {
    const p = await resolvePeriod(k, v, cruises);
    const list = cruisesOf(p, cruises);
    return { label: p.label, cruises: list.length, pax: list.reduce((s, c) => s + paxOf(c), 0) };
  };
  const compare =
    period.kind === "ano"
      ? [await compareOf("ano", String(Number(period.value) - 1))]
      : period.kind === "mes"
        ? [await compareOf("mes", shiftMonth(period.value, -1)), await compareOf("mes", shiftMonth(period.value, -12))]
        : [];

  const first = firstMonth(cruises);
  const months =
    period.kind === "ano"
      ? Array.from({ length: 12 }, (_, i) => `${period.value}-${String(i + 1).padStart(2, "0")}`).map((month) => {
          const list = days.filter((d) => d.day.startsWith(month));
          const state = (st: DayState) => list.filter((d) => d.state === st).length;
          const monthCruises = scope.filter((c) => startKey(c).startsWith(month));
          return {
            month,
            navegando: state("navegando"),
            para: state("para"),
            dique: state("dique"),
            porVenir: state("por_venir"),
            sinRegistro: state("sin_registro"),
            passengers: monthCruises.reduce((s, c) => s + paxOf(c), 0),
            active: Boolean(first && month >= first),
          };
        })
      : [];

  // Años con datos, para el gráfico «Años» (desde que haya dos).
  const years = [...new Set(cruises.filter((c) => c.status !== "planificado").map((c) => startKey(c).slice(0, 4)))].sort();
  const yearBars =
    years.length >= 2
      ? years.map((y) => {
          const list = cruises.filter((c) => c.status !== "planificado" && startKey(c).startsWith(y));
          const p = list.reduce((s, c) => s + paxOf(c), 0);
          return { year: y, passengers: p, occupancy: list.length ? Math.round((p / (list.length * CAPACITY_PER_CRUISE)) * 100) : null, nights: list.reduce((s, c) => s + nightsOf(c), 0) };
        })
      : [];

  const c = period.cruise;
  return {
    period: { kind: period.kind, value: period.value, label: period.label, from: period.fromKey, to: period.toKey },
    partial: period.kind === "ano" ? partialYear(period.value, cruises) : null,
    capacity: CAPACITY_PER_CRUISE,
    figures: {
      cruises: scope.length,
      finished: scope.filter((x) => x.status === "cerrado").length,
      running: scope.filter((x) => x.status === "abordo").length,
      passengers: pax,
      seats,
      occupancy: seats ? Math.round((pax / seats) * 100) : null,
      operatedDays: count("navegando"),
      paraDays: count("para"),
      diqueDays: count("dique"),
      upcomingDays: count("por_venir"),
      since: first,
      compare,
    },
    occupancy: scope.map((x) => ({ id: x._id.toString(), code: x.code, pax: paxOf(x), capacity: CAPACITY_PER_CRUISE })),
    legs,
    countries: countriesOf(scope),
    days: period.kind === "ano" ? [] : days,
    months,
    years: yearBars,
    cruise: c
      ? {
          id: c._id.toString(),
          code: c.code,
          route: c.routeFrom && c.routeTo ? `${c.routeFrom} → ${c.routeTo}` : "",
          leg: (c.code.charAt(0) || c.leg).toUpperCase(),
          status: c.status,
          start: startKey(c),
          end: endKey(c),
          startTime: new Date(c.startDate).toISOString(),
          endTime: c.endDate ? new Date(c.endDate).toISOString() : null,
          nights: nightsOf(c),
          usedCabins: c.cabins.filter((cb) => cb.passengers.length).length,
          cabinCount: c.cabins.length,
          cabins: c.cabins.map((cb) => ({
            number: cb.number,
            holder: (cb.passengers.find((p) => p.isPayer) ?? cb.passengers[0])?.name ?? "",
            pax: cb.passengers.length,
          })),
        }
      : null,
  };
}
