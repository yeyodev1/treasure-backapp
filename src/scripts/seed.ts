import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { Product, ProductCategory } from "../models/product.model";
import { Cruise } from "../models/cruise.model";

/**
 * Seed con la carta real del "Menu_Treasure" (Taller de Tinta, ago-2026):
 * vinos, licores por trago y botella, cervezas, bebidas sin alcohol y los
 * cócteles de la carta con precio fijo de menú. Los licores de los cócteles
 * se descuentan del inventario por la receta (1 trago del destilado base).
 */

interface SeedProduct {
  name: string;
  category: ProductCategory;
  icon: string;
  price: number;
  unit: string;
}

const WINES: SeedProduct[] = [
  // Rosé
  { name: "Rosé D'Anjou (botella)", category: "vino", icon: "wine", price: 45.99, unit: "botella" },
  { name: "Rosé Cotes de Provence (botella)", category: "vino", icon: "wine", price: 50.0, unit: "botella" },
  // Sparkling
  { name: "VDV Ice Rosé (botella)", category: "vino", icon: "bottle", price: 67.5, unit: "botella" },
  { name: "VDV Ice (botella)", category: "vino", icon: "bottle", price: 46.99, unit: "botella" },
  { name: "Calvet Celebration Brut (botella)", category: "vino", icon: "bottle", price: 45.5, unit: "botella" },
  { name: "Calvet Celebration Brut Rosé (botella)", category: "vino", icon: "bottle", price: 44.5, unit: "botella" },
  { name: "Demi Sec Concha y Toro (botella)", category: "vino", icon: "bottle", price: 43.5, unit: "botella" },
  { name: "Blue Nun 24k (botella)", category: "vino", icon: "bottle", price: 46.55, unit: "botella" },
  { name: "Brut Reserva Vilarnau (botella)", category: "vino", icon: "bottle", price: 45.99, unit: "botella" },
  { name: "Demi Sec Vilarnau (botella)", category: "vino", icon: "bottle", price: 42.5, unit: "botella" },
  // White
  { name: "Sauvignon Blanc Casillero (botella)", category: "vino", icon: "wine", price: 52.5, unit: "botella" },
  { name: "Chardonnay Casillero (botella)", category: "vino", icon: "wine", price: 52.5, unit: "botella" },
  { name: "Blanco de Blancas (botella)", category: "vino", icon: "wine", price: 45.5, unit: "botella" },
  { name: "Reservado Sauvignon (copa)", category: "vino", icon: "wine", price: 8.0, unit: "copa" },
  { name: "Reservado Sauvignon (botella)", category: "vino", icon: "wine", price: 38.5, unit: "botella" },
  // Red
  { name: "Faustino V Reserva (botella)", category: "vino", icon: "wine", price: 67.5, unit: "botella" },
  { name: "Malbec Piel de Lobo (botella)", category: "vino", icon: "wine", price: 46.99, unit: "botella" },
  { name: "Merlot Casillero (botella)", category: "vino", icon: "wine", price: 45.5, unit: "botella" },
  { name: "Carmenere Casillero (botella)", category: "vino", icon: "wine", price: 44.5, unit: "botella" },
  { name: "Malbec Casillero (botella)", category: "vino", icon: "wine", price: 43.5, unit: "botella" },
  { name: "Pinot Noir Casillero (botella)", category: "vino", icon: "wine", price: 46.55, unit: "botella" },
  { name: "Syrah Casillero (botella)", category: "vino", icon: "wine", price: 45.99, unit: "botella" },
  { name: "Cabernet Sauvignon Casillero (botella)", category: "vino", icon: "wine", price: 42.5, unit: "botella" },
  { name: "Reservado Cabernet Sauvignon (copa)", category: "vino", icon: "wine", price: 8.0, unit: "copa" },
  { name: "Reservado Cabernet Sauvignon (botella)", category: "vino", icon: "wine", price: 38.5, unit: "botella" },
  { name: "Reservado Merlot (copa)", category: "vino", icon: "wine", price: 8.0, unit: "copa" },
  { name: "Reservado Merlot (botella)", category: "vino", icon: "wine", price: 38.5, unit: "botella" },
  // Minis
  { name: "Calvet Sauvignon Blanc mini 187ml", category: "vino", icon: "bottle", price: 10.99, unit: "botella" },
  { name: "Adobe Reserva Chardonnay mini 375ml", category: "vino", icon: "bottle", price: 12.5, unit: "botella" },
  { name: "Cabernet Sauvignon mini 375ml", category: "vino", icon: "bottle", price: 21.99, unit: "botella" },
  { name: "Calvet Merlot mini 187ml", category: "vino", icon: "bottle", price: 10.99, unit: "botella" },
  { name: "Adobe Reserva Carmenere mini 375ml", category: "vino", icon: "bottle", price: 12.5, unit: "botella" },
  { name: "VDV Ice mini 200ml", category: "vino", icon: "bottle", price: 12.5, unit: "botella" },
  { name: "VDV Ice Rosé mini 200ml", category: "vino", icon: "bottle", price: 12.5, unit: "botella" },
  { name: "Henkell Trocken Dry Piccolo 200ml", category: "vino", icon: "bottle", price: 16.5, unit: "botella" },
  { name: "Henkell Trocken Dry 375ml", category: "vino", icon: "bottle", price: 24.99, unit: "botella" },
  { name: "Adobe Reserva Rosé mini 375ml", category: "vino", icon: "bottle", price: 12.5, unit: "botella" },
];

