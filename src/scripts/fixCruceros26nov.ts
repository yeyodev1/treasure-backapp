/**
 * Corrige dos datos de cruceros reportados por Gerencia (24-nov-2026):
 * - C-003 quedó guardado del 14 al 21 de noviembre; un crucero C dura 6 días → fin el 20.
 * - B-002 se creó (24-nov 10:38, antes de corregir la numeración) aunque ya existía B-005 → B-006.
 * Y de la especificación Bar-stock (sección 8): se elimina el rol Bodega (su usuario queda
 * inactivo, no se borra) y se descarta el conteo CT-002 en borrador desde el 4-nov.
 * Solo toca esos dos cruceros y solo si siguen como estaban. Uso:
 *   MONGODB_URI=... npx ts-node --transpile-only src/scripts/fixCruceros26nov.ts
 */
import mongoose from "mongoose";
import { Cruise } from "../models/cruise.model";
import { User } from "../models/user.model";
import { StockCount } from "../models/stockCount.model";

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);

  const c003 = await Cruise.updateOne(
    { code: "C-003", endDate: new Date("2026-11-21T16:00:00.000Z") },
    { $set: { endDate: new Date("2026-11-20T16:00:00.000Z") } },
  );
  console.log(`C-003 fin 21 → 20 nov: ${c003.modifiedCount ? "corregido" : "sin cambios (ya estaba bien)"}`);

  const b002 = await Cruise.findOne({ code: "B-002", startDate: new Date("2026-11-24T16:00:00.000Z") });
  if (b002 && !(await Cruise.exists({ code: "B-006" }))) {
    b002.code = "B-006";
    b002.name = b002.name.replace(/^B-002/, "B-006");
    await b002.save();
    console.log("B-002 → B-006: renombrado");
  } else {
    console.log("B-002 → B-006: sin cambios (no está o B-006 ya existe)");
  }
  const bodega = await User.updateMany({ role: "bodega", active: true }, { $set: { active: false } });
  console.log(`Usuarios con rol Bodega desactivados: ${bodega.modifiedCount}`);
  const ct002 = await StockCount.updateOne({ code: "CT-002", status: "borrador" }, { $set: { status: "rechazado", reviewNote: "Descartado (Bar-stock: se elimina Inventario)" } });
  console.log(`CT-002 en borrador: ${ct002.modifiedCount ? "descartado" : "sin cambios"}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
