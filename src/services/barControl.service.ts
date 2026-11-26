import { Types } from "mongoose";
import { Cruise } from "../models/cruise.model";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Product } from "../models/product.model";
import { StockCount } from "../models/stockCount.model";
import { StockMovement } from "../models/stockMovement.model";
import { WeeklyOrder } from "../models/weeklyOrder.model";
import { User } from "../models/user.model";
import { AppSetting } from "../models/appSetting.model";
import { addDaysKey, commercialDateKey, parseRangeEdge } from "../utils/dates";
import { round2 } from "../utils/units";
import { isFresh } from "./barStock.service";
import { liveUnits } from "./lines.service";
import { isTestOrTeamEmail, teamEmails } from "./emailRules.service";

/**
 * Control del bar (pantalla de Gerencia, especificación del 26-nov-2026): lo
 * primero es cómo va el crucero actual; lo demás (cerrados, mes, año) en
 * pestañas. «Por decidir» es la única lista: solo lo que necesita autoridad de
 * Gerencia. Lo informativo va como etiqueta en su bloque y se quita solo.
 */

const DAY_MS = 86_400_000;
const keyOf = (d: Date | string) => commercialDateKey(new Date(d));
const paxOf = (c: { cabins: Array<{ passengers: unknown[] }> }) => c.cabins.reduce((t, cb) => t + cb.passengers.length, 0);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

type LeanCruise = {
  _id: Types.ObjectId;
  code: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
  closedAt: Date | null;
  bartenderName: string;
  startedBy: Types.ObjectId | null;
  cabins: Array<{ passengers: unknown[] }>;
  startAuthorization?: { status: string; requestedByName: string; at: Date; reason: string } | null;
};

async function products() {
  const list = await Product.find()
    .select("name kind category legs stockUnit containerSize containerLabel price costPerUnit onboardStock fresh active")
    .lean();
  return new Map(list.map((p) => [p._id.toString(), p]));
}
type ProductMap = Awaited<ReturnType<typeof products>>;

/** Valor de lo que sale del bar: a precio de venta del envase si lo tiene; si no, a costo. */
function valueOf(p: ProductMap extends Map<string, infer V> ? V : never, base: number) {
  const size = p.containerSize || 1;
  return round2(p.price > 0 && p.kind === "fisico" ? (p.price * base) / size : (p.costPerUnit ?? 0) * base);
}

/** Ventas de bar (sin cortesías ni wetsuits) por día y por producto de un crucero. */
async function barSales(cruiseIds: Types.ObjectId[], map: ProductMap) {
  const orders = await Order.find({ cruise: { $in: cruiseIds }, status: { $in: ["entregada", "pendiente"] } })
    .select("cruise items createdAt")
    .lean();
  const rows: Array<{ cruise: string; day: string; product: string; name: string; units: number; amount: number }> = [];
  for (const o of orders) {
    for (const i of o.items) {
      const p = map.get(i.product.toString());
      if (i.courtesy || p?.legs?.length || p?.kind === "servicio") continue;
      const units = liveUnits(i);
      if (units) rows.push({ cruise: o.cruise.toString(), day: keyOf(o.createdAt as Date), product: i.product.toString(), name: i.name, units, amount: units * i.unitPrice });
    }
  }
  return rows;
}

/* ───────────────────────── Por decidir ───────────────────────── */