/** Destilados: [nombre, precio trago, precio botella]. */
const SPIRITS: Array<[string, number, number]> = [
  ["Johnnie Walker Azul", 40.0, 460.0],
  ["Johnnie Walker Verde 15 años", 18.0, 250.0],
  ["Johnnie Walker Negro 12 años", 14.0, 135.0],
  ["Buchanan's 12 años", 13.0, 110.0],
  ["Jack Daniel's", 12.0, 100.0],
  ["Evan Williams", 10.5, 90.5],
  ["Johnnie Walker Rojo", 9.0, 65.0],
  ["Havana Club 7 años", 15.0, 75.0],
  ["Bacardi", 10.0, 70.0],
  ["San Miguel", 8.0, 50.0],
  ["Absolut", 11.5, 65.0],
  ["SKY", 10.0, 50.0],
  ["Smirnoff", 8.5, 45.0],
  ["Bombay Sapphire", 12.5, 95.0],
  ["Hendrick's", 12.0, 85.0],
  ["Tanqueray", 10.0, 65.0],
  ["Don Julio Reposado", 15.0, 240.5],
  ["Don Julio Blanco", 13.5, 215.5],
  ["Jose Cuervo", 10.5, 85.0],
  ["El Charro", 8.0, 65.0],
];

/** Digestivos y aperitivos: solo por trago. */
const DIGESTIFS: Array<[string, number]> = [
  ["Cointreau", 10.5],
  ["Cognac Hennessy", 13.75],
  ["Cinzano Rosso", 8.25],
  ["Gancia Rosso", 10.25],
];

const BEERS: SeedProduct[] = [
  { name: "Club", category: "cerveza", icon: "beer", price: 6.75, unit: "botella" },
  { name: "Pilsener", category: "cerveza", icon: "beer", price: 6.55, unit: "botella" },
  { name: "Stella Artois", category: "cerveza", icon: "beer", price: 9.5, unit: "botella" },
  { name: "Corona", category: "cerveza", icon: "beer", price: 9.0, unit: "botella" },
];

const SOFTS: SeedProduct[] = [
  { name: "Ginger Beer", category: "gaseosa", icon: "soda", price: 6.5, unit: "unidad" },
  { name: "Ginger Ale", category: "gaseosa", icon: "soda", price: 6.5, unit: "unidad" },
  { name: "Agua tónica", category: "gaseosa", icon: "soda", price: 6.5, unit: "unidad" },
  { name: "Coca Cola Zero", category: "gaseosa", icon: "soda", price: 6.75, unit: "unidad" },
  { name: "Gaseosas (Coca Cola, Fanta, Sprite, Inca Cola, Fioravanti)", category: "gaseosa", icon: "soda", price: 6.5, unit: "unidad" },
  { name: "Agua con gas Güitig", category: "agua", icon: "water", price: 6.5, unit: "botella" },
];

const OTHERS: SeedProduct[] = [
  { name: "Corkage Fee (descorche)", category: "otro", icon: "bottle", price: 35.0, unit: "servicio" },
];

