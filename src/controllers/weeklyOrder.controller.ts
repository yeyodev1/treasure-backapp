import { NextFunction, Request, Response } from "express";
import mongoose, { ClientSession, Types } from "mongoose";
import { Product } from "../models/product.model";
import { Cruise } from "../models/cruise.model";
import {
  DeliverySource,
  IWeeklyOrder,
  IWeeklyOrderDelivery,
  IWeeklyOrderDeliveryItem,
  IWeeklyOrderLine,
  WeeklyOrder,
} from "../models/weeklyOrder.model";
import {
  ensureWeeklyOrder,
  isOverdue,
  latestCut,
  newLine,
  ORDER_RECIPIENT,
  orderProgress,
  PHASE_LABELS,
  phaseOf,
} from "../services/weeklyOrder.service";
import { moveStock, stockOf, updateCost } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors/httpError";
import { round2 } from "../utils/units";

/**
 * Pedido semanal: el bar revisa y envía a revisión; la directora modifica,
 * aprueba y envía a compras. Ver services/weeklyOrder.service.ts.
 */

type OrderDoc = InstanceType<typeof WeeklyOrder>;

/** Pedido con el avance de entregas por línea (envases), quién aportó qué y su fase visible. */
function serialize(order: OrderDoc) {
  const progress = orderProgress(order);
  const lines = order.lines.map((l) => {
    const id = l.product.toString();
    const contributions = order.deliveries.flatMap((d) =>
      d.items
        .filter((i) => i.product.toString() === id)
        .map((i) => ({ key: d.key, kind: d.kind, source: i.source, qty: i.qty, byName: d.byName, at: d.at, arrived: d.kind === "entrega" || Boolean(d.arrivedAt) })),
    );
    return { ...(l as unknown as { toObject(): IWeeklyOrderLine }).toObject(), ...progress.get(id)!, contributions };
  });
  const phase = phaseOf(order);
  return {
    ...order.toObject(),
    version: order.__v,
    lines,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    overdue: isOverdue(order),
  };
}

/** Envases ya cubiertos (entregados o enviados) por producto: no se puede pedir menos. */
function covered(order: OrderDoc) {
  const progress = orderProgress(order);
  return (id: string) => {
    const row = progress.get(id);
    return row ? row.delivered + row.inTransit : 0;
  };
}

function role(req: Request) {
  return req.auth!.role;
}

/** Quién edita en cada estado: el bar mientras le toca; la directora siempre antes de cerrar. */
function assertCanEdit(req: Request, order: IWeeklyOrder) {
  const r = role(req);
  const lead = r === "direccion" || r === "duena";
  if (order.status === "cancelado") throw conflict("Este pedido se canceló");
  if (order.status === "bar" && (lead || r === "bartender")) return;
  if ((order.status === "directora" || order.status === "aprobado") && lead) return;
  throw forbidden(
    order.status === "bar" ? "Este pedido lo revisa el bar" : "Ya se envió a revisión: ahora lo revisa la directora",
  );
}

async function load(id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Pedido no encontrado");
  const order = await WeeklyOrder.findById(id);
  if (!order) throw notFound("Pedido no encontrado");
  return order;
}

/** Otro dispositivo cambió el pedido: no se pisa su trabajo. */
function assertVersion(order: OrderDoc, version: unknown) {
  if (version !== undefined && Number(version) !== order.__v) {
    throw conflict("Alguien más cambió este pedido. Recarga para ver la versión vigente.");
  }
}

/** Dos dispositivos guardando a la vez: el segundo recibe 409, no pisa al primero. */
async function save(order: OrderDoc) {
  try {
    await order.save();
  } catch (err) {
    if ((err as { name?: string }).name === "VersionError") {
      throw conflict("Alguien más cambió este pedido. Recarga para ver la versión vigente.");
    }
    throw err;
  }
}

function push(order: OrderDoc, req: Request, action: string, detail = "") {
  order.history.push({ at: new Date(), by: new Types.ObjectId(req.auth!.sub), byName: req.auth!.name, action, detail });
}

/** El pedido vigente (se prepara aquí si la tarea del miércoles no corrió) y los anteriores. */
export async function currentWeeklyOrder(_req: Request, res: Response, next: NextFunction) {
  try {
    await ensureWeeklyOrder();
    const orders = await WeeklyOrder.find().sort({ cutAt: -1 }).limit(12);
    const [first] = orders;
    res.json({
      order: first ? serialize(first) : null,
      // Pedidos anteriores (sin revisar, por atender o cerrados), con su fase para los avisos.
      others: orders.slice(1).map((o) => ({
        _id: o._id,
        code: o.code,
        week: o.week,
        cutAt: o.cutAt,
        status: o.status,
        phase: phaseOf(o),
        overdue: isOverdue(o),
      })),
      nextCut: new Date(latestCut().getTime() + 7 * 86_400_000),
    });
  } catch (err) {
    next(err);
  }
}

