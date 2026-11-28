/**
 * Conteo por tipo de licor (pedido de Felipe, 28-nov-2026) contra un Mongo en
 * memoria y la API real: Bacardi Blanco y Gold se cuentan aparte y suman a la
 * misma botella. Sin todos los tipos, el producto sigue sin contar.
 *
 *   npx ts-node-dev --transpile-only tests/conteo-tipos.e2e.ts
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
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const owner = await User.create({ email: "duena@t", role: "duena", name: "Gerencia", passwordHash: hash, active: true });
  await User.create({ email: "dir@t", role: "direccion", name: "Directora", passwordHash: hash, active: true });
  await syncCatalogV3(owner._id);
  const bacardi = (await Product.findOneAndUpdate({ name: "Bacardi (botella)" }, { variants: ["Blanco", "Gold"] }, { new: true }))!;
  const size = bacardi.containerSize || 1;
  const pid = bacardi._id.toString();

  const server = createApp().app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let token = "";
  async function api(method: string, path: string, body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  }
  token = (await api("POST", "/auth/login", { email: "dir@t", password: "x" })).data.token;

  const opened = await api("POST", "/bar-stock/counts/initial");
  check("Se abre el conteo inicial", opened.status === 201, opened.status);
  const countId = opened.data.count.id;
  const lineOf = (c: any) => c.lines.find((l: any) => l.product === pid);
  check("La línea trae los tipos", JSON.stringify(lineOf(opened.data.count).variants) === '["Blanco","Gold"]', lineOf(opened.data.count).variants);

  const partial = await api("PUT", `/bar-stock/counts/${countId}/lines`, { lines: [{ productId: pid, by: { Blanco: 2.5 } }] });
  check("Con un solo tipo, el producto sigue sin contar", lineOf(partial.data.count).physical === null, lineOf(partial.data.count));
  check("Se guarda lo contado del tipo", lineOf(partial.data.count).physicalBy?.Blanco === 2.5);

  const full = await api("PUT", `/bar-stock/counts/${countId}/lines`, {
    lines: [{ productId: pid, by: { Blanco: 2.5, Gold: 1.25, Otro: 9 } }],
  });
  check("Con todos los tipos suma Blanco + Gold", lineOf(full.data.count).physical === 3.75, lineOf(full.data.count));
  check("Ignora tipos que no son del producto", lineOf(full.data.count).physicalBy?.Otro === undefined);

  // Los demás productos se cuentan en cero para poder enviar.
  const rest = full.data.count.lines.filter((l: any) => l.product !== pid).map((l: any) => ({ productId: l.product, physical: 0 }));
  await api("PUT", `/bar-stock/counts/${countId}/lines`, { lines: rest });
  const sent = await api("POST", `/bar-stock/counts/${countId}/send`);
  check("El conteo inicial queda verificado", sent.data.count?.status === "aprobado", sent.data.count?.status ?? sent.data);
  const after = (await Product.findById(pid).lean())!;
  check("El stock a bordo es la suma de los tipos", Math.abs(after.onboardStock - 3.75 * size) < 0.01, after.onboardStock);

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
