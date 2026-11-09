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

export const LOCATION_FIELD: Record<StockLocation, "warehouseStock" | "quitoStock" | "puertoStock" | "onboardStock"> = {
  quito: "quitoStock",
  puerto: "puertoStock",
  abordo: "onboardStock",
  bodega: "warehouseStock",
};

/**
 * La bodega de Quito solo guarda botellas: vinos, licores y botellas de insumo
 * (vermut, Campari…). Aguas, gaseosas, cervezas y jugos van en Galápagos
 * (pedido del cliente, 4-nov-2026). Lo que ya tenga stock en Quito se muestra igual.
 */
export function belongsInQuito(p: Pick<IProduct, "category" | "containerLabel" | "stockUnit" | "quitoStock">): boolean {
  if (p.quitoStock) return true;
  if (p.category === "vino" || p.category === "licor") return true;
  return p.category === "insumo" && p.containerLabel === "botella" && p.stockUnit === "ml";
}

/** Existencias de un producto en todas las ubicaciones (unidad base). */
export function stockOf(p: Pick<IProduct, "quitoStock" | "puertoStock" | "onboardStock" | "warehouseStock">) {
  return {
    quito: p.quitoStock ?? 0,
    puerto: p.puertoStock ?? 0,
    abordo: p.onboardStock ?? 0,
    bodega: p.warehouseStock ?? 0,
  };
}

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

/** Recargo por cambiar el licor de un cóctel (pedido del cliente, 9-nov-2026). */
export const LIQUOR_SWAP_SURCHARGE = 3;
const SWAPPABLE = ["licor", "gaseosa"];

/**
 * Cóctel con cambio (9-nov-2026): «Cuba Libre con Coca-Cola Zero» o «con
 * Abuelo en vez de Bacardí». Se cambia el insumo por otro de su misma
 * categoría y medida; el stock sale del que de verdad se sirvió. Cambiar la
 * gaseosa no cuesta; cambiar el licor suma el recargo, una vez por bebida.
 */
export async function swapIngredients(applied: IAppliedIngredient[], swaps: unknown) {
  const pairs = (Array.isArray(swaps) ? swaps : [])
    .map((s) => ({ from: String(s?.from ?? ""), to: String(s?.to ?? "") }))
    .filter((s) => s.from !== s.to);
  if (!pairs.length) return { applied, surcharge: 0, note: "" };
  const ids = pairs.flatMap((s) => [s.from, s.to]);
  if (!ids.every((id) => Types.ObjectId.isValid(id))) throw badRequest("Cambio de ingrediente inválido");
  const products = await Product.find({ _id: { $in: ids } }).select("name kind category stockUnit costPerUnit active");
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  let liquor = false;
  const names: string[] = [];
  const next = [...applied];
  for (const swap of pairs) {
    const index = next.findIndex((a) => a.product.toString() === swap.from);
    const from = byId.get(swap.from);
    const to = byId.get(swap.to);
    if (index < 0 || !from) throw badRequest("Ese ingrediente ya no está en la receta: actualiza la carta");
    if (
      !to ||
      !to.active ||
      to.kind !== "fisico" ||
      !SWAPPABLE.includes(from.category) ||
      to.category !== from.category ||
      to.stockUnit !== from.stockUnit
    ) {
      throw badRequest(`${from.name} no se puede cambiar por ese producto`);
    }
    if (from.category === "licor") liquor = true;
    names.push(to.name.replace(/\s*\(botella\)\s*$/i, ""));
    next[index] = { ...next[index]!, product: to._id, name: to.name, unitCost: to.costPerUnit ?? 0 };
  }
  return { applied: next, surcharge: liquor ? LIQUOR_SWAP_SURCHARGE : 0, note: ` (con ${names.join(", ")})` };
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

/** Costo promedio ponderado por unidad base al recibir mercadería. */
export async function updateCost(productId: string, qty: number, costPerUnit: number, session: ClientSession) {
  if (!(costPerUnit > 0) || !(qty > 0)) return;
  const product = await Product.findById(productId)
    .select("warehouseStock quitoStock puertoStock onboardStock costPerUnit")
    .session(session);
  if (!product) return;
  const onHand = Math.max(0, product.warehouseStock + product.quitoStock + product.puertoStock + product.onboardStock);
  const next =
    product.costPerUnit > 0 && onHand > 0
      ? (onHand * product.costPerUnit + qty * costPerUnit) / (onHand + qty)
      : costPerUnit;
  await Product.updateOne(
    { _id: productId },
    { $set: { costPerUnit: Math.round(next * 1e6) / 1e6, costUpdatedAt: new Date() } },
    { session },
  );
}
