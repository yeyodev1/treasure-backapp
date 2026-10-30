import { NextFunction, Request, Response } from "express";
import { isOwner } from "../utils/roles";
import { Types } from "mongoose";
import { StockCount } from "../models/stockCount.model";
import { Product } from "../models/product.model";
import { Cruise } from "../models/cruise.model";
import { applyMovement } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { round2, STOCK_LOCATIONS, StockLocation } from "../utils/units";

const POPULATE_PEOPLE = [
  { path: "createdBy", select: "name" },
  { path: "submittedBy", select: "name" },
  { path: "reviewedBy", select: "name" },
  { path: "cruise", select: "code name" },
];

async function nextCode(): Promise<string> {
  const last = await StockCount.findOne().sort({ createdAt: -1 }).select("code");
  const n = last ? Number(last.code.replace(/\D/g, "")) + 1 : 1;
  return `CT-${String(n).padStart(3, "0")}`;
}

export async function listCounts(_req: Request, res: Response, next: NextFunction) {
  try {
    const counts = await StockCount.find()
      .select("-lines")
      .populate(POPULATE_PEOPLE)
      .sort({ createdAt: -1 })
      .limit(60);
    res.json({ counts });
  } catch (err) {
    next(err);
  }
}

/**
 * Envase de cada producto (botella de 750 ml…) para mostrar el conteo en
 * envases y no en unidad base (checklist 29-oct, L09). No se guarda: sale
 * del catálogo vigente.
 */
async function withContainers(count: InstanceType<typeof StockCount>) {
  const json = count.toJSON() as unknown as { lines: Array<Record<string, unknown> & { product: unknown }> };
  const ids = json.lines.map((l) => l.product);
  const products = await Product.find({ _id: { $in: ids } }).select("containerSize containerLabel").lean();
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  json.lines = json.lines.map((line) => {
    const product = byId.get(String(line.product));
    return {
      ...line,
      containerSize: product?.containerSize ?? 1,
      containerLabel: product?.containerLabel ?? "",
    };
  });
  return json;
}

export async function getCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await StockCount.findById(req.params.id).populate(POPULATE_PEOPLE);
    if (!count) throw notFound("Conteo no encontrado");
    res.json({ count: await withContainers(count) });
  } catch (err) {
    next(err);
  }
}

