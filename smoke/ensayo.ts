/**
 * Ensayo local con stock ficticio (guía auditada: "probar primero en ensayo,
 * no con ventas reales"). Levanta un Mongo en memoria con réplica (las
 * transacciones lo exigen), siembra usuarios, carta v3 y una salida con
 * pasajeros y stock, y deja la URI lista:
 *
 *   ENSAYO_PORT=27318 npx ts-node-dev --transpile-only smoke/ensayo.ts
 *   MONGODB_URI=<uri impresa> PORT=8300 npm run dev
 *
 * Usuarios (clave treasure2026): admin@ (Gerencia), administradora@, direccion@,
 * bar@, bodega@ — todos @treasure.ec.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

async function main() {
  const port = Number(process.env.ENSAYO_PORT || 27318);
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ port }],
  });
  const uri = repl.getUri("treasure");
  await mongoose.connect(uri);
  const { User } = await import("../src/models/user.model");
  const { Product } = await import("../src/models/product.model");
  const { Cruise } = await import("../src/models/cruise.model");
  const { CycleSettings, DEFAULT_LEGS } = await import("../src/models/cycleSettings.model");
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const passwordHash = await bcrypt.hash("treasure2026", 10);
  const users = [
    // Nombres neutros, sin personas ni género (checklist 29-oct, P16).
    ["Gerencia", "admin@treasure.ec", "duena"],
    ["Administración", "administradora@treasure.ec", "admin"],
    ["Dirección de crucero", "direccion@treasure.ec", "direccion"],
    ["Bar", "bar@treasure.ec", "bartender"],
    ["Bodega", "bodega@treasure.ec", "bodega"],
  ];
  for (const [name, email, role] of users) {
    await User.create({ name, email, role, passwordHash, active: true });
  }
  const owner = await User.findOne({ role: "duena" });
  await syncCatalogV3(owner!._id);
  await CycleSettings.create({ key: "main", legs: DEFAULT_LEGS, cabinCount: 9 });

  // Stock ficticio: 6 envases en bodega y 3 a bordo de cada físico, con costo.
  const physical = await Product.find({ kind: "fisico" });
  for (const p of physical) {
    const size = p.containerSize || 1;
    p.warehouseStock = 6 * size;
    p.onboardStock = 3 * size;
    p.costPerUnit = p.price > 0 ? Math.round((p.price * 0.3 / size) * 1e6) / 1e6 : 0.01;
    await p.save();
  }

  await Cruise.create({
    code: "A-901",
    leg: "A",
    name: "Ensayo Baltra → San Cristóbal",
    routeFrom: "Baltra",
    routeTo: "San Cristóbal",
    startDate: new Date(),
    status: "planificado",
    cabins: Array.from({ length: 9 }, (_, i) => ({
      number: i + 1,
      capacity: 2,
      passengers:
        i < 6
          ? [
              { name: `Pasajero ${i + 1}A`, isPayer: true, idNumber: `P${i + 1}00A`, country: "USA" },
              ...(i % 2 ? [{ name: `Pasajero ${i + 1}B`, isPayer: false, country: "USA" }] : []),
            ]
          : [],
      guestName: i < 6 ? `Pasajero ${i + 1}A` : "",
    })),
  });

  console.log(`ENSAYO_READY ${uri}`);
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
