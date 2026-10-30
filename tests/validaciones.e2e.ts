/**
 * Validaciones del servidor (checklist 29-oct puntos 16, 17 y 21):
 *
 *   npx ts-node --transpile-only tests/validaciones.e2e.ts
 *
 * - 16: cero, negativos y texto no crean solicitudes, compras, cargas ni mermas.
 * - 17: el correo del pasajero es vacío o válido; uno inválido no se guarda.
 * - 21: el permiso de precio depende del rol, no del nombre ni del correo.
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

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  const { Product } = await import("../src/models/product.model");
  const { Requisition } = await import("../src/models/requisition.model");
  const { Purchase } = await import("../src/models/purchase.model");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  // El usuario de Administración se llama como el rol de Gerencia: el nombre no da permisos.
  const people: Record<string, [string, string]> = {
    duena: ["duena", "Gerencia"],
    adm: ["admin", "Gerencia (Administración)"],
    dir: ["direccion", "Dirección"],
    bar: ["bartender", "Bar"],
    bod: ["bodega", "Bodega"],
  };
  const ids: Record<string, string> = {};
  for (const [key, [role, name]] of Object.entries(people)) {
    const u = await User.create({ email: `${key}@t`, role, name, passwordHash: hash, active: true });
    ids[key] = u._id.toString();
  }
  const owner = await User.findOne({ role: "duena" });
  const club = await Product.create({
    name: "Club",
    category: "cerveza",
    icon: "bottle",
    kind: "fisico",
    sellable: true,
    price: 4,
    stockUnit: "unidad",
    containerSize: 1,
    containerLabel: "botella",
    warehouseStock: 24,
    onboardStock: 0,
    active: true,
    createdBy: owner!._id,
  });
  const clubId = club._id.toString();

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
    const r = await api(key, "POST", "/auth/login", { email: `${key}@t`, password: "x" });
    tokens[key] = r.data.token;
  }

  // ---- 16 · Cantidad inválida
  const QTY = "Introduce una cantidad mayor que cero.";
  for (const qty of [0, -1, "abc", "12", null]) {
    const r = await api("bar", "POST", "/requisitions", {
      kind: "abastecimiento",
      lines: [{ productId: clubId, qty, unit: "envase" }],
      idempotencyKey: `rq-bad-${String(qty)}`,
    });
    check(`Solicitud con cantidad ${JSON.stringify(qty)} rechazada`, r.status === 400, r.data.message);
    check(`  mensaje claro para ${JSON.stringify(qty)}`, String(r.data.message).toLowerCase().includes(QTY.toLowerCase()), r.data.message);
  }
  check("Ninguna solicitud inválida quedó guardada", (await Requisition.countDocuments()) === 0);
  const ok12 = await api("bar", "POST", "/requisitions", {
    kind: "abastecimiento",
    lines: [{ productId: clubId, qty: 12, unit: "envase" }],
    idempotencyKey: "rq-ok",
  });
  check("Pedir 12 Club crea la solicitud", ok12.status === 201 && ok12.data.requisition?.lines?.[0]?.qty === 12, ok12.data.message);
  const again = await api("bar", "POST", "/requisitions", {
    kind: "abastecimiento",
    lines: [{ productId: clubId, qty: 12, unit: "envase" }],
    idempotencyKey: "rq-ok",
  });
  check("Reintentar la misma solicitud no duplica", again.data.duplicated === true && (await Requisition.countDocuments()) === 1);

  for (const containers of [0, -2, "x"]) {
    const r = await api("adm", "POST", "/purchases", {
      supplier: "Proveedor",
      document: "001-1",
      lines: [{ productId: clubId, containers, containerCost: 1 }],
    });
    check(`Compra con ${JSON.stringify(containers)} envases rechazada`, r.status === 400, r.data.message);
  }
  check("Ninguna compra inválida quedó guardada", (await Purchase.countDocuments()) === 0);

  const tr = await api("adm", "POST", "/inventory/transfer", { items: [{ productId: clubId, qty: -1 }] });
  check("Carga con -1 rechazada sin mover stock", tr.status === 400 && (await Product.findById(clubId))!.warehouseStock === 24, tr.data.message);
  const waste = await api("bod", "POST", "/inventory/waste", { productId: clubId, qty: -1, reason: "rotura", location: "bodega" });
  check("Merma con -1 rechazada", waste.status === 400 && waste.data.message === QTY, waste.data.message);

  // ---- 17 · Correo del pasajero
  const cruise = await api("dir", "POST", "/cruises", { name: "Prueba", startDate: "2026-11-01" });
  const cruiseId = cruise.data.cruise._id;
  const pax = (email: unknown) =>
    api("dir", "PUT", `/cruises/${cruiseId}/cabins/2/passengers`, {
      passengers: [{ name: "Ana", isPayer: true, idNumber: "P123", email }],
    });
  const bad = await pax("esto-no-es-correo");
  check("Correo inválido no se guarda", bad.status === 400, bad.data.message);
  check("  con el mensaje del checklist", String(bad.data.message).includes("Revisa el correo. Ejemplo: nombre@dominio.com."), bad.data.message);
  for (const email of ["ana@", "ana@dominio", "ana dominio.com", "a@b.c d"]) {
    check(`Correo ${email} rechazado`, (await pax(email)).status === 400);
  }
  const empty = await pax("");
  check("Correo vacío permitido", empty.status === 200, empty.data.message);
  const good = await pax(" Ana@Dominio.com ");
  const saved = good.data.cabin?.passengers?.[0];
  check("Correo válido se guarda limpio", good.status === 200 && saved?.email === "ana@dominio.com", saved?.email);
  check("  y conserva los otros datos", saved?.idNumber === "P123" && saved?.name === "Ana", saved);

  // ---- 21 · Precio por rol
  for (const who of ["adm", "dir", "bar", "bod"]) {
    const r = await api(who, "PATCH", `/products/${clubId}`, { price: 9 });
    check(`${people[who][1]} (${people[who][0]}) no cambia precios`, r.status === 403, r.status);
    const msg = String(r.data.message ?? "");
    check("  el aviso no nombra a una persona", !/dueña|paula|directora|administradora/i.test(msg), msg);
  }
  const renamed = await api("duena", "PATCH", `/users/${ids.duena}`, { name: "Otra Persona" });
  check("Gerencia cambia su nombre", renamed.status === 200, renamed.data.message);
  const relog = await api("duena", "POST", "/auth/login", { email: "duena@t", password: "x" });
  tokens.duena = relog.data.token;
  const price = await api("duena", "PATCH", `/products/${clubId}`, { price: 5 });
  check("Con otro nombre, Gerencia sigue cambiando precios", price.status === 200 && (await Product.findById(clubId))!.price === 5, price.data.message);
  check("El precio no cambió por los intentos sin permiso", (await Product.findById(clubId))!.priceHistory.every((h) => h.price !== 9));

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
