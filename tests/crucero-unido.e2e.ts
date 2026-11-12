/**
 * Crucero unido (pedido del cliente, 6-nov-2026) contra un Mongo en memoria:
 *
 *   npx ts-node --transpile-only tests/crucero-unido.e2e.ts
 *
 * A (cabinas 2 y 3) → B: la cabina 2 sigue en la 2 y la 3 se cambia a la 5.
 * Al cerrar A esas cabinas no quedan por cobrar; en B la cuenta suma lo de A
 * y se cobra una sola vez.
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
  await User.create({ email: "dir@t", role: "direccion", name: "Dirección", passwordHash: hash, active: true });
  await User.create({ email: "bar@t", role: "bartender", name: "Bar", passwordHash: hash, active: true });
  await syncCatalogV3(owner._id);
  for (const p of await Product.find({ kind: "fisico" })) {
    p.onboardStock = 10 * (p.containerSize || 1);
    p.costPerUnit = 0.01;
    await p.save();
  }

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
  for (const [who, email] of Object.entries({ dir: "dir@t", bar: "bar@t" })) {
    tokens[who] = (await api(who, "POST", "/auth/login", { email, password: "x" })).data.token;
  }
  const coke = (await Product.findOne({ name: "Coca Cola" }))!._id.toString();
  const price = (await Product.findOne({ name: "Coca Cola" }))!.price;

  const a = (await api("dir", "POST", "/cruises", { name: "Ensayo A", startDate: "2026-11-07" })).data.cruise._id;
  const b = (await api("dir", "POST", "/cruises", { name: "Ensayo B", startDate: "2026-11-10" })).data.cruise._id;
  await api("dir", "PUT", `/cruises/${a}/cabins/2/passengers`, { passengers: [{ name: "Ana Pérez", isPayer: true }] });
  await api("dir", "PUT", `/cruises/${a}/cabins/3/passengers`, { passengers: [{ name: "Marta Ruiz", isPayer: true, idNumber: "P3" }] });
  await api("dir", "PUT", `/cruises/${a}/cabins/4/passengers`, { passengers: [{ name: "Leo Sol", isPayer: true }] });
  await api("dir", "POST", `/cruises/${a}/start`);
  await api("bar", "POST", "/consumptions", { cruiseId: a, cabinNumber: 2, productId: coke, idempotencyKey: "a2" });
  await api("bar", "POST", "/consumptions", { cruiseId: a, cabinNumber: 3, productId: coke, idempotencyKey: "a3" });
  await api("bar", "POST", "/consumptions", { cruiseId: a, cabinNumber: 4, productId: coke, idempotencyKey: "a4" });

  // Validaciones
  const self = await api("dir", "PUT", `/cruises/${b}/continuations`, { links: [{ to: 2, fromCruise: b, fromCabin: 2 }] });
  check("No continúa de su mismo crucero", self.status === 400, self.data);
  const backwards = await api("dir", "PUT", `/cruises/${a}/continuations`, { links: [{ to: 2, fromCruise: b, fromCabin: 2 }] });
  check("El origen debe ser anterior", backwards.status === 400, backwards.data);
  const twice = await api("dir", "PUT", `/cruises/${b}/continuations`, {
    links: [{ to: 2, fromCruise: a, fromCabin: 2 }, { to: 6, fromCruise: a, fromCabin: 2 }],
  });
  check("Una cabina de origen sigue en una sola cabina", twice.status === 400, twice.data);

  // Unir: 2 → 2 y 3 → 5 (cambio de cabina)
  const join = await api("dir", "PUT", `/cruises/${b}/continuations`, {
    links: [{ to: 2, fromCruise: a, fromCabin: 2 }, { to: 5, fromCruise: a, fromCabin: 3 }],
  });
  const cabinsB = join.data.cruise?.cabins ?? [];
  check("Unir responde 200", join.status === 200, join.data);
  check(
    "Pasajeros copiados a la cabina nueva",
    cabinsB.find((c: any) => c.number === 5)?.passengers[0]?.name === "Marta Ruiz" &&
      cabinsB.find((c: any) => c.number === 2)?.guestName === "Ana Pérez",
  );
  const again = await api("dir", "PUT", `/cruises/${b}/continuations`, { links: [{ to: 7, fromCruise: a, fromCabin: 3 }] });
  check("La cabina 3 de A ya está unida", again.status === 400, again.data);

  // Cierre de A: 2 y 3 continúan, 4 queda por cobrar
  const review = (await api("dir", "GET", `/cruises/${a}/finish-check`)).data;
  const row = (n: number) => review.cabins.find((c: any) => c.number === n);
  check("A cabina 3 continúa en B cabina 5", row(3).accountStatus === "continua" && row(3).due === 0 && /cabina 5/.test(row(3).continuesTo), row(3));
  check("A: solo la cabina 4 queda por cobrar", Math.abs(review.totals.due - price) < 0.01, review.totals);
  const accA = (await api("dir", "GET", `/accounts/${a}`)).data.cabins;
  check("Lista de cuentas de A: la 2 sigue en B", accA.find((c: any) => c.cabinNumber === 2).continuesTo !== null && accA.find((c: any) => c.cabinNumber === 2).due === 0);
  await api("dir", "POST", `/cruises/${a}/finish`, { reason: "prueba" });
  await api("dir", "POST", `/cruises/${b}/start`);

  // En B la cuenta de la cabina 5 suma lo de A y lo nuevo
  await api("bar", "POST", "/consumptions", { cruiseId: b, cabinNumber: 5, productId: coke, idempotencyKey: "b5" });
  const acc5 = (await api("dir", "GET", `/accounts/${b}/5`)).data.account ?? (await api("dir", "GET", `/accounts/${b}/5`)).data;
  check("Cuenta B-5 suma A-3 + B-5", Math.abs(acc5.total - 2 * price) < 0.01 && acc5.orders.length === 2, { total: acc5.total, orders: acc5.orders?.length });
  // El bar ve de qué crucero viene cada consumo (7-nov-2026)
  const recent5 = (await api("bar", "GET", `/consumptions/summary/${b}/5`)).data.summary.recent;
  check("Bar: el consumo de A dice su crucero, el de B no", recent5.filter((r: any) => r.fromCruise).length === 1 && recent5.filter((r: any) => !r.fromCruise).length === 1, recent5.map((r: any) => r.fromCruise));
  const listB = (await api("dir", "GET", `/accounts/${b}`)).data.cabins;
  check("Lista de cuentas de B: la 5 con todo", Math.abs(listB.find((c: any) => c.cabinNumber === 5).due - 2 * price) < 0.01);

  // Se cobra una sola vez y marca también el consumo de A
  await api("bar", "POST", `/accounts/${b}/5/submit`);
  await api("dir", "POST", `/accounts/${b}/5/approve`);
  const pay = await api("dir", "POST", "/payments/collect", { cruiseId: b, cabinNumber: 5, method: "efectivo", cashConfirmed: true, billing: { idNumber: "P3" } });
  check("Cobro único en B", pay.status === 200 || pay.status === 201, pay.data);
  const paid = (await api("dir", "GET", `/accounts/${b}/5`)).data;
  const paidAcc = paid.account ?? paid;
  check("Cuenta B-5 pagada, sin saldo", paidAcc.due === 0 && paidAcc.paidOrders.length === 2, { due: paidAcc.due, paid: paidAcc.paidOrders?.length });

  // 12-nov-2026: una cabina vacía en origen no se une (no arrastra consumos de prueba)
  await api("bar", "POST", "/consumptions", { cruiseId: a, cabinNumber: 6, productId: coke, idempotencyKey: "a6" }).catch(() => null);
  const empty = await api("dir", "PUT", `/cruises/${b}/continuations`, { links: [{ to: 6, fromCruise: a, fromCabin: 6 }] });
  check("Cabina vacía de origen no se une", empty.status === 200 && !empty.data.cruise.cabins.find((c: any) => c.number === 6).continuesFrom, empty.data);

  // 12-nov-2026: pasajeros distintos a los de origen sueltan la unión
  await api("dir", "PUT", `/cruises/${b}/cabins/5/passengers`, { passengers: [{ name: "Marta Ruiz", isPayer: true, idNumber: "P3" }, { name: "Otro" }] });
  let c5 = (await api("dir", "GET", `/cruises/${b}`)).data.cruise.cabins.find((c: any) => c.number === 5);
  check("Misma gente + uno nuevo: sigue unida", Boolean(c5.continuesFrom), c5.continuesFrom);
  await api("dir", "PUT", `/cruises/${b}/cabins/2/passengers`, { passengers: [{ name: "Pasajero Nuevo", isPayer: true }] });
  const c2 = (await api("dir", "GET", `/cruises/${b}`)).data.cruise.cabins.find((c: any) => c.number === 2);
  check("Gente nueva: la cabina ya no suma lo anterior", !c2.continuesFrom, c2.continuesFrom);

  // Deshacer
  const undo = await api("dir", "PUT", `/cruises/${b}/continuations`, { links: [{ to: 5, fromCruise: null }] });
  check("Deshacer la unión", undo.status === 200 && !undo.data.cruise.cabins.find((c: any) => c.number === 5).continuesFrom);

  server.close();
  await mongoose.disconnect();
  await repl.stop();
  console.log(failures ? `\n${failures} prueba(s) fallaron` : "\nTodas las pruebas pasaron");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
