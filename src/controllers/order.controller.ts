import { NextFunction, Request, Response } from "express";
import { Error as MongooseError } from "mongoose";
import { IOrder, Order, pendingQty, recomputeOrder } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { Product } from "../models/product.model";
import {
  applyMovement,
  consumptionOf,
  deltasFromApplied,
  mergeDeltas,
} from "../services/inventory.service";
import { buildCabinAccount, chargesChanged } from "../services/account.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";

type IndexQty = { index: number; qty: number };

function describeItems(order: IOrder, picks: IndexQty[]): string {
  return picks
    .filter((p) => p.qty > 0)
    .map((p) => `${p.qty}× ${order.items[p.index]?.name ?? "?"}`)
    .join(", ");
}

function assertNotCharged(order: IOrder) {
  if (order.payment) {
    throw conflict("Este consumo ya fue cobrado: cualquier cambio requiere un reverso autorizado");
  }
}

/** Mapa de {index, qty} validado contra los ítems del pedido. */
function normalizePicks(
  order: IOrder,
  raw: IndexQty[] | undefined,
  limit: (index: number) => number,
): IndexQty[] {
  const picks = raw?.length
    ? raw
    : order.items.map((_, index) => ({ index, qty: limit(index) }));
  const result: IndexQty[] = [];
  for (const pick of picks) {
    if (!Number.isInteger(pick.index) || !order.items[pick.index]) {
      throw badRequest("Hay un ítem inválido en la solicitud");
    }
    if (!Number.isInteger(pick.qty) || pick.qty < 0) throw badRequest("Cantidad inválida");
    if (pick.qty > limit(pick.index)) {
      throw badRequest(`No puedes superar lo pendiente de ${order.items[pick.index]!.name}`);
    }
    if (pick.qty > 0) result.push(pick);
  }
  if (!result.length) throw badRequest("No hay cantidades para procesar");
  return result;
}

/**
 * Registra un pedido (sin descontar stock: eso pasa al entregar).
 * Solo con salida a bordo y cabina con pasajeros. Un mismo
 * `idempotencyKey` nunca crea dos pedidos aunque se repita el clic.
 */
export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, items, idempotencyKey } = req.body as {
      cruiseId?: string;
      cabinNumber?: number;
      items?: Array<{ productId: string; qty: number; courtesy?: boolean }>;
      idempotencyKey?: string;
    };
    if (!cruiseId || !cabinNumber || !items?.length) {
      throw badRequest("Crucero, cabina e ítems son obligatorios");
    }

    if (idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey });
      if (existing) {
        res.status(200).json({ order: existing, duplicated: true });
        return;
      }
    }

    const cruise = await Cruise.findById(cruiseId);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status !== "abordo") {
      throw badRequest("Solo se registran consumos con el crucero en curso. Dirección de crucero debe iniciarlo.");
    }
    const cabin = cruise.cabins.find((c) => c.number === cabinNumber);
    if (!cabin) throw badRequest("Cabina inválida para este crucero");
    if (!cabin.passengers.length) {
      throw badRequest(`La cabina ${cabinNumber} no tiene pasajeros registrados`);
    }

    const products = await Product.find({
      _id: { $in: items.map((i) => i.productId) },
      active: true,
    });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));
    const canCourtesy = req.auth!.role === "duena" || req.auth!.role === "direccion";

    const orderItems = items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw badRequest("Hay productos inválidos o inactivos en el consumo");
      if (product.kind === "fisico" && !product.sellable) {
        throw badRequest(`${product.name} es un insumo y no se vende solo`);
      }
      if (!Number.isInteger(item.qty) || item.qty < 1) throw badRequest("Cantidad inválida");
      return {
        product: product._id,
        name: product.name,
        qty: item.qty,
        unitPrice: product.price,
        courtesy: Boolean(item.courtesy) && canCourtesy,
        deliveredQty: 0,
        cancelledQty: 0,
        annulledQty: 0,
      };
    });

    const order = new Order({
      cruise: cruise._id,
      cabinNumber,
      items: orderItems,
      total: 0,
      createdBy: req.auth!.sub,
      idempotencyKey: idempotencyKey ?? null,
    });
    recomputeOrder(order);

    try {
      await order.save();
    } catch (err) {
      if ((err as { code?: number }).code === 11000 && idempotencyKey) {
        const existing = await Order.findOne({ idempotencyKey });
        res.status(200).json({ order: existing, duplicated: true });
        return;
      }
      throw err;
    }

    await chargesChanged(cruise._id, cabinNumber, req.auth!.sub, "Consumo registrado");
    await logEvent(req.auth, {
      kind: "pedido",
      title: `Consumo registrado · cabina ${cabinNumber}`,
      detail: orderItems
        .map((i) => `${i.qty}× ${i.name}${i.courtesy ? " (cortesía)" : ""}`)
        .join(", "),
      amount: order.total,
      cruise: cruise._id,
      cabinNumber,
    });

    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
}

