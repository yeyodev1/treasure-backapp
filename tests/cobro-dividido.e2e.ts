/**
 * Cobro dividido y cruceros (pedido del cliente, 31-oct-2026) contra un
 * Mongo en memoria:
 *
 *   npx ts-node --transpile-only tests/cobro-dividido.e2e.ts
 *
 * Pago mixto ($10 efectivo + resto tarjeta) con una factura; cuenta de una
 * pareja por consumos y por porcentaje (cada parte su factura); cabinas
 * cobradas juntas; reversos; cortesía de agencia; fechas de zarpe.
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
  const { Payment } = await import("../src/models/payment.model");
  const { Order } = await import("../src/models/order.model");
  const { invoiceAmount, invoiceCobros } = await import("../src/services/contifico.service");
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  const dates = await import("../src/utils/dates");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const mk = (email: string, role: string, name: string) => User.create({ email, role, name, passwordHash: hash, active: true });
  const owner = await mk("duena@t", "duena", "Gerencia");
  await mk("dir@t", "direccion", "Dirección");
  await mk("bar@t", "bartender", "Bar");
  await syncCatalogV3(owner._id);
  for (const p of await Product.find({ kind: "fisico" })) {
    p.onboardStock = 20 * (p.containerSize || 1);
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
  for (const [who, email] of Object.entries({ duena: "duena@t", dir: "dir@t", bar: "bar@t" })) {
    tokens[who] = (await api(who, "POST", "/auth/login", { email, password: "x" })).data.token;
  }
  const id = async (name: string) => (await Product.findOne({ name }))!._id.toString();
  const coke = await id("Coca Cola"); // 6,50
  const gin = await id("Gin Tonic"); // 14,50
  const club = await id("Club"); // 6,75

  // ---- Fechas de zarpe: solo el día de cada tipo y sugerencia del ciclo
  const nextDow = (dow: number) => {
    let key = dates.commercialDateKey();
    while (new Date(`${key}T12:00:00Z`).getUTCDay() !== dow) key = dates.addDaysKey(key, 1);
    return key;
  };
  const sat = nextDow(6);
  const opts0 = (await api("dir", "GET", "/cruises/plan/options")).data;
  check(
    "Opciones: cada tipo solo en su día (A y C sábado, B martes) y sugerencia sin crucero previo = A",
    opts0.legs.find((l: any) => l.code === "A").dates.every((d: any) => new Date(`${d.date}T12:00:00Z`).getUTCDay() === 6) &&
      opts0.legs.find((l: any) => l.code === "B").dates.every((d: any) => new Date(`${d.date}T12:00:00Z`).getUTCDay() === 2) &&
      opts0.suggestion?.leg === "A" && opts0.suggestion.startDate === sat,
    opts0.suggestion,
  );
  const wrongDay = await api("dir", "POST", "/cruises/plan", { leg: "A", startDate: dates.addDaysKey(sat, 1), acceptWeekday: true });
  check("Un crucero A en domingo se rechaza aunque se confirme", wrongDay.status === 400 && /sábados/.test(wrongDay.data.message), wrongDay.data.message);
  const a = await api("dir", "POST", "/cruises/plan", { leg: "A", startDate: sat });
  check("Crea el A en su sábado", a.status === 201, a.data.message);
  const opts1 = (await api("dir", "GET", "/cruises/plan/options")).data;
  const tue = dates.addDaysKey(sat, 3);
  check("La sugerencia sigue el ciclo: B el martes en que termina A", opts1.suggestion?.leg === "B" && opts1.suggestion.startDate === tue, opts1.suggestion);
  const busyC = opts1.legs.find((l: any) => l.code === "C").dates.find((d: any) => d.date === sat);
  check("La fecha ocupada dice por qué crucero", busyC && !busyC.free && busyC.conflict.code === a.data.cruise.code, busyC);

  // ---- Operación
  const cruiseId = a.data.cruise._id;
  const pax = async (n: number, passengers: any[]) => api("dir", "PUT", `/cruises/${cruiseId}/cabins/${n}/passengers`, { passengers });
  await pax(1, [{ name: "Ana", idNumber: "P1", country: "USA" }, { name: "Beto", idNumber: "P2", country: "USA" }]);
  await pax(2, [{ name: "Carla", idNumber: "P3" }]);
  await pax(3, [{ name: "Dani", idNumber: "P4" }]);
  await pax(4, [{ name: "Eva", idNumber: "P5" }]);
  await pax(5, [{ name: "Fer", idNumber: "P6" }]);
  await api("dir", "POST", `/cruises/${cruiseId}/start`);
  let k = 0;
  const consume = (cabin: number, productId: string, extra: Record<string, unknown> = {}) =>
    api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: cabin, productId, idempotencyKey: `k${k++}`, ...extra });
  const approve = (cabin: number) => api("dir", "POST", `/accounts/${cruiseId}/${cabin}/approve`);
  const account = async (cabin: number) => (await api("dir", "GET", `/accounts/${cruiseId}/${cabin}`)).data.account;

  // ---- Pago mixto: $10 efectivo + el resto con tarjeta, una sola factura
  await consume(2, gin);
  await consume(2, gin); // 29,00
  await approve(2);
  const mixed = await api("dir", "POST", "/payments/collect", {
    cruiseId,
    cabinNumber: 2,
    lines: [
      { method: "efectivo", amount: 10, cashConfirmed: true },
      { method: "tarjeta" },
    ],
  });
  const acc2 = await account(2);
  const head2 = await Payment.findById(mixed.data.payment?._id);
  check(
    "Pago mixto: dos pagos ($10 efectivo y $19 tarjeta), una factura por $29 y cuenta Pagada",
    mixed.status === 201 && mixed.data.settled && mixed.data.payments.length === 2 &&
      mixed.data.payments[0].method === "efectivo" && mixed.data.payments[0].total === 10 &&
      mixed.data.payments[1].method === "tarjeta" && mixed.data.payments[1].total === 19 &&
      acc2.status === "cobrada" && acc2.due === 0 && head2 && invoiceAmount(head2) === 29 &&
      (await Payment.countDocuments({ group: head2._id, invoiceStatus: "parcial" })) === 1,
    { status: mixed.status, msg: mixed.data.message },
  );
  const cobros2 = await invoiceCobros(head2!);
  check("La factura lleva un cobro por cada forma de pago", cobros2.length === 1 && cobros2[0]!.forma_cobro === "EF" && cobros2[0]!.monto === 10, cobros2);
  const tooMuch = await api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 2, lines: [{ method: "tarjeta", amount: 5 }] });
  check("Una cuenta pagada no se vuelve a cobrar", tooMuch.status >= 400);

  // ---- Pareja por consumos: cada uno paga lo suyo con su factura
  await consume(1, coke, { courtesy: true, courtesyReason: "Bienvenida" }); // cortesía: $0 para la cabina
  const o1 = (await consume(1, gin)).data.order._id; // Ana 14,50
  const o2 = (await consume(1, coke)).data.order._id; // Ana 6,50
  const o3 = (await consume(1, club)).data.order._id; // Beto 6,75
  await approve(1);
  const ana = await api("dir", "POST", "/payments/collect", {
    cruiseId,
    cabinNumber: 1,
    orderIds: [o1, o2],
    billing: { name: "Ana", idNumber: "P1" },
    lines: [{ method: "tarjeta" }],
  });
  let acc1 = await account(1);
  check(
    "Por consumos: Ana paga $21 de lo suyo; la cuenta sigue aprobada con $6,75 de Beto",
    ana.status === 201 && !ana.data.settled && ana.data.payment.total === 21 && ana.data.payment.invoiceStatus === "pendiente" &&
      acc1.status === "aprobada" && acc1.readyToCollect && acc1.total === 6.75 && acc1.due === 6.75 && acc1.paidOrders.length === 2,
    { status: ana.status, msg: ana.data.message, acc: [acc1.status, acc1.total, acc1.due, acc1.readyToCollect] },
  );
  const wrongOrder = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabinNumber: 1, orderIds: [o1], lines: [{ method: "tarjeta" }],
  });
  check("Un consumo ya pagado no se vuelve a cobrar", wrongOrder.status === 409, wrongOrder.data.message);
  const beto = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabinNumber: 1, orderIds: [o3], billing: { name: "Beto", idNumber: "P2" },
    lines: [{ method: "efectivo", cashConfirmed: true }],
  });
  acc1 = await account(1);
  check(
    "Beto paga lo suyo: la cuenta queda Pagada (la cortesía no queda abierta); dos facturas, cada una a su pagador",
    beto.status === 201 && beto.data.settled && acc1.status === "cobrada" && acc1.orders.length === 0 &&
      acc1.payments.filter((p: any) => p.head).map((p: any) => p.payer).join(",") === "Ana,Beto",
    { status: beto.status, msg: beto.data.message },
  );

  // ---- Porcentaje: 50 % cada uno, cada parte con su factura prorrateada
  await consume(3, gin);
  await consume(3, club); // 21,25
  await approve(3);
  const half = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabinNumber: 3, percent: 50, billing: { name: "Dani", idNumber: "P4" }, lines: [{ method: "tarjeta" }],
  });
  let acc3 = await account(3);
  const halfHead = await Payment.findById(half.data.payment?._id);
  check(
    "50 %: paga $10,63 con su factura; queda saldo $10,62 y la cuenta sigue aprobada",
    half.status === 201 && !half.data.settled && half.data.payment.total === 10.63 && halfHead?.part === true &&
      Math.abs(halfHead.share - 10.63 / 21.25) < 1e-9 && invoiceAmount(halfHead) === 10.63 && halfHead.invoiceStatus === "pendiente" &&
      acc3.status === "aprobada" && acc3.due === 10.62,
    { status: half.status, msg: half.data.message, total: half.data.payment?.total, share: halfHead?.share, due: acc3.due },
  );
  const rest = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabinNumber: 3, percent: 50, billing: { name: "Acompañante", idNumber: "P9" }, lines: [{ method: "efectivo", cashConfirmed: true }],
  });
  acc3 = await account(3);
  const restHead = await Payment.findById(rest.data.payment?._id);
  check(
    "La otra mitad completa la cuenta: su factura es solo su parte ($10,62)",
    rest.status === 201 && rest.data.settled && acc3.status === "cobrada" && restHead && invoiceAmount(restHead) === 10.62 &&
      (await invoiceCobros(restHead)).length === 1,
    { status: rest.status, msg: rest.data.message, inv: restHead && invoiceAmount(restHead) },
  );

  // ---- Cabinas juntas: un amigo paga la 4 y la 5
  await consume(4, gin); // 14,50
  await consume(5, coke); // 6,50
  await approve(4);
  const notApproved = await api("dir", "POST", "/payments/collect", { cruiseId, cabins: [4, 5], lines: [{ method: "tarjeta" }] });
  check("Cabinas juntas exigen todas aprobadas", notApproved.status === 409 && /cabina 5/.test(notApproved.data.message), notApproved.data.message);
  await approve(5);
  const group = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabins: [4, 5], billing: { name: "Eva", idNumber: "P5" },
    lines: [{ method: "efectivo", amount: 10, cashConfirmed: true }, { method: "tarjeta" }],
  });
  const [acc4, acc5] = [await account(4), await account(5)];
  const gHead = await Payment.findById(group.data.payment?._id);
  check(
    "Cabinas 4 y 5 juntas: una factura por $21, ambas Pagadas, pagos repartidos por cabina",
    group.status === 201 && group.data.settled && acc4.status === "cobrada" && acc5.status === "cobrada" &&
      gHead && invoiceAmount(gHead) === 21 && gHead.cabins.join(",") === "4,5" && gHead.orders.length === 2 &&
      acc4.paid === 14.5 && acc5.paid === 6.5,
    { status: group.status, msg: group.data.message, paid: [acc4.paid, acc5.paid] },
  );

  // ---- Reversos
  const memberId = group.data.payments[0]._id;
  const rev = await api("duena", "POST", `/payments/${memberId}/reverse`, { reason: "Prueba de reverso" });
  const [r4, r5] = [await account(4), await account(5)];
  check(
    "Reversar cabinas juntas reversa el cobro entero y reabre las dos cuentas",
    rev.status === 200 && r4.status === "abierta" && r5.status === "abierta" && r4.due === 14.5 && r5.due === 6.5 &&
      (await Payment.countDocuments({ group: gHead!._id, status: "vigente" })) === 0 &&
      (await Order.countDocuments({ payment: gHead!._id })) === 0,
    { status: rev.status, msg: rev.data.message, s: [r4.status, r5.status] },
  );
  const revRest = await api("duena", "POST", `/payments/${rest.data.payment._id}/reverse`, { reason: "Prueba" });
  acc3 = await account(3);
  check(
    "Reversar la parte que completó: la otra mitad sigue pagada y el saldo vuelve",
    revRest.status === 200 && acc3.status === "abierta" && acc3.due === 10.62 && acc3.partialPaid === 10.63,
    { status: revRest.status, msg: revRest.data.message, due: acc3.due, pp: acc3.partialPaid },
  );

  // ---- Cortesía de agencia
  await consume(2, coke, { courtesy: true, courtesyKind: "agencia", courtesyReason: "Guía de la agencia" });
  const paidCoke = (await consume(2, coke)).data.order._id;
  await api("bar", "POST", `/consumptions/${paidCoke}/bonify`, { reason: "Pedido de la agencia", kind: "agencia" });
  await consume(2, gin, { courtesy: true, courtesyReason: "Cumpleaños" });
  const agency = await api("dir", "GET", `/accounts/${cruiseId}/agency-courtesies`);
  const acc2b = await account(2);
  check(
    "Cortesías de agencia: van a su cuenta ($13) y no se cobran a la cabina; la de la casa no entra",
    agency.status === 200 && agency.data.total === 13 && agency.data.items.length === 2 &&
      agency.data.items.every((i: any) => i.cabinNumber === 2 && /agencia/i.test(i.reason)) &&
      acc2b.total === 0 && acc2b.orders.some((o: any) => o.items[0].courtesyKind === "agencia"),
    { status: agency.status, total: agency.data.total, items: agency.data.items?.length },
  );
  const barAgency = await api("bar", "GET", `/accounts/${cruiseId}/agency-courtesies`);
  check("El bar no ve la cuenta de la agencia", barAgency.status === 403);

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
