import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { IWeeklyOrder, IWeeklyOrderLine, WeeklyOrder } from "../models/weeklyOrder.model";
import {
  ensureWeeklyOrder,
  isOverdue,
  latestCut,
  newLine,
  ORDER_RECIPIENT,
  orderProgress,
} from "../services/weeklyOrder.service";
import { stockOf } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors/httpError";
import { round2 } from "../utils/units";

/**
 * Pedido semanal: el bar revisa y envía a revisión; la directora modifica,
 * aprueba y envía a compras. Ver services/weeklyOrder.service.ts.
 */

type OrderDoc = InstanceType<typeof WeeklyOrder>;

const PHASE_LABELS = {
  bar: "Por revisar por el bar",
  directora: "Por revisar por la directora",
  comprar: "Listo para comprar",
  recibir: "Por recibir",
  recibido: "Recibido",
  cancelado: "Cancelado",
} as const;

/** Pedido con el avance de compras por línea (envases) y su fase visible. */
async function serialize(order: OrderDoc) {
  const progress = (await orderProgress([order._id])).get(order._id.toString());
  const lines = order.lines.map((l) => {
    const size = l.containerSize || 1;
    const done = progress?.get(l.product.toString()) ?? { purchased: 0, received: 0 };
    const purchased = round2(done.purchased / size);
    const received = round2(done.received / size);
    return {
      ...(l as unknown as { toObject(): IWeeklyOrderLine }).toObject(),
      purchased,
      received,
      toBuy: round2(Math.max(0, l.qty - purchased)),
      toReceive: round2(Math.max(0, purchased - received)),
    };
  });
  let phase: keyof typeof PHASE_LABELS = order.status === "aprobado" ? "comprar" : order.status;
  if (order.status === "aprobado") {
    // Recibido: todo llegó o lo pendiente se canceló (queda en el historial).
    if (lines.every((l) => l.toBuy <= 0 && l.toReceive <= 0)) phase = "recibido";
    else if (lines.some((l) => l.purchased > 0)) phase = "recibir";
  }
  return {
    ...order.toObject(),
    version: order.__v,
    lines,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    overdue: isOverdue(order),
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
      order: first ? await serialize(first) : null,
      // Pedidos anteriores que siguen abiertos (sin revisar o por comprar/recibir).
      others: orders.slice(1).map((o) => ({
        _id: o._id,
        code: o.code,
        week: o.week,
        status: o.status,
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
    res.json({ order: await serialize(await load(String(req.params.id))) });
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
    const progress = approved ? (await orderProgress([order._id])).get(order._id.toString()) : undefined;
    const now = new Date();
    const changes: string[] = [];

    const removed = new Set<string>();
    for (const line of order.lines) {
      const id = line.product.toString();
      const next = wanted.get(id);
      const bought = round2((progress?.get(id)?.purchased ?? 0) / (line.containerSize || 1));
      if (!next) {
        if (!approved) {
          removed.add(id);
          changes.push(`quitó ${line.name}`);
          continue;
        }
        // Aprobado: quitar = cancelar lo pendiente; lo comprado se conserva.
        if (line.qty !== Math.ceil(bought)) {
          changes.push(`${line.name}: ${line.qty} → ${Math.ceil(bought)} (canceló lo pendiente)`);
          line.qty = Math.ceil(bought);
          line.editedByName = req.auth!.name;
          line.editedAt = now;
        }
        continue;
      }
      if (approved && next.qty < bought - 1e-9) {
        throw conflict(`${line.name}: ya se compraron ${bought} ${line.containerLabel}; no puedes pedir menos`);
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
    res.json({ order: await serialize(order) });
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
    res.json({ order: await serialize(order) });
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
    if (!withQty.length) throw badRequest("El pedido no tiene cantidades: agrega al menos un producto");
    const skippedBar = order.status === "bar";
    for (const l of order.lines) l.approvedQty = l.qty;
    order.status = "aprobado";
    order.recipient = ORDER_RECIPIENT;
    push(
      order,
      req,
      "Aprobado y enviado",
      `${withQty.length} producto(s) · para ${ORDER_RECIPIENT}${skippedBar ? " · el bar no lo revisó" : ""}`,
    );
    await save(order);
    await logEvent(req.auth, {
      kind: "requerimiento",
      title: `Pedido ${order.code} aprobado para comprar`,
      detail: `${withQty.length} producto(s)`,
    });
    res.json({ order: await serialize(order) });
  } catch (err) {
    next(err);
  }
}

/**
 * Cancelar: antes de aprobar se descarta el pedido; después, solo lo
 * pendiente de comprar (las compras y entregas hechas no se borran).
 */
export async function cancelWeeklyOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) throw badRequest("Escribe el motivo");
    if (role(req) !== "direccion" && role(req) !== "duena") throw forbidden("Solo la directora cancela el pedido");
    const order = await load(String(req.params.id));
    if (order.status === "cancelado") throw conflict("Este pedido ya se canceló");
    if (order.status === "aprobado") {
      const progress = (await orderProgress([order._id])).get(order._id.toString());
      for (const l of order.lines) {
        l.qty = Math.ceil(round2((progress?.get(l.product.toString())?.purchased ?? 0) / (l.containerSize || 1)));
      }
      order.revision += 1;
      order.changedAt = new Date();
      push(order, req, "Canceló lo pendiente de comprar", reason);
    } else {
      order.status = "cancelado";
      push(order, req, "Pedido cancelado", reason);
    }
    await save(order);
    await logEvent(req.auth, { kind: "requerimiento", title: `Pedido ${order.code}: ${order.status === "cancelado" ? "cancelado" : "pendiente cancelado"}`, detail: reason });
    res.json({ order: await serialize(order) });
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
