import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { CycleSettings, DEFAULT_LEGS } from "../models/cycleSettings.model";
import { syncCatalogV3 } from "./catalog-v3";

/**
 * Seed para una base nueva: usuarios por rol, catálogo v3 (carta real con
 * medidas en ml) y el ciclo de salidas A → B → C. No crea salidas: se
 * generan desde la app (Salidas → Programar ciclo).
 */
async function seed() {
  await dbConnect();
  console.log("[seed] conectado a", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const password = await bcrypt.hash("treasure2026", 10);
  const users = [
    // Nombres neutros, sin personas ni género (checklist 29-oct, P16).
    { name: "Gerencia", email: "admin@treasure.ec", role: "duena", isCashier: false },
    { name: "Administración", email: "administradora@treasure.ec", role: "admin", isCashier: false },
    { name: "Dirección de crucero", email: "direccion@treasure.ec", role: "direccion", isCashier: false },
    { name: "Bar", email: "bar@treasure.ec", role: "bartender", isCashier: false },
    { name: "Bodega", email: "bodega@treasure.ec", role: "bodega", isCashier: false },
  ] as const;

  for (const u of users) {
    await User.updateOne(
      { email: u.email },
      { $setOnInsert: { ...u, passwordHash: password, active: true } },
      { upsert: true },
    );
  }
  console.log("[seed] usuarios listos (clave: treasure2026)");

  const admin = await User.findOne({ email: "admin@treasure.ec" });
  const ids = await syncCatalogV3(admin!._id);
  console.log(`[seed] catálogo v3 listo: ${ids.size} productos`);

  if (!(await CycleSettings.findOne({ key: "main" }))) {
    await CycleSettings.create({ key: "main", legs: DEFAULT_LEGS, cabinCount: 9 });
  }

  const db = mongoose.connection.db!;
  await db
    .collection("migrations")
    .updateOne({ key: "v3" }, { $setOnInsert: { key: "v3", at: new Date() } }, { upsert: true });

  await mongoose.disconnect();
  console.log("[seed] listo");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
