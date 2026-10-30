import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { AuditEvent } from "../models/auditEvent.model";
import { StockMovement } from "../models/stockMovement.model";
import { moveStock } from "../services/inventory.service";
import { round2, StockLocation } from "../utils/units";
import { TEST_LOAD_DOCUMENT, TEST_LOAD_KEY } from "./load-test-inventory";

/**
 * Revierte la carga de inventario para pruebas (load-test-inventory.ts) antes
 * del conteo real. Solo mira los movimientos con documento
 * CARGA-PRUEBAS-30OCT: resta exactamente lo que se cargó en cada ubicación
 * con un "ajuste" de contrapartida; ningún otro movimiento se toca.
 *
 * Si las pruebas ya consumieron parte de la carga, restarla completa dejaría
 * ese stock bajo cero: la vista previa lo dice y no se aplica salvo con
 * `--tope-cero`, que resta solo hasta dejarlo en cero. Idempotente.
 *
 *   npx ts-node-dev --transpile-only src/scripts/revert-test-inventory.ts          (vista previa)
 *   npx ts-node-dev --transpile-only src/scripts/revert-test-inventory.ts --apply
 *   npx ts-node-dev --transpile-only src/scripts/revert-test-inventory.ts --apply --tope-cero
 */

const REVERT_DOCUMENT = `${TEST_LOAD_DOCUMENT}-REVERSO`;
const REVERT_REASON = "Reverso de la carga inicial para pruebas (30-oct)";

async function main() {
  const apply = process.argv.includes("--apply");
  const capAtZero = process.argv.includes("--tope-cero");
  await dbConnect();
  const db = mongoose.connection.db!;
  console.log("[reverso-pruebas] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  if (await StockMovement.exists({ document: REVERT_DOCUMENT })) {
    console.log("[reverso-pruebas] ya revertida; no se repite");
    await mongoose.disconnect();
    return;
  }

  // Lo cargado por producto y ubicación (suma de los movimientos de la carga).
  const loaded = await StockMovement.aggregate<{
    _id: { product: mongoose.Types.ObjectId; location: StockLocation };
    qty: number;
  }>([
    { $match: { document: TEST_LOAD_DOCUMENT } },
    { $group: { _id: { product: "$product", location: "$location" }, qty: { $sum: "$qty" } } },
  ]);
  if (!loaded.length) {
    console.log(`[reverso-pruebas] no hay movimientos ${TEST_LOAD_DOCUMENT}: nada que revertir`);
    await mongoose.disconnect();
    return;
  }

  const products = await Product.find({ _id: { $in: loaded.map((l) => l._id.product) } }).select(
    "name stockUnit onboardStock warehouseStock",
  );
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const lines = loaded
    .map((l) => {
      const p = byId.get(l._id.product.toString())!;
      const current = l._id.location === "abordo" ? p.onboardStock : p.warehouseStock;
      const qty = round2(capAtZero ? Math.min(l.qty, Math.max(0, current)) : l.qty);
      return { product: p, location: l._id.location, loaded: l.qty, current, qty };
    })
    .sort((a, b) => a.product.name.localeCompare(b.product.name) || a.location.localeCompare(b.location));

  for (const l of lines) {
    const after = round2(l.current - l.qty);
    const where = l.location === "abordo" ? "a bordo" : "bodega";
    const flag = after < 0 ? "  [quedaría bajo cero: ya se consumió parte]" : "";
    const cap = l.qty < l.loaded ? `  [tope cero: se restan ${l.qty} de ${l.loaded}]` : "";
    console.log(`  - ${l.product.name} (${where}): −${l.qty} ${l.product.stockUnit} → queda ${after}${flag}${cap}`);
  }

  const negative = lines.filter((l) => l.current - l.qty < -1e-9);
  const toRevert = lines.filter((l) => l.qty > 0);
  console.log(
    `\n[reverso-pruebas] movimientos de la carga: ${lines.length} · a revertir: ${toRevert.length}` +
      ` · quedarían bajo cero: ${negative.length}`,
  );

  if (!apply) {
    console.log("[reverso-pruebas] vista previa: agrega --apply para revertir");
    await mongoose.disconnect();
    return;
  }
  if (negative.length) {
    console.log(
      "[reverso-pruebas] no se aplica: hay stock que quedaría bajo cero. Anula los consumos de prueba o usa --tope-cero",
    );
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const owner =
    (await User.findOne({ email: "admin@treasure.ec" })) ?? (await User.findOne({ role: "duena" }));
  if (!owner) throw new Error("No hay usuario de Gerencia para firmar los movimientos");

  // Todo o nada; con guard ninguna resta deja el stock bajo cero.
  await mongoose.connection.transaction(async (session) => {
    for (const location of ["abordo", "bodega"] as const) {
      const deltas = new Map(
        toRevert.filter((l) => l.location === location).map((l) => [l.product._id.toString(), -l.qty]),
      );
      await moveStock({
        session,
        guard: true,
        type: "ajuste",
        location,
        deltas,
        userId: owner._id.toString(),
        reason: REVERT_REASON,
        document: REVERT_DOCUMENT,
      });
    }
    await db
      .collection("migrations")
      .updateOne({ key: TEST_LOAD_KEY }, { $set: { revertedAt: new Date(), revertedBy: owner._id } }, { session });
  });

  await AuditEvent.create({
    kind: "inventario",
    title: "Reverso de la carga para pruebas",
    detail: `${toRevert.length} movimientos (${REVERT_DOCUMENT}) · ${REVERT_REASON}`,
    by: owner._id,
    byName: `${owner.name} (script)`,
  });
  console.log(`[reverso-pruebas] revertida: ${toRevert.length} movimientos`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
