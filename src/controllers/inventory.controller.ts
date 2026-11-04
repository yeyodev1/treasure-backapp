import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { Product } from "../models/product.model";
import { StockMovement } from "../models/stockMovement.model";
import { Cruise } from "../models/cruise.model";
import { StockCount } from "../models/stockCount.model";
import { LOCATION_FIELD, moveStock, stockOf } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { canSeeCosts } from "../utils/roles";
import {
  isActiveLocation,
  isPositiveQty,
  LOCATION_LABELS,
  QTY_POSITIVE_ERROR,
  round2,
  STOCK_LOCATIONS,
  StockLocation,
} from "../utils/units";

function parseLocation(value: unknown, fallback: StockLocation = "abordo"): StockLocation {
  if (value === undefined) return fallback;
  if (!STOCK_LOCATIONS.includes(value as StockLocation)) throw badRequest("Ubicación inválida");
  return value as StockLocation;
}

/**
 * Stock de insumos físicos de una ubicación (unidad base y envases). Cada
 * ítem trae además las cantidades de todas las ubicaciones (`byLocation`).
 * El costo solo va a quien puede verlo.
 */
export async function stockByLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const location = parseLocation(req.query.location);
    const field = LOCATION_FIELD[location];
    const costs = canSeeCosts(req.auth?.role);
    const products = await Product.find({ kind: "fisico", active: true })
      .select(
        `name category icon stockUnit containerSize containerLabel warehouseStock quitoStock puertoStock onboardStock lowStockThreshold stockTarget sellable${costs ? " costPerUnit" : ""}`,
      )
      .sort({ category: 1, name: 1 });

    res.json({
      location,
      items: products.map((p) => {
        const qty = p[field];
        return {
          product: p,
          byLocation: stockOf(p),
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
 * Traslado entre ubicaciones (Quito → Puerto, Puerto → A bordo…). Las dos
 * patas comparten `transferId`: el origen nunca queda en negativo y el total
 * general no cambia. Se registra cuando la mercadería llega (sin estado "en
 * tránsito"). La misma clave no traslada dos veces. Sin origen/destino se
 * asume Puerto → A bordo.
 */
export async function transferToBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, key } = req.body as {
      items?: Array<{ productId: string; qty: number }>;
      key?: string;
    };
    const from = parseLocation(req.body.from, "puerto");
    const to = parseLocation(req.body.to, "abordo");
    if (from === to) throw badRequest("El origen y el destino deben ser distintos");
    if (!isActiveLocation(to)) throw badRequest("A la bodega sin separar no entra mercadería");
    if (!items?.length) throw badRequest("No hay ítems para trasladar");
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
    const cruise = from === "abordo" || to === "abordo" ? await activeCruiseId() : null;

    await mongoose.connection.transaction(async (session) => {
      const base = { session, type: "carga" as const, userId: req.auth!.sub, cruise, transferId };
      await moveStock({
        ...base,
        guard: true,
        location: from,
        deltas: new Map([...deltas].map(([id, q]) => [id, -q] as [string, number])),
        reason: `Sale de ${LOCATION_LABELS[from]} hacia ${LOCATION_LABELS[to]}`,
      });
      await moveStock({ ...base, guard: false, location: to, deltas, reason: `Llega desde ${LOCATION_LABELS[from]}` });
    });

    await logEvent(req.auth, {
      kind: "inventario",
      title: to === "abordo" ? "Carga al barco" : `Traslado ${LOCATION_LABELS[from]} → ${LOCATION_LABELS[to]}`,
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

/**
 * Cierra el saldo de "Bodega sin separar" (guía 4-nov: no asignarlo por
 * suposición). Exige un conteo físico aprobado de Quito y otro de Puerto,
 * hechos después del último movimiento que sumó a esa bodega: lo que hay en
 * cada lugar ya entró con esos conteos, así que el saldo anterior se lleva a
 * cero con un ajuste trazable por producto. Solo Gerencia.
 */
export async function closeUnsplitStock(req: Request, res: Response, next: NextFunction) {
  try {
    const [quito, puerto] = await Promise.all(
      (["quito", "puerto"] as const).map((location) =>
        StockCount.findOne({ location, status: "aprobado" }).sort({ reviewedAt: -1 }).select("code reviewedAt cutAt"),
      ),
    );
    if (!quito || !puerto) {
      throw conflict("Primero aprueba un conteo físico de Quito y otro de Puerto: así se sabe qué hay en cada lugar");
    }
    // Si algo salió de la bodega sin separar después del corte de esos conteos, ya no reflejan lo físico.
    const lastMove = await StockMovement.findOne({ location: "bodega" }).sort({ createdAt: -1 }).select("createdAt");
    const stale = [quito, puerto].find((c) => lastMove?.createdAt && c.cutAt < lastMove.createdAt);
    if (stale) {
      throw conflict(`La bodega sin separar tuvo movimientos después del conteo ${stale.code}: cuenta de nuevo esa ubicación`);
    }
    const products = await Product.find({ warehouseStock: { $ne: 0 } }).select("name stockUnit warehouseStock");
    if (!products.length) {
      res.json({ ok: true, closed: 0 });
      return;
    }
    const reason = `Saldo sin separar cerrado: lo físico quedó en Quito (${quito.code}) y Puerto (${puerto.code})`;
    await mongoose.connection.transaction(async (session) => {
      for (const p of products) {
        // Solo si nadie lo movió entre la lectura y ahora.
        const result = await Product.updateOne(
          { _id: p._id, warehouseStock: p.warehouseStock },
          { $set: { warehouseStock: 0 } },
          { session },
        );
        if (!result.matchedCount) throw conflict("El saldo cambió mientras cerrabas: vuelve a intentarlo");
        await StockMovement.create(
          [
            {
              type: "ajuste",
              product: p._id,
              location: "bodega",
              qty: round2(-p.warehouseStock),
              reason,
              user: req.auth!.sub,
            },
          ],
          { session },
        );
      }
    });
    await logEvent(req.auth, {
      kind: "inventario",
      title: "Bodega sin separar cerrada",
      detail: `${products.length} producto(s) · ${reason}`,
    });
    res.json({ ok: true, closed: products.length });
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
    const product = await Product.findById(req.params.productId).select(
      canSeeCosts(req.auth?.role) ? "" : "-costPerUnit -costUpdatedAt",
    );
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
