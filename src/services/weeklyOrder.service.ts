import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { IWeeklyOrder, IWeeklyOrderLine, SuggestionBasis, WeeklyOrder } from "../models/weeklyOrder.model";
import { nextCode } from "./codes.service";
import { stockOf } from "./inventory.service";
import { round2 } from "../utils/units";
import { Cruise } from "../models/cruise.model";
import { User } from "../models/user.model";
import { AppSetting } from "../models/appSetting.model";
import { isFresh } from "./barStock.service";
import { goalsAt } from "./goals.service";

/**
 * Pedido semanal (Bar-stock, especificación del 24-nov-2026): el miércoles a
 * las 12h00 (Galápagos, UTC−6) la app propone; el bartender ajusta hasta las
 * 15h00 y la directora aprueba hasta las 18h00. Sin aprobación a las 18h00 se
 * aprueba solo con la propuesta y avisa a Gerencia.
 */
const GALAPAGOS_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;
const CUT_WEEKDAY = 3; // miércoles
const CUT_HOUR = 12;
/** 15h00: termina el ajuste del bartender. */
export const ALERT_AFTER_MS = 3 * 3600_000;
/** 18h00: termina la aprobación de la directora. */
export const APPROVE_AFTER_MS = 6 * 3600_000;
/** A quién llega el pedido aprobado: por ahora solo dentro del sistema (sin correo ni WhatsApp). */
export const ORDER_RECIPIENT = "Administración (puerto o compra nueva) y la dueña (Quito), en Pedido semanal";

/** Último corte (miércoles 15h00 Galápagos) que ya ocurrió en `now`. */
export function latestCut(now: Date = new Date()): Date {
  const local = new Date(now.getTime() - GALAPAGOS_OFFSET_MS);
  const back = (local.getUTCDay() - CUT_WEEKDAY + 7) % 7;
  const candidate =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back, CUT_HOUR) + GALAPAGOS_OFFSET_MS;
  return new Date(candidate > now.getTime() ? candidate - 7 * DAY_MS : candidate);
}

