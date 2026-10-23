import { NextFunction, Request, Response } from "express";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { Cruise } from "../models/cruise.model";
import { applyMovement } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, notFound } from "../errors/httpError";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

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
        "name category icon stockUnit containerSize containerLabel warehouseStock onboardStock lowStockThreshold sellable",
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

/** Merma reportada en el momento (se cayó una botella): resta con motivo. */
export async function registerWaste(req: Request, res: Response, next: NextFunction) {
  try {
    const { productId, qty, reason } = req.body as {
      productId?: string;
      qty?: number;
      reason?: string;
    };
    const location = parseLocation(req.body.location);
    if (!productId || !qty || qty <= 0) throw badRequest("Producto y cantidad son obligatorios");
    if (!reason?.trim()) throw badRequest("La merma necesita un motivo");

    const product = await Product.findById(productId);
    if (!product || product.kind !== "fisico") throw badRequest("Solo se registra merma de insumos físicos");

    await applyMovement({
      type: "merma",
      location,
      deltas: new Map([[productId, -qty]]),
      userId: req.auth!.sub,
      cruise: location === "abordo" ? await activeCruiseId() : null,
      reason: reason.trim(),
    });
    await logEvent(req.auth, {
      kind: "inventario",
      title: `Merma · ${product.name}`,
      detail: `−${qty} ${product.stockUnit} · ${reason.trim()}`,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Ajuste manual: exclusivo de administración (Paula autoriza ajustes). */
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

    await applyMovement({
      type: "ajuste",
      location,
      deltas: new Map([[productId, qty]]),
      userId: req.auth!.sub,
      reason: reason.trim(),
    });
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

/** Compra a bodega con proveedor, documento, cantidad y costo por envase. */
export async function warehousePurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, supplier, document } = req.body as {
      items?: Array<{ productId: string; containers: number; unitCost?: number }>;
      supplier?: string;
      document?: string;
    };
    if (!items?.length) throw badRequest("No hay ítems para ingresar");
    if (!supplier?.trim()) throw badRequest("Indica el proveedor");
    if (!document?.trim()) throw badRequest("Indica el documento (factura o guía)");

    const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
    const map = new Map(products.map((p) => [p._id.toString(), p]));

    for (const item of items) {
      const product = map.get(item.productId);
      if (!product || product.kind !== "fisico") throw badRequest("Hay productos inválidos");
      if (!(item.containers > 0)) throw badRequest("Cantidades inválidas");
      await applyMovement({
        type: "compra",
        location: "bodega",
        deltas: new Map([[item.productId, item.containers * (product.containerSize || 1)]]),
        userId: req.auth!.sub,
        reason: `${item.containers} ${product.containerLabel}`,
        supplier: supplier.trim(),
        document: document.trim(),
        unitCost: item.unitCost ?? 0,
      });
    }

    const total = items.reduce((sum, i) => sum + i.containers * (i.unitCost ?? 0), 0);
    await logEvent(req.auth, {
      kind: "inventario",
      title: `Compra a bodega · ${supplier.trim()}`,
      detail: `Doc. ${document.trim()} · ${items.length} producto(s)`,
      amount: total || null,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Carga a bordo: traslado de bodega al barco para la salida activa. */
export async function transferToBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const { items } = req.body as { items?: Array<{ productId: string; qty: number }> };
    if (!items?.length) throw badRequest("No hay ítems para cargar");

    const products = await Product.find({ _id: { $in: items.map((i) => i.productId) } });
    const map = new Map(products.map((p) => [p._id.toString(), p]));
    const cruise = await activeCruiseId();

    for (const item of items) {
      const product = map.get(item.productId);
      if (!product || product.kind !== "fisico") throw badRequest("Hay productos inválidos");
      if (!(item.qty > 0)) throw badRequest("Las cantidades deben ser mayores a cero");
      await applyMovement({
        type: "carga",
        location: "bodega",
        deltas: new Map([[item.productId, -item.qty]]),
        userId: req.auth!.sub,
        cruise,
        reason: "Sale de bodega hacia el barco",
      });
      await applyMovement({
        type: "carga",
        location: "abordo",
        deltas: new Map([[item.productId, item.qty]]),
        userId: req.auth!.sub,
        cruise,
        reason: "Llega desde bodega",
      });
    }

    await logEvent(req.auth, {
      kind: "inventario",
      title: "Carga a bordo",
      detail: items
        .map((i) => {
          const p = map.get(i.productId)!;
          return `${p.name} +${i.qty} ${p.stockUnit}`;
        })
        .join(", "),
      cruise,
    });
    res.status(201).json({ ok: true });
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