export async function getWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ order: serialize(await load(String(req.params.id))) });
  } catch (err) {
    next(err);
  }
}

/**
 * Guarda la lista completa (cantidades en envases y "Hay otra cantidad").
 * Antes de aprobar: se agregan y quitan productos libremente (borrador).
 * Después de aprobar: solo la directora; no baja de lo ya comprado (se cancela
 * solo lo pendiente) y cada cambio queda como revisión con aviso a compras.
 */
export async function saveWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { version, lines } = req.body as {
      version?: number;
      lines?: Array<{ productId: string; qty: number; observation?: string }>;
    };
    if (!Array.isArray(lines)) throw badRequest("Falta la lista del pedido");
    const order = await load(String(req.params.id));
    assertCanEdit(req, order);
    assertVersion(order, version);

    const wanted = new Map<string, { qty: number; observation: string }>();
    for (const l of lines) {
      const qty = Number(l.qty);
      if (!Number.isInteger(qty) || qty < 0 || qty > 10_000) throw badRequest("Las cantidades son envases enteros, de 0 en adelante");
      if (wanted.has(l.productId)) throw badRequest("Hay un producto repetido en el pedido");
      wanted.set(l.productId, { qty, observation: String(l.observation ?? "").trim().slice(0, 300) });
    }

    const approved = order.status === "aprobado";
    const coveredOf = covered(order);
    const now = new Date();
    const changes: string[] = [];

    const removed = new Set<string>();
    for (const line of order.lines) {
      const id = line.product.toString();
      const next = wanted.get(id);
      const bought = coveredOf(id);
      if (!next) {
        if (!approved) {
          removed.add(id);
          changes.push(`quitó ${line.name}`);
          continue;
        }
        // Aprobado: quitar = cancelar lo pendiente; lo entregado o enviado se conserva.
        if (line.qty !== bought) {
          changes.push(`${line.name}: ${line.qty} → ${bought} (canceló lo pendiente)`);
          line.qty = bought;
          line.editedByName = req.auth!.name;
          line.editedAt = now;
        }
        continue;
      }
      if (approved && next.qty < bought - 1e-9) {
        throw conflict(`${line.name}: ya se entregaron o enviaron ${bought} ${line.containerLabel}; no puedes pedir menos`);
      }
      if (next.qty !== line.qty || next.observation !== line.observation) {
        if (next.qty !== line.qty) changes.push(`${line.name}: ${line.qty} → ${next.qty}`);
        if (next.observation !== line.observation && next.observation) changes.push(`${line.name}: hay otra cantidad (${next.observation})`);
        line.qty = next.qty;
        line.observation = next.observation;
        line.editedByName = req.auth!.name;
        line.editedAt = now;
      }
      wanted.delete(id);
    }

    if (removed.size) order.set("lines", order.lines.filter((l) => !removed.has(l.product.toString())));

    // Productos agregados a mano: con sus existencias de este momento.
    if (wanted.size) {
      const products = await Product.find({ _id: { $in: [...wanted.keys()] }, kind: "fisico", active: true });
      if (products.length !== wanted.size) throw badRequest("Solo se piden insumos físicos activos");
      for (const p of products) {
        const w = wanted.get(p._id.toString())!;
        const line = newLine(p, stockOf(p), { target: p.stockTarget ?? 0, incoming: 0, consumption: 0, suggested: null, basis: "agregado" });
        line.qty = w.qty;
        line.observation = w.observation;
        line.editedByName = req.auth!.name;
        line.editedAt = now;
        order.lines.push(line);
        changes.push(`agregó ${p.name} (${w.qty})`);
      }
    }

    if (approved && changes.length) {
      order.revision += 1;
      order.changedAt = now;
      push(order, req, `Revisión ${order.revision} después de aprobar`, changes.join(" · "));
    }
    await save(order);
    if (approved && changes.length) {
      await logEvent(req.auth, {
        kind: "requerimiento",
        title: `Pedido ${order.code}: revisión ${order.revision}`,
        detail: changes.join(" · "),
      });
    }
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/** Bar → directora. No compra ni mueve stock. */
export async function sendWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await load(String(req.params.id));
    if (order.status !== "bar") throw conflict("Este pedido ya se envió a revisión");
    assertCanEdit(req, order);
    assertVersion(order, req.body?.version);
    for (const l of order.lines) l.barQty = l.qty;
    order.status = "directora";
    push(order, req, "Enviado a revisión", `${order.lines.filter((l) => l.qty > 0).length} producto(s) con cantidad`);
    await save(order);
    await logEvent(req.auth, { kind: "requerimiento", title: `Pedido ${order.code} enviado a revisión`, detail: "" });
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/** Directora: "Aprobar y enviar pedido". Queda listo para comprar; nada se recibe solo. */
export async function approveWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await load(String(req.params.id));
    if (role(req) !== "direccion" && role(req) !== "duena") throw forbidden("Solo la directora aprueba el pedido");
    if (order.status !== "bar" && order.status !== "directora") throw conflict("Este pedido ya se aprobó o se canceló");
    assertVersion(order, req.body?.version);
    const withQty = order.lines.filter((l) => l.qty > 0);
    const noNeeds = req.body?.noNeeds === true;
    if (!withQty.length && !noNeeds) {
      throw badRequest("El pedido está en cero: agrega productos o ciérralo «Sin necesidades»");
    }
    if (withQty.length && noNeeds) throw badRequest("El pedido tiene cantidades: apruébalo o déjalas en cero");
    const skippedBar = order.status === "bar";
    for (const l of order.lines) l.approvedQty = l.qty;
    order.status = "aprobado";
    order.noNeeds = noNeeds;
    order.recipient = noNeeds ? "" : ORDER_RECIPIENT;
    push(
      order,
      req,
      noNeeds ? "Cerrado sin necesidades" : "Aprobado y enviado",
      noNeeds
        ? `El barco no necesita reposición esta semana${skippedBar ? " · el bar no lo revisó" : ""}`
        : `${withQty.length} producto(s) · para ${ORDER_RECIPIENT}${skippedBar ? " · el bar no lo revisó" : ""}`,
    );
    await save(order);
    await logEvent(req.auth, {
      kind: "requerimiento",
      title: noNeeds ? `Pedido ${order.code} cerrado sin necesidades` : `Pedido ${order.code} aprobado`,
      detail: `${withQty.length} producto(s)`,
    });
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * Cancelar: antes de aprobar se descarta el pedido; después, solo lo
 * pendiente de entregar (las entregas y envíos hechos no se borran).
 */
