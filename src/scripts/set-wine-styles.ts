import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Product, WineStyle } from "../models/product.model";
import { wineStyleOf } from "../utils/wineStyle";

/**
 * Pedido del cliente (31-oct-2026): la carta del bar divide los vinos en
 * tinto, blanco, rosado y espumante. Asigna el tipo a los vinos que aún no
 * lo tienen (no pisa lo que se haya puesto a mano en Catálogo). Idempotente.
 *
 *   npx ts-node --transpile-only src/scripts/set-wine-styles.ts          (vista previa)
 *   npx ts-node --transpile-only src/scripts/set-wine-styles.ts --apply
 */
async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  console.log("[vinos] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const wines = await Product.find({ category: "vino" }).select("name wineStyle active").sort({ name: 1 });
  const pending: Array<{ id: mongoose.Types.ObjectId; name: string; style: WineStyle }> = [];
  const unknown: string[] = [];
  for (const w of wines) {
    if (w.wineStyle) continue;
    const style = wineStyleOf(w.name);
    if (style) pending.push({ id: w._id, name: w.name, style });
    else unknown.push(w.name);
  }
  for (const p of pending) console.log(`[vinos] ${p.style.padEnd(9)} ${p.name}`);
  if (unknown.length) console.log(`[vinos] sin reconocer (asignar en Catálogo): ${unknown.join(", ")}`);
  console.log(`[vinos] ${wines.length} vinos · por asignar ${pending.length} · sin reconocer ${unknown.length}`);

  if (apply && pending.length) {
    await Product.bulkWrite(
      pending.map((p) => ({ updateOne: { filter: { _id: p.id, wineStyle: { $in: ["", null] } }, update: { $set: { wineStyle: p.style } } } })),
    );
    console.log("[vinos] tipos asignados");
  } else if (pending.length) {
    console.log("[vinos] vista previa: agrega --apply para guardar");
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
