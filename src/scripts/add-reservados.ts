/**
 * Agrega Reservado Carménère y Reservado Malbec (botella + copa) sin tocar el
 * resto del catálogo (pedido del cliente, 7-nov-2026). Si ya existen, no hace nada.
 *
 *   vercel env run -e production -- npx ts-node --transpile-only src/scripts/add-reservados.ts
 */
import mongoose from "mongoose";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { wineStyleOf } from "../utils/wineStyle";

const WINES: Array<[string, number, number]> = [
  ["Reservado Carménère", 38.5, 8.0],
  ["Reservado Malbec", 38.5, 8.0],
];
// Igual que catalog-v3.
const BOTTLE_ML = 750;
const GLASS_ML = 150;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const owner = await User.findOne({ role: "duena", active: true }).sort({ createdAt: 1 });
  if (!owner) throw new Error("No hay usuario Gerencia para registrar el alta");
  const at = new Date();

  for (const [name, bottlePrice, glassPrice] of WINES) {
    const wineStyle = wineStyleOf(name);
    let bottle = await Product.findOne({ name: `${name} (botella)` });
    if (bottle) console.log(`Ya existe: ${bottle.name}`);
    else {
      bottle = await Product.create({
        name: `${name} (botella)`,
        category: "vino",
        icon: "wine",
        kind: "fisico",
        sellable: true,
        stockUnit: "ml",
        containerSize: BOTTLE_ML,
        containerLabel: "botella",
        servingSize: GLASS_ML,
        servingPrice: glassPrice,
        recipe: [],
        wineStyle,
        active: true,
        price: bottlePrice,
        warehouseStock: 0,
        onboardStock: 0,
        createdBy: owner._id,
        priceHistory: [{ price: bottlePrice, changedBy: owner._id, at }],
      });
      console.log(`Creado: ${bottle.name} $${bottlePrice}`);
    }

    const glass = await Product.findOne({ name: `${name} (copa)` });
    if (glass) console.log(`Ya existe: ${glass.name}`);
    else {
      await Product.create({
        name: `${name} (copa)`,
        category: "vino",
        icon: "wine",
        kind: "receta",
        sellable: true,
        recipe: [{ product: bottle._id, qty: GLASS_ML }],
        stockUnit: "unidad",
        containerSize: 1,
        containerLabel: "unidad",
        warehouseStock: 0,
        onboardStock: 0,
        wineStyle,
        active: true,
        price: glassPrice,
        createdBy: owner._id,
        priceHistory: [{ price: glassPrice, changedBy: owner._id, at }],
      });
      console.log(`Creado: ${name} (copa) $${glassPrice}`);
    }
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
