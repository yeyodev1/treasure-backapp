import { ClientSession, Types } from "mongoose";
import { IProduct, Product } from "../models/product.model";
import { IAppliedIngredient } from "../models/order.model";
import { MovementType, StockMovement } from "../models/stockMovement.model";
import { badRequest, insufficientStock } from "../errors/httpError";
import { round2, StockLocation } from "../utils/units";

/** Cantidades por insumo físico, en su unidad base (ml, unidad…). */
export type Deltas = Map<string, number>;

function addDelta(deltas: Deltas, productId: string, qty: number) {
  deltas.set(productId, round2((deltas.get(productId) ?? 0) + qty));
}

/**
 * Qué insumos consume vender `qty` unidades de un producto:
 * - físico: el envase completo (botella 750 ml, cerveza 1 unidad)
 * - receta: sus ingredientes con su medida (60 ml de Bacardí, 120 ml de cola…)
 * - servicio: nada
 */
export async function consumptionOf(productId: string, qty: number): Promise<Deltas> {
  const deltas: Deltas = new Map();
  const product = await Product.findById(productId).populate("recipe.product");
  if (!product) throw badRequest("Producto no encontrado");

  if (product.kind === "fisico") {
    addDelta(deltas, product._id.toString(), qty * (product.containerSize || 1));
  } else if (product.kind === "receta") {
    for (const ing of product.recipe) {
      const ingredient = ing.product as unknown as (IProduct & { _id: Types.ObjectId }) | null;
      if (!ingredient) continue;
      if (ingredient.kind !== "fisico") {
        throw badRequest(`La receta de ${product.name} usa un ingrediente que no es físico`);
      }
      addDelta(deltas, ingredient._id.toString(), ing.qty * qty);
    }
  }
  return deltas;
}

export async function mergeDeltas(parts: Deltas[]): Promise<Deltas> {
  const total: Deltas = new Map();
  for (const part of parts) {
    for (const [id, qty] of part) addDelta(total, id, qty);
  }
  return total;
}

interface ApplyInput {
  type: MovementType;
  location: StockLocation;
  /** Positivo suma, negativo resta. */
  deltas: Deltas;
  userId: string;
  cruise?: Types.ObjectId | string | null;
  order?: Types.ObjectId | string | null;
  count?: Types.ObjectId | string | null;
  reason?: string;
  supplier?: string;
  document?: string;
  unitCost?: number;
}

const LOCATION_FIELD: Record<StockLocation, "warehouseStock" | "onboardStock"> = {
  bodega: "warehouseStock",
  abordo: "onboardStock",
};

/** Mueve stock en una ubicación y deja cada movimiento en la bitácora. */
export async function applyMovement(input: ApplyInput) {
  const field = LOCATION_FIELD[input.location];
  for (const [productId, qty] of input.deltas) {
    if (!qty) continue;
    await Product.updateOne({ _id: productId }, { $inc: { [field]: qty } });
    await StockMovement.create({
      type: input.type,
      product: productId,
      location: input.location,
      qty,
      cruise: input.cruise ?? null,
      order: input.order ?? null,
      count: input.count ?? null,
      reason: input.reason ?? "",
      supplier: input.supplier ?? "",
      document: input.document ?? "",
      unitCost: input.unitCost ?? 0,
      user: input.userId,
    });
  }
}

/** Precio sugerido de un cóctel creado en el bar a partir de sus medidas. */
export async function suggestedPrice(recipe: Array<{ product: string; qty: number }>) {
  const ids = recipe.map((r) => r.product);
  const products = await Product.find({ _id: { $in: ids } }).select(
    "kind servingSize servingPrice",
  );
  const map = new Map(products.map((p) => [p._id.toString(), p]));
  let total = 0;
  for (const item of recipe) {
    const p = map.get(item.product);
    if (!p) throw badRequest("Hay ingredientes que no existen");
    if (p.kind !== "fisico") throw badRequest("Los ingredientes deben ser insumos físicos");
    if (p.servingSize > 0) total += (item.qty / p.servingSize) * p.servingPrice;
  }
  // Se redondea hacia arriba a múltiplos de 0,50 como la carta.
  return Math.ceil(total * 2) / 2;
}

// ---------------------------------------------------------------------------
// Movimientos atómicos sin negativos (guía auditada 27-oct-2026)
// ---------------------------------------------------------------------------


/**
 * Receta aplicada a una unidad vendida: un físico descuenta su envase, una
 * receta sus ingredientes, un servicio nada. Se guarda en el consumo.
 */
