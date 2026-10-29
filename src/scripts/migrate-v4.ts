import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { Cruise } from "../models/cruise.model";
import { Order } from "../models/order.model";
import { Product } from "../models/product.model";

/**
 * Migración v4 (guía auditada 27-oct-2026). Idempotente: se marca en
 * `migrations` y no se repite. Respaldar antes con backup.ts.
 *
 * - Paula (admin@treasure.ec) pasa a dueña; se crea la administradora.
 * - Cabinas con capacidad (2, o los pasajeros que ya tenga).
 * - Pedidos v3 marcados como flujo "pedido" (el bar nuevo usa "directo").
 * - Índices nuevos (salida en curso única, requerimientos, compras).
 *
 *   npx ts-node-dev --transpile-only src/scripts/migrate-v4.ts          (vista previa)
 *   npx ts-node-dev --transpile-only src/scripts/migrate-v4.ts --apply
 */
async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  const db = mongoose.connection.db!;
  console.log("[v4] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  if (await db.collection("migrations").findOne({ key: "v4" })) {
    console.log("[v4] ya aplicada");
    await mongoose.disconnect();
    return;
  }

  const paula = await User.findOne({ email: "admin@treasure.ec" });
  console.log(`[v4] Paula: ${paula?.name} (${paula?.role}) → duena`);
  const adminExists = await User.exists({ email: "administradora@treasure.ec" });
  console.log(`[v4] administradora@treasure.ec: ${adminExists ? "ya existe" : "se crea (clave treasure2026)"}`);

  const cruises = await Cruise.find({});
  const negatives = await Product.find({
    kind: "fisico",
    $or: [{ warehouseStock: { $lt: 0 } }, { onboardStock: { $lt: 0 } }],
  }).select("name warehouseStock onboardStock stockUnit");
  console.log(`[v4] salidas: ${cruises.length} · pedidos v3: ${await Order.countDocuments({ source: { $exists: false } })}`);
  console.log(
    `[v4] stock negativo (queda "No disponible" hasta el conteo): ${
      negatives.map((p) => `${p.name} ${p.onboardStock < 0 ? p.onboardStock : p.warehouseStock} ${p.stockUnit}`).join(", ") || "ninguno"
    }`,
  );

  if (!apply) {
    console.log("[v4] vista previa: agrega --apply para guardar");
    await mongoose.disconnect();
    return;
  }

  if (paula && paula.role !== "duena") {
    paula.role = "duena";
    await paula.save();
  }
  if (!adminExists) {
    await User.create({
      name: "Administradora",
      email: "administradora@treasure.ec",
      role: "admin",
      passwordHash: await bcrypt.hash("treasure2026", 10),
      active: true,
      createdBy: paula?._id ?? null,
    });
  }

  for (const cruise of cruises) {
    let changed = false;
    for (const cabin of cruise.cabins) {
      const raw = cabin as unknown as { capacity?: number };
      const capacity = Math.max(2, cabin.passengers.length);
      if (raw.capacity !== capacity && (!raw.capacity || raw.capacity < cabin.passengers.length)) {
        cabin.capacity = capacity;
        changed = true;
      }
    }
    if (changed) await cruise.save();
  }

  await Order.updateMany({ source: { $exists: false } }, { $set: { source: "pedido" } });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  await db.collection("migrations").insertOne({ key: "v4", at: new Date() });
  console.log("[v4] aplicada");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
