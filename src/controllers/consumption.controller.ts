import { NextFunction, Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { chargeableQty, IOrder, Order } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { Product } from "../models/product.model";
import { Account } from "../models/account.model";
import { Device } from "../models/device.model";
import {
  appliedFor,
  costOf,
  deltasFromApplied,
  moveStock,
  onboardAvailability,
} from "../services/inventory.service";
import { chargesChanged } from "../services/account.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors/httpError";
import { startOfDayEcuador } from "../utils/dates";
import { QTY_POSITIVE_ERROR, round2 } from "../utils/units";

/**
 * Consumo directo del bar (guía auditada 27-oct-2026): elegir cabina y tocar
 * la bebida registra lo servido, carga el precio a la cabina y descuenta
 * los ingredientes a bordo, todo en una sola transacción. Si falta un
 * insumo no se guarda nada. Cada toque lleva su `idempotencyKey`: los
 * reintentos sin señal nunca duplican.
 */

const LEADS = new Set(["duena", "admin", "direccion"]);

function isLead(role: string) {
  return LEADS.has(role);
}

type Auth = { sub: string; role: string };

/**
 * Quién corrige un consumo (pedido del cliente, 31-oct-2026): Cortesía y
 * Retirar consumo los hacen el bar, Dirección de crucero y Gerencia sobre
 * cualquier consumo de la cuenta. El bar solo con la cuenta abierta (o en
 * revisión, estado heredado); con la cuenta aprobada solo Dirección o
 * Gerencia, y la corrección anula la aprobación. Lo cobrado no se toca.
 */
function correctionBlock(
  order: Pick<IOrder, "payment" | "status" | "items">,
  accountStatus: string,
  role: string,
): HttpError | null {
  if (order.payment || accountStatus === "cobrada") {
    return conflict("La cuenta ya se cobró: corrígelo con un reverso autorizado");
  }
  if (order.status === "retenida") return conflict("Este consumo está retenido para revisión");
  if (order.items.length !== 1) return conflict("Este pedido tiene varias líneas: corrígelo desde Cuentas");
  if (accountStatus === "aprobada" && !isLead(role)) {
    return forbidden("La cuenta ya está aprobada: solo Dirección de crucero o Gerencia la corrigen");
  }
  return null;
}

async function accountStatusOf(cruiseId: Types.ObjectId | string, cabinNumber: number) {
  const account = await Account.findOne({ cruise: cruiseId, cabinNumber }).select("status");
  return account?.status ?? "abierta";
}

/**
 * Totales y consumos de la cabina para el bar (pedido del cliente,
 * 31-oct-2026): el bar ve todo lo que lleva la cuenta sin entrar a Cuentas,
 * agrupado por bebida, con el total de hoy y el del viaje.
 */
async function cabinSummary(cruiseId: Types.ObjectId | string, cabinNumber: number, auth: Auth) {
  const [orders, account] = await Promise.all([
    Order.find({ cruise: cruiseId, cabinNumber, status: { $in: ["entregada", "pendiente"] } })
      .populate("createdBy", "name")
      .sort({ createdAt: -1 })
      .limit(400),
    Account.findOne({ cruise: cruiseId, cabinNumber }).select("status"),
  ]);
  const today = startOfDayEcuador();
  let trip = 0;
  let todayTotal = 0;
  for (const order of orders) {
    trip += order.total;
    if ((order.createdAt as Date) >= today) todayTotal += order.total;
  }
  const accountStatus = account?.status ?? "abierta";
  type OrderDoc = (typeof orders)[number];
  /** Una fila por línea del pedido (los consumos directos tienen una sola). */
  const row = (o: OrderDoc, index: number) => {
    const item = o.items[index];
    const blocked = correctionBlock(o, accountStatus, auth.role);
    const open = !blocked && o.status === "entregada" && Boolean(item) && chargeableQty(item!) > 0;
    const qty = item ? chargeableQty(item) : 0;
    return {
      orderId: o._id.toString(),
      line: index,
      productId: item?.product?.toString() ?? "",
      name: item?.name ?? "",
      unitPrice: item?.unitPrice ?? 0,
      today: (o.createdAt as Date) >= today,
      qty,
      courtesy: Boolean(item?.courtesy),
      total: o.items.length === 1 ? o.total : item && !item.courtesy ? round2(qty * item.unitPrice) : 0,
      at: o.clientAt ?? o.createdAt,
      by: (o.createdBy as unknown as { name?: string })?.name ?? "",
      canUndo: open,
      canCourtesy: open && !item?.courtesy,
    };
  };
  const view = (o: OrderDoc) => row(o, 0);
  const rows = (o: OrderDoc) =>
    o.items.length <= 1 ? [view(o)] : o.items.map((_, i) => row(o, i)).filter((r) => r.qty > 0);
  const live = orders.filter((o) => !o.undo);
  const last = live[0] ?? null;
  return {
    cabinNumber,
    tripTotal: round2(trip),
    todayTotal: round2(todayTotal),
    accountStatus,
    last: last ? view(last) : null,
    recent: live.flatMap(rows),
  };
}

export async function createConsumption(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, productId, qty, courtesy, courtesyReason, idempotencyKey, clientAt } =
      req.body as {
        cruiseId?: string;
        cabinNumber?: number;
        productId?: string;
        qty?: number;
        courtesy?: boolean;
        courtesyReason?: string;
        idempotencyKey?: string;
        clientAt?: string;
      };
    if (!cruiseId || !cabinNumber || !productId) {
      throw badRequest("Crucero, cabina y bebida son obligatorios");
    }
    if (!idempotencyKey) throw badRequest("Falta el identificador del registro");
    const units = qty ?? 1;
    if (!Number.isInteger(units) || units < 1) throw badRequest(QTY_POSITIVE_ERROR);
    if (units > 50) throw badRequest("Cantidad demasiado alta: máximo 50 por registro.");

    const existing = await Order.findOne({ idempotencyKey });
    if (existing) {
      res.status(200).json({
        order: existing,
        duplicated: true,
        summary: await cabinSummary(existing.cruise, existing.cabinNumber, req.auth!),
      });
      return;
    }

    const cruise = await Cruise.findById(cruiseId);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "planificado") {
      throw badRequest(`${cruise.code ? `Crucero ${cruise.code}` : "El crucero"} aún no ha iniciado. Dirección de crucero debe iniciarlo.`);
    }
    const cabin = cruise.cabins.find((c) => c.number === cabinNumber);
    if (!cabin) throw badRequest("Cabina inválida para este crucero");
    if (!cabin.passengers.length) {
      throw badRequest(`Cabina ${cabinNumber} sin pasajeros. Dirección de crucero debe registrarlos.`);
    }

    const product = await Product.findOne({ _id: productId, active: true });
    if (!product) throw badRequest("Esa bebida no está activa");
    if (product.kind === "fisico" && !product.sellable) {
      throw badRequest(`${product.name} es un insumo y no se vende solo`);
    }

    const applied = await appliedFor(product);
    const cost = costOf(applied);
    const late = cruise.status === "cerrado";
    const item = {
      product: product._id,
      name: product.name,
      qty: units,
      unitPrice: product.price,
      // El bar también registra cortesías (con motivo), no solo Dirección.
      courtesy: Boolean(courtesy),
      deliveredQty: late ? 0 : units,
      cancelledQty: 0,
      annulledQty: 0,
      applied,
      unitCost: cost.unitCost,
      costComplete: cost.complete,
    };
    const at = clientAt ? new Date(clientAt) : new Date();
    const courtesyWhy = item.courtesy
      ? (typeof courtesyReason === "string" ? courtesyReason.trim().slice(0, 200) : "") || "Cortesía registrada en el bar"
      : "";

    let order: (IOrder & { _id: Types.ObjectId }) | null = null;
    try {
      await mongoose.connection.transaction(async (session) => {
        const doc = new Order({
          cruise: cruise._id,
          cabinNumber,
          items: [item],
          status: late ? "retenida" : "entregada",
          total: late || item.courtesy ? 0 : round2(units * product.price),
          createdBy: req.auth!.sub,
          idempotencyKey,
          source: "directo",
          clientAt: Number.isNaN(at.getTime()) ? null : at,
          deliveries: late
            ? []
            : [{ key: idempotencyKey, items: [{ index: 0, qty: units }], by: req.auth!.sub, at: new Date() }],
          cancellations: item.courtesy
            ? [{ items: [], reason: `Cortesía: ${courtesyWhy}`, by: req.auth!.sub, at: new Date() }]
            : [],
        });
        await doc.save({ session });
        if (!late) {
          await moveStock({
            session,
            guard: true,
            type: "venta",
            location: "abordo",
            deltas: new Map(
              [...deltasFromApplied(applied, units)].map(([id, q]) => [id, -q] as [string, number]),
            ),
            userId: req.auth!.sub,
            cruise: cruise._id,
            order: doc._id,
            reason: `Consumo cabina ${cabinNumber}`,
          });
        }
        order = doc;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const dup = await Order.findOne({ idempotencyKey });
        if (dup) {
          res.status(200).json({
            order: dup,
            duplicated: true,
            summary: await cabinSummary(dup.cruise, dup.cabinNumber, req.auth!),
          });
          return;
        }
      }
      throw err;
    }
    const saved = order as unknown as IOrder & { _id: Types.ObjectId };

    if (late) {
      await logEvent(req.auth, {
        kind: "consumo",
        title: `Consumo retenido · cabina ${cabinNumber}`,
        detail: `${units}× ${product.name} · llegó con el crucero finalizado; pendiente de revisión`,
        cruise: cruise._id,
        cabinNumber,
      });
      res.status(202).json({ order: saved, held: true });
      return;
    }

    await chargesChanged(
      cruise._id,
      cabinNumber,
      req.auth!.sub,
      item.courtesy
        ? `Consumo como cortesía: ${units}× ${product.name} · ${courtesyWhy}`
        : `Consumo: ${units}× ${product.name}`,
    );
    await logEvent(req.auth, {
      kind: "consumo",
      title: `Consumo · cabina ${cabinNumber}`,
      detail: `${units}× ${product.name}${item.courtesy ? ` (cortesía · ${courtesyWhy})` : ""}`,
      amount: saved.total,
      cruise: cruise._id,
      cabinNumber,
    });

    res.status(201).json({
      order: saved,
      summary: await cabinSummary(cruise._id, cabinNumber, req.auth!),
    });
  } catch (err) {
    next(err);
  }
}

