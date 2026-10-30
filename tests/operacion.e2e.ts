/**
 * Prueba de entrega de la guía auditada (27-oct-2026) contra un Mongo en
 * memoria con réplica (las transacciones lo exigen) y la API real:
 *
 *   npx ts-node-dev --transpile-only tests/operacion.e2e.ts
 *
 * Cubre: inicio con pasajeros, varias cabinas, 2 Gin Tonic con stock exacto,
 * falta de gin sin cargo parcial, reintento sin duplicar, Deshacer,
 * requerimiento aprobado sin aumento ficticio y su recepción, compra en dos
 * pasos con costo, cierre con deuda, envío tardío retenido y la salida
 * siguiente sin mezcla.
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
  const { syncCatalogV3 } = await import("../src/scripts/catalog-v3");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const mk = (email: string, role: string, name: string) =>
    User.create({ email, role, name, passwordHash: hash, active: true });
  const owner = await mk("duena@t", "duena", "Paula");
  await mk("dir@t", "direccion", "Directora");
  await mk("bar@t", "bartender", "Bartender");
  await mk("bar2@t", "bartender", "Bartender 2");
  await mk("adm@t", "admin", "Administradora");
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
  for (const [who, email] of Object.entries({ duena: "duena@t", dir: "dir@t", bar: "bar@t", bar2: "bar2@t", adm: "adm@t" })) {
    const r = await api(who, "POST", "/auth/login", { email, password: "x", remember: who === "bar" });
    tokens[who] = r.data.token;
  }
  const refreshed = await api("bar", "POST", "/auth/refresh");
  check("Mantener sesión: el token se renueva", refreshed.status === 200 && Boolean(refreshed.data.token));

  const id = async (name: string) => (await Product.findOne({ name }))!._id.toString();
  const gin = await id("Tanqueray (botella)");
  const tonic = await id("Agua tónica");
  const lime = await id("Limón (rodaja)");
  const ginTonic = await id("Gin Tonic");
  const coke = await id("Coca Cola");
  const can = (await Product.findById(coke))!.containerSize || 1;
  const stock = async (pid: string) => {
    const p = await Product.findById(pid).lean();
    return { bodega: p!.warehouseStock, abordo: p!.onboardStock };
  };

  // ---- Compra en dos pasos: la factura no suma; la recepción sí, con costo
  const purchase = await api("adm", "POST", "/purchases", {
    supplier: "Distribuidora",
    document: "001-001-123",
    destination: "bodega",
    idempotencyKey: "cp-1",
    lines: [
      { productId: gin, containers: 2, containerCost: 18 },
      { productId: tonic, containers: 2, containerCost: 0.7 },
      { productId: lime, containers: 10, containerCost: 0.05 },
      { productId: coke, containers: 4, containerCost: 0.6 },
    ],
  });
  check("Compra registrada", purchase.status === 201, purchase.data.message);
  check("Factura sin recepción no aumenta stock", (await stock(gin)).bodega === 0, await stock(gin));
  const pid = purchase.data.purchase._id;
  const receiveBody = { key: "rx-1", lines: [0, 1, 2, 3].map((index) => ({ index, containers: [2, 2, 10, 4][index] })) };
  const rec = await api("adm", "POST", `/purchases/${pid}/receive`, receiveBody);
  const rec2 = await api("adm", "POST", `/purchases/${pid}/receive`, receiveBody);
  check("Recepción suma a bodega: Tanqueray +1.500 ml", (await stock(gin)).bodega === 1500, await stock(gin));
  check("A bordo sin cambio tras la compra", (await stock(gin)).abordo === 0);
  check("Recepción repetida no duplica", rec.status === 200 && rec2.data.duplicated === true && (await stock(gin)).bodega === 1500);
  const ginCost = (await Product.findById(gin))!.costPerUnit;
  check("Costo por ml de Tanqueray = 18/750", Math.abs(ginCost - 0.024) < 1e-6, ginCost);

  // ---- Cargar al barco: bodega − y a bordo +, total sin cambio
  const t = await api("adm", "POST", "/inventory/transfer", {
    key: "tr-1",
    items: [
      { productId: gin, qty: 1500 },
      { productId: tonic, qty: 710 },
      { productId: lime, qty: 10 },
      { productId: coke, qty: 4 * can },
    ],
  });
  check("Traslado bodega → a bordo", t.status === 201, t.data.message);
  const g = await stock(gin);
  check("Bodega −1.500 y a bordo +1.500", g.bodega === 0 && g.abordo === 1500, g);
  const over = await api("adm", "POST", "/inventory/transfer", { items: [{ productId: gin, qty: 10 }] });
  check("Bodega nunca queda en negativo", over.status === 409 && over.data.code === "sin_stock", over.data);

  // ---- Salida: pasajeros, validaciones e inicio una sola vez
  const gen = await api("dir", "POST", "/cruises", { name: "Prueba A", startDate: "2026-11-01" });
  const cruiseId = gen.data.cruise._id;
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/2/passengers`, { passengers: [{ name: "Ana", isPayer: true }, { name: "Luis" }] });
  await api("dir", "PUT", `/cruises/${cruiseId}/cabins/3/passengers`, { passengers: [{ name: "Marta", isPayer: true }] });
  const dup = await api("dir", "PUT", `/cruises/${cruiseId}/cabins/4/passengers`, { passengers: [{ name: "Ana" }] });
  check("Pasajero duplicado en la salida se rechaza", dup.status === 400, dup.data.message);
  const cap = await api("dir", "PUT", `/cruises/${cruiseId}/cabins/5/passengers`, { passengers: [{ name: "A1" }, { name: "A2" }, { name: "A3" }] });
  check("No se supera la capacidad de la cabina", cap.status === 400, cap.data.message);

  const early = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: coke, idempotencyKey: "early" });
  check("Salida programada no acepta consumos", early.status === 400, early.data.message);

  const [s1, s2] = await Promise.all([
    api("dir", "POST", `/cruises/${cruiseId}/start`),
    api("dir", "POST", `/cruises/${cruiseId}/start`),
  ]);
  check("Doble toque en Iniciar no duplica", [s1.status, s2.status].every((x) => x === 200), [s1.data.message, s2.data.message]);
  const started = await api("dir", "GET", `/cruises/${cruiseId}`);
  check("Programada pasa a En curso con responsable y hora", started.data.cruise.status === "abordo" && Boolean(started.data.cruise.startedAt));

  const empty = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 7, productId: coke, idempotencyKey: "empty" });
  check("Cabina vacía no acepta consumos", empty.status === 400);

  // ---- 2 Gin Tonic con stock exacto
  const gt1 = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: ginTonic, idempotencyKey: "gt-1" });
  const gt2 = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: ginTonic, idempotencyKey: "gt-2" });
  const retry = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: ginTonic, idempotencyKey: "gt-2" });
  check("Consumo directo registrado", gt1.status === 201 && gt2.status === 201, [gt1.data.message, gt2.data.message]);
  check("Reintento con el mismo identificador no duplica", retry.status === 200 && retry.data.duplicated === true);
  const [sg, st, sl] = [await stock(gin), await stock(tonic), await stock(lime)];
  check("2 Gin Tonic: gin 1.500 → 1.380 ml", sg.abordo === 1380, sg);
  check("2 Gin Tonic: tónica 710 → 410 ml", st.abordo === 410, st);
  check("2 Gin Tonic: limón 10 → 8 rodajas", sl.abordo === 8, sl);
  check("Cuenta de cabina 2 +$29", gt2.data.summary.tripTotal === 29, gt2.data.summary);
  const moves = await mongoose.connection.collection("stockmovements").countDocuments({ type: "venta", order: { $exists: true } });
  check("Bitácora muestra las salidas vinculadas (3 insumos × 2)", moves === 6, moves);
  check("El consumo guarda receta, precio y costo aplicados", gt1.data.order.items[0].applied.length === 3 && gt1.data.order.items[0].costComplete === true);

  // Cambiar a cabina 3 en paralelo no mueve lo de la cabina 2
  await Promise.all([
    api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: coke, idempotencyKey: "c2-a" }),
    api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 3, productId: coke, idempotencyKey: "c3-a" }),
  ]);
  const s2sum = await api("bar", "GET", `/consumptions/summary/${cruiseId}/2`);
  const s3sum = await api("bar", "GET", `/consumptions/summary/${cruiseId}/3`);
  check("Cada consumo queda en su cabina", s2sum.data.summary.tripTotal === 35.5 && s3sum.data.summary.tripTotal === 6.5, [s2sum.data.summary.tripTotal, s3sum.data.summary.tripTotal]);

  // ---- Falta gin: no se guarda nada ni se descuentan los otros insumos
  await api("duena", "POST", "/inventory/adjust", { productId: gin, qty: -1350, reason: "Prueba: dejar 30 ml", location: "abordo" });
  const tonicBefore = (await stock(tonic)).abordo;
  const short = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: ginTonic, idempotencyKey: "gt-3" });
  check("Sin gin suficiente: no se guarda", short.status === 409 && short.data.code === "sin_stock", short.data);
  check("Sin cargo parcial ni descuento de tónica", (await stock(tonic)).abordo === tonicBefore && (await api("bar", "GET", `/consumptions/summary/${cruiseId}/2`)).data.summary.tripTotal === 35.5);
  const avail = await api("bar", "GET", "/consumptions/availability");
  check("Gin Tonic aparece no disponible (solo ese producto)", avail.data.availability[ginTonic].available === false && avail.data.availability[coke].available === true, avail.data.availability[ginTonic]);
  const rv = await api("bar", "POST", "/requisitions", { kind: "revision", lines: [{ productId: gin, qty: 0 }], note: "Hay una botella abierta en la barra" });
  check("El bar puede pedir revisión de inventario", rv.status === 201 && rv.data.requisition.code.startsWith("RV-"));

  // ---- Deshacer: solo lo propio y con cuenta abierta; revierte cargo y stock
  const otherUndo = await api("bar2", "POST", `/consumptions/${gt2.data.order._id}/undo`, {});
  check("Otro bartender no deshace lo ajeno", otherUndo.status === 403);
  const undo = await api("bar", "POST", `/consumptions/${gt2.data.order._id}/undo`, { reason: "Error de cabina" });
  check("Deshacer revierte cargo", undo.status === 200 && undo.data.summary.tripTotal === 21, undo.data.summary ?? undo.data);
  check("Deshacer devuelve ingredientes (gin +60, tónica +150, limón +1)", (await stock(gin)).abordo === 90 && (await stock(tonic)).abordo === 560 && (await stock(lime)).abordo === 9, [await stock(gin), await stock(tonic), await stock(lime)]);

  // ---- Requerimiento: aprobar no suma; recibir traslada lo real
  await api("adm", "POST", "/purchases", { supplier: "D", document: "2", idempotencyKey: "cp-2", lines: [{ productId: coke, containers: 24, containerCost: 0.6 }] })
    .then((r) => api("adm", "POST", `/purchases/${r.data.purchase._id}/receive`, { key: "rx-2", lines: [{ index: 0, containers: 24 }] }));
  const rq = await api("bar", "POST", "/requisitions", { lines: [{ productId: coke, qty: 12 }], idempotencyKey: "rq-1" });
  check("El bar pide en latas y queda en ml", rq.data.requisition.lines[0].qty === 12 * can && rq.data.requisition.lines[0].label.startsWith("12 "), rq.data.requisition.lines[0]);
  const cokeBefore = await stock(coke);
  const ap = await api("dir", "POST", `/requisitions/${rq.data.requisition._id}/review`, { decision: "aprobar" });
  check("Requerimiento aprobado", ap.status === 200 && ap.data.requisition.status === "aprobado");
  check("Aprobar no aumenta stock", JSON.stringify(await stock(coke)) === JSON.stringify(cokeBefore));
  const part = await api("adm", "POST", `/requisitions/${rq.data.requisition._id}/receive`, { key: "rr-1", lines: [{ index: 0, qty: 5 * can }] });
  const partDup = await api("adm", "POST", `/requisitions/${rq.data.requisition._id}/receive`, { key: "rr-1", lines: [{ index: 0, qty: 5 * can }] });
  check("Recepción parcial suma solo lo real al barco", part.data.requisition?.status === "recibido_parcial" && (await stock(coke)).abordo === cokeBefore.abordo + 5 * can, part.data.message);
  check("Recepción repetida no duplica", partDup.data.duplicated === true && (await stock(coke)).abordo === cokeBefore.abordo + 5 * can);
  const rest = await api("adm", "POST", `/requisitions/${rq.data.requisition._id}/receive`, { key: "rr-2", lines: [{ index: 0, qty: 7 * can }] });
  check("Recepción completa", rest.data.requisition.status === "recibido");
  const tooMuch = await api("adm", "POST", `/requisitions/${rq.data.requisition._id}/receive`, { key: "rr-3", lines: [{ index: 0, qty: can }] });
  check("No se recibe más de lo pendiente", tooMuch.status === 409 || tooMuch.status === 400);

  // ---- Cuenta y cobro parcial del viaje: cabina 3 se cobra, cabina 2 queda con deuda
  // Dirección aprueba la cuenta abierta en un solo paso (sin "Enviar a revisión") y cobra.
  const barApprove = await api("bar", "POST", "/accounts/" + cruiseId + "/3/approve");
  check("El bar no aprueba cuentas", barApprove.status === 403);
  const direct = await api("dir", "POST", "/accounts/" + cruiseId + "/3/approve");
  check("Dirección aprueba directo desde abierta", direct.status === 200 && direct.data.account.status === "aprobada" && direct.data.account.readyToCollect, direct.data.message);
  const barPay = await api("bar", "POST", "/payments/collect", { cruiseId, cabinNumber: 3, method: "efectivo", cashConfirmed: true, billing: { idNumber: "0912345678" } });
  check("El bar no cobra", barPay.status === 403);
  const pay = await api("dir", "POST", "/payments/collect", { cruiseId, cabinNumber: 3, method: "efectivo", cashConfirmed: true, billing: { idNumber: "0912345678" } });
  check("La directora cobra (sin depender de cajera)", pay.status === 201, pay.data.message);
  const owner1 = await api("duena", "GET", `/reports/owner?cruiseId=${cruiseId}`);
  check("Panel: consumo neto, cobrado y por cobrar", owner1.data.netConsumption === 27.5 && owner1.data.collected === 6.5 && owner1.data.pendingCollection === 21, owner1.data);
  check("Panel: costo consumido y margen con costos completos", owner1.data.costsComplete === true && owner1.data.margin !== null, owner1.data);
  const ownerForbidden = await api("dir", "GET", "/reports/owner");
  check("El panel de la dueña no lo ve la directora", ownerForbidden.status === 403);

  // ---- Cierre con deuda, envío tardío retenido y salida siguiente sin mezcla
  await api("bar", "POST", "/devices/heartbeat", { deviceId: "tablet-1", label: "Tablet bar", pending: 1, cruiseId });
  const noReason = await api("dir", "POST", `/cruises/${cruiseId}/finish`, {});
  check("Equipo con envíos pendientes exige cierre excepcional con motivo", noReason.status === 400, noReason.data.message);
  const fin = await api("dir", "POST", `/cruises/${cruiseId}/finish`, { reason: "Tablet sin señal en Baltra" });
  check("En curso pasa a Finalizada", fin.status === 200 && fin.data.cruise.status === "cerrado" && Boolean(fin.data.cruise.closedAt));
  check("La cuenta pendiente conserva su saldo", fin.data.summary.totals.due === 21, fin.data.summary.totals);

  const late = await api("bar", "POST", "/consumptions", { cruiseId, cabinNumber: 2, productId: coke, idempotencyKey: "late-1", clientAt: new Date().toISOString() });
  check("Envío tardío queda retenido en su salida original", late.status === 202 && late.data.order.status === "retenida");

  const next = await api("dir", "POST", "/cruises", { name: "Prueba B", startDate: "2026-11-08" });
  const nextId = next.data.cruise._id;
  await api("dir", "PUT", `/cruises/${nextId}/cabins/2/passengers`, { passengers: [{ name: "Pedro", isPayer: true }] });
  const startNext = await api("dir", "POST", `/cruises/${nextId}/start`);
  check("El siguiente crucero inicia aunque haya deuda anterior", startNext.status === 200, startNext.data.message);
  const sumNext = await api("bar", "GET", `/consumptions/summary/${nextId}/2`);
  check("La salida nueva no hereda consumos ni deudas", sumNext.data.summary.tripTotal === 0);
  const heldOk = await api("dir", "POST", `/consumptions/${late.data.order._id}/held-review`, { decision: "aceptar", reason: "Se sirvió antes del cierre" });
  const prevAcc = await api("dir", "GET", `/accounts/${cruiseId}/2`);
  check("Al aceptarlo se carga en la salida original, nunca en la nueva", heldOk.status === 200 && prevAcc.data.account.total === 27.5 && (await api("bar", "GET", `/consumptions/summary/${nextId}/2`)).data.summary.tripTotal === 0, prevAcc.data.account?.total);

  // ---- Permisos
  const price = await api("adm", "PATCH", `/products/${coke}`, { price: 1 });
  check("La administradora no cambia precios", price.status === 403);
  const adj = await api("adm", "POST", "/inventory/adjust", { productId: coke, qty: 1, reason: "x", location: "abordo" });
  check("La administradora no autoriza ajustes", adj.status === 403);

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