/**
 * Entrega total o parcial. Aquí se descuenta el stock a bordo según la
 * medida de cada producto. Repetir con la misma `key` no descuenta dos veces.
 */
export async function deliverOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, key } = req.body as { items?: IndexQty[]; key?: string };
    if (!key) throw badRequest("Falta la clave de la entrega");

    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    if (order.deliveries.some((d) => d.key === key)) {
      res.json({ order, duplicated: true });
      return;
    }
    assertNotCharged(order);

    const picks = normalizePicks(order, items, (i) => pendingQty(order.items[i]!));
    for (const pick of picks) order.items[pick.index]!.deliveredQty += pick.qty;
    order.deliveries.push({ key, items: picks, by: req.auth!.sub as never, at: new Date() });
    recomputeOrder(order);

    try {
      await order.save();
    } catch (err) {
      if (err instanceof MongooseError.VersionError) {
        throw conflict("El consumo cambió mientras lo entregabas. Revisa y vuelve a intentar.");
      }
      throw err;
    }

    // El stock se mueve solo después de guardar la entrega.
    const parts = await Promise.all(
      picks.map((p) => consumptionOf(order.items[p.index]!.product.toString(), p.qty)),
    );
    await applyMovement({
      type: "venta",
      location: "abordo",
      deltas: new Map([...(await mergeDeltas(parts))].map(([id, q]) => [id, -q])),
      userId: req.auth!.sub,
      cruise: order.cruise,
      order: order._id,
      reason: `Entrega cabina ${order.cabinNumber}`,
    });

    await logEvent(req.auth, {
      kind: "entrega",
      title: `Entregado · cabina ${order.cabinNumber}`,
      detail: describeItems(order, picks),
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });

    res.json({ order });
  } catch (err) {
    next(err);
  }
}

/**
 * Cancela lo que aún no se entregó. No toca el stock y lo retira del saldo
 * cobrable. Bar cancela sus propios pedidos; Dirección y administración,
 * cualquier pendiente de la salida.
 */
export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, reason } = req.body as { items?: IndexQty[]; reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo de la cancelación es obligatorio");

    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    assertNotCharged(order);

    const role = req.auth!.role;
    if (role === "bartender" && order.createdBy.toString() !== req.auth!.sub) {
      throw forbidden("Solo puedes cancelar consumos que registraste tú. Pídelo a Dirección de crucero.");
    }
    if (role === "bodega") throw forbidden();

    const picks = normalizePicks(order, items, (i) => pendingQty(order.items[i]!));
    for (const pick of picks) order.items[pick.index]!.cancelledQty += pick.qty;
    order.cancellations.push({
      items: picks,
      reason: reason.trim(),
      by: req.auth!.sub as never,
      at: new Date(),
    });
    recomputeOrder(order);

    try {
      await order.save();
    } catch (err) {
      if (err instanceof MongooseError.VersionError) {
        throw conflict("El consumo cambió mientras lo cancelabas. Revisa y vuelve a intentar.");
      }
      throw err;
    }

    await chargesChanged(order.cruise, order.cabinNumber, req.auth!.sub, `Cancelación: ${reason}`);
    await logEvent(req.auth, {
      kind: "cancelacion",
      title: `Cancelado · cabina ${order.cabinNumber}`,
      detail: `${describeItems(order, picks)} · ${reason}`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });

    res.json({ order });
  } catch (err) {
    next(err);
  }
}

