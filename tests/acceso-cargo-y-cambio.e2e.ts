/**
 * Pedidos del cliente del 9-nov-2026:
 *
 *   npx ts-node-dev --transpile-only tests/acceso-cargo-y-cambio.e2e.ts
 *
 * 1. Registros ISM: entrar eligiendo el cargo y la clave de 4 números.
 * 2. Bar: cóctel con cambio de gaseosa (sin recargo) o de licor (+$3).
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
  process.env.RESEND_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  const { Product } = await import("../src/models/product.model");
  const { IsmCrew } = await import("../src/models/ismCrew.model");
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const mk = (email: string, role: string, name: string, position = "") =>
    User.create({ email, role, name, passwordHash: hash, active: true, position });
  const owner = await mk("duena@t", "duena", "Gerencia");
  await mk("dir@t", "direccion", "Dirección");
  await mk("bar@t", "bartender", "Bartender");
  const cap = await mk("cap@t", "capitan", "Capitán Uno", "CAP");
  const tim1 = await mk("t1@t", "tripulante", "Timonel Uno", "TIM_01");
  const tim2 = await mk("t2@t", "tripulante", "Timonel Dos", "TIM_02");
  const pin = async (user: { _id: unknown }, value: string, extra: Record<string, unknown> = {}) =>
    IsmCrew.create({ user: user._id, pinHash: await bcrypt.hash(value, 4), ...extra });
  await pin(cap, "4821");
  await pin(tim1, "7305");
  await pin(tim2, "9164", { pinTemporary: true });
  await syncCatalogV3(owner._id);

  const server = createApp().app.listen(0);
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
  const crew = (body: unknown) => api("", "POST", "/auth/login/crew", body);

  // ---- 1. Acceso por cargo
  const okCap = await crew({ cargo: "capitan", pin: "4821" });
  check("Capitán entra con cargo + clave", okCap.status === 200 && okCap.data.user?.name === "Capitán Uno", okCap.data);
  const okTim = await crew({ cargo: "marinero", pin: "7305" });
  check("Marinero: la clave dice quién es entre los dos", okTim.data.user?.name === "Timonel Uno", okTim.data);
  const temp = await crew({ cargo: "marinero", pin: "9164" });
  check("Clave temporal pide crear la propia", temp.status === 428 && temp.data.code === "clave_temporal", temp.data);
  const temp2 = await crew({ cargo: "marinero", pin: "9164", newPin: "2468" });
  check("…y entra al crearla", temp2.status === 200 && temp2.data.user?.name === "Timonel Dos", temp2.data);
  const otherCargo = await crew({ cargo: "capitan", pin: "7305" });
  check("La clave de otro cargo no sirve", otherCargo.status === 403 && otherCargo.data.code === "clave_incorrecta", otherCargo.data);
  const noOne = await crew({ cargo: "barman", pin: "4821" });
  check("Cargo sin nadie registrado: no entra", noOne.status === 401, noOne.data);
  const fake = await crew({ cargo: "constructor", pin: "4821" });
  check("Cargo inventado: no entra", fake.status === 401, fake.data);
  let last = otherCargo;
  for (let i = 0; i < 4; i++) last = await crew({ cargo: "capitan", pin: "0001" });
  check("Al quinto intento fallido se bloquea", last.status === 423 && last.data.code === "clave_bloqueada", last.data);
  const locked = await crew({ cargo: "capitan", pin: "4821" });
  check("Bloqueada: ni la clave buena entra", locked.status === 423, locked.data);
  const byUser = await crew({ username: "nadie", pin: "4821" });
  check("El acceso con usuario sigue igual", byUser.status === 401, byUser.data);

  // ---- 1b. Clave puesta por Gerencia al agregar o editar (12-nov-2026)
  tokens.owner = (await api("owner", "POST", "/auth/login", { email: "duena@t", password: "x" })).data.token;
  const weak = await api("owner", "POST", "/ism/crew", { firstName: "Mario", lastName: "Máquinas", position: "MAQ", pin: "1111" });
  check("Clave débil al agregar: no se acepta", weak.status === 400, weak.data);
  const added = await api("owner", "POST", "/ism/crew", { firstName: "Mario", lastName: "Máquinas", position: "MAQ", pin: "3579" });
  check("Agregar con clave", added.status === 201 && added.data.member?.hasPin && !added.data.member?.pinTemporary, added.data);
  const maq = await crew({ cargo: "maquinas", pin: "3579" });
  check("…y entra de una con esa clave (sin temporal)", maq.status === 200 && maq.data.user?.name === "Mario Máquinas", maq.data);
  const edited = await api("owner", "PATCH", `/ism/crew/${tim1._id}`, { pin: "1357" });
  check("Editar pone clave nueva", edited.status === 200 && edited.data.member?.hasPin, edited.data);
  const newTim = await crew({ cargo: "marinero", pin: "1357" });
  check("…entra con la nueva", newTim.status === 200 && newTim.data.user?.name === "Timonel Uno", newTim.data);
  const oldTim = await crew({ cargo: "marinero", pin: "7305" });
  check("…y la vieja ya no sirve", oldTim.status !== 200, oldTim.data);
  tokens.dir = (await api("dir", "POST", "/auth/login", { email: "dir@t", password: "x" })).data.token;
  const notKeeper = await api("dir", "PATCH", `/ism/crew/${tim1._id}`, { pin: "8642" });
  check("Dirección de crucero no pone claves", notKeeper.status === 403, notKeeper.data);

  // ---- 2. Cóctel con cambio
  for (const [who, email] of Object.entries({ dir: "dir@t", bar: "bar@t" })) {
    tokens[who] = (await api(who, "POST", "/auth/login", { email, password: "x" })).data.token;
  }
  const byName = async (name: string) => (await Product.findOne({ name }))!;
  const cuba = await byName("Cuba Libre");
  const bacardi = await byName("Bacardi (botella)");
  const coke = await byName("Coca Cola");
  const zero = await byName("Coca Cola Zero");
  const rum = (await Product.findOne({ category: "licor", kind: "fisico", stockUnit: "ml", _id: { $ne: bacardi._id } }))!;
  await Product.updateMany({ kind: "fisico" }, { $set: { onboardStock: 10_000 } });
  const stock = async (id: unknown) => (await Product.findById(id))!.onboardStock;

  const cruiseId = (await api("dir", "POST", "/cruises", { name: "Prueba", startDate: "2026-11-01" })).data.cruise._id;
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/2/passengers`, { passengers: [{ name: "Ana", isPayer: true }] });
  const started = await api("dir", "POST", `/cruises/${cruiseId}/start`, { confirm: true });
  check("Crucero iniciado", started.status === 200, started.data.message);
  const consume = (key: string, extra: Record<string, unknown>) =>
    api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: cuba._id, idempotencyKey: key, ...extra });

  const plain = await consume("c-0", {});
  check("Cuba Libre normal: su precio", plain.status === 201 && plain.data.order.total === cuba.price, plain.data);
  const soda = await consume("c-1", { swaps: [{ from: coke._id, to: zero._id }] });
  const sodaItem = soda.data.order?.items?.[0];
  check("Cambio de gaseosa: sin recargo", soda.status === 201 && soda.data.order.total === cuba.price, soda.data.message);
  check("…y el nombre dice el cambio", sodaItem?.name === "Cuba Libre (con Coca Cola Zero)", sodaItem?.name);
  check("…descuenta la Zero, no la normal", (await stock(zero._id)) === 10_000 - 120 && (await stock(coke._id)) === 10_000 - 120, [await stock(zero._id), await stock(coke._id)]);
  const liquor = await consume("c-2", { swaps: [{ from: bacardi._id, to: rum._id }] });
  check("Cambio de licor: +$3", liquor.status === 201 && liquor.data.order.total === cuba.price + 3, liquor.data.order?.total ?? liquor.data.message);
  check("…descuenta el licor servido", (await stock(rum._id)) === 10_000 - 60 && (await stock(bacardi._id)) === 10_000 - 120, [await stock(rum._id), await stock(bacardi._id)]);
  const both = await consume("c-3", { swaps: [{ from: bacardi._id, to: rum._id }, { from: coke._id, to: zero._id }] });
  check("Licor y gaseosa: un solo recargo", both.data.order?.total === cuba.price + 3, both.data.order?.total ?? both.data.message);
  const cross = await consume("c-4", { swaps: [{ from: coke._id, to: rum._id }] });
  check("No se cambia gaseosa por licor", cross.status === 400, cross.data.message);
  const notCocktail = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: coke._id, idempotencyKey: "c-5", swaps: [{ from: coke._id, to: zero._id }] });
  check("Solo los cócteles admiten cambio", notCocktail.status === 400, notCocktail.data.message);
  const undo = await api("bar", "POST", `/consumptions/${liquor.data.order._id}/undo`, { reason: "error" });
  check("Retirar devuelve el licor cambiado", undo.status === 200 && (await stock(rum._id)) === 10_000 - 60, await stock(rum._id));

  server.close();
  await mongoose.disconnect();
  await repl.stop();
  console.log(failures ? `\n${failures} FALLA(S)` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
