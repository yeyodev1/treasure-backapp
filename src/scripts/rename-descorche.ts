import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Product } from "../models/product.model";

/**
 * Checklist 29-oct, L12: en la app el servicio se llama "Descorche"; el
 * documento en inglés lo traduce a "Corkage fee". Solo cambia el nombre del
 * producto; los consumos ya registrados conservan el nombre con que se
 * guardaron. Idempotente. Respaldar antes con backup.ts.
 *
 *   npx ts-node-dev --transpile-only src/scripts/rename-descorche.ts          (vista previa)
 *   npx ts-node-dev --transpile-only src/scripts/rename-descorche.ts --apply
 */
async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  console.log("[descorche] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const legacy = await Product.find({ name: "Corkage Fee (descorche)" }).select("name price active");
  const already = await Product.exists({ name: "Descorche" });
  console.log(`[descorche] por renombrar: ${legacy.length} · ya existe "Descorche": ${already ? "sí" : "no"}`);
  if (legacy.length > 1 || (legacy.length && already)) {
    console.log("[descorche] hay más de un producto de descorche: revisar a mano, no se cambia nada");
  } else if (legacy.length && apply) {
    await Product.updateOne({ _id: legacy[0]!._id }, { $set: { name: "Descorche" } });
    console.log("[descorche] renombrado a Descorche");
  } else if (legacy.length) {
    console.log("[descorche] vista previa: agrega --apply para renombrar");
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