export async function cancelWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw badRequest("Escribe el motivo");
    if (role(req) !== "direccion" && role(req) !== "duena") throw forbidden("Solo la directora cancela el pedido");
    const order = await load(String(req.params.id));
    if (order.status === "cancelado") throw conflict("Este pedido ya se canceló");
    if (order.status === "aprobado") {
      const coveredOf = covered(order);
      for (const l of order.lines) l.qty = coveredOf(l.product.toString());
      order.revision += 1;
      order.changedAt = new Date();
      push(order, req, "Canceló lo pendiente de entregar", reason);
    } else {
      order.status = "cancelado";
      push(order, req, "Pedido cancelado", reason);
    }
    await save(order);
    await logEvent(req.auth, { kind: "requerimiento", title: `Pedido ${order.code}: ${order.status === "cancelado" ? "cancelado" : "pendiente cancelado"}`, detail: reason });
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * Tarea programada de Vercel (miércoles 21h00 UTC = 15h00 Galápagos). Vercel
 * envía `Authorization: Bearer CRON_SECRET`; sin esa clave no corre.
 */
export async function weeklyOrderCron(req: Request, res: Response, next: NextFunction) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw unauthorized();
    const { order, created } = await ensureWeeklyOrder();
    res.json({ ok: true, created, code: order.code, week: order.week });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Entrega compartida dentro del pedido aprobado (guía 4 perfiles, 4-nov-2026)
// ---------------------------------------------------------------------------

const SOURCES_BY_KIND = {
  entrega: ["puerto", "compra"],
  envio: ["quito", "compra"],
} as const satisfies Record<IWeeklyOrderDelivery["kind"], readonly DeliverySource[]>;

interface DeliveryBody {
  key?: string;
  document?: string;
  items?: Array<{ productId: string; source: DeliverySource; qty: number; cost?: number }>;
}

/**
 * Valida lo que cada responsable dice que atiende: solo productos del pedido,
 * envases enteros, sus orígenes y sin pasarse de lo que falta.
 */
