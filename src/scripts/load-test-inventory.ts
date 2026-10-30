import mongoose, { Types } from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { IProduct, Product } from "../models/product.model";
import { User } from "../models/user.model";
import { AuditEvent } from "../models/auditEvent.model";
import { StockMovement } from "../models/stockMovement.model";
import { moveStock } from "../services/inventory.service";
import { round2, StockLocation } from "../utils/units";

/**
 * Carga de inventario para pruebas (pedido de Gerencia, 30-oct-2026): con el
 * stock en cero la carta sale "No disponible" y no se puede probar. Carga a
 * bordo y en bodega cada producto físico activo hasta una cantidad de prueba:
 *
 * - Licores y vinos (también los mini): 6 envases a bordo.
 * - Cervezas, gaseosas, aguas y demás envases por unidad: 48 a bordo.
 * - Insumos de coctelería: lo que piden ~40 cócteles con su medida más alta,
 *   redondeado a envases enteros.
 * - Bodega: el doble.
 *
 * Cada carga es un movimiento "ajuste" con motivo y documento propios, así la
 * bitácora cuadra y revert-test-inventory.ts la deshace sin tocar nada más.
 * Si un producto ya tiene esa cantidad o más, no se toca. Los costos no se
 * cambian: si faltan, el resumen lo sigue diciendo. Idempotente: se marca en
 * `migrations` y por documento; correrlo dos veces no duplica la carga.
 *
 *   npx ts-node-dev --transpile-only src/scripts/load-test-inventory.ts          (vista previa)
 *   npx ts-node-dev --transpile-only src/scripts/load-test-inventory.ts --apply
 */

export const TEST_LOAD_KEY = "test-inventory-30oct";
export const TEST_LOAD_DOCUMENT = "CARGA-PRUEBAS-30OCT";
export const TEST_LOAD_REASON = "Carga inicial para pruebas (30-oct)";

const BOTTLE_TARGET = 6;
const UNIT_TARGET = 48;
const COCKTAILS = 40;
const WAREHOUSE_FACTOR = 2;

type PhysicalDoc = IProduct & { _id: Types.ObjectId };

/** Medida más alta de cada insumo en las recetas activas (unidad base). */
async function maxRecipeUse(): Promise<Map<string, number>> {
  const recipes = await Product.find({ kind: "receta", active: true }).select("recipe");
  const max = new Map<string, number>();
  for (const r of recipes) {
    for (const ing of r.recipe) {
      const id = ing.product.toString();
      max.set(id, Math.max(max.get(id) ?? 0, ing.qty));
    }
  }
  return max;
}

/** Envases a bordo para la prueba según el tipo de producto. */
function onboardContainers(p: PhysicalDoc, maxUse: Map<string, number>): number {
  const size = p.containerSize || 1;
  if (p.category === "licor" || p.category === "vino") return BOTTLE_TARGET;
  if (p.category === "insumo") {
    const use = maxUse.get(p._id.toString());
    if (!use) return p.stockUnit === "ml" ? BOTTLE_TARGET : COCKTAILS;
    return Math.max(1, Math.ceil((use * COCKTAILS) / size));
  }
  // Cerveza, gaseosa, agua, jugo, snack…: por unidad o lata.
  return UNIT_TARGET;
}

interface PlanLine {
  product: PhysicalDoc;
  location: StockLocation;
  current: number;
  target: number;
  qty: number;
}

