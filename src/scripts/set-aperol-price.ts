/**
 * Precio único del Aperol (pedido de Diego, 19-nov-2026: "Aperol 15.50, todos").
 * Pone $15,50 a Aperol (trago), Aperol (botella) y Aperol Spritz, y deja el cambio en el
 * historial de precios, igual que Catálogo. Sin --apply solo muestra lo que haría.
 *
 *   vercel env run -e production -- npx ts-node --transpile-only src/scripts/set-aperol-price.ts [--apply]
 */
import mongoose from "mongoose";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";

const PRICE = 15.5;
const NAMES = ["Aperol (trago)", "Aperol (botella)", "Aperol Spritz"];
const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const owner = await User.findOne({ role: "duena", active: true }).sort({ createdAt: 1 });
  if (!owner) throw new Error("No hay usuario Gerencia para registrar el cambio");

  for (const name of NAMES) {
    const p = await Product.findOne({ name });
    if (!p) {
      console.log(`No existe: ${name}`);
      continue;
    }
    console.log(`${name}: $${p.price} → $${PRICE}${apply ? "" : " (simulación)"}`);
    if (!apply || p.price === PRICE) continue;
    const set: Record<string, number> = { price: PRICE };
    // La botella también guarda el precio del trago que se sirve de ella.
    if (p.kind === "fisico" && p.servingSize) set.servingPrice = PRICE;
    await Product.updateOne(
      { _id: p._id },
      { $set: set, $push: { priceHistory: { price: PRICE, changedBy: owner._id, at: new Date() } } },
    );
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