function parseItems(order: OrderDoc, kind: IWeeklyOrderDelivery["kind"], body: DeliveryBody): IWeeklyOrderDeliveryItem[] {
  if (order.status !== "aprobado" || order.noNeeds) throw conflict("Este pedido no está aprobado para entregar");
  if (!body.items?.length) throw badRequest("Indica qué productos atiendes");
  const allowed: readonly DeliverySource[] = SOURCES_BY_KIND[kind];
  const progress = orderProgress(order);
  const byLine = new Map(order.lines.map((l) => [l.product.toString(), l]));
  const asked = new Map<string, number>();
  const items: IWeeklyOrderDeliveryItem[] = [];
  for (const raw of body.items) {
    const line = byLine.get(raw.productId);
    if (!line) throw badRequest("Hay un producto que no está en el pedido");
    if (!allowed.includes(raw.source)) throw badRequest(`${line.name}: elige de dónde sale`);
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest(`${line.name}: la cantidad son envases enteros`);
    const cost = Number(raw.cost ?? 0);
    if (!(cost >= 0) || cost > 100_000) throw badRequest(`${line.name}: costo inválido`);
    const total = (asked.get(raw.productId) ?? 0) + qty;
    const pending = progress.get(raw.productId)!.pending;
    if (total > pending) {
      throw conflict(`${line.name}: faltan ${pending} ${line.containerLabel}; no puedes atender ${total}`);
    }
    asked.set(raw.productId, total);
    items.push({ product: line.product, name: line.name, source: raw.source, qty, cost: raw.source === "compra" ? cost : 0 });
  }
  return items;
}

/**
 * Registra una entrega o envío una sola vez: dentro de una transacción con la
 * versión del pedido; un doble toque o un reintento con la misma clave
 * devuelve el pedido como quedó.
 */
async function recordDelivery(
  req: Request,
  kind: IWeeklyOrderDelivery["kind"],
  apply: (order: OrderDoc, delivery: IWeeklyOrderDelivery, session: ClientSession) => Promise<void>,
) {
  const body = (req.body ?? {}) as DeliveryBody;
  const key = String(body.key ?? "").trim();
  if (!key || key.length > 80) throw badRequest("Falta la clave de la entrega");
  const id = String(req.params.id);
  let result: OrderDoc | null = null;
  try {
    await mongoose.connection.transaction(async (session) => {
      const order = await WeeklyOrder.findById(id).session(session);
      if (!order) throw notFound("Pedido no encontrado");
      if (order.deliveries.some((d) => d.key === key)) {
        result = order;
        return;
      }
      const delivery: IWeeklyOrderDelivery = {
        key,
        kind,
        at: new Date(),
        by: new Types.ObjectId(req.auth!.sub),
        byName: req.auth!.name,
        items: parseItems(order, kind, body),
        document: String(body.document ?? "").trim().slice(0, 120),
        arrivedAt: null,
        arrivedByName: "",
      };
      await apply(order, delivery, session);
      order.deliveries.push(delivery);
      const total = delivery.items.reduce((s, i) => s + i.qty, 0);
      order.history.push({
        at: delivery.at,
        by: delivery.by,
        byName: delivery.byName,
        action: kind === "entrega" ? "Confirmó su entrega" : "Confirmó su envío",
        detail: `${total} envase(s) · ${describe(delivery.items)}`,
      });
      await order.save({ session });
      result = order;
    });
  } catch (err) {
    if ((err as { name?: string }).name !== "VersionError") throw err;
    // Otro toque guardó primero: si fue esta misma entrega, no es un error.
    const order = await load(id);
    if (!order.deliveries.some((d) => d.key === key)) {
      throw conflict("Alguien más cambió este pedido. Recarga para ver la versión vigente.");
    }
    result = order;
  }
  return result as unknown as OrderDoc;
}

const SOURCE_LABEL: Record<DeliverySource, string> = { puerto: "puerto", quito: "Quito", compra: "compra nueva" };

function describe(items: IWeeklyOrderDeliveryItem[]) {
  return items.map((i) => `${i.name} ${i.qty} de ${SOURCE_LABEL[i.source]}`).join(", ");
}

async function containerSizes(items: IWeeklyOrderDeliveryItem[], session: ClientSession) {
  const products = await Product.find({ _id: { $in: items.map((i) => i.product) } })
    .select("containerSize")
    .session(session);
  const size = new Map(products.map((p) => [p._id.toString(), p.containerSize || 1]));
  return (i: IWeeklyOrderDeliveryItem) => size.get(i.product.toString()) ?? 1;
}