/** Revierte cargo y stock de una orden directa dentro de una transacción. */
async function reverseOrder(order: IOrder & { _id: Types.ObjectId }, userId: string, reason: string) {
  await mongoose.connection.transaction(async (session) => {
    const fresh = await Order.findById(order._id).session(session);
    if (!fresh) throw notFound("Consumo no encontrado");
    if (fresh.undo) throw conflict("Este consumo ya se deshizo");
    const item = fresh.items[0]!;
    const units = chargeableQty(item);
    if (units <= 0) throw conflict("No queda nada que deshacer");
    const delivered = Math.min(units, item.deliveredQty - item.annulledQty);
    item.annulledQty += units;
    fresh.undo = { by: new Types.ObjectId(userId), at: new Date(), reason };
    fresh.total = 0;
    fresh.status = "cancelada";
    await fresh.save({ session });
    if (delivered > 0 && item.applied.length) {
      await moveStock({
        session,
        guard: false,
        type: "reverso",
        location: "abordo",
        deltas: deltasFromApplied(item.applied, delivered),
        userId,
        cruise: fresh.cruise,
        order: fresh._id,
        reason: `Deshacer: ${reason}`,
      });
    }
  });
}

/**
 * Retirar consumo (no se sirvió): el bar, Dirección de crucero o Gerencia,
 * sobre cualquier consumo de la cuenta y con motivo. Devuelve el cargo y los
 * ingredientes con reverso auditable. El bar solo con la cuenta sin aprobar;
 * con la cuenta aprobada lo hace Dirección o Gerencia y la aprobación se anula.
 */
