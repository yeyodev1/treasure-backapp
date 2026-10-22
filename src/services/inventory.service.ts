import { Types } from "mongoose";
import { CruiseStock } from "../models/cruiseStock.model";
import { Product, IProduct } from "../models/product.model";
import { StockMovement, MovementType } from "../models/stockMovement.model";
import { badRequest } from "../errors/httpError";

interface ConsumeInput {
  cruiseId: Types.ObjectId | string;
  userId: string;
  orderId?: Types.ObjectId | string | null;
  type: MovementType;
  reason?: string;
  items: Array<{ productId: string; qty: number }>;
}

/**
 * Expande un ítem a sus componentes de inventario:
 * un cóctel descuenta sus ingredientes, un producto simple se descuenta a sí mismo.
 */
async function expandToComponents(productId: string, qty: number) {
  const product = await Product.findById(productId);
  if (!product) throw badRequest("Producto no encontrado");

  if (product.isCocktail && product.recipe.length > 0) {
    return product.recipe.map((ing) => ({
      productId: ing.product.toString(),
      qty: ing.qty * qty,
    }));
  }
  return [{ productId, qty }];
}

/** Descuenta stock del crucero y deja el movimiento en la bitácora. */
export async function consumeCruiseStock(input: ConsumeInput) {
  const components = new Map<string, number>();
  for (const item of input.items) {
    for (const comp of await expandToComponents(item.productId, item.qty)) {
      components.set(comp.productId, (components.get(comp.productId) ?? 0) + comp.qty);
    }
  }

  for (const [productId, qty] of components) {
    await CruiseStock.updateOne(
      { cruise: input.cruiseId, product: productId },
      { $inc: { currentQty: -qty }, $setOnInsert: { initialQty: 0 } },
      { upsert: true },
    );
    await StockMovement.create({
      type: input.type,
      product: productId,
      qty: -qty,
      cruise: input.cruiseId,
      order: input.orderId ?? null,
      reason: input.reason ?? "",
      user: input.userId,
    });
  }
}

/** Carga stock al crucero (inicio de viaje o reabastecimiento en puerto) descontando bodega. */
export async function loadCruiseStock(
  cruiseId: string,
  userId: string,
  items: Array<{ productId: string; qty: number }>,
  fromWarehouse: boolean,
) {
  for (const item of items) {
    if (item.qty <= 0) throw badRequest("Las cantidades de carga deben ser mayores a cero");

    await CruiseStock.updateOne(
      { cruise: cruiseId, product: item.productId },
      { $inc: { currentQty: item.qty, initialQty: item.qty } },
      { upsert: true },
    );
    if (fromWarehouse) {
      await Product.updateOne({ _id: item.productId }, { $inc: { warehouseStock: -item.qty } });
    }
    await StockMovement.create({
      type: "carga",
      product: item.productId,
      qty: item.qty,
      cruise: cruiseId,
      reason: fromWarehouse ? "Carga desde bodega" : "Carga directa",
      user: userId,
    });
  }
}

/** Precio automático de un cóctel: suma de sus ingredientes (acuerdo de reunión). */
export function cocktailPriceFromRecipe(
  recipe: Array<{ product: Pick<IProduct, "price">; qty: number }>,
) {
  const total = recipe.reduce((sum, ing) => sum + ing.product.price * ing.qty, 0);
  return Math.round(total * 100) / 100;
}
