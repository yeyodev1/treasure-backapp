import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { Cruise } from "../models/cruise.model";
import { moveStock } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, notFound } from "../errors/httpError";
import { isPositiveQty, QTY_POSITIVE_ERROR, STOCK_LOCATIONS, StockLocation } from "../utils/units";

function parseLocation(value: unknown, fallback: StockLocation = "abordo"): StockLocation {
  if (value === undefined) return fallback;
  if (!STOCK_LOCATIONS.includes(value as StockLocation)) throw badRequest("Ubicación inválida");
  return value as StockLocation;
}

/** Stock de insumos físicos por ubicación, en unidad base y en envases. */
export async function stockByLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const location = parseLocation(req.query.location);
    const field = location === "bodega" ? "warehouseStock" : "onboardStock";
    const products = await Product.find({ kind: "fisico", active: true })
      .select(
        "name category icon stockUnit containerSize containerLabel warehouseStock onboardStock lowStockThreshold sellable costPerUnit",
      )
      .sort({ category: 1, name: 1 });

    res.json({
      location,
      items: products.map((p) => {
        const qty = p[field];
        return {
          product: p,
          qty,
          containers: p.containerSize ? qty / p.containerSize : qty,
          negative: qty < 0,
          low: p.lowStockThreshold > 0 && qty <= p.lowStockThreshold,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

async function activeCruiseId() {
  const cruise = await Cruise.findOne({ status: "abordo" }).select("_id");
  return cruise?._id ?? null;
}

/** Merma reportada en el momento (se cayó una botella): resta con motivo, sin negativos. */
export async function registerWaste(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, qty, reason, key } = req.body as {
      productId?: string;
      qty?: number;
      reason?: string;
      key?: string;
    };
    const location = parseLocation(req.body.location);
    if (!productId) throw badRequest("Elige el producto");
    if (!isPositiveQty(qty)) throw badRequest(QTY_POSITIVE_ERROR);
    if (!reason?.trim()) throw badRequest("La merma necesita un motivo");
    // La misma clave (reintento sin señal) nunca registra dos mermas.
    if (key && (await StockMovement.exists({ type: "merma", transferId: key }))) {
      res.json({ ok: true, duplicated: true });
      return;
    }

    const product = await Product.findById(productId);
    if (!product || product.kind !== "fisico") throw badRequest("Solo se registra merma de insumos físicos");

    const cruise = location === "abordo" ? await activeCruiseId() : null;
    await mongoose.connection.transaction((session) =>
      moveStock({
        session,
        guard: true,
        type: "merma",
        location,
        deltas: new Map([[productId, -qty]]),
        userId: req.auth!.sub,
        cruise,
        reason: reason.trim(),
        transferId: key ?? "",
      }),
    );
    await logEvent(req.auth, {
      kind: "inventario",
      title: `Merma · ${product.name}`,
      detail: `−${qty} ${product.stockUnit} (${location}) · ${reason.trim()}`,
      cruise,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Ajuste manual: solo Gerencia; nunca deja el stock bajo cero. */
export async function adjustStock(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, qty, reason } = req.body as {
      productId?: string;
      qty?: number;
      reason?: string;
    };
    const location = parseLocation(req.body.location);
    if (!productId || !qty) throw badRequest("Producto y cantidad son obligatorios");
    if (!reason?.trim()) throw badRequest("El ajuste necesita un motivo");

    const product = await Product.findById(productId);
    if (!product || product.kind !== "fisico") throw badRequest("Producto inválido");

    await mongoose.connection.transaction((session) =>
      moveStock({
        session,
        guard: true,
        type: "ajuste",
        location,
        deltas: new Map([[productId, qty]]),
        userId: req.auth!.sub,
        reason: reason.trim(),
      }),
    );
    await logEvent(req.auth, {
      kind: "inventario",
      title: `Ajuste manual · ${product.name}`,
      detail: `${qty > 0 ? "+" : ""}${qty} ${product.stockUnit} (${location}) · ${reason.trim()}`,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Cargar al barco: un traslado con origen bodega y destino a bordo. Las dos
 * patas comparten `transferId`; bodega nunca queda en negativo y el total
 * general no cambia. La misma clave no traslada dos veces.
 */
export async function transferToBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, key } = req.body as {
      items?: Array<{ productId: string; qty: number }>;
      key?: string;
    };
    if (!items?.length) throw badRequest("No hay ítems para cargar");
    const transferId = key || crypto.randomUUID();
    if (await StockMovement.exists({ transferId })) {
      res.json({ ok: true, duplicated: true, transferId });
      return;
    }

    const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
    const map = new Map(products.map((p) => [p._id.toString(), p]));
    const deltas = new Map<string, number>();
    for (const item of items) {
      const product = map.get(item.productId);
      if (!product || product.kind !== "fisico") throw badRequest("Hay productos inválidos");
      if (!isPositiveQty(item.qty)) throw badRequest(`${product.name}: ${QTY_POSITIVE_ERROR.toLowerCase()}`);
      deltas.set(item.productId, (deltas.get(item.productId) ?? 0) + item.qty);
    }
    const cruise = await activeCruiseId();

    await mongoose.connection.transaction(async (session) => {
      const base = { session, type: "carga" as const, userId: req.auth!.sub, cruise, transferId };
      await moveStock({
        ...base,
        guard: true,
        location: "bodega",
        deltas: new Map([...deltas].map(([id, q]) => [id, -q] as [string, number])),
        reason: "Sale de bodega hacia el barco",
      });
      await moveStock({ ...base, guard: false, location: "abordo", deltas, reason: "Llega desde bodega" });
    });

    await logEvent(req.auth, {
      kind: "inventario",
      title: "Carga al barco",
      detail: [...deltas]
        .map(([id, q]) => {
          const p = map.get(id)!;
          return `${p.name} +${q} ${p.stockUnit}`;
        })
        .join(", "),
      cruise,
    });
    res.status(201).json({ ok: true, transferId });
  } catch (err) {
    next(err);
  }
}

/** Bitácora de movimientos: quién hizo qué, cuándo, dónde y por qué. */
export async function listMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, productId, type, location, before, limit } = req.query as Record<
      string,
      string
    >;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    if (productId) filter.product = productId;
    if (type) filter.type = type;
    if (location) filter.location = location;
    if (before) filter.createdAt = { $lt: new Date(before) };

    const pageSize = Math.min(Number(limit) || 40, 300);
    const movements = await StockMovement.find(filter)
      .populate("product", "name stockUnit containerLabel icon")
      .populate("user", "name role")
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);

    const hasMore = movements.length > pageSize;
    res.json({ movements: hasMore ? movements.slice(0, pageSize) : movements, hasMore });
  } catch (err) {
    next(err);
  }
}

/** Ficha de un insumo: stock actual y últimos movimientos. */
export async function productStock(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await Product.findById(req.params.productId);
    if (!product) throw notFound("Producto no encontrado");
    const movements = await StockMovement.find({ product: product._id })
      .populate("user", "name role")
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ product, movements });
  } catch (err) {
    next(err);
  }
}