/** Lo ya entregado no se cancela: se solicita su anulación a Dirección. */
export async function requestAnnulment(req: Request, res: Response, next: NextFunction) {
  try {
    const { index, qty, reason } = req.body as { index?: number; qty?: number; reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo de la anulación es obligatorio");

    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    assertNotCharged(order);

    const item = index !== undefined ? order.items[index] : undefined;
    if (!item || index === undefined) throw badRequest("Ítem inválido");
    const requested = order.annulments
      .filter((a) => a.index === index && a.status === "pendiente")
      .reduce((sum, a) => sum + a.qty, 0);
    const available = item.deliveredQty - item.annulledQty - requested;
    if (!qty || !Number.isInteger(qty) || qty < 1 || qty > available) {
      throw badRequest(`Solo puedes pedir anular hasta ${available} de ${item.name}`);
    }

    order.annulments.push({
      index,
      qty,
      reason: reason.trim(),
      requestedBy: req.auth!.sub as never,
      requestedAt: new Date(),
      status: "pendiente",
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: "",
      restocked: false,
    });
    await order.save();

    await logEvent(req.auth, {
      kind: "anulacion",
      title: `Anulación solicitada · cabina ${order.cabinNumber}`,
      detail: `${qty}× ${item.name} · ${reason}`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });

    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
}

/**
 * Dirección aprueba o rechaza la anulación. Devolver la bebida al stock
 * es decisión exclusiva de Gerencia.
 */
export async function reviewAnnulment(req: Request, res: Response, next: NextFunction) {
  try {
    const { decision, restock, note } = req.body as {
      decision?: "aprobar" | "rechazar";
      restock?: boolean;
      note?: string;
    };
    if (decision !== "aprobar" && decision !== "rechazar") throw badRequest("Decisión inválida");
    if (restock && req.auth!.role !== "duena") {
      throw forbidden("Solo Gerencia puede devolver stock");
    }

    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Consumo no encontrado");
    assertNotCharged(order);

    const annulment = order.annulments.find((a) => a._id?.toString() === req.params.annulmentId);
    if (!annulment) throw notFound("Solicitud no encontrada");
    if (annulment.status !== "pendiente") throw conflict("Esta solicitud ya fue revisada");

    const item = order.items[annulment.index]!;
    annulment.status = decision === "aprobar" ? "aprobada" : "rechazada";
    annulment.reviewedBy = req.auth!.sub as never;
    annulment.reviewedAt = new Date();
    annulment.reviewNote = note?.trim() ?? "";

    if (decision === "aprobar") {
      if (annulment.qty > item.deliveredQty - item.annulledQty) {
        throw conflict("La cantidad a anular ya no está disponible");
      }
      item.annulledQty += annulment.qty;
      annulment.restocked = Boolean(restock);
      recomputeOrder(order);
    }

    try {
      await order.save();
    } catch (err) {
      if (err instanceof MongooseError.VersionError) {
        throw conflict("El consumo cambió mientras lo revisabas. Vuelve a intentar.");
      }
      throw err;
    }

    if (decision === "aprobar") {
      if (restock) {
        // Se devuelve lo que salió según la receta aplicada en la venta.
        const deltas = item.applied?.length
          ? deltasFromApplied(item.applied, annulment.qty)
          : await consumptionOf(item.product.toString(), annulment.qty);
        await applyMovement({
          type: "devolucion",
          location: "abordo",
          deltas,
          userId: req.auth!.sub,
          cruise: order.cruise,
          order: order._id,
          reason: `Anulación aprobada con devolución: ${annulment.reason}`,
        });
      }
      await chargesChanged(
        order.cruise,
        order.cabinNumber,
        req.auth!.sub,
        `Anulación aprobada: ${annulment.qty}× ${item.name}`,
      );
    }

    await logEvent(req.auth, {
      kind: "anulacion",
      title: `Anulación ${decision === "aprobar" ? "aprobada" : "rechazada"} · cabina ${order.cabinNumber}`,
      detail: `${annulment.qty}× ${item.name}${restock ? " · devuelto al stock" : ""}${
        annulment.reviewNote ? ` · ${annulment.reviewNote}` : ""
      }`,
      cruise: order.cruise,
      cabinNumber: order.cabinNumber,
    });

    res.json({ order });
  } catch (err) {
    next(err);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, status, before, limit, annulment, mine } = req.query as Record<
      string,
      string
    >;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    if (cabinNumber) filter.cabinNumber = Number(cabinNumber);
    if (status) filter.status = status;
    if (annulment) filter["annulments.status"] = annulment;
    if (mine === "1") filter.createdBy = req.auth!.sub;
    if (before) filter.createdAt = { $lt: new Date(before) };

    const pageSize = Math.min(Number(limit) || 50, 300);
    const orders = await Order.find(filter)
      .populate("createdBy", "name role")
      .populate("annulments.requestedBy", "name")
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);

    const hasMore = orders.length > pageSize;
    res.json({ orders: hasMore ? orders.slice(0, pageSize) : orders, hasMore });
  } catch (err) {
    next(err);
  }
}

/** Cuenta acumulada de una cabina (vista de revisión y cobro). */
export async function cabinAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = req.params;
    const account = await buildCabinAccount(String(cruiseId), Number(cabinNumber));
    res.json({ account });
  } catch (err) {
    next(err);
  }
}