/** Suma al barco lo que llega; lo de compra nueva entra con su costo. */
async function addToBoard(req: Request, order: OrderDoc, items: IWeeklyOrderDeliveryItem[], key: string, session: ClientSession) {
  const sizeOf = await containerSizes(items, session);
  const base = { session, userId: req.auth!.sub, cruise: await activeCruiseId(session), transferId: key, guard: false, location: "abordo" as const };
  const moved = items.filter((i) => i.source !== "compra");
  if (moved.length) {
    await moveStock({
      ...base,
      type: "carga",
      deltas: new Map(moved.map((i) => [i.product.toString(), round2(i.qty * sizeOf(i))])),
      reason: `${order.code}: llega desde ${[...new Set(moved.map((i) => SOURCE_LABEL[i.source]))].join(" y ")}`,
    });
  }
  for (const i of items.filter((x) => x.source === "compra")) {
    const qty = round2(i.qty * sizeOf(i));
    const unitCost = i.cost ? i.cost / sizeOf(i) : 0;
    await updateCost(i.product.toString(), qty, unitCost, session);
    await moveStock({
      ...base,
      type: "compra",
      deltas: new Map([[i.product.toString(), qty]]),
      unitCost: Math.round(unitCost * 10000) / 10000,
      reason: `${order.code}: compra nueva entregada al barco`,
    });
  }
}

/** Resta del origen una sola vez (sin negativos). */
async function takeFrom(
  req: Request,
  order: OrderDoc,
  location: "puerto" | "quito",
  items: IWeeklyOrderDeliveryItem[],
  key: string,
  session: ClientSession,
) {
  const from = items.filter((i) => i.source === location);
  if (!from.length) return;
  const sizeOf = await containerSizes(from, session);
  await moveStock({
    session,
    type: "carga",
    guard: true,
    location,
    userId: req.auth!.sub,
    transferId: key,
    deltas: new Map(from.map((i) => [i.product.toString(), -round2(i.qty * sizeOf(i))])),
    reason: `${order.code}: sale hacia el barco`,
  });
}

async function activeCruiseId(session: ClientSession) {
  const cruise = await Cruise.findOne({ status: "abordo" }).select("_id").session(session);
  return cruise?._id ?? null;
}

/** Administradora: "Confirmar mi entrega". Puerto −lo tomado, barco +todo lo entregado. */
export async function deliverWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await recordDelivery(req, "entrega", async (o, d, session) => {
      await takeFrom(req, o, "puerto", d.items, d.key, session);
      await addToBoard(req, o, d.items, d.key, session);
    });
    await logEvent(req.auth, { kind: "inventario", title: `Pedido ${order.code}: entrega al barco`, detail: req.auth!.name });
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/** Dueña: "Confirmar mi envío". Quito −lo enviado; el barco suma al confirmar la llegada. */
export async function shipWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await recordDelivery(req, "envio", async (o, d, session) => {
      await takeFrom(req, o, "quito", d.items, d.key, session);
    });
    await logEvent(req.auth, { kind: "inventario", title: `Pedido ${order.code}: envío desde Quito`, detail: req.auth!.name });
    res.json({ order: serialize(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * "Confirmar llegada" de un envío de Quito en el mismo pedido: barco +lo
 * enviado, sin volver a descontar Quito. Confirmar dos veces no suma dos veces.
 * Quién la confirma aún no está acordado: pueden la directora, la administradora o la dueña.
 */
export async function arriveWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const key = String(req.params.key);
    let order: OrderDoc | null = null;
    let arrived = false;
    try {
      await mongoose.connection.transaction(async (session) => {
        const o = await WeeklyOrder.findById(String(req.params.id)).session(session);
        if (!o) throw notFound("Pedido no encontrado");
        const delivery = o.deliveries.find((d) => d.key === key && d.kind === "envio");
        if (!delivery) throw notFound("Envío no encontrado");
        order = o;
        if (delivery.arrivedAt) return;
        await addToBoard(req, o, delivery.items, `${key}:llegada`, session);
        delivery.arrivedAt = new Date();
        delivery.arrivedByName = req.auth!.name;
        o.history.push({
          at: delivery.arrivedAt,
          by: new Types.ObjectId(req.auth!.sub),
          byName: req.auth!.name,
          action: "Confirmó la llegada del envío de Quito",
          detail: describe(delivery.items),
        });
        await o.save({ session });
        arrived = true;
      });
    } catch (err) {
      if ((err as { name?: string }).name !== "VersionError") throw err;
      order = await load(String(req.params.id));
    }
    const result = order as unknown as OrderDoc;
    if (arrived) {
      await logEvent(req.auth, { kind: "inventario", title: `Pedido ${result.code}: llegó el envío de Quito`, detail: req.auth!.name });
    }
    res.json({ order: serialize(result) });
  } catch (err) {
    next(err);
  }
}