/** Cócteles de la carta: precio fijo de menú + receta hacia el trago base. */
const COCKTAILS: Array<{ name: string; price: number; base: string[] }> = [
  { name: "Classic Margarita", price: 14.5, base: ["El Charro (trago)", "Cointreau (trago)"] },
  { name: "Tequila Sunrise", price: 14.5, base: ["El Charro (trago)"] },
  { name: "Mojito", price: 13.5, base: ["Bacardi (trago)"] },
  { name: "Cuba Libre", price: 13.5, base: ["Bacardi (trago)", "Gaseosas (Coca Cola, Fanta, Sprite, Inca Cola, Fioravanti)"] },
  { name: "Piña Colada", price: 13.0, base: ["Bacardi (trago)"] },
  { name: "Daiquiri", price: 13.0, base: ["Bacardi (trago)"] },
  { name: "Gin Tonic", price: 14.5, base: ["Tanqueray (trago)", "Agua tónica"] },
  { name: "Martini", price: 14.5, base: ["Tanqueray (trago)"] },
  { name: "Negroni", price: 15.5, base: ["Tanqueray (trago)", "Cinzano Rosso (trago)"] },
  { name: "Moscow Mule", price: 15.5, base: ["SKY (trago)", "Ginger Beer"] },
  { name: "Vodka Tonic", price: 13.5, base: ["SKY (trago)", "Agua tónica"] },
  { name: "Cosmopolitan", price: 16.5, base: ["SKY (trago)", "Cointreau (trago)"] },
  { name: "Manhattan", price: 16.5, base: ["Evan Williams (trago)", "Cinzano Rosso (trago)"] },
  { name: "Old Fashioned", price: 16.5, base: ["Evan Williams (trago)"] },
  { name: "Caipirinha", price: 10.0, base: [] },
  { name: "Pisco Sour", price: 12.5, base: [] },
  { name: "Baileys", price: 10.0, base: [] },
];

async function upsertProduct(p: SeedProduct) {
  await Product.updateOne(
    { name: p.name },
    { $setOnInsert: { ...p, warehouseStock: 0, active: true } },
    { upsert: true },
  );
}

async function seed() {
  await dbConnect();
  console.log("[seed] conectado a", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const password = await bcrypt.hash("treasure2026", 10);
  const users = [
    { name: "Paula Terán", email: "admin@treasure.ec", role: "admin" },
    { name: "Kerly (Dirección)", email: "direccion@treasure.ec", role: "direccion" },
    { name: "Bartender", email: "bar@treasure.ec", role: "bartender" },
    { name: "Bodega", email: "bodega@treasure.ec", role: "bodega" },
  ] as const;

  for (const u of users) {
    await User.updateOne(
      { email: u.email },
      { $setOnInsert: { ...u, passwordHash: password, active: true } },
      { upsert: true },
    );
  }
  console.log("[seed] usuarios listos (clave: treasure2026)");

  for (const wine of WINES) await upsertProduct(wine);
  for (const beer of BEERS) await upsertProduct(beer);
  for (const soft of SOFTS) await upsertProduct(soft);
  for (const other of OTHERS) await upsertProduct(other);

  for (const [name, shotPrice, bottlePrice] of SPIRITS) {
    await upsertProduct({ name: `${name} (trago)`, category: "licor", icon: "shot", price: shotPrice, unit: "trago" });
    await upsertProduct({ name: `${name} (botella)`, category: "licor", icon: "bottle", price: bottlePrice, unit: "botella" });
  }
  for (const [name, price] of DIGESTIFS) {
    await upsertProduct({ name: `${name} (trago)`, category: "licor", icon: "shot", price, unit: "trago" });
  }
  console.log("[seed] carta de vinos, licores, cervezas y softs lista");

  for (const cocktail of COCKTAILS) {
    const recipe = [];
    for (const baseName of cocktail.base) {
      const ingredient = await Product.findOne({ name: baseName }).select("_id");
      if (ingredient) recipe.push({ product: ingredient._id, qty: 1 });
    }
    await Product.updateOne(
      { name: cocktail.name },
      {
        $setOnInsert: {
          name: cocktail.name,
          category: "coctel",
          icon: "cocktail",
          price: cocktail.price,
          unit: "vaso",
          isCocktail: true,
          recipe,
          warehouseStock: 0,
          active: true,
        },
      },
      { upsert: true },
    );
  }
  console.log("[seed] cócteles de la carta listos");

  const existingCruise = await Cruise.findOne({ status: { $ne: "cerrado" } });
  if (!existingCruise) {
    await Cruise.create({
      name: "Crucero 28-oct",
      startDate: new Date("2026-10-28T06:00:00-05:00"),
      status: "planificado",
      cabins: Array.from({ length: 9 }, (_, i) => ({ number: i + 1 })),
      notes: "Primer crucero con el sistema",
    });
    console.log("[seed] crucero del 28-oct creado (9 cabinas)");
  }

  await mongoose.disconnect();
  console.log("[seed] listo");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