export async function pendingDecisions() {
  const now = Date.now();
  const since = (d: Date | string | null | undefined) => (d ? Math.max(0, Math.floor((now - new Date(d).getTime()) / DAY_MS)) : 0);
  const [counts, cruises, orders, adminCounts] = await Promise.all([
    StockCount.find({ kind: "cierre", status: "gerencia" }).populate("cruise", "code").lean(),
    Cruise.find({ "startAuthorization.status": "pedida", status: "planificado" }).select("code startAuthorization").lean(),
    WeeklyOrder.find({ status: "aprobado" }).sort({ cutAt: -1 }).limit(6).lean(),
    StockCount.find({ kind: "admin", status: "enviado" }).lean(),
  ]);
  const items: Array<{ type: string; label: string; detail: string; amount: number | null; days: number; ref: string; key?: string; actions: string[] }> = [];
  for (const c of counts) {
    items.push({
      type: "merma",
      label: "Merma sobre límite",
      detail: `${(c.cruise as unknown as { code?: string } | null)?.code ?? ""} · ${c.toManagement.join(" · ")}${c.verifiedByName ? ` · verificó ${c.verifiedByName}` : ""}`,
      amount: c.wasteTotal,
      days: since(c.verifiedAt),
      ref: c._id.toString(),
      actions: ["Aprobar", "Rechazar"],
    });
  }
  for (const c of cruises) {
    items.push({
      type: "inicio",
      label: "Inicio de crucero sin conteo",
      detail: `${c.code} · pidió ${c.startAuthorization?.requestedByName ?? ""}${c.startAuthorization?.reason ? ` · «${c.startAuthorization.reason}»` : ""}`,
      amount: null,
      days: since(c.startAuthorization?.at),
      ref: c._id.toString(),
      actions: ["Autorizar", "No autorizar"],
    });
  }
  const map = await products();
  for (const o of orders) {
    if (o.outliers?.length && !o.outlierDecision && !o.sentAt) {
      const amount = round2(o.lines.reduce((t, l) => t + l.qty * (map.get(l.product.toString())?.costPerUnit ?? 0) * (l.containerSize || 1), 0));
      items.push({ type: "pedido", label: "Pedido fuera de lo normal", detail: `${o.code} · ${o.outliers.join(" · ")}`, amount: amount || null, days: since(o.cutAt), ref: o._id.toString(), actions: ["Aceptar", "Ajustar"] });
    }
    for (const d of o.deliveries ?? []) {
      if (d.different && !d.differenceDecision) {
        const missing = d.items.filter((i) => (i.received ?? i.qty) !== i.qty).map((i) => `${i.name} ${i.received ?? 0} de ${i.qty}`);
        items.push({ type: "recepcion", label: "Recepción «llegó diferente»", detail: `${o.code} · ${missing.join(", ") || "con diferencias"} · recibió ${d.arrivedByName}`, amount: null, days: since(d.arrivedAt ?? d.at), ref: o._id.toString(), key: d.key, actions: ["Aceptar", "Pedir explicación"] });
      }
    }
  }
  for (const c of adminCounts) {
    const diffs = c.lines.filter((l) => l.physical !== null && Math.abs(l.physical - Math.max(0, l.digitalAtCut)) > 1e-6);
    if (!diffs.length) continue;
    const amount = round2(diffs.reduce((t, l) => t + Math.max(0, Math.max(0, l.digitalAtCut) - (l.physical ?? 0)) * (map.get(l.product.toString())?.costPerUnit ?? 0), 0));
    items.push({ type: "control", label: "Control cruzado con diferencia", detail: `${c.code} · ${diffs.slice(0, 3).map((l) => l.name).join(", ")}${diffs.length > 3 ? ` y ${diffs.length - 3} más` : ""}`, amount: amount || null, days: since(c.submittedAt), ref: c._id.toString(), actions: ["Pedir recuento", "Registrar merma"] });
  }
  // Ordenado por dinero en juego.
  return items.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || b.days - a.days);
}

/* ───────────────────────── Ciclo de la semana ───────────────────────── */

