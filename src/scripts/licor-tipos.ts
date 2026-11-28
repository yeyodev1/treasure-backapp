import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Product } from "../models/product.model";

/**
 * Pedido de Felipe (28-nov-2026): en el conteo del bar se especifica el tipo
 * de licor. El Charro, Bacardi y Jose Cuervo se cuentan por tipo y suman a la
 * misma botella (la carta, el precio y Contífico no cambian). Johnnie Walker
 * toma los nombres que usa el bar (Black Label, Red Label…). Los consumos ya
 * registrados conservan el nombre con que se guardaron. Idempotente.
 *
 *   npx ts-node-dev --transpile-only src/scripts/licor-tipos.ts          (vista previa)
 *   npx ts-node-dev --transpile-only src/scripts/licor-tipos.ts --apply
 */
const VARIANTS: Record<string, string[]> = {
  "El Charro (botella)": ["Silver", "Gold", "Reposado"],
  "Bacardi (botella)": ["Blanco", "Gold"],
  "Jose Cuervo (botella)": ["Silver", "Gold", "Reposado"],
};
const RENAMES: Array<[string, string]> = [
  ["Johnnie Walker Negro 12 años", "Johnnie Walker Black Label 12 años"],
  ["Johnnie Walker Rojo", "Johnnie Walker Red Label"],
  ["Johnnie Walker Verde 15 años", "Johnnie Walker Green Label 15 años"],
  ["Johnnie Walker Azul", "Johnnie Walker Blue Label"],
];

async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  console.log("[licor-tipos] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  for (const [name, variants] of Object.entries(VARIANTS)) {
    const p = await Product.findOne({ name }).select("name variants");
    if (!p) console.log(`[licor-tipos] NO existe "${name}": revisar el nombre`);
    else if (p.variants.join() === variants.join()) console.log(`[licor-tipos] ya tiene tipos: ${name}`);
    else {
      console.log(`[licor-tipos] ${name} → ${variants.join(" / ")}`);
      if (apply) await Product.updateOne({ _id: p._id }, { $set: { variants } });
    }
  }
  for (const [from, to] of RENAMES) {
    for (const suffix of [" (botella)", " (trago)"]) {
      const p = await Product.findOne({ name: from + suffix }).select("name");
      if (!p) {
        console.log(`[licor-tipos] ${(await Product.exists({ name: to + suffix })) ? "ya renombrado" : "NO existe"}: ${from + suffix}`);
        continue;
      }
      console.log(`[licor-tipos] ${from + suffix} → ${to + suffix}`);
      if (apply) await Product.updateOne({ _id: p._id }, { $set: { name: to + suffix } });
    }
  }
  if (!apply) console.log("[licor-tipos] vista previa: agrega --apply para guardar");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