/** AAAA-MM-DD del corte en Galápagos. */
export function weekKey(cut: Date): string {
  return new Date(cut.getTime() - GALAPAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** El bar no revisó a tiempo: la directora recibe la alerta (no se aprueba solo). */
export function isOverdue(order: Pick<IWeeklyOrder, "status" | "week">, now: Date = new Date()): boolean {
  if (order.status !== "bar") return false;
  const cut = new Date(`${order.week}T${String(CUT_HOUR).padStart(2, "0")}:00:00-06:00`);
  return now.getTime() >= cut.getTime() + ALERT_AFTER_MS;
}

export interface SuggestionInput {
  /** Envases a mantener; 0 = sin objetivo. */
  target: number;
  containerSize: number;
  /** Existencias utilizables (unidad base, sin negativos). */
  onHand: number;
  /** Lo que ya viene en camino (unidad base). */
  incoming: number;
  /** Consumo de la última semana (unidad base). */
  consumption: number;
  /** Alerta de stock bajo del catálogo (unidad base). */
  lowThreshold: number;
}

/**
 * Cuánto pedir y por qué. Con objetivo: objetivo − lo que hay − lo que viene
 * (ej.: objetivo 18, hay 6, vienen 4 → 8). Sin objetivo: lo consumido la última
 * semana − lo que hay − lo que viene. Sin datos y bajo el mínimo: "revisar".
 * null = el producto no entra en la propuesta.
 */
export function suggest(input: SuggestionInput): { suggested: number | null; basis: SuggestionBasis } | null {
  const size = input.containerSize > 0 ? input.containerSize : 1;
  const available = input.onHand + input.incoming;
  const envases = (base: number) => Math.max(0, Math.ceil(round2(base / size) - 1e-9));
  if (input.target > 0) return { suggested: envases(input.target * size - available), basis: "objetivo" };
  if (input.consumption > 0) return { suggested: envases(input.consumption - available), basis: "consumo" };
  if (input.lowThreshold > 0 && input.onHand <= input.lowThreshold) return { suggested: null, basis: "revisar" };
  return null;
}

/** Avance de una línea: entregado al barco, enviado sin llegar y lo que falta (envases). */
export interface LineProgress {
  delivered: number;
  inTransit: number;
  pending: number;
}

/**
 * Avance del pedido aprobado según sus entregas y envíos. Flujo simple
 * (Gabriel, 16-nov-2026): todo va "en camino" hasta que el bar confirma, y
 * cuenta lo que recibió; si llegó menos, lo que falta vuelve a quedar pendiente.
 * Entregas anteriores al cambio (sin awaitsBar) ya estaban en el barco.
 */
export function orderProgress(order: Pick<IWeeklyOrder, "lines" | "deliveries">): Map<string, LineProgress> {
  const result = new Map<string, LineProgress>();
  for (const l of order.lines) result.set(l.product.toString(), { delivered: 0, inTransit: 0, pending: 0 });
  for (const d of order.deliveries ?? []) {
    for (const item of d.items) {
      const row = result.get(item.product.toString());
      if (!row) continue;
      if (d.arrivedAt) row.delivered += item.received ?? item.qty;
      else if (d.kind === "entrega" && !d.awaitsBar) row.delivered += item.qty;
      else row.inTransit += item.qty;
    }
  }
  for (const l of order.lines) {
    const row = result.get(l.product.toString())!;
    row.pending = Math.max(0, l.qty - row.delivered - row.inTransit);
  }
  return result;
}

export const PHASE_LABELS = {
  bar: "Por revisar por el bar",
  directora: "Por revisar por la directora",
  atender: "Aprobado: por atender",
  en_curso: "Aprobado: entrega en curso",
  completo: "Entregado completo",
  sin_necesidades: "Cerrado sin necesidades",
  cancelado: "Cancelado",
} as const;
export type OrderPhase = keyof typeof PHASE_LABELS;

export function phaseOf(order: Pick<IWeeklyOrder, "status" | "lines" | "deliveries" | "noNeeds">): OrderPhase {
  if (order.status !== "aprobado") return order.status;
  if (order.noNeeds) return "sin_necesidades";
  const rows = [...orderProgress(order).values()];
  if (rows.every((r) => r.pending <= 0 && r.inTransit <= 0)) return "completo";
  return rows.some((r) => r.delivered > 0 || r.inTransit > 0) ? "en_curso" : "atender";
}

/**
 * Lo que ya viene en camino al barco al corte, para no pedirlo dos veces: lo
 * enviado sin llegar y lo aprobado sin atender de pedidos anteriores. Las
 * compras a una bodega no cuentan: tenerlo en bodega no es tenerlo a bordo.
 */
async function incomingByProduct(before: Date) {
  const incoming = new Map<string, number>();
  const approved = await WeeklyOrder.find({ status: "aprobado", noNeeds: { $ne: true }, cutAt: { $lt: before } })
    .select("lines deliveries")
    .lean();
  for (const o of approved) {
    const progress = orderProgress(o);
    for (const l of o.lines) {
      const row = progress.get(l.product.toString())!;
      const qty = (row.pending + row.inTransit) * (l.containerSize || 1);
      if (qty > 0) incoming.set(l.product.toString(), round2((incoming.get(l.product.toString()) ?? 0) + qty));
    }
  }
  return incoming;
}

/** Noches con pasajeros dentro de [from, to) de un crucero, en días de Galápagos. */
function nightsIn(c: { startDate: Date; endDate: Date | null }, from: string, to: string) {
  const key = (d: Date) => new Date(d.getTime() - GALAPAGOS_OFFSET_MS).toISOString().slice(0, 10);
  const start = key(c.startDate);
  const end = key(c.endDate ?? c.startDate);
  const a = start > from ? start : from;
  const b = end < to ? end : to;
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS));
}
const addDays = (key: string, n: number) => new Date(Date.parse(key) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Propuesta del miércoles 12h00 (Bar-stock, sección 6):
 *   consumo por pasajero por día = promedio de los últimos 4 cruceros cerrados
 *   stock al viernes = lo que hay hoy (+ lo que ya viene) − consumo esperado hasta el viernes
 *   pedir = consumo esperado de viernes a viernes − stock al viernes (hacia arriba, en envases; ≤ 0 no se pide)
 * Sin cruceros la semana siguiente (para o dique), la propuesta es 0.
 */
export async function buildLines(cutAt: Date): Promise<IWeeklyOrderLine[]> {
  const today = new Date(cutAt.getTime() - GALAPAGOS_OFFSET_MS).toISOString().slice(0, 10);
  const friday = addDays(today, (5 - CUT_WEEKDAY + 7) % 7 || 7);
  const nextFriday = addDays(friday, 7);
  const [products, incoming, history, coming] = await Promise.all([
    Product.find({ kind: "fisico", active: true }).sort({ category: 1, name: 1 }).lean(),
    incomingByProduct(cutAt),
    Cruise.find({ status: "cerrado", startDate: { $lt: cutAt } }).sort({ startDate: -1 }).limit(4).select("startDate endDate cabins.passengers").lean(),
    Cruise.find({ status: { $in: ["planificado", "abordo"] } }).select("startDate endDate cabins.passengers").lean(),
  ]);
  const paxOf = (c: { cabins: Array<{ passengers: unknown[] }> }) => c.cabins.reduce((t, cb) => t + cb.passengers.length, 0);
  const pastPaxDays = history.reduce((t, c) => t + paxOf(c) * nightsIn(c, "0000-01-01", "9999-12-31"), 0);
  const avgPax = history.length ? history.reduce((t, c) => t + paxOf(c), 0) / history.length : 0;
  // Un crucero programado sin pasajeros cargados usa el promedio de los últimos cuatro.
  const paxDays = (from: string, to: string) => coming.reduce((t, c) => t + (paxOf(c) || avgPax) * nightsIn(c, from, to), 0);
  const untilFriday = paxDays(today, friday);
  const nextWeek = paxDays(friday, nextFriday);
  const sales = history.length
    ? await StockMovement.aggregate<{ _id: Types.ObjectId; qty: number }>([
        { $match: { type: "venta", cruise: { $in: history.map((c) => c._id) } } },
        { $group: { _id: "$product", qty: { $sum: "$qty" } } },
      ])
    : [];
  const rate = new Map(sales.map((s) => [s._id.toString(), pastPaxDays ? Math.max(0, -s.qty) / pastPaxDays : 0]));

  const lines: IWeeklyOrderLine[] = [];
  for (const p of products) {
    const id = p._id.toString();
    const perPaxDay = rate.get(id) ?? 0;
    if (!perPaxDay) continue;
    const size = p.containerSize || 1;
    // Los frescos no llevan stock: se pide lo que se va a consumir.
    const fresh = isFresh(p);
    const fridayBase = fresh ? 0 : Math.max(0, p.onboardStock ?? 0) + (incoming.get(id) ?? 0) - perPaxDay * untilFriday;
    const need = perPaxDay * nextWeek - Math.max(0, fridayBase);
    const suggested = nextWeek > 0 ? Math.max(0, Math.ceil(round2(need / size) - 1e-9)) : 0;
    if (!suggested) continue;
    lines.push(
      newLine(p, stockOf(p), {
        target: p.stockTarget ?? 0,
        incoming: incoming.get(id) ?? 0,
        consumption: round2(perPaxDay * nextWeek),
        suggested,
        basis: "consumo",
        fridayStock: fresh ? null : round2(Math.max(0, fridayBase) / size),
      }),
    );
  }
  return lines;
}

type ProductLike = { _id: Types.ObjectId; name: string; stockUnit: string; containerSize: number; containerLabel: string };

export function newLine(
  p: ProductLike,
  atCut: IWeeklyOrderLine["atCut"],
  data: Pick<IWeeklyOrderLine, "target" | "incoming" | "consumption" | "suggested" | "basis"> & { fridayStock?: number | null },
): IWeeklyOrderLine {
  return {
    product: p._id,
    name: p.name,
    stockUnit: p.stockUnit,
    containerSize: p.containerSize || 1,
    containerLabel: p.containerLabel,
    atCut,
    ...data,
    qty: data.suggested ?? 0,
    barQty: null,
    approvedQty: null,
    observation: "",
    counted: null,
    fridayStock: data.fridayStock ?? null,
    editedByName: "",
    editedAt: null,
  };
}

/**
 * Asegura la propuesta del último corte: una sola por semana (índice único
 * por `week`), así un reintento de la tarea no crea otro pedido.
 */
export async function ensureWeeklyOrder(now: Date = new Date()) {
  const cut = latestCut(now);
  const week = weekKey(cut);
  const existing = await WeeklyOrder.findOne({ week });
  if (existing) return { order: existing, created: false };

  const late = now.getTime() - cut.getTime() > 15 * 60_000;
  const cutAt = late ? now : cut;
  const lines = await buildLines(cutAt);
  try {
    const order = await WeeklyOrder.create({
      code: await nextCode("PS"),
      week,
      cutAt,
      generatedLate: late,
      status: "bar",
      lines,
      history: [
        {
          at: now,
          by: null,
          byName: "Sistema",
          action: "Propuesta preparada",
          detail: `${lines.length} producto(s) · consumo por pasajero de los últimos 4 cruceros${late ? " (se armó después de las 12h00)" : ""}`,
        },
      ],
    });
    return { order, created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const order = await WeeklyOrder.findOne({ week });
      if (order) return { order, created: false };
    }
    throw err;
  }
}

/** Hora límite de un paso del pedido de esa semana (12h00 + offset). */
export function deadline(order: Pick<IWeeklyOrder, "week">, afterCutMs: number) {
  return new Date(new Date(`${order.week}T${String(CUT_HOUR).padStart(2, "0")}:00:00-06:00`).getTime() + afterCutMs);
}

/**
 * Pedido fuera de lo normal (avisa a Gerencia al aprobarse): más del N % sobre
 * la propuesta o un producto que nunca se pide.
 */
export async function outlierReasons(order: Pick<IWeeklyOrder, "lines" | "code" | "week">) {
  const pct = (await goalsAt()).orderOutlierPct ?? 20;
  const proposal = order.lines.reduce((t, l) => t + (l.suggested ?? 0), 0);
  const asked = order.lines.reduce((t, l) => t + l.qty, 0);
  const out: string[] = [];
  if (proposal > 0 && asked > proposal * (1 + pct / 100)) out.push(`+${Math.round((asked / proposal - 1) * 100)} % sobre la propuesta`);
  const before = await WeeklyOrder.find({ status: "aprobado", week: { $lt: order.week } }).select("lines.product lines.qty").lean();
  const ordered = new Set(before.flatMap((o) => o.lines.filter((l) => l.qty > 0).map((l) => l.product.toString())));
  if (before.length) {
    for (const l of order.lines) if (l.qty > 0 && !ordered.has(l.product.toString())) out.push(`${l.name} ×${l.qty} (nunca se pide)`);
  }
  return out;
}

/**
 * Plazos del miércoles, se aplican al leer el pedido y en la tarea de cada
 * hora: a las 15h00 lo que el bar no envió pasa a la directora; a las 18h00
 * lo que nadie aprobó se aprueba solo con la propuesta. Devuelve si cambió.
 */
/** Primer miércoles con los plazos automáticos: los pedidos anteriores siguen como estaban (no se aprueban solos de forma retroactiva). */
export const DEADLINES_FROM_WEEK = "2026-12-02";

/** Acción del historial cuando la directora devuelve el pedido al bartender. */
export const RETURNED = "Devuelto al bartender";

export async function advanceDeadlines(order: InstanceType<typeof WeeklyOrder>, now: Date = new Date()) {
  if (order.week < DEADLINES_FROM_WEEK) return false;
  let changed = false;
  // Devuelto por la directora: no vuelve solo a las 15h00, pero a las 18h00 se aprueba igual.
  const returned = order.history.some((h) => h.action === RETURNED);
  if (order.status === "bar" && !returned && now >= deadline(order, ALERT_AFTER_MS)) {
    for (const l of order.lines) l.barQty = l.qty;
    order.status = "directora";
    order.history.push({ at: now, by: null, byName: "Sistema", action: "Pasó a la directora a las 15h00", detail: "El bartender no envió ajustes" });
    changed = true;
  }
  if ((order.status === "directora" || (order.status === "bar" && returned)) && now >= deadline(order, APPROVE_AFTER_MS)) {
    for (const l of order.lines) l.approvedQty = l.qty;
    order.status = "aprobado";
    order.autoApproved = true;
    order.noNeeds = !order.lines.some((l) => l.qty > 0);
    order.recipient = order.noNeeds ? "" : ORDER_RECIPIENT;
    order.outliers = order.noNeeds ? [] : await outlierReasons(order);
    order.history.push({ at: now, by: null, byName: "Sistema", action: "Aprobado solo a las 18h00", detail: "Sin aprobación de la directora: se aprobó con la propuesta y se avisó a Gerencia" });
    changed = true;
  }
  return changed;
}

/** Responsable de compras: el que fijó Gerencia (fijo o hasta una fecha) o Administración por defecto. */
export async function purchaseResponsible(now: Date = new Date()) {
  const setting = await AppSetting.findOne({ key: "purchaseResponsible" }).lean();
  const value = (setting?.value ?? {}) as { userId?: string; until?: string | null };
  if (value.userId && (!value.until || new Date(value.until) >= now)) {
    const user = await User.findOne({ _id: value.userId, active: true }).select("name role").lean();
    if (user) return { id: user._id.toString(), name: user.name, role: user.role, until: value.until ?? null, isDefault: false };
  }
  const admin = await User.findOne({ role: "admin", active: true }).sort({ createdAt: 1 }).select("name role").lean();
  return admin ? { id: admin._id.toString(), name: admin.name, role: admin.role, until: null, isDefault: true } : null;
}