/** Abre un conteo: toma una foto del stock digital en este instante (el corte). */
export async function createCount(req: Request, res: Response, next: NextFunction) {
  try {
    const location = req.body.location as StockLocation;
    if (!STOCK_LOCATIONS.includes(location)) throw badRequest("Ubicación inválida");

    const cruise =
      location === "abordo" ? await Cruise.findOne({ status: "abordo" }).select("_id") : null;
    const field = location === "bodega" ? "warehouseStock" : "onboardStock";
    const products = await Product.find({ kind: "fisico", active: true })
      .select(`name stockUnit ${field}`)
      .sort({ category: 1, name: 1 });

    const count = await StockCount.create({
      code: await nextCode(),
      location,
      cruise: cruise?._id ?? null,
      cutAt: new Date(),
      lines: products.map((p) => ({
        product: p._id,
        name: p.name,
        stockUnit: p.stockUnit,
        digitalAtCut: p[field],
        physical: null,
        reason: "",
      })),
      createdBy: req.auth!.sub,
    });

    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} abierto`,
      detail: location === "abordo" ? "A bordo" : "Bodega",
      cruise: cruise?._id ?? null,
    });
    res.status(201).json({ count: await withContainers(await count.populate(POPULATE_PEOPLE)) });
  } catch (err) {
    next(err);
  }
}

/** Guardar el conteo nunca cambia stock. */
export async function saveCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { lines, notes } = req.body as {
      lines?: Array<{ product: string; physical: number | null; reason?: string }>;
      notes?: string;
    };
    const count = await StockCount.findById(req.params.id);
    if (!count) throw notFound("Conteo no encontrado");
    if (count.status !== "borrador" && count.status !== "rechazado") {
      throw conflict("Este conteo ya fue enviado para revisión y no se puede editar mientras se revisa");
    }

    const byProduct = new Map((lines ?? []).map((l) => [l.product, l]));
    for (const line of count.lines) {
      const update = byProduct.get(line.product.toString());
      if (!update) continue;
      if (update.physical !== null && !(update.physical >= 0)) {
        throw badRequest(`Cantidad física inválida en ${line.name}`);
      }
      line.physical = update.physical === null ? null : round2(update.physical);
      line.reason = update.reason?.trim() ?? line.reason;
    }
    if (notes !== undefined) count.notes = notes;
    count.status = "borrador";
    await count.save();
    res.json({ count: await withContainers(await count.populate(POPULATE_PEOPLE)) });
  } catch (err) {
    next(err);
  }
}

/** Enviar para revisión: cada diferencia necesita su motivo. */
export async function submitCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await StockCount.findById(req.params.id);
    if (!count) throw notFound("Conteo no encontrado");
    if (count.status !== "borrador" && count.status !== "rechazado") {
      throw conflict("Este conteo ya fue enviado");
    }

    const counted = count.lines.filter((l) => l.physical !== null);
    if (!counted.length) throw badRequest("Cuenta al menos un producto antes de enviar");
    const missingReason = counted.find(
      (l) => round2(l.physical! - l.digitalAtCut) !== 0 && !l.reason,
    );
    if (missingReason) throw badRequest(`Falta el motivo de la diferencia en ${missingReason.name}`);

    count.status = "enviado";
    count.submittedBy = new Types.ObjectId(req.auth!.sub);
    count.submittedAt = new Date();
    await count.save();

    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} enviado para revisión`,
      detail: `${counted.length} producto(s) contados`,
      cruise: count.cruise,
    });
    res.json({ count: await withContainers(await count.populate(POPULATE_PEOPLE)) });
  } catch (err) {
    next(err);
  }
}

/**
 * Solo Gerencia aprueba. Por cada producto se registra una sola diferencia
 * (físico − digital al corte) sobre el stock actual, así se conservan los
 * movimientos ocurridos después del corte.
 */
export async function approveCount(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isOwner(req.auth!.role)) throw forbidden("Solo Gerencia aprueba ajustes de inventario");

    const count = await StockCount.findOneAndUpdate(
      { _id: req.params.id, status: "enviado" },
      { $set: { status: "aprobado", reviewedBy: req.auth!.sub, reviewedAt: new Date() } },
      { new: true },
    );
    if (!count) throw conflict("El conteo no está pendiente de aprobación");

    let adjusted = 0;
    for (const line of count.lines) {
      if (line.physical === null) continue;
      const diff = round2(line.physical - line.digitalAtCut);
      if (!diff) continue;
      adjusted += 1;
      await applyMovement({
        type: "ajuste",
        location: count.location,
        deltas: new Map([[line.product.toString(), diff]]),
        userId: req.auth!.sub,
        cruise: count.cruise,
        count: count._id,
        reason: `${count.code} · ${line.reason}`,
      });
    }

    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} aprobado`,
      detail: `${adjusted} diferencia(s) ajustada(s)`,
      cruise: count.cruise,
    });
    res.json({ count: await withContainers(await count.populate(POPULATE_PEOPLE)) });
  } catch (err) {
    next(err);
  }
}

export async function rejectCount(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isOwner(req.auth!.role)) throw forbidden("Solo Gerencia revisa los conteos");
    const { note } = req.body as { note?: string };
    if (!note?.trim()) throw badRequest("Indica qué debe revisarse");

    const count = await StockCount.findOneAndUpdate(
      { _id: req.params.id, status: "enviado" },
      {
        $set: {
          status: "rechazado",
          reviewedBy: req.auth!.sub,
          reviewedAt: new Date(),
          reviewNote: note.trim(),
        },
      },
      { new: true },
    );
    if (!count) throw conflict("El conteo no está pendiente de aprobación");

    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} devuelto`,
      detail: note.trim(),
      cruise: count.cruise,
    });
    res.json({ count: await withContainers(await count.populate(POPULATE_PEOPLE)) });
  } catch (err) {
    next(err);
  }
}
