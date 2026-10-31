/**
 * Cuentas, cobros, prefactura y resumen del negocio (checklist 29-oct:
 * 01, 02, 03, 04, 05, 08, 09, 10A, 10B, 11 y 22) contra un Mongo en memoria:
 *
 *   npx ts-node --transpile-only tests/cuentas.e2e.ts
 *
 * Caso del ensayo: A-001 cabina 2 con 2 Coca Cola + 1 Gin Tonic = $27,50,
 * cobrada; compras CP-001 recibida parcial $84 y CP-002 $18.
 * P05: cabina 4 ($21) pagada en partes ($10 + $5 + $6) con resumen por
 * correo a un transporte de prueba (nunca se envía un correo real).
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
  process.env.CONTIFICO_BANK_ACCOUNT_ID = "";
  process.env.CONTIFICO_CARD_PROCESSOR = "";

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
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/4/passengers`, {
    passengers: [{ name: "John Smith", isPayer: true, email: "pax4@example.com", idNumber: "P444", country: "USA" }],
  });
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/5/passengers`, {
    passengers: [{ name: "Lea Roy", isPayer: true, idNumber: "P555" }],
  });
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

  // ---- 05: compras recibidas = recepciones exactas ($84 parcial + $18)
  const tanqueray = await id("Tanqueray (botella)");
  const cp1 = await api("adm", "POST", "/purchases", {
    supplier: "Distribuidora", document: "001-001-1", idempotencyKey: "cp-001",
    lines: [{ productId: tanqueray, containers: 4, containerCost: 28 }],
  });
  await api("adm", "POST", `/purchases/${cp1.data.purchase._id}/receive`, { key: "r1", lines: [{ index: 0, containers: 3 }] });
  const cp2 = await api("adm", "POST", "/purchases", {
    supplier: "Distribuidora", document: "001-001-2", idempotencyKey: "cp-002",
    lines: [{ productId: coke, containers: 30, containerCost: 0.6 }],
  });
  await api("adm", "POST", `/purchases/${cp2.data.purchase._id}/receive`, { key: "r2", lines: [{ index: 0, containers: 30 }] });
  const { StockMovement } = await import("../src/models/stockMovement.model");
  const oldWay = (await StockMovement.find({ type: "compra", qty: { $gt: 0 } })).reduce((s, m) => s + m.qty * m.unitCost, 0);
  const today = dates.commercialDateKey();
  const period = (await api("duena", "GET", `/reports/owner?from=${today}&to=${today}`)).data;
  check(
    "Compras: $84 (CP-001 parcial) + $18 (CP-002) = $102 exactos",
    period.purchases === 102 && period.details.purchases.length === 2 && period.details.purchases[0].amount === 84 && period.details.purchases[0].partial === true && period.details.purchases[1].amount === 18,
    { purchases: period.purchases, antes: Math.round(oldWay * 100) / 100 },
  );

  // ---- P09: el exceso se rechaza con qué hacer; lo pendiente se cierra con motivo
  const excess = await api("adm", "POST", `/purchases/${cp1.data.purchase._id}/receive`, { key: "r-x", lines: [{ index: 0, containers: 2 }] });
  check(
    "Recibir de más: rechazo con texto claro",
    excess.status === 400 && /solo queda 1 botella por recibir/.test(excess.data.message) && /compra nueva/.test(excess.data.message),
    excess.data.message,
  );
  const noReason = await api("adm", "POST", `/purchases/${cp1.data.purchase._id}/cancel`, {});
  check("Cerrar lo pendiente exige motivo", noReason.status === 400);
  const closed = await api("adm", "POST", `/purchases/${cp1.data.purchase._id}/cancel`, { reason: "El proveedor no tiene más" });
  check(
    "Compra recibida en parte: se cierra lo pendiente y lo recibido se conserva",
    closed.status === 200 && closed.data.purchase.status === "cerrada" && closed.data.purchase.lines[0].receivedQty === 3 * closed.data.purchase.lines[0].containerSize,
    closed.data.purchase?.status ?? closed.data.message,
  );
  const fullCancel = await api("adm", "POST", `/purchases/${cp2.data.purchase._id}/cancel`, { reason: "x" });
  check("Una compra recibida completa no se cierra", fullCancel.status === 409, fullCancel.data.message);

  // ---- 08/09/10A: un filtro, cifras que cuadran con su detalle
  const sum = (rows: any[], key: string) => Math.round(rows.reduce((s, r) => s + (r[key] ?? 0), 0) * 100) / 100;
  const byCruise = (await api("duena", "GET", `/reports/owner?cruiseId=${cruiseId}`)).data;
  check(
    "Crucero: consumos $34, cobrado $27,50, por cobrar $6,50",
    byCruise.netConsumption === 34 && byCruise.collected === 27.5 && byCruise.pendingCollection === 6.5 && byCruise.scope.mode === "crucero",
    { net: byCruise.netConsumption, col: byCruise.collected, pend: byCruise.pendingCollection },
  );
  check(
    "Cada cifra suma su detalle (consumos, pagos, por cobrar, por día)",
    sum(byCruise.details.consumption, "amount") === byCruise.netConsumption &&
      sum(byCruise.details.payments, "total") === byCruise.collected &&
      sum(byCruise.details.pending, "amount") === byCruise.pendingCollection &&
      sum(byCruise.byDay, "total") === byCruise.netConsumption,
  );
  check(
    "Alertas con acción: cuentas pendientes y facturas pendientes",
    byCruise.alerts.some((a: any) => a.kind === "cuentas" && a.action === "Ver cuentas pendientes") &&
      byCruise.alerts.some((a: any) => a.kind === "facturas" && a.count === 1),
    byCruise.alerts.map((a: any) => a.kind),
  );
  check("Costos completos: costo y margen calculados", byCruise.consumedCost !== null && byCruise.margin === Math.round((34 - byCruise.consumedCost) * 100) / 100);

  // 10A: la deuda de ayer no es consumo de hoy; cobrarla hoy tampoco.
  const { Order } = await import("../src/models/order.model");
  const yesterday = new Date(Date.now() - 26 * 3600 * 1000);
  await Order.collection.updateMany({ cruise: new mongoose.Types.ObjectId(cruiseId), cabinNumber: 3 }, { $set: { createdAt: yesterday } });
  await api("bar", "POST", `/accounts/${cruiseId}/3/submit`);
  await api("dir", "POST", `/accounts/${cruiseId}/3/approve`);
  await api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 3, method: "transferencia", reference: "TR-1", billing: { idNumber: "P3" } });
  const todayAfter = (await api("duena", "GET", `/reports/owner?from=${today}&to=${today}`)).data;
  check(
    "Cobrar hoy una deuda de ayer no aumenta los consumos de hoy",
    todayAfter.netConsumption === 27.5 && todayAfter.collected === 34 && todayAfter.pendingCollection === 0,
    { net: todayAfter.netConsumption, col: todayAfter.collected },
  );
  const cutYesterday = dates.commercialDateKey(yesterday);
  const atYesterday = (await api("duena", "GET", `/reports/owner?to=${cutYesterday}`)).data;
  check(
    "Por cobrar es el saldo al corte (ayer debía $6,50)",
    atYesterday.pendingCollection === 6.5 && atYesterday.collected === 0,
    { pend: atYesterday.pendingCollection, col: atYesterday.collected },
  );

  // 10B: un costo desconocido no vale cero.
  const fanta = await id("Fanta");
  await Product.updateOne({ _id: fanta }, { $set: { costPerUnit: 0 } });
  await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: fanta, idempotencyKey: "f-1" });
  const noCost = (await api("duena", "GET", `/reports/owner?cruiseId=${cruiseId}`)).data;
  check(
    "Falta un costo: costo y margen No disponible, producto listado",
    noCost.consumedCost === null && noCost.margin === null && noCost.missingCost.includes("Fanta") && noCost.alerts.some((a: any) => a.kind === "costos"),
    { cost: noCost.consumedCost, missing: noCost.missingCost },
  );
  const empty = (await api("duena", "GET", "/reports/owner?from=2026-01-01&to=2026-01-02")).data;
  check(
    "Sin consumos en el alcance: costo y margen $0 (no 'faltan costos')",
    empty.noConsumption === true && empty.consumedCost === 0 && empty.margin === 0,
    { cost: empty.consumedCost, margin: empty.margin },
  );
  const periodAlerts = (await api("duena", "GET", `/reports/owner?from=${today}&to=${today}`)).data.alerts;
  check(
    "Alertas: facturas pendientes del periodo se rotulan como pendientes en total; las del crucero siguen el filtro",
    periodAlerts.find((a: any) => a.kind === "facturas")?.scope === "total" &&
      noCost.alerts.find((a: any) => a.kind === "facturas")?.scope === "alcance" &&
      noCost.alerts.find((a: any) => a.kind === "costos")?.scope === "alcance",
    periodAlerts.map((a: any) => [a.kind, a.scope]),
  );
  const forbidden = await api("dir", "GET", `/reports/owner?cruiseId=${cruiseId}`);
  check("El resumen solo lo ve Gerencia", forbidden.status === 403);


  // ---- P05: pagos parciales combinando medios; la cuenta se paga al llegar a cero
  const mail = await import("../src/services/accountEmail.service");
  const sent: any[] = [];
  mail.setMailTransport(async (options) => {
    sent.push(options);
    return { id: `stub-${sent.length}` };
  });
  await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 4, productId: coke, idempotencyKey: "c4-0" });
  await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 4, productId: ginTonic, idempotencyKey: "c4-1" });
  await api("bar", "POST", `/accounts/${cruiseId}/4/submit`);
  await api("dir", "POST", `/accounts/${cruiseId}/4/approve`);
  const acc4 = (await api("dir", "GET", `/accounts/${cruiseId}/4`)).data.account;
  check("Cabina 4 aprobada por $21", acc4.status === "aprobada" && acc4.due === 21 && acc4.readyToCollect, acc4.due);
  const collect4 = (body: Record<string, unknown>) =>
    api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 4, ...body });

  const zero = await collect4({ method: "efectivo", cashConfirmed: true, amount: 0 });
  check("Monto 0: Introduce una cantidad mayor que cero.", zero.status === 400 && zero.data.message === "Introduce una cantidad mayor que cero.", zero.data.message);
  const over = await collect4({ method: "efectivo", cashConfirmed: true, amount: 25 });
  check("Monto mayor que el saldo: rechazado con el saldo", over.status === 400 && /\$21\.00/.test(over.data.message), over.data.message);

  const part1 = await collect4({ method: "efectivo", cashConfirmed: true, amount: 10, expectedDue: 21 });
  check(
    "Pago parcial $10 en efectivo: saldo $11, sin factura propia",
    part1.status === 201 && part1.data.settled === false && part1.data.due === 11 && part1.data.payment.invoiceStatus === "parcial",
    { status: part1.status, due: part1.data.due },
  );
  const after1 = (await api("dir", "GET", `/accounts/${cruiseId}/4`)).data.account;
  check(
    "Con saldo la cuenta sigue aprobada: pagado $10, por cobrar $11",
    after1.status === "aprobada" && after1.paid === 10 && after1.due === 11 && after1.partialPaid === 10 && after1.readyToCollect &&
      after1.history.some((h: any) => h.action === "pago_parcial"),
    { status: after1.status, paid: after1.paid, due: after1.due },
  );
  const again = await collect4({ method: "efectivo", cashConfirmed: true, amount: 10, expectedDue: 21 });
  check("Segundo clic con el saldo anterior: no registra otro pago", again.status === 409 && (await Payment.countDocuments({ cruise: cruiseId, cabinNumber: 4 })) === 1, again.data.message);
  const [c1, c2] = await Promise.all([
    collect4({ method: "tarjeta", amount: 5, expectedDue: 11 }),
    collect4({ method: "tarjeta", amount: 5, expectedDue: 11 }),
  ]);
  check("Doble clic simultáneo en un pago parcial: uno solo", [c1.status, c2.status].sort().join() === "201,409", [c1.status, c2.status]);
  const retryPartial = await api("dir", "POST", `/payments/${part1.data.payment._id}/retry-invoice`);
  check("Un pago parcial no se factura solo", retryPartial.status === 400, retryPartial.data.message);

  const last = await collect4({ method: "transferencia", reference: "TR-44", amount: 6, expectedDue: 6 });
  check("Último pago $6 por transferencia: saldo $0", last.status === 201 && last.data.settled === true && last.data.due === 0, last.data);
  const paid4 = (await api("dir", "GET", `/accounts/${cruiseId}/4`)).data.account;
  check(
    "Cuenta Pagada con 3 pagos conservados: $10 + $5 + $6 = $21",
    paid4.status === "cobrada" && paid4.paid === 21 && paid4.due === 0 && paid4.consumed === 21 && paid4.payments.length === 3 &&
      paid4.payments.map((p: any) => p.method).join() === "efectivo,tarjeta,transferencia" && paid4.paidOrders.length === 2,
    { status: paid4.status, paid: paid4.paid, methods: paid4.payments.map((p: any) => p.method) },
  );
  const group = await Payment.find({ cruise: cruiseId, cabinNumber: 4 }).sort({ createdAt: 1 });
  const liquidator = group[2]!;
  check(
    "Una factura por el total al liquidar: el último pago lleva $21 y los parciales van dentro",
    liquidator.invoiceStatus === "pendiente" && liquidator.accountTotal === 21 &&
      group.every((p) => p.settled && p.settledBy?.equals(liquidator._id)) &&
      group.slice(0, 2).every((p) => p.invoiceStatus === "parcial"),
    group.map((p) => [p.total, p.invoiceStatus, p.settled]),
  );
  const { invoiceCobros, invoiceAmount } = await import("../src/services/contifico.service");
  const cobros = await invoiceCobros(liquidator as any);
  check(
    "Factura (sin llamar a Contífico): importe $21 y un cobro por pago identificable",
    invoiceAmount(liquidator) === 21 &&
      cobros[0]!.forma_cobro === "EF" && cobros[0]!.monto === 10 &&
      // Sin procesador ni cuenta bancaria, tarjeta y transferencia quedan por cobrar en Contífico.
      cobros.length === 1,
    cobros,
  );
  const row4 = (await api("dir", "GET", `/accounts/${cruiseId}`)).data.cabins.find((r: any) => r.cabinNumber === 4);
  check("Lista de cuentas: cabina 4 pagada $21, saldo $0", row4.status === "cobrada" && row4.paid === 21 && row4.due === 0, row4);
  const pre4 = await proformaData(cruiseId, 4);
  const pub4 = (await api("anon", "GET", `/public/account/${(await Cruise.findById(cruiseId))!.cabins.find((c) => c.number === 4)!.accountToken}`)).data;
  check(
    "Prefactura y QR listan los 3 pagos y saldo $0",
    pre4.payments.length === 3 && pre4.paid === 21 && pre4.balance === 0 && pub4.account.payments.length === 3 && pub4.account.due === 0,
    { pre: pre4.payments.length, pub: pub4.account.payments.length },
  );

  // ---- Resumen por correo al pagador (transporte de prueba)
  const m = sent[0];
  check(
    "Al quedar Pagada se envía un solo resumen al pagador",
    sent.length === 1 && m.to === "pax4@example.com" && m.subject === "Your onboard account · Treasure of Galápagos · Cabin 4",
    sent.map((x) => x.to),
  );
  check(
    "Resumen: saludo, productos, total, pagos, saldo $0.00 y nota",
    /Dear John Smith/.test(m.html) && /Coca Cola/.test(m.html) && /\$21\.00/.test(m.html) && /Payments received/.test(m.html) &&
      /Bank transfer/.test(m.html) && /Balance due/.test(m.html) && /\$0\.00/.test(m.html) &&
      /not a tax invoice/.test(m.html) && /brand\/seal-pine\.png/.test(m.html),
  );
  check(
    "Resumen: adjunta la prefactura en PDF",
    m.attachments?.length === 1 && /\.pdf$/.test(m.attachments[0].filename) && m.attachments[0].content.subarray(0, 4).toString() === "%PDF",
  );
  const sentPay = await Payment.findById(liquidator._id);
  check(
    "Envío guardado en el pago que liquida",
    sentPay!.summaryEmail.status === "enviado" && sentPay!.summaryEmail.to === "pax4@example.com" && Boolean(sentPay!.summaryEmail.sentAt),
    sentPay!.summaryEmail,
  );
  const auto = await mail.sendAccountSummary(liquidator._id, null);
  check("El envío automático no se repite para la misma liquidación", auto.status === "omitido" && sent.length === 1);
  const resend = await api("dir", "POST", `/payments/${liquidator._id}/resend-summary`);
  check("Reenviar resumen por correo (Dirección)", resend.status === 200 && resend.data.email.status === "enviado" && sent.length === 2, resend.data);
  const barResend = await api("bar", "POST", `/payments/${liquidator._id}/resend-summary`);
  check("El bar no reenvía el resumen", barResend.status === 403);
  mail.setMailTransport(async () => {
    throw new Error("Resend: servicio caído");
  });
  const failed = await api("duena", "POST", `/payments/${liquidator._id}/resend-summary`);
  const failedAcc = (await api("dir", "GET", `/accounts/${cruiseId}/4`)).data.account;
  check(
    "Si el correo falla: queda 'Correo no enviado: causa' en la cuenta",
    failed.status === 200 && failed.data.email.status === "error" &&
      failedAcc.history.some((h: any) => h.action === "correo_no_enviado" && h.reason === "Correo no enviado: Resend: servicio caído") &&
      failedAcc.payments[2].summaryEmail.status === "error",
    failed.data.email,
  );
  mail.setMailTransport(null);
  const unconfigured = await api("dir", "POST", `/payments/${liquidator._id}/resend-summary`);
  check(
    "Sin RESEND_API_KEY no se envía nada real",
    unconfigured.data.email?.status === "error" && /no está configurado/.test(unconfigured.data.email.error),
    unconfigured.data.email,
  );

  // ---- Reversos con pagos parciales
  const revPartial = await api("duena", "POST", `/payments/${group[0]!._id}/reverse`, { reason: "Prueba" });
  check("Un parcial de una cuenta pagada se reversa después del pago final", revPartial.status === 409, revPartial.data.message);
  const revLast = await api("duena", "POST", `/payments/${liquidator._id}/reverse`, { reason: "Transferencia no llegó" });
  const reopened = (await api("dir", "GET", `/accounts/${cruiseId}/4`)).data.account;
  check(
    "Reversar el pago final reabre la cuenta con saldo $6 y conserva los parciales",
    revLast.status === 200 && reopened.status === "abierta" && reopened.due === 6 && reopened.partialPaid === 15 && reopened.paid === 15,
    { status: reopened.status, due: reopened.due, partial: reopened.partialPaid },
  );
  const report4 = (await api("duena", "GET", `/reports/owner?cruiseId=${cruiseId}`)).data;
  const pend4 = report4.details.pending.find((p: any) => p.cabin === 4);
  check(
    "Resumen del negocio: por cobrar de la cabina 4 descuenta los pagos parciales",
    pend4?.amount === 6 && sum(report4.details.pending, "amount") === report4.pendingCollection,
    { pend4, total: report4.pendingCollection },
  );


  // ---- Modificar / Aprobar en la misma cuenta: retiro con motivo, cortesía, aprobar y cobrar
  for (const [i, pid] of [coke, coke, ginTonic].entries()) {
    await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 5, productId: pid, idempotencyKey: `c5-${i}` });
  }
  const barApprove = await api("bar", "POST", `/accounts/${cruiseId}/5/approve`);
  check("El bar no aprueba", barApprove.status === 403);
  let acc5 = (await api("dir", "GET", `/accounts/${cruiseId}/5`)).data.account;
  check("Cabina 5 abierta con $27,50", acc5.status === "abierta" && acc5.due === 27.5, acc5.due);
  const cokeOrders = acc5.orders.filter((o: any) => o.items[0].name === "Coca Cola");
  const { StockMovement: SM } = await import("../src/models/stockMovement.model");
  const movesBefore = await SM.countDocuments({});
  const retire = await api("dir", "POST", `/consumptions/${cokeOrders[0].id}/undo`, { reason: "El pasajero dice que no la pidió" });
  acc5 = (await api("dir", "GET", `/accounts/${cruiseId}/5`)).data.account;
  const retireEvent = acc5.history.find((h: any) => h.action === "cargo_cambiado" && /Consumo retirado/.test(h.reason));
  check(
    "Retirar (no se sirvió): total $21 al instante y registro con quién, qué y motivo",
    retire.status === 200 && acc5.due === 21 && retireEvent?.reason === "Consumo retirado (no se sirvió): 1× Coca Cola · El pasajero dice que no la pidió" &&
      retireEvent.by === "Dirección" && Boolean(retireEvent.at),
    { due: acc5.due, retireEvent },
  );
  check("Retirar lo no servido devuelve ingredientes (reverso de stock)", (await SM.countDocuments({})) > movesBefore);
  const movesServed = await SM.countDocuments({});
  const courtesy = await api("dir", "POST", `/consumptions/${cokeOrders[1].id}/bonify`, { reason: "Retirado por reclamo (se sirvió): Compensación al pasajero" });
  acc5 = (await api("dir", "GET", `/accounts/${cruiseId}/5`)).data.account;
  check(
    "Retirar lo servido = cortesía: total $14,50, stock sigue descontado, queda en historial",
    courtesy.status === 200 && acc5.due === 14.5 && acc5.courtesyTotal === 6.5 && (await SM.countDocuments({})) === movesServed &&
      acc5.history.some((h: any) => h.reason === "Cortesía: 1× Coca Cola · Retirado por reclamo (se sirvió): Compensación al pasajero"),
    { due: acc5.due, courtesy: acc5.courtesyTotal },
  );
  const approveDirect = await api("dir", "POST", `/accounts/${cruiseId}/5/approve`);
  const approvedEvent = approveDirect.data.account?.history.at(-1);
  check(
    "Aprobar desde abierta en un toque: lista para cobrar y 'Aprobada' con quién",
    approveDirect.status === 200 && approveDirect.data.account.status === "aprobada" && approveDirect.data.account.readyToCollect &&
      approvedEvent.action === "aprobada" && approvedEvent.by === "Dirección",
    approveDirect.data.message ?? approvedEvent,
  );
  const twice = await api("dir", "POST", `/accounts/${cruiseId}/5/approve`);
  check("Aprobar dos veces: la segunda se rechaza", twice.status === 409);
  const barCollect = await api("bar", "POST", "/payments/collect", { cruiseId, cabinNumber: 5, method: "efectivo", cashConfirmed: true });
  check("El bar no cobra", barCollect.status === 403);
  await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 5, productId: coke, idempotencyKey: "c5-late" });
  acc5 = (await api("dir", "GET", `/accounts/${cruiseId}/5`)).data.account;
  check(
    "Un cargo nuevo tras aprobar anula la aprobación",
    acc5.status === "abierta" && !acc5.readyToCollect && acc5.due === 21 &&
      acc5.history.some((h: any) => h.action === "invalidada" && /^Aprobación anulada: Consumo/.test(h.reason)),
    { status: acc5.status, due: acc5.due },
  );
  const stale = await api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 5, method: "efectivo", cashConfirmed: true });
  check("Sin nueva aprobación no se cobra", stale.status === 409);
  await api("dir", "POST", `/accounts/${cruiseId}/5/approve`);
  const pay5 = await api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 5, method: "efectivo", cashConfirmed: true, expectedDue: 21 });
  acc5 = (await api("dir", "GET", `/accounts/${cruiseId}/5`)).data.account;
  check("Aprobar → Cobrar en el mismo flujo: Pagada", pay5.status === 201 && acc5.status === "cobrada" && acc5.paid === 21 && acc5.due === 0, pay5.data.message);

  // ---- Pedido 31-oct: el bar corrige en cuenta abierta (Cortesía / Retirar consumo); aprobar y cobrar no
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/6/passengers`, {
    passengers: [{ name: "Pasajero Seis", isPayer: true, idNumber: "P666" }],
  });
  for (const [i, pid] of [coke, coke, ginTonic].entries()) {
    await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 6, productId: pid, idempotencyKey: `c6-${i}` });
  }
  const barCourtesyTap = await api("bar", "POST", "/consumptions", {
    cruiseId, cabinNumber: 6, productId: coke, courtesy: true, courtesyReason: "Cumpleaños del pasajero", idempotencyKey: "c6-gift",
  });
  let acc6 = (await api("bar", "GET", `/accounts/${cruiseId}/6`)).data.account;
  check(
    "El bar registra una bebida directo como cortesía (con motivo): no suma al total",
    barCourtesyTap.status === 201 && barCourtesyTap.data.order.total === 0 && barCourtesyTap.data.order.items[0].courtesy === true &&
      acc6.due === 27.5 && acc6.courtesyTotal === 6.5 &&
      acc6.history.some((h: any) => h.reason === "Consumo como cortesía: 1× Coca Cola · Cumpleaños del pasajero" && h.by === "Bar"),
    { due: acc6.due, courtesy: acc6.courtesyTotal },
  );
  const recent6 = (await api("bar", "GET", `/consumptions/summary/${cruiseId}/6`)).data.summary;
  check(
    "La barra del bar lista los consumos recientes con Cortesía / Retirar disponibles",
    recent6.recent.length === 4 && recent6.recent.every((r: any) => r.canUndo) &&
      recent6.recent[0].canCourtesy === false && recent6.recent[1].canCourtesy === true,
    recent6.recent,
  );
  check(
    "El bar ve cada consumo de la cabina con su bebida, precio y si es de hoy (31-oct)",
    recent6.recent.every((r: any) => r.productId && r.unitPrice > 0 && r.today === true) &&
      recent6.recent.filter((r: any) => r.productId === coke).length === 3 && recent6.tripTotal === 27.5,
    recent6.recent.map((r: any) => [r.name, r.unitPrice, r.today]),
  );
  // Más consumos que el límite viejo de 8: el bar ve todos, no solo los recientes.
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/7/passengers`, { passengers: [{ name: "Lucía", isPayer: true }] });
  const pilsener = await id("Pilsener");
  for (let i = 0; i < 9; i++) {
    await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 7, productId: pilsener, idempotencyKey: `c7-${i}` });
  }
  const all7 = (await api("bar", "GET", `/consumptions/summary/${cruiseId}/7`)).data.summary;
  check("El resumen de la cabina trae todos los consumos (9 de 9)", all7.recent.length === 9 && all7.tripTotal === 58.95, all7.recent.length);
  const cokes6 = acc6.orders.filter((o: any) => o.items[0].name === "Coca Cola" && !o.items[0].courtesy);
  const barRetire = await api("bar", "POST", `/consumptions/${cokes6[0].id}/undo`, { reason: "Cabina equivocada" });
  acc6 = (await api("bar", "GET", `/accounts/${cruiseId}/6`)).data.account;
  check(
    "El bar retira cualquier consumo de la cuenta abierta: total recalculado y en el historial",
    barRetire.status === 200 && acc6.due === 21 &&
      acc6.history.some((h: any) => h.reason === "Consumo retirado (no se sirvió): 1× Coca Cola · Cabina equivocada" && h.by === "Bar"),
    { status: barRetire.status, due: acc6.due, msg: barRetire.data.message },
  );
  const barBonify = await api("bar", "POST", `/consumptions/${cokes6[1].id}/bonify`, { reason: "Cortesía de la casa" });
  acc6 = (await api("bar", "GET", `/accounts/${cruiseId}/6`)).data.account;
  check(
    "El bar marca cortesía en la cuenta abierta: total recalculado",
    barBonify.status === 200 && acc6.due === 14.5 && acc6.courtesyTotal === 13 &&
      acc6.history.some((h: any) => h.reason === "Cortesía: 1× Coca Cola · Cortesía de la casa" && h.by === "Bar"),
    { status: barBonify.status, due: acc6.due, msg: barBonify.data.message },
  );
  const barNoReason = await api("bar", "POST", `/consumptions/${cokes6[1].id}/bonify`, {});
  check("Cortesía sin motivo: se rechaza", barNoReason.status === 400);
  const barApprove6 = await api("bar", "POST", `/accounts/${cruiseId}/6/approve`);
  check("El bar no aprueba (403)", barApprove6.status === 403);
  const approve6 = await api("dir", "POST", `/accounts/${cruiseId}/6/approve`);
  check("Dirección aprueba directo desde abierta", approve6.status === 200 && approve6.data.account.status === "aprobada");
  const gin6 = acc6.orders.find((o: any) => o.items[0].name === "Gin Tonic");
  const barRetireApproved = await api("bar", "POST", `/consumptions/${gin6.id}/undo`, { reason: "Prueba" });
  const barBonifyApproved = await api("bar", "POST", `/consumptions/${gin6.id}/bonify`, { reason: "Prueba" });
  check(
    "Con la cuenta aprobada el bar ya no retira ni marca cortesía (403)",
    barRetireApproved.status === 403 && barBonifyApproved.status === 403,
    [barRetireApproved.status, barBonifyApproved.status],
  );
  const recentApproved = (await api("bar", "GET", `/consumptions/summary/${cruiseId}/6`)).data.summary;
  check("En el bar la cuenta aprobada no ofrece correcciones", recentApproved.recent.every((r: any) => !r.canUndo && !r.canCourtesy));
  const barCollect6 = await api("bar", "POST", "/payments/collect", { cruiseId, cabinNumber: 6, method: "efectivo", cashConfirmed: true });
  check("El bar no cobra (403)", barCollect6.status === 403);
  const dirBonifyApproved = await api("dir", "POST", `/consumptions/${gin6.id}/bonify`, { reason: "Compensación al pasajero" });
  acc6 = (await api("dir", "GET", `/accounts/${cruiseId}/6`)).data.account;
  check(
    "Dirección corrige la cuenta aprobada: cortesía recalcula y anula la aprobación",
    dirBonifyApproved.status === 200 && acc6.status === "abierta" && acc6.due === 0 && !acc6.readyToCollect &&
      acc6.history.some((h: any) => h.action === "invalidada" && /^Aprobación anulada: Cortesía/.test(h.reason)),
    { status: acc6.status, due: acc6.due },
  );
  const paidOrder = acc5.paidOrders[0];
  const retirePaid = await api("dir", "POST", `/consumptions/${paidOrder.id}/undo`, { reason: "Prueba" });
  const bonifyPaid = await api("dir", "POST", `/consumptions/${paidOrder.id}/bonify`, { reason: "Prueba" });
  check("Lo pagado no se retira ni se marca cortesía (409)", retirePaid.status === 409 && bonifyPaid.status === 409, [retirePaid.status, bonifyPaid.status]);

  // ---- Vinos por tipo y cócteles creados en el bar (31-oct)
  const wine = async (name: string) => (await Product.findOne({ name }))!.wineStyle;
  check(
    "El catálogo trae cada vino con su tipo (tinto, blanco, rosado, espumante)",
    (await wine("Reservado Merlot (copa)")) === "tinto" && (await wine("Chardonnay Casillero (botella)")) === "blanco" &&
      (await wine("Rosé D'Anjou (botella)")) === "rosado" && (await wine("Henkell Trocken Dry Piccolo 200ml")) === "espumante",
  );
  const merlot = await id("Merlot Casillero (botella)");
  const restyle = await api("duena", "PATCH", `/products/${merlot}`, { wineStyle: "rosado" });
  const badStyle = await api("duena", "PATCH", `/products/${merlot}`, { wineStyle: "naranja" });
  const styleOnBeer = await api("duena", "PATCH", `/products/${await id("Club")}`, { wineStyle: "tinto" });
  check(
    "Gerencia cambia el tipo de vino; uno inválido se rechaza y fuera de vinos no aplica",
    restyle.status === 200 && restyle.data.product.wineStyle === "rosado" && badStyle.status === 400 &&
      styleOnBeer.status === 200 && styleOnBeer.data.product.wineStyle === "",
    [restyle.status, badStyle.status, styleOnBeer.data.product?.wineStyle],
  );
  const custom = await api("bar", "POST", "/products/custom-cocktail", {
    name: "Sunset de prueba",
    recipe: [{ product: await id("Bacardi (botella)"), qty: 60 }, { product: await id("Jugo de naranja"), qty: 90 }],
  });
  const notCustom = await api("bar", "POST", `/products/${ginTonic}/remove-custom`);
  const bodegaRemove = await api("adm", "POST", `/products/${custom.data.product._id}/remove-custom`);
  const removed = await api("bar", "POST", `/products/${custom.data.product._id}/remove-custom`);
  const listed = (await api("bar", "GET", "/products")).data.products.some((p: any) => p._id === custom.data.product._id);
  check(
    "El bar elimina el cóctel que creó (sale de la carta); los de la carta oficial no",
    custom.status === 201 && removed.status === 200 && removed.data.product.active === false && !listed &&
      notCustom.status === 403 && bodegaRemove.status === 403,
    [custom.status, removed.status, notCustom.status, bodegaRemove.status, listed],
  );

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
