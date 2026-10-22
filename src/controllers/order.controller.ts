import { NextFunction, Request, Response } from "express";
import { Order } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { Product } from "../models/product.model";
import { consumeCruiseStock } from "../services/inventory.service";
import { buildCabinAccount } from "../services/account.service";
import { badRequest, notFound } from "../errors/httpError";

/**
 * Crea una comanda: el bartender selecciona la cabina, agrega productos y envía.
 * El inventario del crucero se descuenta en el acto (cócteles por ingredientes).
 */
export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, items } = req.body as {
      cruiseId?: string;
      cabinNumber?: number;
      items?: Array<{ productId: string; qty: number; courtesy?: boolean }>;
    };
    if (!cruiseId || !cabinNumber || !items?.length) {
      throw badRequest("Crucero, cabina e ítems son obligatorios");
    }

    const cruise = await Cruise.findById(cruiseId);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "cerrado") throw badRequest("El crucero ya está cerrado");
    if (!cruise.cabins.some((c) => c.number === cabinNumber)) {
      throw badRequest("Cabina inválida para este crucero");
    }

    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, active: true });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    // Cortesías: solo administración o dirección pueden marcarlas.
    const canCourtesy = req.auth!.role === "admin" || req.auth!.role === "direccion";

    const orderItems = items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw badRequest("Hay productos inválidos en el pedido");
      if (!Number.isInteger(item.qty) || item.qty < 1) throw badRequest("Cantidad inválida");
      return {
        product: product._id,
        name: product.name,
        qty: item.qty,
        unitPrice: product.price,
        courtesy: Boolean(item.courtesy) && canCourtesy,
      };
    });

    const total = orderItems.reduce(
      (sum, i) => sum + (i.courtesy ? 0 : i.qty * i.unitPrice),
      0,
    );

    const order = await Order.create({
      cruise: cruise._id,
      cabinNumber,
      items: orderItems,
      total: Math.round(total * 100) / 100,
      createdBy: req.auth!.sub,
    });

    // La cortesía también descarga inventario (acuerdo de reunión).
    await consumeCruiseStock({
      cruiseId,
      userId: req.auth!.sub,
      orderId: order._id,
      type: "venta",
      items: items.map((i) => ({ productId: i.productId, qty: i.qty })),
    });

    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    if (cabinNumber) filter.cabinNumber = Number(cabinNumber);
    if (status) filter.status = status;

    const orders = await Order.find(filter)
      .populate("createdBy", "name role")
      .sort({ createdAt: -1 })
      .limit(300);
    res.json({ orders });
  } catch (err) {
    next(err);
  }
}

export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    const order = await Order.findById(req.params.id);
    if (!order) throw notFound("Pedido no encontrado");
    if (order.status !== "abierta") throw badRequest("Solo se anulan pedidos abiertos");

    order.status = "anulada";
    await order.save();

    // Devuelve el stock con un ajuste positivo en la bitácora.
    await consumeCruiseStock({
      cruiseId: order.cruise,
      userId: req.auth!.sub,
      orderId: order._id,
      type: "ajuste",
      reason: `Anulación de pedido: ${reason ?? "sin motivo"}`,
      items: order.items.map((i) => ({ productId: i.product.toString(), qty: -i.qty })),
    });

    res.json({ order });
  } catch (err) {
    next(err);
  }
}

/** Cuenta acumulada de una cabina (para la vista de cobro y la del pasajero). */
export async function cabinAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = req.params;
    const account = await buildCabinAccount(String(cruiseId), Number(cabinNumber));
    res.json({ account });
  } catch (err) {
    next(err);
  }
}
