/**
 * Prueba del flujo "Inventario y pedidos" contra la base del .env, con un
 * producto temporal "ZZ Prueba" que se borra al final junto con todo lo que
 * crea (movimientos, compras, pedido semanal de 2099, solicitud, conteo,
 * eventos y contadores de código). No toca el stock real.
 * Uso: npx ts-node --transpile-only tests/inventario-prod.check.ts
 */
import "dotenv/config";
import http from "http";
import jwt from "jsonwebtoken";
import mongoose, { Types } from "mongoose";
import { dbConnect } from "../src/config/mongo";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { User } from "../src/models/user.model";
import { Product } from "../src/models/product.model";
import { StockMovement } from "../src/models/stockMovement.model";
import { Purchase } from "../src/models/purchase.model";
import { WeeklyOrder } from "../src/models/weeklyOrder.model";
import { Requisition } from "../src/models/requisition.model";
import { StockCount } from "../src/models/stockCount.model";
import { ensureWeeklyOrder } from "../src/services/weeklyOrder.service";

let failures = 0;
function check(label: string, ok: boolean, info?: unknown) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FALLA"} ${label}${ok ? "" : ` → ${JSON.stringify(info)?.slice(0, 400)}`}`);
}

async function main() {
  await dbConnect();
  const db = mongoose.connection.db!;
  const t0 = new Date();
  const counters = await db.collection("codecounters").find().toArray();

  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const roles = ["bartender", "direccion", "duena", "admin", "bodega"] as const;
  const tokens: Record<string, string> = {};
  for (const role of roles) {
    const u = await User.findOne({ role, active: true });
    if (!u) throw new Error(`No hay usuario activo con rol ${role}`);
    tokens[role] = jwt.sign({ sub: u._id.toString(), name: u.name, role }, env.JWT_SECRET, { expiresIn: "1h" });
  }
  const api = async (role: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[role]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  };

  const P = await Product.create({
    name: "ZZ Prueba Claude (borrar)", category: "otro", kind: "fisico", sellable: false, stockUnit: "unidad",
    containerSize: 1, containerLabel: "lata", stockTarget: 18, active: true,
  } as never);
  const P2 = await Product.create({
    name: "ZZ Prueba Claude 2 (borrar)", category: "otro", kind: "fisico", sellable: false, stockUnit: "unidad",
    containerSize: 1, containerLabel: "lata", active: true,
  } as never);
  const pid = P._id.toString();
  const stock = async () => {
    const p = (await Product.findById(P._id).lean())!;
    return { quito: p.quitoStock, puerto: p.puertoStock, abordo: p.onboardStock, bodega: p.warehouseStock };
  };
  const created = { purchases: [] as string[], orders: [] as string[], requisitions: [] as string[], counts: [] as string[] };

  try {
    // ---- Existencias y costos por rol
    const sBar = await api("bartender", "GET", "/inventory/stock?location=abordo");
    const mine = sBar.data.items?.find((i: any) => i.product._id === pid);
    check("Existencias trae Quito/Puerto/A bordo por producto", mine && "quito" in mine.byLocation && "puerto" in mine.byLocation, mine);
    check("El bar no ve costos en existencias", sBar.data.items?.every((i: any) => i.product.costPerUnit === undefined));
    const sAdm = await api("admin", "GET", "/inventory/stock?location=abordo");
    check("Administración sí ve costos", sAdm.data.items?.some((i: any) => i.product.costPerUnit !== undefined));
    const prodBar = await api("bartender", "GET", "/products");
    check("Catálogo del bar sin costos", prodBar.data.products?.every((p: any) => p.costPerUnit === undefined));

    // ---- Compra: la factura no suma; recepción parcial en Quito y el resto en Puerto
    const bad = await api("admin", "POST", "/purchases", { supplier: "Prueba", document: "X", destination: "bodega", lines: [{ productId: pid, containers: 1 }] });
    check("No se compra hacia la bodega sin separar", bad.status === 400, bad.data);
    const cp = await api("admin", "POST", "/purchases", {
      supplier: "Proveedor prueba", document: "PRUEBA-001", destination: "quito", idempotencyKey: `zz-cp-${t0.getTime()}`,
      lines: [{ productId: pid, containers: 12, containerCost: 0.5 }],
    });
    check("Compra registrada", cp.status === 201, cp.data);
    created.purchases.push(cp.data.purchase._id);
    check("Factura sin recepción no suma", (await stock()).quito === 0);
    const rx = { key: `zz-rx1-${t0.getTime()}`, lines: [{ index: 0, containers: 8 }], location: "quito" };
    const r1 = await api("bodega", "POST", `/purchases/${cp.data.purchase._id}/receive`, rx);
    const r1b = await api("bodega", "POST", `/purchases/${cp.data.purchase._id}/receive`, rx);
    check("Pedido de 12, llegan 8 a Quito: suma 8 y quedan 4", r1.data.purchase?.status === "recibida_parcial" && (await stock()).quito === 8, r1.data);
    check("Recepción repetida (doble clic) no duplica", r1b.data.duplicated === true && (await stock()).quito === 8);
    const r2 = await api("bodega", "POST", `/purchases/${cp.data.purchase._id}/receive`, { key: `zz-rx2-${t0.getTime()}`, lines: [{ index: 0, containers: 2 }], location: "puerto" });
    check("La misma factura recibe 2 en Puerto", r2.status === 200 && (await stock()).puerto === 2, r2.data);

    // ---- Traslado Quito → Puerto conserva el total
    const tr = { key: `zz-tr-${t0.getTime()}`, from: "quito", to: "puerto", items: [{ productId: pid, qty: 6 }] };
    const t1 = await api("admin", "POST", "/inventory/transfer", tr);
    const t1b = await api("admin", "POST", "/inventory/transfer", tr);
    const s1 = await stock();
    check("Traslado Quito 8→2, Puerto 2→8, total 10", t1.status === 201 && s1.quito === 2 && s1.puerto === 8, s1);
    check("Traslado repetido no duplica", t1b.data.duplicated === true && (await stock()).puerto === 8);
    const over = await api("admin", "POST", "/inventory/transfer", { from: "quito", to: "abordo", items: [{ productId: pid, qty: 3 }] });
    check("No sale más de lo que hay (Quito nunca negativo)", over.status === 409 && over.data.code === "sin_stock", over.data);
    const toUnsplit = await api("admin", "POST", "/inventory/transfer", { from: "quito", to: "bodega", items: [{ productId: pid, qty: 1 }] });
    check("A la bodega sin separar no entra mercadería", toUnsplit.status === 400);

    // ---- Pedido semanal (semana ficticia de 2099 para no crear el pedido real)
    const fake = new Date("2099-01-08T12:00:00Z"); // jueves → corte del miércoles 7
    const { order, created: c1 } = await ensureWeeklyOrder(fake);
    created.orders.push(order._id.toString());
    const again = await ensureWeeklyOrder(fake);
    check("Una sola propuesta por semana (reintento no duplica)", c1 && !again.created && again.order._id.equals(order._id));
    const line = order.lines.find((l) => l.product.toString() === pid);
    // Objetivo 18 − hay 10 − vienen 2 (lo que falta de la compra) = 6
    check("Sugerencia: objetivo 18, hay 10, vienen 2 → 6", line?.suggested === 6 && line?.basis === "objetivo", line);
    const oid = order._id.toString();
    let o = (await api("bartender", "GET", `/weekly-orders/${oid}`)).data.order;
    check("El pedido se ve con su fase", o?.phaseLabel === "Por revisar por el bar", o?.phaseLabel);

    const editLines = (qty: number, extra: any[] = []) => [
      ...o.lines.filter((l: any) => l.product !== pid).map((l: any) => ({ productId: l.product, qty: l.qty, observation: l.observation })),
      { productId: pid, qty, observation: "Hay 3 latas en la barra" },
      ...extra,
    ];
    const stale = await api("bartender", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version + 5, lines: editLines(10) });
    check("Otro equipo con versión vieja no pisa el pedido", stale.status === 409, stale.data);
    const noBodega = await api("bodega", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version, lines: editLines(10) });
    check("Bodega no edita el pedido", noBodega.status === 403, noBodega.status);
    const e1 = await api("bartender", "PUT", `/weekly-orders/${oid}/lines`, {
      version: o.version, lines: editLines(10, [{ productId: P2._id.toString(), qty: 3, observation: "" }]),
    });
    o = e1.data.order;
    const l1 = o?.lines.find((l: any) => l.product === pid);
    check("El bar cambia 6→10, agrega un producto y deja 'Hay otra cantidad'", e1.status === 200 && l1?.qty === 10 && l1?.observation && o.lines.some((l: any) => l.product === P2._id.toString() && l.basis === "agregado"), e1.data);
    check("'Hay otra cantidad' no cambia el inventario", (await stock()).puerto === 8);
    const send = await api("bartender", "POST", `/weekly-orders/${oid}/send`, { version: o.version });
    o = send.data.order;
    check("Enviar a revisión → por revisar por la directora, sin mover stock", o?.status === "directora" && o.lines.find((l: any) => l.product === pid)?.barQty === 10 && (await stock()).puerto === 8, send.data);
    const barLate = await api("bartender", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version, lines: editLines(11) });
    check("Después de enviar, el bar ya no edita", barLate.status === 403);
    const barApprove = await api("bartender", "POST", `/weekly-orders/${oid}/approve`, { version: o.version });
    check("El bar no aprueba", barApprove.status === 403);
    const dirEdit = await api("direccion", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version, lines: editLines(12).filter((l) => l.productId !== P2._id.toString()) });
    o = dirEdit.data.order;
    check("La directora cambia a 12 y quita el agregado", dirEdit.status === 200 && o.lines.find((l: any) => l.product === pid)?.qty === 12 && !o.lines.some((l: any) => l.product === P2._id.toString()), dirEdit.data);
    const ap = await api("direccion", "POST", `/weekly-orders/${oid}/approve`, { version: o.version });
    o = ap.data.order;
    check("Aprobar y enviar pedido → listo para comprar, con destinatario", o?.status === "aprobado" && o.phase === "comprar" && o.recipient && (await stock()).puerto === 8, ap.data);

    // Compra desde el pedido
    const outside = await api("admin", "POST", "/purchases", { supplier: "Prueba", document: "Y", destination: "puerto", weeklyOrderId: oid, lines: [{ productId: P2._id.toString(), containers: 1 }] });
    check("Desde el pedido no se compra lo que no está en él", outside.status === 400, outside.data);
    const cp2 = await api("admin", "POST", "/purchases", { supplier: "Proveedor prueba", document: "PRUEBA-002", destination: "puerto", weeklyOrderId: oid, idempotencyKey: `zz-cp2-${t0.getTime()}`, lines: [{ productId: pid, containers: 4, containerCost: 0.5 }] });
    created.purchases.push(cp2.data.purchase?._id);
    o = (await api("direccion", "GET", `/weekly-orders/${oid}`)).data.order;
    let pl = o.lines.find((l: any) => l.product === pid);
    check("Por línea: pedido 12, comprado 4, faltan 8 por comprar", cp2.status === 201 && pl.purchased === 4 && pl.toBuy === 8 && pl.toReceive === 4 && o.phase === "recibir", pl);
    await api("bodega", "POST", `/purchases/${cp2.data.purchase._id}/receive`, { key: `zz-rx3-${t0.getTime()}`, lines: [{ index: 0, containers: 4 }], location: "puerto" });
    o = (await api("direccion", "GET", `/weekly-orders/${oid}`)).data.order;
    pl = o.lines.find((l: any) => l.product === pid);
    check("Recibido 4 de lo comprado", pl.received === 4 && pl.toReceive === 0 && (await stock()).puerto === 12, pl);
    const below = await api("direccion", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version, lines: editLines(2) });
    check("Después de aprobar no se pide menos de lo comprado", below.status === 409, below.data);
    const rev = await api("direccion", "PUT", `/weekly-orders/${oid}/lines`, { version: o.version, lines: editLines(9) });
    o = rev.data.order;
    check("Cambio después de aprobar = revisión 1 identificada", o?.revision === 1 && o.history.some((h: any) => h.action.startsWith("Revisión 1")), rev.data);
    const cancel = await api("direccion", "POST", `/weekly-orders/${oid}/cancel`, { reason: "Prueba" });
    o = cancel.data.order;
    pl = o?.lines.find((l: any) => l.product === pid);
    check("Cancelar lo pendiente deja lo comprado y no borra la compra", pl?.qty === 4 && o.status === "aprobado" && (await Purchase.exists({ _id: cp2.data.purchase._id })) !== null, o?.lines?.find((l: any) => l.product === pid));
    check("Con todo comprado y recibido: Recibido", o?.lines.every((l: any) => l.toBuy <= 0 && l.toReceive <= 0) ? o.phase === "recibido" : true, o?.phase);

    // ---- Solicitud del bar entregada desde Puerto
    const rq = await api("bartender", "POST", "/requisitions", { lines: [{ productId: pid, qty: 2 }], idempotencyKey: `zz-rq-${t0.getTime()}` });
    created.requisitions.push(rq.data.requisition?._id);
    await api("direccion", "POST", `/requisitions/${rq.data.requisition._id}/review`, { decision: "aprobar" });
    const rr = await api("admin", "POST", `/requisitions/${rq.data.requisition._id}/receive`, { key: `zz-rr-${t0.getTime()}`, lines: [{ index: 0, qty: 2 }], from: "puerto" });
    const s2 = await stock();
    check("Entrega al barco sale de Puerto: Puerto 12→10, A bordo +2", rr.data.requisition?.status === "recibido" && s2.puerto === 10 && s2.abordo === 2, { s2, rr: rr.data });

    // ---- Merma en Quito
    const w = await api("bodega", "POST", "/inventory/waste", { productId: pid, qty: 1, reason: "Prueba", location: "quito", key: `zz-w-${t0.getTime()}` });
    check("Merma en Quito resta 1", w.status === 201 && (await stock()).quito === 1, w.data);

    // ---- Conteo en Puerto mientras sigue la operación (sin conteo de Quito)
    const ct = await api("admin", "POST", "/counts", { location: "puerto" });
    created.counts.push(ct.data.count?._id);
    const cut = ct.data.count.lines.find((l: any) => l.product === pid)?.digitalAtCut;
    await api("admin", "PATCH", `/counts/${ct.data.count._id}`, { lines: [{ product: pid, physical: 9, reason: "Prueba: falta 1" }] });
    await api("admin", "POST", `/counts/${ct.data.count._id}/submit`);
    check("Guardar y enviar el conteo no cambia stock", (await stock()).puerto === 10);
    // Después del corte sale 3 hacia el barco: sistema 7. La diferencia −1 deja 6, no 9.
    await api("admin", "POST", "/inventory/transfer", { key: `zz-tr2-${t0.getTime()}`, from: "puerto", to: "abordo", items: [{ productId: pid, qty: 3 }] });
    const apC = await api("duena", "POST", `/counts/${ct.data.count._id}/approve`);
    check("Conteo: corte 10, físico 9, luego salen 3 → queda 6", cut === 10 && apC.status === 200 && (await stock()).puerto === 6, { cut, s: await stock(), apC: apC.status });
    const notOwnerApprove = await api("admin", "POST", `/counts/${ct.data.count._id}/approve`);
    check("Solo Gerencia aprueba conteos", notOwnerApprove.status === 403 || notOwnerApprove.status === 409);

    // ---- Bodega sin separar: sin conteo de Quito aprobado no se cierra (no se ejecuta de verdad)
    const quitoApproved = await StockCount.exists({ location: "quito", status: "aprobado" });
    if (!quitoApproved) {
      const close = await api("duena", "POST", "/inventory/close-unsplit");
      check("No cierra la bodega sin separar sin conteo de Quito", close.status === 409, close.data);
    } else {
      console.log("SALTO cierre de bodega sin separar: ya hay un conteo de Quito aprobado y lo cerraría de verdad");
    }
    const closeBar = await api("bartender", "POST", "/inventory/close-unsplit");
    check("El bar no cierra saldos", closeBar.status === 403);

    // ---- Cron sin clave no corre
    const cron = await fetch(`http://127.0.0.1:${port}/api/cron/weekly-order`);
    check("La tarea del miércoles exige CRON_SECRET", cron.status === 401);

    // ---- Comisiones (solo lectura)
    const com = await api("duena", "GET", "/commissions");
    check("Comisiones por bartender responde", com.status === 200 && Array.isArray(com.data.bartenders), com.status);
    const comBar = await api("bartender", "GET", "/commissions");
    check("El bar no ve comisiones", comBar.status === 403);

    const s3 = await stock();
    check("El total del producto de prueba cuadra (compras 14 − merma 1 − conteo 1 = 12)", s3.quito + s3.puerto + s3.abordo + s3.bodega === 12, s3);
  } finally {
    // ---- Limpieza: todo lo creado por la prueba
    const ids = [P._id, P2._id];
    const orders = created.orders.filter(Boolean).map((i) => new Types.ObjectId(i));
    const purchases = await Purchase.find({ "lines.product": { $in: ids } }).select("code");
    const reqs = await Requisition.find({ "lines.product": { $in: ids } }).select("code");
    const counts = created.counts.filter(Boolean);
    const codes = [
      ...purchases.map((p) => p.code),
      ...reqs.map((r) => r.code),
      ...(await WeeklyOrder.find({ _id: { $in: orders } }).select("code")).map((o) => o.code),
      ...(await StockCount.find({ _id: { $in: counts } }).select("code")).map((c) => c.code),
    ];
    const results = {
      movements: (await StockMovement.deleteMany({ product: { $in: ids } })).deletedCount,
      purchases: (await Purchase.deleteMany({ _id: { $in: purchases.map((p) => p._id) } })).deletedCount,
      requisitions: (await Requisition.deleteMany({ _id: { $in: reqs.map((r) => r._id) } })).deletedCount,
      orders: (await WeeklyOrder.deleteMany({ $or: [{ _id: { $in: orders } }, { week: /^2099-/ }] })).deletedCount,
      counts: (await StockCount.deleteMany({ _id: { $in: counts } })).deletedCount,
      products: (await Product.deleteMany({ _id: { $in: ids } })).deletedCount,
    };
    const escaped = codes.map((c) => c.replace(/[-]/g, "\\-"));
    const pattern = new RegExp([...escaped, "ZZ Prueba", "PRUEBA-00", "Proveedor prueba", "Merma · ZZ"].join("|"));
    const audit = await db.collection("auditevents").deleteMany({
      createdAt: { $gte: t0 },
      $or: [{ title: pattern }, { detail: pattern }],
    });
    // Contadores de código: vuelven a como estaban (sin huecos en CP/RQ/PS).
    for (const c of await db.collection("codecounters").find().toArray()) {
      const before = counters.find((b) => b._id === c._id);
      if (!before) await db.collection("codecounters").deleteOne({ _id: c._id });
      else if (before.n !== c.n) await db.collection("codecounters").updateOne({ _id: c._id }, { $set: { n: before.n } });
    }
    console.log("Limpieza:", JSON.stringify({ ...results, audit: audit.deletedCount, codes }));
    server.close();
    await mongoose.disconnect();
  }
  console.log(failures ? `\n${failures} FALLA(S)` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