async function weekCycle(map: ProductMap) {
  const [closing, order, admin, setting] = await Promise.all([
    StockCount.findOne({ kind: "cierre" }).sort({ cutAt: -1 }).populate("cruise", "code").lean(),
    WeeklyOrder.findOne().sort({ cutAt: -1 }).lean(),
    StockCount.findOne({ kind: "admin", status: { $ne: "borrador" } }).sort({ submittedAt: -1 }).lean(),
    AppSetting.findOne({ key: "adminControl" }).lean(),
  ]);
  const rows: Array<{ label: string; state: string; tone: "verde" | "amarillo" | "rojo" | "gris" }> = [];
  if (closing) {
    const code = (closing.cruise as unknown as { code?: string } | null)?.code ?? "";
    rows.push({
      label: `Conteo de cierre de ${code}`,
      state: closing.status === "aprobado" ? `verificado ${keyOf(closing.verifiedAt ?? closing.updatedAt!).slice(5).split("-").reverse().join("-")}` : closing.status === "gerencia" ? "en Gerencia" : closing.status === "enviado" ? "con la directora" : "el bartender cuenta",
      tone: closing.status === "aprobado" ? "verde" : closing.status === "gerencia" ? "rojo" : "amarillo",
    });
  }
  if (order) {
    const day = new Date(`${order.week}T12:00:00-06:00`).toLocaleDateString("es-EC", { weekday: "short", day: "numeric", timeZone: "Pacific/Galapagos" });
    rows.push({
      label: `Pedido ${order.code} (${day})`,
      state: order.status === "aprobado" ? (order.autoApproved ? "aprobado solo 18h00" : order.noNeeds ? "sin necesidades" : "aprobado") : order.status === "directora" ? "por aprobar (hasta 18h00)" : order.status === "bar" ? "el bartender ajusta (hasta 15h00)" : "cancelado",
      tone: order.status === "aprobado" ? (order.autoApproved ? "amarillo" : "verde") : "amarillo",
    });
    for (const d of order.deliveries ?? []) {
      const hours = Math.floor((Date.now() - new Date(d.at).getTime()) / 3_600_000);
      rows.push({
        label: `Recepción ${order.code}`,
        state: d.arrivedAt ? `recibida${d.different ? " (llegó diferente)" : ""}` : d.needsDirector ? "falta la directora" : `${hours} h sin confirmar`,
        tone: d.arrivedAt ? (d.different ? "amarillo" : "verde") : hours >= 24 ? "rojo" : "amarillo",
      });
    }
    if (order.status === "aprobado" && !order.noNeeds && !(order.deliveries ?? []).length) {
      rows.push({ label: "Compra del jueves", state: "pendiente", tone: "amarillo" });
    }
  }
  const next = (setting?.value as { nextDay?: string } | undefined)?.nextDay ?? "";
  rows.push({
    label: "Control de Administración",
    state: admin ? `hecho ${keyOf(admin.submittedAt ?? admin.updatedAt!).slice(5).split("-").reverse().join("-")}` : next ? `próximo ${next.slice(5).split("-").reverse().join("-")}` : "sin programar",
    tone: admin ? "verde" : "gris",
  });
  return rows;
}

/* ───────────────────────── Crucero en curso ───────────────────────── */

async function lastClosed(n: number, before: Date) {
  return (await Cruise.find({ status: "cerrado", startDate: { $lt: before } })
    .sort({ startDate: -1 })
    .limit(n)
    .select("code startDate endDate cabins.passengers")
    .lean()) as unknown as LeanCruise[];
}

