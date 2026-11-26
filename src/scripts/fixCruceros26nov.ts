/**
 * Corrige dos datos de cruceros reportados por Gerencia (24-nov-2026):
 * - C-003 quedó guardado del 14 al 21 de noviembre; un crucero C dura 6 días → fin el 20.
 * - B-002 se creó (24-nov 10:38, antes de corregir la numeración) aunque ya existía B-005 → B-006.
 * Solo toca esos dos cruceros y solo si siguen como estaban. Uso:
 *   MONGODB_URI=... npx ts-node --transpile-only src/scripts/fixCruceros26nov.ts
 */
import mongoose from "mongoose";
import { Cruise } from "../models/cruise.model";

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
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
