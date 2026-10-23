import { Types } from "mongoose";
import { IProduct, Product } from "../models/product.model";
import { MovementType, StockMovement } from "../models/stockMovement.model";
import { badRequest } from "../errors/httpError";
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