function fmt(p: PhysicalDoc, qty: number): string {
  const size = p.containerSize || 1;
  const containers = round2(qty / size);
  const unit = p.stockUnit === "unidad" ? "" : ` ${p.stockUnit}`;
  return size > 1 ? `${qty}${unit} (${containers} ${p.containerLabel})` : `${qty}${unit || " u."}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  const db = mongoose.connection.db!;
  console.log("[carga-pruebas] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const marker = await db.collection("migrations").findOne({ key: TEST_LOAD_KEY });
  const already = await StockMovement.countDocuments({ document: TEST_LOAD_DOCUMENT });
  if (marker || already) {
    console.log(
      `[carga-pruebas] ya aplicada${marker?.at ? ` el ${new Date(marker.at).toISOString()}` : ""} ` +
        `(${already} movimientos ${TEST_LOAD_DOCUMENT}${marker?.revertedAt ? ", revertida" : ""}); no se repite`,
    );
    await mongoose.disconnect();
    return;
  }

  const owner =
    (await User.findOne({ email: "admin@treasure.ec" })) ?? (await User.findOne({ role: "duena" }));
  if (!owner) throw new Error("No hay usuario de Gerencia para firmar los movimientos");

  const maxUse = await maxRecipeUse();
  const products = (await Product.find({ kind: "fisico", active: true }).sort({
    category: 1,
    name: 1,
  })) as unknown as PhysicalDoc[];

  const plan: PlanLine[] = [];
  for (const p of products) {
    const size = p.containerSize || 1;
    const onboardTarget = round2(onboardContainers(p, maxUse) * size);
    const targets: Array<[StockLocation, number, number]> = [
      ["abordo", onboardTarget, p.onboardStock ?? 0],
      ["bodega", round2(onboardTarget * WAREHOUSE_FACTOR), p.warehouseStock ?? 0],
    ];
    for (const [location, target, current] of targets) {
      plan.push({ product: p, location, current, target, qty: round2(Math.max(0, target - current)) });
    }
  }

  const toLoad = plan.filter((l) => l.qty > 0);
  let lastCategory = "";
  for (const p of products) {
    if (p.category !== lastCategory) {
      lastCategory = p.category;
      console.log(`\n  ${p.category.toUpperCase()}`);
    }
    const lines = plan.filter((l) => l.product._id.equals(p._id));
    const text = lines
      .map((l) => `${l.location === "abordo" ? "a bordo" : "bodega"} +${l.qty ? fmt(p, l.qty) : "0 (ya tiene)"}`)
      .join(" · ");
    console.log(`  - ${p.name}: ${text}${p.costPerUnit > 0 ? "" : "  [sin costo]"}`);
  }

  const missingCost = products.filter((p) => !(p.costPerUnit > 0)).length;
  console.log(
    `\n[carga-pruebas] productos físicos: ${products.length} · movimientos a crear: ${toLoad.length}` +
      ` · sin costo (se deja igual): ${missingCost}`,
  );
  console.log(`[carga-pruebas] motivo: "${TEST_LOAD_REASON}" · documento: ${TEST_LOAD_DOCUMENT} · firma: ${owner.email}`);

  if (!apply) {
    console.log("[carga-pruebas] vista previa: agrega --apply para cargar");
    await mongoose.disconnect();
    return;
  }

  // Todo o nada: una sola transacción con los movimientos y la marca.
  await mongoose.connection.transaction(async (session) => {
    for (const location of ["abordo", "bodega"] as const) {
      const deltas = new Map(
        toLoad.filter((l) => l.location === location).map((l) => [l.product._id.toString(), l.qty]),
      );
      await moveStock({
        session,
        guard: false,
        type: "ajuste",
        location,
        deltas,
        userId: owner._id.toString(),
        reason: TEST_LOAD_REASON,
        document: TEST_LOAD_DOCUMENT,
      });
    }
    await db
      .collection("migrations")
      .insertOne({ key: TEST_LOAD_KEY, at: new Date(), by: owner._id, movements: toLoad.length }, { session });
  });

  await AuditEvent.create({
    kind: "inventario",
    title: "Carga inicial para pruebas",
    detail: `${toLoad.length} movimientos (${TEST_LOAD_DOCUMENT}) en bodega y a bordo · ${TEST_LOAD_REASON}`,
    by: owner._id,
    byName: `${owner.name} (script)`,
  });
  console.log(`[carga-pruebas] aplicada: ${toLoad.length} movimientos`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
