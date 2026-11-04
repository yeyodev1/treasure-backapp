import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { Purchase } from "../models/purchase.model";
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
export const ORDER_RECIPIENT = "Compras: Administración y Bodega, en Inventario y pedidos";

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

/** Comprado y recibido por pedido y producto (unidad base), según sus compras. */
export async function orderProgress(orderIds: Types.ObjectId[]) {
  const purchases = await Purchase.find({ weeklyOrder: { $in: orderIds }, status: { $ne: "anulada" } })
    .select("weeklyOrder status lines.product lines.qty lines.receivedQty")
    .lean();
  const result = new Map<string, Map<string, { purchased: number; received: number }>>();
  for (const p of purchases) {
    const key = String(p.weeklyOrder);
    const byProduct = result.get(key) ?? new Map<string, { purchased: number; received: number }>();
    for (const line of p.lines) {
      const id = line.product.toString();
      const row = byProduct.get(id) ?? { purchased: 0, received: 0 };
      // Una compra cerrada con faltante solo cuenta lo que llegó.
      row.purchased = round2(row.purchased + (p.status === "cerrada" ? line.receivedQty : line.qty));
      row.received = round2(row.received + line.receivedQty);
      byProduct.set(id, row);
    }
    result.set(key, byProduct);
  }
  return result;
}

/**
 * Lo que ya viene en camino al corte, para no pedirlo dos veces: compras sin
 * recibir y lo aprobado en pedidos anteriores que aún no se compró.
 */
async function incomingByProduct(before: Date) {
  const incoming = new Map<string, number>();
  const add = (id: string, qty: number) => {
    if (qty > 0) incoming.set(id, round2((incoming.get(id) ?? 0) + qty));
  };
  const open = await Purchase.find({ status: { $in: ["registrada", "recibida_parcial"] } })
    .select("lines.product lines.qty lines.receivedQty")
    .lean();
  for (const p of open) for (const l of p.lines) add(l.product.toString(), l.qty - l.receivedQty);

  const approved = await WeeklyOrder.find({ status: "aprobado", cutAt: { $lt: before } })
    .select("lines.product lines.qty lines.containerSize")
    .lean();
  const progress = await orderProgress(approved.map((o) => o._id));
  for (const o of approved) {
    const done = progress.get(o._id.toString());
    for (const l of o.lines) {
      add(l.product.toString(), l.qty * (l.containerSize || 1) - (done?.get(l.product.toString())?.purchased ?? 0));
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
    const onHand = Object.values(atCut).reduce((s, q) => s + Math.max(0, q), 0);
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
