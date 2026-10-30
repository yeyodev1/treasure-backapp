import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Cruise } from "../models/cruise.model";
import { isValidOptionalEmail } from "../utils/email";

/**
 * Checklist 29-oct, 17: el correo de un pasajero es opcional, pero si existe
 * debe tener forma nombre@dominio.ext. Los correos guardados antes de la
 * validación que no la cumplen se vacían (el resto del pasajero no cambia),
 * para que no bloqueen la edición de pasajeros ni lleguen a la factura o al
 * resumen por correo.
 *
 * Vista previa por defecto; --apply guarda. Idempotente: cada cambio se
 * aplica solo si el correo sigue siendo el mismo inválido.
 *
 *   npx ts-node --transpile-only src/scripts/clean-invalid-emails.ts           (vista previa)
 *   npx ts-node --transpile-only src/scripts/clean-invalid-emails.ts --apply
 */
async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  console.log("[correos] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  // Cruceros con al menos un pasajero con correo (se valida cada uno abajo).
  const cruises = await Cruise.find({
    cabins: { $elemMatch: { passengers: { $elemMatch: { email: { $nin: ["", null] } } } } },
  })
    .select("code name cabins")
    .lean();

  let found = 0;
  let cleaned = 0;
  for (const cruise of cruises) {
    for (const [ci, cabin] of cruise.cabins.entries()) {
      for (const [pi, passenger] of (cabin.passengers ?? []).entries()) {
        const email = passenger.email ?? "";
        if (!email || isValidOptionalEmail(email)) continue;
        found += 1;
        console.log(
          `[correos] ${cruise.code || cruise.name} · cabina ${cabin.number} · ${passenger.name || "(sin nombre)"}: "${email}" → vacío`,
        );
        if (!apply) continue;
        const path = `cabins.${ci}.passengers.${pi}.email`;
        const res = await Cruise.collection.updateOne(
          { _id: cruise._id, [path]: email },
          { $set: { [path]: "" } },
        );
        cleaned += res.modifiedCount;
      }
    }
  }

  if (!found) console.log("[correos] todos los correos de pasajeros son válidos");
  else if (apply) console.log(`[correos] ${cleaned} correo(s) vaciados`);
  else console.log(`[correos] ${found} correo(s) inválidos · vista previa: agrega --apply para vaciarlos`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
