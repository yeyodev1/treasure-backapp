/**
 * Entrega compartida y conteo del barco (guía 4 perfiles, 4-nov-2026):
 *
 *   npx ts-node --transpile-only tests/entrega-compartida.e2e.ts
 *
 * Ejemplo de la guía: 24 Coca Cola. La administradora entrega 10 de puerto +
 * 6 de compra nueva; la dueña envía 8 de Quito; al llegar, el barco completa 24.
 * Base en memoria: no toca producción.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AddressInfo } from "net";
import bcrypt from "bcryptjs";

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
  process.env.RESEND_API_KEY = ""; // las pruebas nunca envían correos reales

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  const { Product } = await import("../src/models/product.model");
  const { WeeklyOrder } = await import("../src/models/weeklyOrder.model");
  const { StockCount } = await import("../src/models/stockCount.model");
  const { newLine } = await import("../src/services/weeklyOrder.service");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const people = { duena: "duena", adm: "admin", dir: "direccion", bar: "bartender" } as const;
  for (const [key, role] of Object.entries(people)) {
    await User.create({ email: `${key}@t`, role, name: key, passwordHash: hash, active: true });
  }

  const server = createApp().app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tokens: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  }
  for (const key of Object.keys(people)) {
    tokens[key] = (await api(key, "POST", "/auth/login", { email: `${key}@t`, password: "x" })).data.token;
  }

  const cola = await Product.create({
    name: "Coca Cola",
    category: "gaseosa",
    kind: "fisico",
    stockUnit: "unidad",
    containerSize: 1,
    containerLabel: "lata",
    puertoStock: 10,
    quitoStock: 8,
    onboardStock: 0,
  });
  const line = newLine(cola as any, { quito: 8, puerto: 10, abordo: 0, bodega: 0 }, {
    target: 0,
    incoming: 0,
    consumption: 24,
    suggested: 24,
    basis: "consumo",
  });
  const order = await WeeklyOrder.create({
    code: "PS-900",
    week: "2026-11-04",
    cutAt: new Date("2026-11-04T21:00:00Z"),
    status: "aprobado",
    lines: [line],
  });
  const id = order._id.toString();
  const pid = cola._id.toString();
  const stock = async () => (await Product.findById(pid).lean())!;
  const lineOf = (r: any) => r.data.order?.lines?.[0];

  // Permisos: cada quien confirma solo lo suyo.
  check("El bar no confirma entregas", (await api("bar", "POST", `/weekly-orders/${id}/deliver`, { key: "x", items: [] })).status === 403);
  check("La directora no confirma entregas", (await api("dir", "POST", `/weekly-orders/${id}/deliver`, { key: "x", items: [] })).status === 403);
  check("La administradora no confirma envíos de Quito", (await api("adm", "POST", `/weekly-orders/${id}/ship`, { key: "x", items: [] })).status === 403);
  const wrongSource = await api("adm", "POST", `/weekly-orders/${id}/deliver`, { key: "x", items: [{ productId: pid, source: "quito", qty: 1 }] });
  check("La administradora no entrega desde Quito", wrongSource.status === 400, wrongSource.status);

  // Administradora: 10 de puerto + 6 de compra nueva.
  const delivery = { key: "entrega-1", document: "Fact. 001-123", items: [{ productId: pid, source: "puerto", qty: 10 }, { productId: pid, source: "compra", qty: 6, cost: 0.6 }] };
  const d1 = await api("adm", "POST", `/weekly-orders/${id}/deliver`, delivery);
  check("Confirmar mi entrega", d1.status === 200, d1.data);
  check("Quedan 8 por atender", lineOf(d1)?.pending === 8, lineOf(d1));
  let s = await stock();
  check("Puerto −10", s.puertoStock === 0, s.puertoStock);
  check("Barco +16", s.onboardStock === 16, s.onboardStock);
  check("La compra nueva deja su costo", s.costPerUnit === 0.6, s.costPerUnit);

  const again = await api("adm", "POST", `/weekly-orders/${id}/deliver`, delivery);
  s = await stock();
  check("Repetir la misma entrega no duplica", again.status === 200 && s.onboardStock === 16 && s.puertoStock === 0, { status: again.status, s: s.onboardStock });
  const both = await Promise.all([1, 2].map(() => api("adm", "POST", `/weekly-orders/${id}/deliver`, { ...delivery, key: "doble" , items: [{ productId: pid, source: "compra", qty: 1 }] })));
  s = await stock();
  check("Doble toque simultáneo suma una sola vez", s.onboardStock === 17, { statuses: both.map((b) => b.status), board: s.onboardStock });
  // Se deshace el toque de prueba para seguir con el ejemplo de la guía.
  await WeeklyOrder.updateOne({ _id: id }, { $pull: { deliveries: { key: "doble" } } });
  await Product.updateOne({ _id: pid }, { $inc: { onboardStock: -1 } });

  const over = await api("adm", "POST", `/weekly-orders/${id}/deliver`, { key: "over", items: [{ productId: pid, source: "compra", qty: 9 }] });
  check("No se entrega más de lo que falta", over.status === 409, over.data);

  // Dueña: 8 desde Quito.
  const ship = await api("duena", "POST", `/weekly-orders/${id}/ship`, { key: "envio-1", items: [{ productId: pid, source: "quito", qty: 8 }] });
  check("Confirmar mi envío", ship.status === 200, ship.data);
  s = await stock();
  check("Quito −8", s.quitoStock === 0, s.quitoStock);
  check("El barco no suma antes de llegar", s.onboardStock === 16, s.onboardStock);
  check("Quedan 8 en camino y 0 por atender", lineOf(ship)?.inTransit === 8 && lineOf(ship)?.pending === 0, lineOf(ship));

  // Llegada en el mismo pedido.
  check("El bar no confirma la llegada", (await api("bar", "POST", `/weekly-orders/${id}/deliveries/envio-1/arrive`)).status === 403);
  const arrive = await api("dir", "POST", `/weekly-orders/${id}/deliveries/envio-1/arrive`);
  check("Confirmar llegada", arrive.status === 200, arrive.data);
  await api("dir", "POST", `/weekly-orders/${id}/deliveries/envio-1/arrive`);
  s = await stock();
  check("Barco +8 una sola vez (24 en total)", s.onboardStock === 24, s.onboardStock);
  check("Quito no se descuenta otra vez", s.quitoStock === 0, s.quitoStock);
  const final = await api("adm", "GET", `/weekly-orders/${id}`);
  check("Pedido entregado completo", final.data.order?.phase === "completo", final.data.order?.phase);

  // Sin stock en puerto: no deja negativos.
  await WeeklyOrder.updateOne({ _id: id }, { $set: { "lines.0.qty": 30 } });
  const empty = await api("adm", "POST", `/weekly-orders/${id}/deliver`, { key: "sin-stock", items: [{ productId: pid, source: "puerto", qty: 1 }] });
  s = await stock();
  check("Puerto vacío no queda negativo", empty.status === 409 && s.puertoStock === 0 && s.onboardStock === 24, { status: empty.status, s: s.puertoStock });

  // Conteo del barco: se confirma una vez y el físico queda como referencia.
  const count = await api("adm", "POST", "/counts", { location: "abordo" });
  const countId = count.data.count?._id;
  await api("adm", "PATCH", `/counts/${countId}`, { lines: [{ product: pid, physical: 22, reason: "" }] });
  await Product.updateOne({ _id: pid }, { $inc: { onboardStock: -2 } }); // se venden 2 después del corte
  check("El bar no confirma el conteo", (await api("bar", "POST", `/counts/${countId}/confirm`)).status === 403);
  const confirm = await api("adm", "POST", `/counts/${countId}/confirm`);
  check("Confirmar inventario del barco", confirm.status === 200 && confirm.data.count?.status === "aprobado", confirm.data);
  s = await stock();
  check("Conserva lo vendido después del corte (24 → 22 físico, −2 después = 20)", s.onboardStock === 20, s.onboardStock);
  const twice = await api("adm", "POST", `/counts/${countId}/confirm`);
  s = await stock();
  check("Confirmar dos veces no repite el ajuste", twice.status === 409 && s.onboardStock === 20, { status: twice.status, s: s.onboardStock });
  const list = await api("adm", "GET", "/counts");
  const row = list.data.counts?.find((c: any) => c._id === countId);
  check("El informe dice cuántas diferencias hubo", row?.differences === 1 && row?.countedLines === 1, row);
  check("Lo no contado no se toca", (await StockCount.findById(countId).lean())!.lines.length >= 1);

  server.close();
  await mongoose.disconnect();
  await repl.stop();
  console.log(failures ? `\n${failures} falla(s)` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
