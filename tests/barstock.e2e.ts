/**
 * BAR - STOCK (pedido del cliente, 19-nov-2026) contra un Mongo en memoria y
 * la API real, sin tocar la base del barco:
 *
 *   npx ts-node-dev --transpile-only tests/barstock.e2e.ts          (prueba)
 *   npx ts-node-dev --transpile-only tests/barstock.e2e.ts --serve  (deja la API en :4100 para ver las pantallas)
 *
 * Flujo: BAR cuenta y pide → DIRECTORA modifica y aprueba → TIERRA envía →
 * BAR confirma lo recibido. El conteo queda como conteo físico al enviar y
 * el barco solo sube con lo que el bar recibió.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AddressInfo } from "net";
import bcrypt from "bcryptjs";

const serve = process.argv.includes("--serve");
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK   " : "FALLA"} ${label}${detail !== "" ? ` → ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = repl.getUri("treasure");
  process.env.CONTIFICO_API_KEY = "";
  process.env.CONTIFICO_API_TOKEN = "";
  process.env.RESEND_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  const { Product } = await import("../src/models/product.model");
  const { StockCount } = await import("../src/models/stockCount.model");
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const mk = (email: string, role: string, name: string) => User.create({ email, role, name, passwordHash: hash, active: true });
  const owner = await mk("duena@t", "duena", "Gerencia");
  await mk("dir@t", "direccion", "Directora");
  await mk("bar@t", "bartender", "Bartender");
  await mk("adm@t", "admin", "Tierra");
  await syncCatalogV3(owner._id);

  const id = async (name: string) => (await Product.findOne({ name }))!._id.toString();
  const gin = await id("Tanqueray (botella)");
  const coke = await id("Coca Cola");
  const tonic = await id("Agua tónica");
  const ginSize = (await Product.findById(gin))!.containerSize;
  const cokeSize = (await Product.findById(coke))!.containerSize || 1;
  // Lo que el sistema cree que hay a bordo: 3 botellas de gin y 10 Coca Colas.
  await Product.updateOne({ _id: gin }, { onboardStock: 3 * ginSize, stockTarget: 6 });
  await Product.updateOne({ _id: coke }, { onboardStock: 10 * cokeSize, stockTarget: 24 });
  const onboard = async (pid: string) => (await Product.findById(pid).lean())!.onboardStock;

  const server = createApp().app.listen(serve ? 4100 : 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tokens: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  }
  for (const [who, email] of Object.entries({ duena: "duena@t", dir: "dir@t", bar: "bar@t", adm: "adm@t" })) {
    tokens[who] = (await api(who, "POST", "/auth/login", { email, password: "x" })).data.token;
  }

  if (serve) {
    console.log(`API de prueba en ${base}`);
    for (const [who, token] of Object.entries(tokens)) console.log(`TOKEN ${who} ${token}`);
    return;
  }

  // ---- BAR: cuenta y pide
  const cur = await api("bar", "GET", "/weekly-orders/current");
  let order = cur.data.order;
  check("Hay pedido de la semana para el bar", cur.status === 200 && order?.status === "bar", cur.data.message);
  const saved = await api("bar", "PUT", `/weekly-orders/${order._id}/lines`, {
    version: order.version,
    lines: [
      ...order.lines.map((l: any) => ({ productId: l.product, qty: 0, observation: "", counted: null })).filter((l: any) => ![gin, coke, tonic].includes(l.productId)),
      // Licor: 2 cerradas + ½ abierta.
      { productId: gin, qty: 4, observation: "", counted: 2.5 },
      { productId: coke, qty: 12, observation: "", counted: 8 },
      { productId: tonic, qty: 6, observation: "", counted: null },
    ],
  });
  check("El bar guarda TENGO y PEDIR", saved.status === 200, saved.data.message);
  order = saved.data.order;
  check("Guardar no cambia el inventario", (await onboard(gin)) === 3 * ginSize);

  const sent = await api("bar", "POST", `/weekly-orders/${order._id}/send`, { version: order.version });
  check("ENVIAR PEDIDO lo pasa a la directora", sent.status === 200 && sent.data.order.status === "directora", sent.data.message);
  order = sent.data.order;
  check("El conteo queda como inventario: gin 2,5 botellas", (await onboard(gin)) === 2.5 * ginSize, await onboard(gin));
  check("El conteo queda como inventario: Coca Cola 8", (await onboard(coke)) === 8 * cokeSize, await onboard(coke));
  const count = await StockCount.findOne({ location: "abordo" }).sort({ createdAt: -1 }).lean();
  const ginLine = count?.lines.find((l) => l.product.toString() === gin);
  check(
    "Se guarda el conteo físico con lo calculado y lo contado",
    count?.status === "aprobado" && ginLine?.digitalAtCut === 3 * ginSize && ginLine?.physical === 2.5 * ginSize,
    ginLine,
  );
  check("Lo no contado no entra al conteo", !count?.lines.some((l) => l.product.toString() === tonic));

  // ---- DIRECTORA: modifica, borra y aprueba
  const edit = await api("dir", "PUT", `/weekly-orders/${order._id}/lines`, {
    version: order.version,
    lines: order.lines
      .filter((l: any) => l.product !== tonic)
      .map((l: any) => ({ productId: l.product, qty: l.product === gin ? 5 : l.qty, observation: l.observation, counted: l.counted })),
  });
  check("La directora cambia cantidades y borra un producto", edit.status === 200 && !edit.data.order.lines.some((l: any) => l.product === tonic), edit.data.message);
  order = edit.data.order;
  const approved = await api("dir", "POST", `/weekly-orders/${order._id}/approve`, { version: order.version });
  check("APROBAR pasa el pedido a Tierra", approved.status === 200 && approved.data.order.status === "aprobado", approved.data.message);
  order = approved.data.order;
  const before = await StockCount.countDocuments();
  check("Aprobar no repite el conteo", before === 1, before);

  // ---- TIERRA: envía distinto de lo aprobado, con precio
  const shipped = await api("adm", "POST", `/weekly-orders/${order._id}/deliver`, {
    key: "env-1",
    document: "",
    items: [
      { productId: gin, source: "compra", qty: 4, cost: 18 },
      { productId: coke, source: "compra", qty: 12, cost: 0.6 },
    ],
  });
  check("ENVIADO registra lo que sale (4 de 5 gin)", shipped.status === 200, shipped.data.message);
  order = shipped.data.order;
  check("Enviado no suma al barco", (await onboard(gin)) === 2.5 * ginSize);
  const ginPending = order.lines.find((l: any) => l.product === gin);
  check("Queda pendiente 1 gin y 4 en camino", ginPending.pending === 1 && ginPending.inTransit === 4, ginPending);
  const forBar = await api("bar", "GET", "/weekly-orders/current");
  check("Al bar le aparece «Pedido por recibir»", forBar.data.order.toReceive === true);

  // ---- BAR: recibe con diferencia
  const arrived = await api("bar", "POST", `/weekly-orders/${order._id}/deliveries/env-1/arrive`, {
    items: [
      { productId: gin, source: "compra", received: 3 },
      { productId: coke, source: "compra", received: 12 },
    ],
  });
  check("El bar confirma lo recibido", arrived.status === 200, arrived.data.message);
  check("El barco suma solo lo recibido: gin 5,5", (await onboard(gin)) === 5.5 * ginSize, await onboard(gin));
  check("Coca Cola 8 + 12 = 20", (await onboard(coke)) === 20 * cokeSize, await onboard(coke));
  const ginCost = (await Product.findById(gin))!.costPerUnit;
  check("El precio de Tierra queda como costo del gin", ginCost > 0, ginCost);
  const again = await api("bar", "POST", `/weekly-orders/${order._id}/deliveries/env-1/arrive`, { items: [] });
  check("Confirmar dos veces no suma dos veces", again.status === 200 && (await onboard(gin)) === 5.5 * ginSize);
  const after = arrived.data.order.lines.find((l: any) => l.product === gin);
  check("Lo que no llegó vuelve a quedar pendiente (2 gin)", after.pending === 2, after);

  // ---- Permisos: el bar no aprueba ni envía
  const barApprove = await api("bar", "POST", `/weekly-orders/${order._id}/approve`, { version: 0 });
  check("El bar no puede aprobar", barApprove.status === 403);
  const barShip = await api("bar", "POST", `/weekly-orders/${order._id}/deliver`, { key: "x", items: [] });
  check("El bar no puede marcar enviado", barShip.status === 403);

  server.close();
  await mongoose.disconnect();
  await repl.stop();
  console.log(failures ? `\n${failures} falla(s)` : "\nTodo bien");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