export async function controlCurrent() {
  const map = await products();
  let cruise = (await Cruise.findOne({ status: "abordo" }).lean()) as unknown as LeanCruise | null;
  const navigating = Boolean(cruise);
  if (!cruise) cruise = (await Cruise.findOne({ status: "cerrado" }).sort({ startDate: -1 }).lean()) as unknown as LeanCruise | null;
  const nextCruise = await Cruise.findOne({ status: "planificado" }).sort({ startDate: 1 }).select("code startDate").lean();
  const [decisions, cycle] = await Promise.all([pendingDecisions(), weekCycle(map)]);
  if (!cruise) return { navigating: false, cruise: null, next: nextCruise ? { code: nextCruise.code, start: keyOf(nextCruise.startDate) } : null, decisions, cycle };

  const start = keyOf(cruise.startDate);
  const end = keyOf(cruise.endDate ?? cruise.startDate);
  const today = commercialDateKey();
  const totalDays = daysBetween(start, end) + 1;
  const dayX = navigating ? Math.min(totalDays, Math.max(1, daysBetween(start, today) + 1)) : totalDays;
  const pax = paxOf(cruise);
  const directora = cruise.startedBy ? (await User.findById(cruise.startedBy).select("name").lean())?.name ?? "" : "";

  // Ventas del bar hasta hoy y el promedio de los últimos 4 cruceros cerrados al mismo día.
  const previous = await lastClosed(4, cruise.startDate);
  const sales = await barSales([cruise._id, ...previous.map((c) => c._id)], map);
  const upTo = (c: { _id: Types.ObjectId; startDate: Date }) => {
    const limit = addDaysKey(keyOf(c.startDate), dayX - 1);
    return round2(sales.filter((s) => s.cruise === c._id.toString() && s.day <= limit).reduce((t, s) => t + s.amount, 0));
  };
  const sold = upTo(cruise);
  const avgSold = previous.length ? round2(previous.reduce((t, c) => t + upTo(c), 0) / previous.length) : null;
  const perPaxDay = pax ? round2(sold / pax / dayX) : null;
  const avgPerPaxDay = previous.length ? round2(previous.reduce((t, c) => t + (paxOf(c) ? upTo(c) / paxOf(c) / dayX : 0), 0) / previous.length) : null;

  // Cortesías, roturas y salidas: valor y % de las ventas.
  const [courtesyOrders, moves] = await Promise.all([
    Order.find({ cruise: cruise._id, status: { $in: ["entregada", "pendiente"] }, "items.courtesy": true }).select("items").lean(),
    StockMovement.find({ cruise: cruise._id, type: { $in: ["rotura", "salida", "devolucion_tierra"] } }).select("product qty").lean(),
  ]);
  const courtesy = courtesyOrders.reduce((t, o) => t + o.items.filter((i) => i.courtesy).reduce((s, i) => s + liveUnits(i) * i.unitPrice, 0), 0);
  const outs = moves.reduce((t, m) => {
    const p = map.get(m.product.toString());
    return t + (p ? valueOf(p, -m.qty) : 0);
  }, 0);
  const exits = round2(courtesy + outs);

  // Stock bajo cero (el esperado se muestra en 0 con alerta).
  const countable = [...map.values()].filter((p) => p.kind === "fisico" && p.active !== false && !isFresh(p));
  const belowZero = countable.filter((p) => (p.onboardStock ?? 0) < -1e-9).map((p) => p.name);

  // Puede faltar antes del cierre: consumo que falta = consumo por pasajero y día (últimos 4) × pasajeros × días que faltan.
  const daysLeft = navigating ? Math.max(0, totalDays - dayX) : 0;
  const pastPaxDays = previous.reduce((t, c) => t + paxOf(c) * Math.max(1, daysBetween(keyOf(c.startDate), keyOf(c.endDate ?? c.startDate))), 0);
  const ventas = previous.length
    ? await StockMovement.aggregate<{ _id: Types.ObjectId; qty: number }>([
        { $match: { type: "venta", cruise: { $in: previous.map((c) => c._id) } } },
        { $group: { _id: "$product", qty: { $sum: "$qty" } } },
      ])
    : [];
  const order = await WeeklyOrder.findOne({ status: "aprobado", noNeeds: { $ne: true } }).sort({ cutAt: -1 }).lean();
  const incoming = new Map<string, number>();
  const shortage = new Set<string>();
  if (order) {
    for (const d of order.deliveries ?? []) if (!d.arrivedAt) for (const i of d.items) incoming.set(i.product.toString(), (incoming.get(i.product.toString()) ?? 0) + i.qty);
    for (const l of order.lines) {
      const delivered = (order.deliveries ?? []).some((d) => d.items.some((i) => i.product.equals(l.product)));
      if (!delivered && l.qty > 0 && !order.sentAt) incoming.set(l.product.toString(), (incoming.get(l.product.toString()) ?? 0) + l.qty);
    }
    for (const s of order.shortages ?? []) shortage.add(s.product.toString());
  }
  const friday = addDaysKey(today, (5 - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7 || 7);
  const short: Array<{ product: string; now: number; need: number; incoming: string; state: string; tone: string }> = [];
  if (navigating && pastPaxDays && daysLeft > 0) {
    for (const v of ventas) {
      const p = map.get(v._id.toString());
      if (!p || isFresh(p) || p.kind !== "fisico") continue;
      const size = p.containerSize || 1;
      const perDay = (Math.max(0, -v.qty) / pastPaxDays) * pax;
      if (!perDay) continue;
      const now = Math.max(0, p.onboardStock ?? 0);
      const need = perDay * daysLeft;
      const coming = shortage.has(v._id.toString()) ? 0 : (incoming.get(v._id.toString()) ?? 0) * size;
      const runsOutIn = Math.floor(now / perDay);
      const outDay = addDaysKey(today, runsOutIn);
      const beforeReception = coming > 0 && outDay < friday;
      if (now + coming >= need && !beforeReception) continue;
      const dayName = new Date(`${outDay}T12:00:00-06:00`).toLocaleDateString("es-EC", { weekday: "long", timeZone: "Pacific/Galapagos" });
      short.push({
        product: p.name,
        now: round2(now / size),
        need: round2(need / size),
        incoming: shortage.has(v._id.toString()) ? "no conseguido" : coming ? `${round2(coming / size)} pedidas` : "no pedido",
        state: now + coming >= need ? "Alcanza con la recepción" : now <= 0 ? "Sin stock ahora" : runsOutIn <= 1 ? "Se acaba mañana" : `Se acaba el ${dayName}`,
        tone: now + coming >= need ? "amarillo" : "rojo",
      });
    }
  }

  // Cobros de este crucero (el efectivo de un crucero no se mezcla con el del anterior).
  const payments = await Payment.find({ cruise: cruise._id, status: "vigente" }).select("method total billing invoiceStatus invoiceEmail").lean();
  const byMethod = (m: string) => round2(payments.filter((p) => p.method === m).reduce((t, p) => t + p.total, 0));
  const team = await teamEmails();
  const badEmails = payments.filter((p) => p.invoiceStatus === "emitida" && (p.invoiceEmail?.status === "error" || (!p.billing?.noEmail && isTestOrTeamEmail(p.billing?.email ?? "", team)))).length;

  // Más vendido en este crucero.
  const top = new Map<string, { name: string; units: number; amount: number }>();
  for (const s of sales.filter((x) => x.cruise === cruise!._id.toString())) {
    const row = top.get(s.product) ?? { name: s.name.replace(/ \(.*\+.*\)$/, ""), units: 0, amount: 0 };
    row.units += s.units;
    row.amount += s.amount;
    top.set(s.product, row);
  }

  return {
    navigating,
    cruise: {
      id: cruise._id.toString(),
      code: cruise.code,
      start,
      end,
      dayX,
      totalDays,
      passengers: pax,
      bartender: cruise.bartenderName,
      directora,
      status: cruise.status,
    },
    next: nextCruise ? { code: nextCruise.code, start: keyOf(nextCruise.startDate) } : null,
    figures: {
      sold,
      avgSold,
      soldPct: avgSold ? Math.round(((sold - avgSold) / avgSold) * 100) : null,
      perPaxDay,
      avgPerPaxDay,
      exits,
      exitsPct: sold > 0 ? round2((exits / sold) * 100) : null,
      belowZero: belowZero.length,
      belowZeroNames: belowZero,
    },
    decisions,
    short,
    payments: {
      tarjeta: byMethod("tarjeta"),
      efectivo: byMethod("efectivo"),
      transferencia: round2(byMethod("transferencia") + byMethod("online")),
      total: round2(payments.reduce((t, p) => t + p.total, 0)),
      badEmails: navigating ? badEmails : 0,
    },
    top: [...top.values()].sort((a, b) => b.units - a.units).slice(0, 5).map((t) => ({ ...t, amount: round2(t.amount) })),
    cycle,
  };
}

/* ───────────────────────── Cruceros cerrados, Mes y Año ───────────────────────── */

export async function controlClosed() {
  const cruises = (await Cruise.find({ status: "cerrado" }).sort({ startDate: -1 }).limit(20).select("code startDate endDate bartenderName").lean()) as unknown as Array<LeanCruise>;
  const counts = await StockCount.find({ kind: "cierre", cruise: { $in: cruises.map((c) => c._id) } }).lean();
  return cruises.map((c) => {
    const count = counts.find((k) => k.cruise?.equals(c._id));
    return {
      id: c._id.toString(),
      code: c.code,
      start: keyOf(c.startDate),
      end: keyOf(c.endDate ?? c.startDate),
      bartender: c.bartenderName,
      count: count
        ? {
            code: count.code,
            status: count.status,
            wasteTotal: count.wasteTotal,
            bartender: count.submittedByName,
            directora: count.verifiedByName,
            lines: count.lines
              .filter((l) => l.result === "merma")
              .map((l) => ({ name: l.name, value: l.value, motive: l.motive, units: round2(Math.max(0, l.digitalAtCut) - (l.recount ?? l.physical ?? 0)) })),
          }
        : null,
    };
  });
}

export async function controlPeriod(kind: "mes" | "ano", value: string) {
  const today = commercialDateKey();
  const from = kind === "mes" ? `${/^\d{4}-\d{2}$/.test(value) ? value : today.slice(0, 7)}-01` : `${/^\d{4}$/.test(value) ? value : today.slice(0, 4)}-01-01`;
  const [y, m] = from.split("-").map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const to = kind === "mes" ? addDaysKey(nextMonth, -1) : `${y}-12-31`;
  const range = { $gte: parseRangeEdge(from, "start")!, $lte: parseRangeEdge(to, "end")! };
  const map = await products();

  // Merma por crucero, producto, persona (bartender y directora que verificó) y motivo.
  const counts = await StockCount.find({ kind: "cierre", status: { $in: ["aprobado", "gerencia"] }, cutAt: range }).populate("cruise", "code").lean();
  const add = (m: Map<string, number>, k: string, v: number) => k && m.set(k, round2((m.get(k) ?? 0) + v));
  const byCruise = new Map<string, number>();
  const byProduct = new Map<string, number>();
  const byPerson = new Map<string, number>();
  const byMotive = new Map<string, number>();
  const MOTIVE: Record<string, string> = { rotura: "Rotura no reg.", cortesia: "Cortesía no reg.", consumo: "Consumo no reg.", faltante: "Faltante" };
  for (const c of counts) {
    add(byCruise, (c.cruise as unknown as { code?: string } | null)?.code ?? "", c.wasteTotal);
    if (c.submittedByName) add(byPerson, `${c.submittedByName} · bartender`, c.wasteTotal);
    if (c.verifiedByName) add(byPerson, `${c.verifiedByName} · directora`, c.wasteTotal);
    for (const l of c.lines.filter((x) => x.result === "merma")) {
      add(byProduct, l.name, l.value);
      add(byMotive, MOTIVE[l.motive] ?? "Sin motivo", l.value);
    }
  }
  const rows = (m: Map<string, number>) => [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  // Salidas registradas (no son merma).
  const [moves, courtesyOrders] = await Promise.all([
    StockMovement.find({ type: { $in: ["rotura", "salida", "devolucion_tierra"] }, createdAt: range }).select("type exitKind product qty").lean(),
    Order.find({ status: { $in: ["entregada", "pendiente"] }, "items.courtesy": true, createdAt: range }).select("items").lean(),
  ]);
  const exits = { cortesias: 0, roturas: 0, cocina: 0, tripulacion: 0, brindis: 0, devoluciones: 0 };
  exits.cortesias = round2(courtesyOrders.reduce((t, o) => t + o.items.filter((i) => i.courtesy).reduce((s, i) => s + liveUnits(i) * i.unitPrice, 0), 0));
  for (const m of moves) {
    const p = map.get(m.product.toString());
    const v = p ? valueOf(p, -m.qty) : 0;
    if (m.type === "rotura") exits.roturas = round2(exits.roturas + v);
    else if (m.type === "devolucion_tierra") exits.devoluciones = round2(exits.devoluciones + v);
    else if (m.exitKind === "cocina" || m.exitKind === "tripulacion" || m.exitKind === "brindis") exits[m.exitKind] = round2(exits[m.exitKind] + v);
  }

  // Pedidos y compras: a tiempo, recepciones a tiempo y no conseguidos.
  const orders = await WeeklyOrder.find({ week: { $gte: from, $lte: to } }).lean();
  const deliveries = orders.flatMap((o) => o.deliveries ?? []);
  const purchases = {
    orders: orders.length,
    approvedOnTime: orders.filter((o) => o.status === "aprobado" && !o.autoApproved).length,
    receptions: deliveries.length,
    receptionsOnTime: deliveries.filter((d) => d.arrivedAt && new Date(d.arrivedAt).getTime() - new Date(d.at).getTime() <= DAY_MS).length,
    notFound: orders.reduce((t, o) => t + (o.shortages ?? []).filter((s) => s.status === "no_conseguido").length, 0),
  };

  // Cobros por crucero (tarjeta, efectivo, transferencia): cada crucero con su propio efectivo.
  const cruises = await Cruise.find({ startDate: range, status: { $ne: "planificado" } }).sort({ startDate: 1 }).select("code startDate endDate status").lean();
  const payments = await Payment.find({ cruise: { $in: cruises.map((c) => c._id) }, status: "vigente" }).select("cruise method total").lean();
  const collections = cruises.map((c) => {
    const list = payments.filter((p) => p.cruise.equals(c._id));
    const m = (x: string) => round2(list.filter((p) => p.method === x).reduce((t, p) => t + p.total, 0));
    return { code: c.code, status: c.status, start: keyOf(c.startDate), end: keyOf(c.endDate ?? c.startDate), tarjeta: m("tarjeta"), efectivo: m("efectivo"), transferencia: round2(m("transferencia") + m("online")), total: round2(list.reduce((t, p) => t + p.total, 0)) };
  });

  // Control cruzado: Administración vs bartender (mismo momento) vs sistema.
  const admins = await StockCount.find({ kind: "admin", status: { $ne: "borrador" }, submittedAt: range }).sort({ submittedAt: -1 }).lean();
  const cross = [];
  for (const a of admins.slice(0, 2)) {
    const bartender = await StockCount.findOne({ kind: { $in: ["cierre", "inicial"] }, cutAt: { $lte: a.cutAt } }).sort({ cutAt: -1 }).lean();
    for (const l of a.lines) {
      if (l.physical === null) continue;
      const p = map.get(l.product.toString());
      const size = p?.containerSize || 1;
      const b = bartender?.lines.find((x) => x.product.equals(l.product));
      const system = Math.max(0, l.digitalAtCut);
      const diff = round2((l.physical - system) / size);
      cross.push({
        product: l.name,
        date: keyOf(a.submittedAt ?? a.cutAt),
        admin: round2(l.physical / size),
        bartender: b?.physical != null ? round2(b.physical / size) : null,
        system: round2(system / size),
        diff,
      });
    }
  }

  return {
    period: { kind, from, to },
    waste: { total: round2(counts.reduce((t, c) => t + c.wasteTotal, 0)), byCruise: rows(byCruise), byProduct: rows(byProduct).slice(0, 8), byPerson: rows(byPerson), byMotive: rows(byMotive) },
    exits,
    purchases,
    collections,
    cross,
  };
}

/* ───────────────────────── Control de Administración ───────────────────────── */

/**
 * Cada 2 semanas la app elige al azar uno de los días de cambio de crucero (el
 * único momento en que el barco está en puerto). Solo Administración lo ve, ese
 * mismo día.
 */
export async function adminControlDay(now: Date = new Date()) {
  const today = commercialDateKey(now);
  const setting = await AppSetting.findOne({ key: "adminControl" });
  const value = (setting?.value ?? {}) as { nextDay?: string | null; lastDay?: string | null };
  if (value.nextDay && value.nextDay >= today) return value.nextDay;
  const from = value.lastDay && value.lastDay >= addDaysKey(today, -14) ? addDaysKey(value.lastDay, 7) : today;
  const cruises = await Cruise.find({ status: { $ne: "cerrado" } }).select("startDate endDate").lean();
  // Día de cambio: termina un crucero y zarpa el siguiente.
  const changes = cruises
    .map((c) => keyOf(c.startDate))
    .filter((d) => d >= from && d <= addDaysKey(from, 14))
    .filter((d) => cruises.some((c) => c.endDate && keyOf(c.endDate) === d) || d > today)
    .sort();
  const nextDay = changes.length ? changes[Math.floor(Math.random() * changes.length)]! : null;
  await AppSetting.updateOne({ key: "adminControl" }, { $set: { value: { ...value, nextDay } } }, { upsert: true });
  return nextDay;
}

export async function markAdminControlDone(day: string) {
  await AppSetting.updateOne({ key: "adminControl" }, { $set: { value: { lastDay: day, nextDay: null } } }, { upsert: true });
}
