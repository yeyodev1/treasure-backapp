/**
 * Cuentas, cobros, prefactura y resumen del negocio (checklist 29-oct:
 * 01, 02, 03, 04, 05, 08, 09, 10A, 10B, 11 y 22) contra un Mongo en memoria:
 *
 *   npx ts-node --transpile-only tests/cuentas.e2e.ts
 *
 * Caso del ensayo: A-001 cabina 2 con 2 Coca Cola + 1 Gin Tonic = $27,50,
 * cobrada; compras CP-001 recibida parcial $84 y CP-002 $18.
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
  const { Payment } = await import("../src/models/payment.model");
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  const dates = await import("../src/utils/dates");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  // ---- 04: fecha local de Galápagos (UTC−6)
  check(
    "29-oct 23:30 en Galápagos sigue siendo 29-oct",
    dates.commercialDateKey(new Date("2026-10-30T05:30:00Z")) === "2026-10-29",
  );
  check(
    "El día empieza a las 06:00 UTC",
    dates.startOfDayLocal(new Date("2026-10-30T05:30:00Z")).toISOString() === "2026-10-29T06:00:00.000Z",
  );
  check(
    "Filtro hasta 'YYYY-MM-DD' cubre el día local completo",
    dates.parseRangeEdge("2026-10-29", "end")!.toISOString() === "2026-10-30T05:59:59.999Z",
  );

  const hash = await bcrypt.hash("x", 4);
  const mk = (email: string, role: string, name: string) =>
    User.create({ email, role, name, passwordHash: hash, active: true });
  const owner = await mk("duena@t", "duena", "Gerencia");
  await mk("dir@t", "direccion", "Dirección");
  await mk("bar@t", "bartender", "Bar");
  await mk("adm@t", "admin", "Administración");
  await syncCatalogV3(owner._id);
  // Stock ficticio a bordo con costo.
  for (const p of await Product.find({ kind: "fisico" })) {
    p.onboardStock = 10 * (p.containerSize || 1);
    p.costPerUnit = p.price > 0 ? Math.round(((p.price * 0.3) / (p.containerSize || 1)) * 1e6) / 1e6 : 0.01;
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
    const type = r.headers.get("content-type") ?? "";
    if (type.includes("application/pdf")) {
      return { status: r.status, data: {} as any, pdf: Buffer.from(await r.arrayBuffer()), type };
    }
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any, type };
  }
  for (const [who, email] of Object.entries({ duena: "duena@t", dir: "dir@t", bar: "bar@t", adm: "adm@t" })) {
    tokens[who] = (await api(who, "POST", "/auth/login", { email, password: "x" })).data.token;
  }

  const id = async (name: string) => (await Product.findOne({ name }))!._id.toString();
  const coke = await id("Coca Cola");
  const ginTonic = await id("Gin Tonic");

  const gen = await api("dir", "POST", "/cruises", { name: "Ensayo A", startDate: "2026-10-29" });
  const cruiseId = gen.data.cruise._id;
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/2/passengers`, {
    passengers: [{ name: "Ana Pérez", isPayer: true, country: "USA" }],
  });
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/3/passengers`, { passengers: [{ name: "Marta", isPayer: true }] });
  await api("dir", "POST", `/cruises/${cruiseId}/start`);

  for (const [i, pid] of [coke, coke, ginTonic].entries()) {
    await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: pid, idempotencyKey: `c2-${i}` });
  }
  await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 3, productId: coke, idempotencyKey: "c3-0" });

  // ---- 02: prefactura antes de pagar
  const before = await api("dir", "GET", `/accounts/${cruiseId}/2/proforma`);
  check("Prefactura antes de pagar: PDF", before.status === 200 && before.type.includes("pdf") && (before.pdf?.length ?? 0) > 1000, before.status);
  const barProforma = await api("bar", "GET", `/accounts/${cruiseId}/2/proforma`);
  check("El bar no descarga la prefactura", barProforma.status === 403);
  const { proformaData, englishItemName } = await import("../src/services/proforma.service");
  const pre = await proformaData(cruiseId, 2);
  check(
    "Prefactura: crucero, cabina, pagador, productos y total",
    pre.cabin === 2 && pre.billTo === "Ana Pérez" && pre.lines.length === 3 && pre.total === 27.5 && pre.balance === 27.5 && pre.paid === 0,
    { total: pre.total, lines: pre.lines.length, billTo: pre.billTo },
  );
  check(
    "Conceptos en inglés; marcas se conservan",
    englishItemName("Tanqueray (botella)") === "Tanqueray (bottle)" &&
      englishItemName("Reservado Merlot (copa)") === "Reservado Merlot (glass)" &&
      englishItemName("Corkage Fee (descorche)") === "Corkage fee" &&
      englishItemName("Coca Cola") === "Coca Cola",
  );

  // ---- 01 y 03: cobrar conserva productos; pago registrado con factura pendiente
  await api("bar", "POST", `/accounts/${cruiseId}/2/submit`);
  await api("dir", "POST", `/accounts/${cruiseId}/2/approve`);
  const badMail = await api("dir", "POST", "/payments/collect", {
    cruiseId, cabinNumber: 2, method: "efectivo", cashConfirmed: true, billing: { idNumber: "P123", email: "esto-no-es-correo" },
  });
  check("Correo inválido para la factura: mensaje claro", badMail.status === 400 && /nombre@dominio\.com/.test(badMail.data.message), badMail.data.message);
  const [pay1, pay2] = await Promise.all([
    api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 2, method: "efectivo", cashConfirmed: true, billing: { idNumber: "P123" } }),
    api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 2, method: "efectivo", cashConfirmed: true, billing: { idNumber: "P123" } }),
  ]);
  const pays = await Payment.countDocuments({ cruise: cruiseId, cabinNumber: 2 });
  check("Doble clic en Cobrar: un solo pago", pays === 1, { pays, status: [pay1.status, pay2.status] });
  const payment = (pay1.status === 201 ? pay1 : pay2).data.payment;
  check(
    "Pago registrado y factura pendiente con causa",
    payment.status === "vigente" && payment.invoiceStatus === "pendiente" && payment.invoiceError === "La facturación no está configurada.",
    { status: payment.invoiceStatus, error: payment.invoiceError },
  );
  const retry = await api("dir", "POST", `/payments/${payment._id}/retry-invoice`);
  const paysAfter = await Payment.countDocuments({ cruise: cruiseId, cabinNumber: 2 });
  check(
    "Reintentar emisión no duplica el pago ni afirma emisión",
    retry.status === 200 && retry.data.payment.invoiceStatus === "pendiente" && paysAfter === 1,
    retry.data.payment?.invoiceStatus,
  );

  const acc = (await api("dir", "GET", `/accounts/${cruiseId}/2`)).data.account;
  check(
    "Cuenta pagada: Consumos $27,50 · Pagado $27,50 · Por cobrar $0",
    acc.status === "cobrada" && acc.consumed === 27.5 && acc.paid === 27.5 && acc.due === 0,
    { status: acc.status, consumed: acc.consumed, paid: acc.paid, due: acc.due },
  );
  check(
    "La cuenta pagada conserva productos e historial",
    acc.paidOrders.length === 3 && acc.payments.length === 1 && acc.history.some((h: any) => h.action === "cobrada"),
  );
  const rows = (await api("dir", "GET", `/accounts/${cruiseId}`)).data.cabins;
  const row2 = rows.find((r: any) => r.cabinNumber === 2);
  check(
    "Lista de cuentas: la pagada no dice Sin consumos",
    row2.paidOrders === 3 && row2.consumed === 27.5 && row2.paid === 27.5 && row2.due === 0,
    row2,
  );

  // ---- 02 después de pagar
  const post = await proformaData(cruiseId, 2);
  check(
    "Prefactura después de pagar: pagos recibidos y saldo",
    post.total === 27.5 && post.paid === 27.5 && post.balance === 0 && post.payments[0]?.method === "Cash",
    { paid: post.paid, balance: post.balance },
  );
  const after = await api("dir", "GET", `/accounts/${cruiseId}/2/proforma?download=1`);
  check("Descarga después de pagar", after.status === 200 && (after.pdf?.length ?? 0) > 1000);

  // ---- 22: página pública del QR en inglés con total, pagos y saldo
  const { Cruise } = await import("../src/models/cruise.model");
  const token = (await Cruise.findById(cruiseId))!.cabins.find((c) => c.number === 2)!.accountToken;
  const pub = (await api("anon", "GET", `/public/account/${token}`)).data;
  check(
    "QR: total $27,50, pagos $27,50 y saldo $0",
    pub.account.total === 27.5 && pub.account.paid === 27.5 && pub.account.due === 0 && pub.account.payments.length === 1,
    pub.account,
  );
  check("QR: sin datos de facturación del pago", !("billing" in pub.account.payments[0]) && !("reference" in pub.account.payments[0]));

  // RESUMEN

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
