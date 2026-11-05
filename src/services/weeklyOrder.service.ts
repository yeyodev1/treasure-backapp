import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { IWeeklyOrder, IWeeklyOrderLine, SuggestionBasis, WeeklyOrder } from "../models/weeklyOrder.model";
import { nextCode } from "./codes.service";
import { stockOf } from "./inventory.service";
import { round2 } from "../utils/units";

/**
 * Pedido semanal (guía Inventario y pedidos, 4-nov-2026): corte el miércoles
 * a las 15h00 en Galápagos (UTC−6, sin horario de verano) y alerta a la
 * directora a las 18h00 si el bar no lo revisó (decisión de Diego, 4-nov).
 */
const GALAPAGOS_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;
const CUT_WEEKDAY = 3; // miércoles
const CUT_HOUR = 15;
export const ALERT_AFTER_MS = 3 * 3600_000; // 18h00
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
 * Avance del pedido aprobado según sus entregas y envíos (guía 4 perfiles):
 * la entrega de la administradora ya está en el barco; el envío de Quito
 * cuenta como "en camino" hasta confirmar la llegada.
 */
export function orderProgress(order: Pick<IWeeklyOrder, "lines" | "deliveries">): Map<string, LineProgress> {
  const result = new Map<string, LineProgress>();
  for (const l of order.lines) result.set(l.product.toString(), { delivered: 0, inTransit: 0, pending: 0 });
  for (const d of order.deliveries ?? []) {
    for (const item of d.items) {
      const row = result.get(item.product.toString());
      if (!row) continue;
      if (d.kind === "entrega" || d.arrivedAt) row.delivered += item.qty;
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

/** Líneas de la propuesta con las existencias y datos de este instante (el corte). */
export async function buildLines(cutAt: Date): Promise<IWeeklyOrderLine[]> {
  const [products, incoming, sales] = await Promise.all([
    Product.find({ kind: "fisico", active: true }).sort({ category: 1, name: 1 }).lean(),
    incomingByProduct(cutAt),
    StockMovement.aggregate<{ _id: Types.ObjectId; qty: number }>([
      { $match: { type: "venta", createdAt: { $gte: new Date(cutAt.getTime() - 7 * DAY_MS), $lte: cutAt } } },
      { $group: { _id: "$product", qty: { $sum: "$qty" } } },
    ]),
  ]);
  const consumed = new Map(sales.map((s) => [s._id.toString(), round2(-s.qty)]));
  const lines: IWeeklyOrderLine[] = [];
  for (const p of products) {
    const id = p._id.toString();
    const atCut = stockOf(p);
    // Necesidad del barco: solo cuenta lo que hay a bordo. Puerto y Quito son de dónde se consigue.
    const onHand = Math.max(0, atCut.abordo);
    const result = suggest({
      target: p.stockTarget ?? 0,
      containerSize: p.containerSize || 1,
      onHand,
      incoming: incoming.get(id) ?? 0,
      consumption: Math.max(0, consumed.get(id) ?? 0),
      lowThreshold: p.lowStockThreshold ?? 0,
    });
    // Lo vendido en la semana siempre se muestra (aunque sugiera 0): el bar decide cuánto reponer (4-nov-2026).
    if (!result || (result.suggested === 0 && result.basis !== "consumo")) continue;
    lines.push(newLine(p, atCut, {
      target: p.stockTarget ?? 0,
      incoming: incoming.get(id) ?? 0,
      consumption: Math.max(0, consumed.get(id) ?? 0),
      suggested: result.suggested,
      basis: result.basis,
    }));
  }
  return lines;
}

type ProductLike = { _id: Types.ObjectId; name: string; stockUnit: string; containerSize: number; containerLabel: string };

export function newLine(
  p: ProductLike,
  atCut: IWeeklyOrderLine["atCut"],
  data: Pick<IWeeklyOrderLine, "target" | "incoming" | "consumption" | "suggested" | "basis">,
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
          detail: `${lines.length} producto(s) con existencias del corte${late ? " (se armó después de las 15h00)" : ""}`,
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