export async function undoConsumption(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = (req.body?.reason as string | undefined)?.trim() || "Registro por error";
    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    const blocked = correctionBlock(order, await accountStatusOf(order.cruise, order.cabinNumber), req.auth!.role);
    if (blocked) throw blocked;

    await reverseOrder(order, req.auth!.sub, reason);
    const what = `${order.items[0]?.qty ?? 0}× ${order.items[0]?.name ?? ""}`;
    await chargesChanged(
      order.cruise,
      order.cabinNumber,
      req.auth!.sub,
      `Consumo retirado (no se sirvió): ${what} · ${reason}`,
    );
    await logEvent(req.auth, {
      kind: "consumo",
      title: `Consumo retirado · cabina ${order.cabinNumber}`,
      detail: `${what} · ${reason}`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });

    res.json({
      order: await Order.findById(order._id),
      summary: await cabinSummary(order.cruise, order.cabinNumber, req.auth!),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Marcar como cortesía una bebida que sí se consumió: deja de cobrarse pero
 * conserva la salida de ingredientes. El bar, Dirección o Gerencia, con
 * motivo; mismas reglas de cuenta que Retirar consumo.
 */
export async function bonifyConsumption(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) throw badRequest("El motivo de la cortesía es obligatorio");
    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    const blocked = correctionBlock(order, await accountStatusOf(order.cruise, order.cabinNumber), req.auth!.role);
    if (blocked) throw blocked;
    if (order.status !== "entregada") throw conflict("Solo se marca como cortesía un consumo servido");
    const item = order.items[0]!;
    if (item.courtesy) throw conflict("Ya es cortesía");
    item.courtesy = true;
    order.total = 0;
    order.cancellations.push({ items: [], reason: `Cortesía: ${reason}`, by: req.auth!.sub as never, at: new Date() });
    await order.save();

    await chargesChanged(order.cruise, order.cabinNumber, req.auth!.sub, `Cortesía: ${item.qty}× ${item.name} · ${reason}`);
    await logEvent(req.auth, {
      kind: "consumo",
      title: `Cortesía · cabina ${order.cabinNumber}`,
      detail: `${item.qty}× ${item.name} · ${reason}`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });
    res.json({ order, summary: await cabinSummary(order.cruise, order.cabinNumber, req.auth!) });
  } catch (err) {
    next(err);
  }
}

/**
 * Envío tardío: Dirección de crucero acepta (se carga en su salida original y
 * descuenta stock) o rechaza con motivo. Nunca pasa al viaje nuevo.
 */
export async function reviewHeld(req: Request, res: Response, next: NextFunction) {
  try {
    const { decision, reason } = req.body as { decision?: "aceptar" | "rechazar"; reason?: string };
    if (decision !== "aceptar" && decision !== "rechazar") throw badRequest("Decisión inválida");
    if (!reason?.trim()) throw badRequest("El motivo es obligatorio");

    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    if (order.status !== "retenida") throw conflict("Este consumo ya fue revisado");
    const item = order.items[0]!;

    await mongoose.connection.transaction(async (session) => {
      const fresh = await Order.findOne({ _id: order._id, status: "retenida" }).session(session);
      if (!fresh) throw conflict("Este consumo ya fue revisado");
      const line = fresh.items[0]!;
      fresh.heldReview = {
        by: new Types.ObjectId(req.auth!.sub),
        at: new Date(),
        decision: decision === "aceptar" ? "aceptado" : "rechazado",
        reason: reason.trim(),
      };
      if (decision === "aceptar") {
        line.deliveredQty = line.qty;
        fresh.status = "entregada";
        fresh.total = line.courtesy ? 0 : round2(line.qty * line.unitPrice);
        fresh.deliveries.push({
          key: `${fresh.idempotencyKey}-aceptado`,
          items: [{ index: 0, qty: line.qty }],
          by: req.auth!.sub as never,
          at: new Date(),
        });
        await fresh.save({ session });
        await moveStock({
          session,
          guard: true,
          type: "venta",
          location: "abordo",
          deltas: new Map(
            [...deltasFromApplied(line.applied, line.qty)].map(([id, q]) => [id, -q] as [string, number]),
          ),
          userId: req.auth!.sub,
          cruise: fresh.cruise,
          order: fresh._id,
          reason: `Consumo tardío aceptado · cabina ${fresh.cabinNumber}`,
        });
      } else {
        line.cancelledQty = line.qty;
        fresh.status = "cancelada";
        fresh.total = 0;
        await fresh.save({ session });
      }
    });

    if (decision === "aceptar") {
      await chargesChanged(order.cruise, order.cabinNumber, req.auth!.sub, `Consumo tardío aceptado: ${reason.trim()}`);
    }
    await logEvent(req.auth, {
      kind: "consumo",
      title: `Consumo tardío ${decision === "aceptar" ? "aceptado" : "rechazado"} · cabina ${order.cabinNumber}`,
      detail: `${item.qty}× ${item.name} · ${reason.trim()}`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });
    res.json({ order: await Order.findById(order._id) });
  } catch (err) {
    if (err instanceof HttpError) return next(err);
    next(err);
  }
}

/** Barra inferior del bar: último consumo y totales hoy / viaje. */
export async function getCabinSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = req.params;
    res.json({ summary: await cabinSummary(String(cruiseId), Number(cabinNumber), req.auth!) });
  } catch (err) {
    next(err);
  }
}

/** Qué bebidas se pueden servir ahora con el stock a bordo. */
export async function availability(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ availability: await onboardAvailability() });
  } catch (err) {
    next(err);
  }
}

/** Cada tablet avisa sus envíos sin confirmar y su última sincronización. */
export async function heartbeat(req: Request, res: Response, next: NextFunction) {
  try {
    const { deviceId, label, pending, lastSyncAt, cruiseId } = req.body as {
      deviceId?: string;
      label?: string;
      pending?: number;
      lastSyncAt?: string | null;
      cruiseId?: string | null;
    };
    if (!deviceId) throw badRequest("Falta el identificador del equipo");
    await Device.updateOne(
      { deviceId },
      {
        $set: {
          label: label ?? "",
          user: req.auth!.sub,
          userName: req.auth!.name,
          cruise: cruiseId && Types.ObjectId.isValid(cruiseId) ? cruiseId : null,
          pending: Math.max(0, Number(pending) || 0),
          lastSyncAt: lastSyncAt ? new Date(lastSyncAt) : null,
          lastSeenAt: new Date(),
        },
      },
      { upsert: true },
    );
    res.json({ ok: true, serverTime: new Date() });
  } catch (err) {
    next(err);
  }
}
