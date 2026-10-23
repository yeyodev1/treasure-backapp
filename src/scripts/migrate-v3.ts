import mongoose, { Types } from "mongoose";
import { dbConnect } from "../config/mongo";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { CycleSettings, DEFAULT_LEGS } from "../models/cycleSettings.model";
import { syncCatalogV3 } from "./catalog-v3";

/**
 * Migración al modelo v3 (guía visual V3 + medidas por copa, 23-oct-2026).
 * Idempotente: deja una marca en `migrations` y no vuelve a correr.
 *
 * Nada se borra ni se corrige en silencio:
 * - El stock anterior (por unidad de venta) se convierte a unidad base (ml)
 *   y queda registrado como movimiento "migracion". Los negativos se
 *   conservan para que Paula los resuelva con un conteo físico.
 * - Los pedidos anteriores ya habían descontado stock: quedan como entregados.
 * - Los movimientos anteriores quedan marcados como `legacy`.
 */
type RawDoc = Record<string, any>;

async function migrate() {
  await dbConnect();
  const db = mongoose.connection.db!;
  const migrations = db.collection("migrations");

  if (await migrations.findOne({ key: "v3" })) {
    console.log("[v3] ya aplicada, nada que hacer");
    await mongoose.disconnect();
    return;
  }

  const admin = await User.findOne({ role: "admin" }).sort({ createdAt: 1 });
  if (!admin) throw new Error("No hay usuario administrador");
  const adminId = admin._id;

  // 1. Foto cruda del modelo anterior antes de tocar nada.
  const oldProducts: RawDoc[] = await db.collection("products").find().toArray();
  const oldCruiseStock: RawDoc[] = await db.collection("cruisestocks").find().toArray();
  const oldById = new Map(oldProducts.map((p) => [String(p._id), p]));

  // 2. Catálogo v3 (conserva _id y precio de lo existente).
  const ids = await syncCatalogV3(adminId);
  console.log(`[v3] catálogo sincronizado: ${ids.size} productos definidos`);

  // 3. Cócteles creados en el bar con el modelo anterior: su receta apuntaba a
  //    productos (tragos, latas). Se traduce a insumos físicos con medida.
  const newProducts = await Product.find();
  const newById = new Map(newProducts.map((p) => [p._id.toString(), p]));

  /** Insumos que consume 1 unidad de venta de un producto (ya en modelo v3). */
  function consumption(productId: string, qty: number, acc: Map<string, number>) {
    const p = newById.get(productId);
    if (!p) return;
    if (p.kind === "fisico") {
      acc.set(productId, (acc.get(productId) ?? 0) + qty * (p.containerSize || 1));
    } else if (p.kind === "receta") {
      for (const ing of p.recipe) {
        const ingId = ing.product.toString();
        acc.set(ingId, (acc.get(ingId) ?? 0) + ing.qty * qty);
      }
    }
  }

  const customs = oldProducts.filter((p) => p.isCustom && !ids.has(p.name));
  for (const old of customs) {
    const acc = new Map<string, number>();
    for (const item of (old.recipe ?? []) as RawDoc[]) {
      consumption(String(item.product), Number(item.qty) || 0, acc);
    }
    await Product.updateOne(
      { _id: old._id },
      {
        $set: {
          kind: "receta",
          sellable: true,
          stockUnit: "unidad",
          containerSize: 1,
          containerLabel: "unidad",
          warehouseStock: 0,
          onboardStock: 0,
          recipe: [...acc.entries()].map(([product, qty]) => ({
            product: new Types.ObjectId(product),
            qty: Math.round(qty * 100) / 100,
          })),
        },
      },
    );
  }
  console.log(`[v3] cócteles del bar convertidos: ${customs.length}`);

  // Cualquier otro producto viejo fuera de la carta se marca como físico unitario.
  const known = new Set([...ids.values()].map(String));
  for (const old of oldProducts) {
    const id = String(old._id);
    if (known.has(id) || customs.some((c) => String(c._id) === id)) continue;
    if (old.name === "Corkage Fee (descorche)") continue;
    await Product.updateOne(
      { _id: old._id, kind: { $exists: false } },
      { $set: { kind: "fisico", stockUnit: "unidad", containerSize: 1, containerLabel: "unidad" } },
    );
  }

  // 4. Stock: unidades de venta antiguas → unidad base de cada insumo.
  const refreshed = await Product.find();
  newById.clear();
  for (const p of refreshed) newById.set(p._id.toString(), p);

  const warehouse = new Map<string, number>();
  const onboard = new Map<string, number>();
  for (const old of oldProducts) {
    const qty = Number(old.warehouseStock) || 0;
    if (qty) consumption(String(old._id), qty, warehouse);
  }
  for (const row of oldCruiseStock) {
    const qty = Number(row.currentQty) || 0;
    if (qty) consumption(String(row.product), qty, onboard);
  }

  // Los stocks pasan a calcularse desde cero con lo convertido.
  await Product.updateMany({}, { $set: { warehouseStock: 0, onboardStock: 0 } });

  const movements = db.collection("stockmovements");
  await movements.updateMany({ legacy: { $ne: true } }, { $set: { legacy: true } });

  const now = new Date();
  const migrationMoves: RawDoc[] = [];
  for (const [location, map] of [
    ["bodega", warehouse],
    ["abordo", onboard],
  ] as const) {
    for (const [productId, qty] of map) {
      const rounded = Math.round(qty * 100) / 100;
      if (!rounded) continue;
      await Product.updateOne(
        { _id: productId },
        { $inc: { [location === "bodega" ? "warehouseStock" : "onboardStock"]: rounded } },
      );
      migrationMoves.push({
        type: "migracion",
        product: new Types.ObjectId(productId),
        location,
        qty: rounded,
        cruise: null,
        order: null,
        count: null,
        reason: "Saldo trasladado del modelo anterior (unidades de venta → unidad base)",
        supplier: "",
        document: "",
        unitCost: 0,
        legacy: false,
        user: adminId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  if (migrationMoves.length) await movements.insertMany(migrationMoves);
  console.log(`[v3] saldos convertidos: ${migrationMoves.length} movimientos`);

  // 5. Pedidos: lo anterior ya descontó stock, queda como entregado.
  const orders = db.collection("orders");
  const oldOrders: RawDoc[] = await orders.find().toArray();
  for (const order of oldOrders) {
    if (order.items?.[0]?.deliveredQty !== undefined) continue;
    const cancelled = order.status === "anulada";
    let total = 0;
    const items: RawDoc[] = (order.items as RawDoc[]).map((item) => {
      const qty = Number(item.qty);
      if (!cancelled && !item.courtesy) total += qty * Number(item.unitPrice);
      return {
        ...item,
        deliveredQty: cancelled ? 0 : qty,
        cancelledQty: cancelled ? qty : 0,
        annulledQty: 0,
      };
    });
    await orders.updateOne(
      { _id: order._id },
      {
        $set: {
          items,
          status: cancelled ? "cancelada" : "entregada",
          total: Math.round(total * 100) / 100,
          idempotencyKey: null,
          deliveries: [],
          cancellations: cancelled
            ? [
                {
                  items: items.map((_, index) => ({ index, qty: Number(items[index]!.qty) })),
                  reason: "Anulado en el modelo anterior",
                  by: order.createdBy,
                  at: order.updatedAt ?? order.createdAt,
                },
              ]
            : [],
          annulments: [],
        },
      },
    );
  }
  console.log(`[v3] pedidos migrados: ${oldOrders.length}`);

  // 6. Cobros anteriores: vigentes, versión 1.
  await db
    .collection("payments")
    .updateMany(
      { status: { $exists: false } },
      { $set: { status: "vigente", accountVersion: 1, reversedBy: null, reversedAt: null, reverseReason: "" } },
    );

  // 7. Cuentas por cabina a partir de los pedidos existentes.
  const accounts = db.collection("accounts");
  const pairs = await orders
    .aggregate([
      { $match: { status: { $ne: "cancelada" } } },
      {
        $group: {
          _id: { cruise: "$cruise", cabinNumber: "$cabinNumber" },
          open: { $sum: { $cond: [{ $eq: ["$payment", null] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  for (const pair of pairs) {
    const exists = await accounts.findOne({
      cruise: pair._id.cruise,
      cabinNumber: pair._id.cabinNumber,
    });
    if (exists) continue;
    await accounts.insertOne({
      cruise: pair._id.cruise,
      cabinNumber: pair._id.cabinNumber,
      status: pair.open > 0 ? "abierta" : "cobrada",
      version: 1,
      approvedVersion: null,
      approvedTotal: null,
      history: [{ action: "creada", version: 1, reason: "Migración v3", by: adminId, at: now }],
      createdAt: now,
      updatedAt: now,
    });
  }
  console.log(`[v3] cuentas creadas: ${pairs.length}`);

  // 8. Cabinas: huésped único → lista de pasajeros con pagador.
  const cruises = db.collection("cruises");
  const oldCruises: RawDoc[] = await cruises.find().toArray();
  for (const cruise of oldCruises) {
    const cabins = (cruise.cabins as RawDoc[]).map((cabin) => {
      if (Array.isArray(cabin.passengers)) return cabin;
      const passengers = cabin.guestName
        ? [
            {
              _id: new Types.ObjectId(),
              name: cabin.guestName,
              country: cabin.country ?? "",
              nationality: cabin.country ?? "",
              idNumber: "",
              email: cabin.email ?? "",
              phone: cabin.phone ?? "",
              isPayer: true,
            },
          ]
        : [];
      return {
        number: cabin.number,
        passengers,
        guestName: cabin.guestName ?? "",
        accountToken: cabin.accountToken,
      };
    });
    await cruises.updateOne(
      { _id: cruise._id },
      {
        $set: {
          cabins,
          code: cruise.code ?? "",
          leg: cruise.leg ?? "",
          routeFrom: cruise.routeFrom ?? "",
          routeTo: cruise.routeTo ?? "",
        },
      },
    );
  }
  console.log(`[v3] salidas migradas: ${oldCruises.length}`);

  // 9. Ciclo de salidas por defecto.
  if (!(await CycleSettings.findOne({ key: "main" }))) {
    await CycleSettings.create({ key: "main", legs: DEFAULT_LEGS, cabinCount: 9 });
  }

  // 10. Bitácora de actividad: se reconstruye lo anterior para el panel En vivo.
  const audit = db.collection("auditevents");
  if ((await audit.countDocuments()) === 0) {
    const users = await User.find().select("name");
    const names = new Map(users.map((u) => [u._id.toString(), u.name]));
    const events: RawDoc[] = [];
    for (const order of oldOrders) {
      events.push({
        kind: "pedido",
        title: `Pedido registrado · cabina ${order.cabinNumber}`,
        detail: (order.items as RawDoc[]).map((i) => `${i.qty}× ${i.name}`).join(", "),
        amount: order.total ?? null,
        by: order.createdBy ?? null,
        byName: names.get(String(order.createdBy)) ?? "",
        cruise: order.cruise ?? null,
        cabinNumber: order.cabinNumber ?? null,
        createdAt: order.createdAt ?? now,
      });
    }
    const payments: RawDoc[] = await db.collection("payments").find().toArray();
    for (const p of payments) {
      events.push({
        kind: "cobro",
        title: `Cobro · cabina ${p.cabinNumber}`,
        detail: p.method ?? "",
        amount: p.total ?? null,
        by: p.collectedBy ?? null,
        byName: names.get(String(p.collectedBy)) ?? "",
        cruise: p.cruise ?? null,
        cabinNumber: p.cabinNumber ?? null,
        createdAt: p.createdAt ?? now,
      });
    }
    events.push({
      kind: "inventario",
      title: "Inventario migrado a mililitros",
      detail: `${migrationMoves.length} saldo(s) convertidos; los negativos quedan para conteo físico`,
      amount: null,
      by: adminId,
      byName: admin.name,
      cruise: null,
      cabinNumber: null,
      createdAt: now,
    });
    if (events.length) await audit.insertMany(events);
  }

  await migrations.insertOne({ key: "v3", at: now, by: adminId });
  await mongoose.disconnect();
  console.log("[v3] migración completa");
}

migrate().catch(async (err) => {
  console.error("[v3] falló:", err);
  await mongoose.disconnect();
  process.exit(1);
});
