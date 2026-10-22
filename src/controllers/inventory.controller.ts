import { NextFunction, Request, Response } from "express";
import { CruiseStock } from "../models/cruiseStock.model";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { consumeCruiseStock } from "../services/inventory.service";
import { badRequest } from "../errors/httpError";

/** Stock a bordo del crucero indicado. */
export async function cruiseStock(req: Request, res: Response, next: NextFunction) {
  try {
    const stock = await CruiseStock.find({ cruise: req.params.cruiseId })
      .populate("product", "name category icon unit price")
      .sort({ "product.name": 1 });
    res.json({ stock });
  } catch (err) {
    next(err);
  }
}

/** Registra una merma: algo se cayó o se dañó; descarga inventario con motivo. */
export async function registerWaste(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, productId, qty, reason } = req.body as {
      cruiseId?: string;
      productId?: string;
      qty?: number;
      reason?: string;
    };
    if (!cruiseId || !productId || !qty || qty <= 0) {
      throw badRequest("Crucero, producto y cantidad son obligatorios");
    }
    if (!reason?.trim()) throw badRequest("La merma necesita un motivo");

    await consumeCruiseStock({
      cruiseId,
      userId: req.auth!.sub,
      type: "merma",
      reason,
      items: [{ productId, qty }],
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Ajuste manual tras verificación física (positivo o negativo) con motivo. */
export async function adjustStock(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, productId, qty, reason } = req.body as {
      cruiseId?: string;
      productId?: string;
      qty?: number;
      reason?: string;
    };
    if (!cruiseId || !productId || !qty) {
      throw badRequest("Crucero, producto y cantidad son obligatorios");
    }
    if (!reason?.trim()) throw badRequest("El ajuste necesita un motivo");

    await consumeCruiseStock({
      cruiseId,
      userId: req.auth!.sub,
      type: "ajuste",
      reason,
      items: [{ productId, qty: -qty }], // qty positivo suma, negativo resta
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Ingreso de compras a bodega (tierra). */
export async function warehousePurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const { items } = req.body as { items?: Array<{ productId: string; qty: number }> };
    if (!items?.length) throw badRequest("No hay ítems para ingresar");

    for (const item of items) {
      if (item.qty <= 0) throw badRequest("Cantidades inválidas");
      await Product.updateOne({ _id: item.productId }, { $inc: { warehouseStock: item.qty } });
      await StockMovement.create({
        type: "compra",
        product: item.productId,
        qty: item.qty,
        reason: "Ingreso a bodega",
        user: req.auth!.sub,
      });
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Bitácora de movimientos: quién hizo qué, cuándo y por qué. */
export async function listMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, productId, type } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    if (productId) filter.product = productId;
    if (type) filter.type = type;

    const movements = await StockMovement.find(filter)
      .populate("product", "name unit icon")
      .populate("user", "name role")
      .sort({ createdAt: -1 })
      .limit(300);
    res.json({ movements });
  } catch (err) {
    next(err);
  }
}