export async function appliedFor(
  product: IProduct & { _id: Types.ObjectId },
  session?: ClientSession,
): Promise<IAppliedIngredient[]> {
  if (product.kind === "fisico") {
    return [
      {
        product: product._id,
        name: product.name,
        qty: product.containerSize || 1,
        stockUnit: product.stockUnit,
        unitCost: product.costPerUnit ?? 0,
      },
    ];
  }
  if (product.kind !== "receta") return [];
  const ids = product.recipe.map((r) => r.product);
  const ingredients = await Product.find({ _id: { $in: ids } })
    .select("name kind stockUnit costPerUnit")
    .session(session ?? null);
  const byId = new Map(ingredients.map((i) => [i._id.toString(), i]));
  return product.recipe.map((r) => {
    const ing = byId.get(r.product.toString());
    if (!ing || ing.kind !== "fisico") {
      throw badRequest(`La receta de ${product.name} usa un ingrediente que no es físico`);
    }
    return {
      product: ing._id,
      name: ing.name,
      qty: r.qty,
      stockUnit: ing.stockUnit,
      unitCost: ing.costPerUnit ?? 0,
    };
  });
}

/** Costo de una unidad vendida y si todos sus insumos tienen costo. */
export function costOf(applied: IAppliedIngredient[]): { unitCost: number; complete: boolean } {
  const unitCost = applied.reduce((sum, a) => sum + a.qty * a.unitCost, 0);
  return {
    unitCost: Math.round(unitCost * 10000) / 10000,
    complete: applied.length > 0 && applied.every((a) => a.unitCost > 0),
  };
}

/** Deltas (en unidad base) de `qty` unidades según la receta aplicada. */
export function deltasFromApplied(applied: IAppliedIngredient[], qty: number): Deltas {
  const deltas: Deltas = new Map();
  for (const a of applied) addDelta(deltas, a.product.toString(), a.qty * qty);
  return deltas;
}

interface GuardedInput extends ApplyInput {
  session: ClientSession;
  /** true: si alguna resta deja el stock bajo cero, se cancela todo. */
  guard: boolean;
  transferId?: string;
  requisition?: Types.ObjectId | string | null;
  purchase?: Types.ObjectId | string | null;
}

/**
 * Mueve stock dentro de una transacción. Con `guard`, cada resta exige que
 * alcance (`$gte`); si un insumo falta, se lanza `sin_stock` y la
 * transacción entera se revierte: ni cargo parcial ni otros descuentos.
 */
export async function moveStock(input: GuardedInput) {
  const field = LOCATION_FIELD[input.location];
  const docs = [];
  for (const [productId, qty] of input.deltas) {
    if (!qty) continue;
    const filter: Record<string, unknown> = { _id: productId };
    if (input.guard && qty < 0) filter[field] = { $gte: -qty - 1e-9 };
    const result = await Product.updateOne(filter, { $inc: { [field]: qty } }, { session: input.session });
    if (result.matchedCount === 0) {
      const product = await Product.findById(productId).select("name").session(input.session);
      throw insufficientStock(productId, product?.name ?? "un insumo", input.location);
    }
    docs.push({
      type: input.type,
      product: productId,
      location: input.location,
      qty,
      cruise: input.cruise ?? null,
      order: input.order ?? null,
      count: input.count ?? null,
      reason: input.reason ?? "",
      supplier: input.supplier ?? "",
      document: input.document ?? "",
      unitCost: input.unitCost ?? 0,
      transferId: input.transferId ?? "",
      requisition: input.requisition ?? null,
      purchase: input.purchase ?? null,
      user: input.userId,
    });
  }
  if (docs.length) await StockMovement.create(docs, { session: input.session, ordered: true });
}

/**
 * Disponibilidad de la carta a bordo: un producto se puede servir si hay
 * stock de todos sus insumos para una unidad. Si no, se bloquea ese
 * producto (no toda la salida) y se dice qué falta.
 */
export async function onboardAvailability() {
  const products = await Product.find({ active: true }).select(
    "name kind sellable containerSize onboardStock recipe",
  );
  const stock = new Map(products.map((p) => [p._id.toString(), p]));
  const result: Record<string, { available: boolean; missing: string }> = {};
  for (const p of products) {
    if (p.kind === "fisico" && !p.sellable) continue;
    if (p.kind === "servicio") {
      result[p._id.toString()] = { available: true, missing: "" };
      continue;
    }
    const needs =
      p.kind === "fisico"
        ? [{ id: p._id.toString(), qty: p.containerSize || 1 }]
        : p.recipe.map((r) => ({ id: r.product.toString(), qty: r.qty }));
    const short = needs.find((n) => (stock.get(n.id)?.onboardStock ?? 0) + 1e-9 < n.qty);
    result[p._id.toString()] = {
      available: !short,
      missing: short ? (stock.get(short.id)?.name ?? "un insumo") : "",
    };
  }
  return result;
}
