import { NextFunction, Request, Response } from "express";
import mongoose, { ClientSession } from "mongoose";
import crypto from "crypto";
import { Product } from "../models/product.model";
import { Requisition, RequisitionKind } from "../models/requisition.model";
import { Purchase } from "../models/purchase.model";
import { Cruise } from "../models/cruise.model";
import { moveStock } from "../services/inventory.service";
import { nextCode } from "../services/codes.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { round2, STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Abastecimiento (guía auditada 27-oct-2026):
 * - El bar pide (requerimiento): Solicitado → Aprobado/Rechazado (directora)
 *   → Recibido parcial/completo. Aprobar no suma stock; recibir traslada la
 *   cantidad real de bodega al barco y descuenta lo pendiente.
 * - Compras: la factura se registra sin mover stock; la recepción física
 *   suma lo que llegó al almacén destino con su costo.
 * Toda recepción lleva una clave: repetirla no duplica.
 */

const round4 = (v: number) => Math.round(v * 10000) / 10000;

async function activeCruiseId() {
  const cruise = await Cruise.findOne({ status: "abordo" }).select("_id");
  return cruise?._id ?? null;
}

/** "lata" → "latas", "botella" → "botellas", "unidad" → "unidades". */
function plural(word: string) {
  if (!word) return word;
  return /[aeiouáéó]$/i.test(word) ? `${word}s` : `${word}es`;
}

// ---------------------------------------------------------------------------
// Requerimientos
// ---------------------------------------------------------------------------

const REQUISITION_POPULATE = [
  { path: "requestedBy", select: "name role" },
  { path: "reviewedBy", select: "name" },
  { path: "receipts.by", select: "name" },
  { path: "cruise", select: "code name" },
  { path: "lines.product", select: "name stockUnit containerSize containerLabel icon warehouseStock onboardStock" },
];

export async function createRequisition(req: Request, res: Response, next: NextFunction) {
  try {
    const { kind, lines, note, idempotencyKey } = req.body as {
      kind?: RequisitionKind;
      lines?: Array<{ productId: string; qty: number; unit?: "envase" | "base" }>;
      note?: string;
      idempotencyKey?: string;
    };
    const type: RequisitionKind = kind === "revision" ? "revision" : "abastecimiento";
    if (!lines?.length) throw badRequest("Agrega al menos un producto");
    if (type === "revision" && !note?.trim()) {
      throw badRequest("Cuenta qué ves: por ejemplo, la botella está en la barra");
    }

    if (idempotencyKey) {
      const existing = await Requisition.findOne({ idempotencyKey });
      if (existing) {
        res.json({ requisition: await existing.populate(REQUISITION_POPULATE), duplicated: true });
        return;
      }
    }

    const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) }, kind: "fisico" });
    const map = new Map(products.map((p) => [p._id.toString(), p]));
    const clean = lines.map((line) => {
      const product = map.get(line.productId);
      if (!product) throw badRequest("Solo se piden insumos físicos");
      if (type === "abastecimiento" && !(line.qty > 0)) throw badRequest(`Indica cuánto ${product.name}`);
      const byContainer = line.unit !== "base" && product.containerSize > 1;
      const qty = byContainer ? line.qty * product.containerSize : line.qty;
      return {
        product: product._id,
        name: product.name,
        qty: round2(qty || 0),
        label: type === "revision"
          ? "Revisión de inventario"
          : byContainer
            ? `${line.qty} ${line.qty === 1 ? product.containerLabel : plural(product.containerLabel)}`
            : `${line.qty} ${product.stockUnit}`,
        receivedQty: 0,
      };
    });

    const requisition = await Requisition.create({
      code: await nextCode(type === "revision" ? "RV" : "RQ"),
      kind: type,
      cruise: await activeCruiseId(),
      lines: clean,
      note: note?.trim() ?? "",
      requestedBy: req.auth!.sub,
      idempotencyKey: idempotencyKey ?? null,
    });

    await logEvent(req.auth, {
      kind: "requerimiento",
      title: `${type === "revision" ? "Revisión de inventario" : "Requerimiento"} ${requisition.code}`,
      detail: clean.map((l) => `${l.name}${type === "revision" ? "" : ` · ${l.label}`}`).join(", "),
      cruise: requisition.cruise,
    });
    res.status(201).json({ requisition: await requisition.populate(REQUISITION_POPULATE) });
  } catch (err) {
    next(err);
  }
}

export async function listRequisitions(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, kind, mine, before, limit } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = { $in: status.split(",") };
    if (kind) filter.kind = kind;
    if (mine === "1" || req.auth!.role === "bartender") filter.requestedBy = req.auth!.sub;
    if (before) filter.createdAt = { $lt: new Date(before) };
    const pageSize = Math.min(Number(limit) || 40, 200);
    const rows = await Requisition.find(filter)
      .populate(REQUISITION_POPULATE)
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);
    const hasMore = rows.length > pageSize;
    res.json({ requisitions: hasMore ? rows.slice(0, pageSize) : rows, hasMore });
  } catch (err) {
    next(err);
  }
}

/** La directora aprueba o rechaza (con motivo). Aprobar no suma stock. */
export async function reviewRequisition(req: Request, res: Response, next: NextFunction) {
  try {
    const { decision, note } = req.body as { decision?: "aprobar" | "rechazar"; note?: string };
    if (decision !== "aprobar" && decision !== "rechazar") throw badRequest("Decisión inválida");
    if (decision === "rechazar" && !note?.trim()) throw badRequest("El motivo del rechazo es obligatorio");

    const requisition = await Requisition.findOneAndUpdate(
      { _id: req.params.id, kind: "abastecimiento", status: "solicitado" },
      {
        $set: {
          status: decision === "aprobar" ? "aprobado" : "rechazado",
          reviewedBy: req.auth!.sub,
          reviewedAt: new Date(),
          reviewNote: note?.trim() ?? "",
        },
      },
      { new: true },
    );
    if (!requisition) throw conflict("El requerimiento no existe o ya fue revisado");

    await logEvent(req.auth, {
      kind: "requerimiento",
      title: `Requerimiento ${requisition.code} ${decision === "aprobar" ? "aprobado" : "rechazado"}`,
      detail: note?.trim() ?? "",
      cruise: requisition.cruise,
    });
    res.json({ requisition: await requisition.populate(REQUISITION_POPULATE) });
  } catch (err) {
    next(err);
  }
}

/**
 * Recepción física de un requerimiento aprobado: traslada la cantidad real
 * de bodega al barco (sin dejar bodega en negativo) y descuenta lo pendiente.
 */
export async function receiveRequisition(req: Request, res: Response, next: NextFunction) {
  try {
    const { key, lines, note } = req.body as {
      key?: string;
      lines?: Array<{ index: number; qty: number }>;
      note?: string;
    };
    if (!key) throw badRequest("Falta la clave de la recepción");
    if (!lines?.length) throw badRequest("Indica qué llegó");

    const current = await Requisition.findById(req.params.id);
    if (!current) throw notFound("Requerimiento no encontrado");
    if (current.receipts.some((r) => r.key === key)) {
      res.json({ requisition: await current.populate(REQUISITION_POPULATE), duplicated: true });
      return;
    }

    let code = "";
    await mongoose.connection.transaction(async (session) => {
      const requisition = await Requisition.findById(req.params.id).session(session);
      if (!requisition) throw notFound("Requerimiento no encontrado");
      if (!["aprobado", "recibido_parcial"].includes(requisition.status)) {
        throw conflict("Solo se recibe un requerimiento aprobado y con pendiente");
      }
      code = requisition.code;
      const picks: Array<{ index: number; qty: number }> = [];
      for (const pick of lines) {
        const line = requisition.lines[pick.index];
        if (!line) throw badRequest("Hay una línea inválida");
        if (!(pick.qty >= 0)) throw badRequest("Cantidad inválida");
        if (pick.qty === 0) continue;
        const pending = round2(line.qty - line.receivedQty);
        if (pick.qty > pending + 1e-9) throw badRequest(`De ${line.name} solo quedan ${pending} por recibir`);
        line.receivedQty = round2(line.receivedQty + pick.qty);
        picks.push(pick);
      }
      if (!picks.length) throw badRequest("Indica al menos una cantidad recibida");

      const transferId = crypto.randomUUID();
      const deltas = new Map<string, number>();
      for (const pick of picks) {
        const id = requisition.lines[pick.index]!.product.toString();
        deltas.set(id, round2((deltas.get(id) ?? 0) + pick.qty));
      }
      const base = {
        session,
        type: "carga" as const,
        userId: req.auth!.sub,
        cruise: requisition.cruise,
        requisition: requisition._id,
        transferId,
      };
      await moveStock({
        ...base,
        guard: true,
        location: "bodega",
        deltas: new Map([...deltas].map(([id, q]) => [id, -q] as [string, number])),
        reason: `${requisition.code}: sale de bodega`,
      });
      await moveStock({ ...base, guard: false, location: "abordo", deltas, reason: `${requisition.code}: llega al barco` });

      const complete = requisition.lines.every((l) => l.receivedQty + 1e-9 >= l.qty);
      requisition.status = complete ? "recibido" : "recibido_parcial";
      requisition.receipts.push({
        key,
        lines: picks,
        note: note?.trim() ?? "",
        transferId,
        by: req.auth!.sub as never,
        at: new Date(),
      });
      await requisition.save({ session });
    });

    const saved = await Requisition.findById(req.params.id).populate(REQUISITION_POPULATE);
    await logEvent(req.auth, {
      kind: "requerimiento",
      title: `Requerimiento ${code} ${saved?.status === "recibido" ? "recibido" : "recibido parcial"}`,
      detail: lines
        .filter((l) => l.qty > 0)
        .map((l) => `${saved?.lines[l.index]?.name ?? "?"} +${l.qty}`)
        .join(", "),
      cruise: saved?.cruise ?? null,
    });
    res.json({ requisition: saved });
  } catch (err) {
    next(err);
  }
}

/** La administradora atiende una solicitud de revisión (normalmente tras un conteo). */
export async function resolveRequisition(req: Request, res: Response, next: NextFunction) {
  try {
    const note = (req.body?.note as string | undefined)?.trim();
    if (!note) throw badRequest("Cuenta qué se hizo (p. ej. conteo CT-004 aprobado)");
    const requisition = await Requisition.findOneAndUpdate(
      { _id: req.params.id, kind: "revision", status: "solicitado" },
      { $set: { status: "atendido", reviewedBy: req.auth!.sub, reviewedAt: new Date(), reviewNote: note } },
      { new: true },
    );
    if (!requisition) throw conflict("La solicitud no existe o ya fue atendida");
    await logEvent(req.auth, {
      kind: "requerimiento",
      title: `Revisión ${requisition.code} atendida`,
      detail: note,
    });
    res.json({ requisition: await requisition.populate(REQUISITION_POPULATE) });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Compras
// ---------------------------------------------------------------------------

const PURCHASE_POPULATE = [
  { path: "createdBy", select: "name" },
  { path: "receipts.by", select: "name" },
  { path: "lines.product", select: "name stockUnit containerSize containerLabel icon" },
];

/** Registrar la factura: guarda cantidades, conversión y costo. No mueve stock. */
export async function createPurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const { supplier, document, documentDate, destination, lines, note, idempotencyKey } = req.body as {
      supplier?: string;
      document?: string;
      documentDate?: string;
      destination?: StockLocation;
      lines?: Array<{ productId: string; containers: number; containerCost?: number }>;
      note?: string;
      idempotencyKey?: string;
    };
    if (!supplier?.trim()) throw badRequest("Indica el proveedor");
    if (!document?.trim()) throw badRequest("Indica el número de factura o guía");
    if (!lines?.length) throw badRequest("Agrega al menos un producto");
    const target: StockLocation = destination ?? "bodega";
    if (!STOCK_LOCATIONS.includes(target)) throw badRequest("Almacén destino inválido");

    if (idempotencyKey) {
      const existing = await Purchase.findOne({ idempotencyKey });
      if (existing) {
        res.json({ purchase: await existing.populate(PURCHASE_POPULATE), duplicated: true });
        return;
      }
    }

    const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) }, kind: "fisico" });
    const map = new Map(products.map((p) => [p._id.toString(), p]));
    const clean = lines.map((line) => {
      const product = map.get(line.productId);
      if (!product) throw badRequest("Solo se compran insumos físicos");
      if (!(line.containers > 0)) throw badRequest(`Indica cuántos ${product.containerLabel} de ${product.name}`);
      if (line.containerCost !== undefined && !(line.containerCost >= 0)) throw badRequest("Costo inválido");
      return {
        product: product._id,
        name: product.name,
        containers: line.containers,
        containerSize: product.containerSize || 1,
        containerLabel: product.containerLabel,
        stockUnit: product.stockUnit,
        qty: round2(line.containers * (product.containerSize || 1)),
        containerCost: round4(line.containerCost ?? 0),
        receivedQty: 0,
      };
    });

    const purchase = await Purchase.create({
      code: await nextCode("CP"),
      supplier: supplier.trim(),
      document: document.trim(),
      documentDate: documentDate ? new Date(`${documentDate}T12:00:00-05:00`) : null,
      destination: target,
      lines: clean,
      total: round2(clean.reduce((s, l) => s + l.containers * l.containerCost, 0)),
      note: note?.trim() ?? "",
      idempotencyKey: idempotencyKey ?? null,
      createdBy: req.auth!.sub,
    });

    await logEvent(req.auth, {
      kind: "compra",
      title: `Compra ${purchase.code} registrada · ${purchase.supplier}`,
      detail: `Doc. ${purchase.document} · ${clean.length} producto(s) · llega a ${target === "bodega" ? "bodega" : "a bordo"}`,
      amount: purchase.total || null,
    });
    res.status(201).json({ purchase: await purchase.populate(PURCHASE_POPULATE) });
  } catch (err) {
    next(err);
  }
}

export async function listPurchases(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, before, limit } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (status) filter.status = { $in: status.split(",") };
    if (before) filter.createdAt = { $lt: new Date(before) };
    const pageSize = Math.min(Number(limit) || 40, 200);
    const rows = await Purchase.find(filter)
      .populate(PURCHASE_POPULATE)
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);
    const hasMore = rows.length > pageSize;
    res.json({ purchases: hasMore ? rows.slice(0, pageSize) : rows, hasMore });
  } catch (err) {
    next(err);
  }
}

/** Costo promedio ponderado por unidad base al recibir mercadería. */
async function updateCost(productId: string, qty: number, costPerUnit: number, session: ClientSession) {
  if (!(costPerUnit > 0) || !(qty > 0)) return;
  const product = await Product.findById(productId)
    .select("warehouseStock onboardStock costPerUnit")
    .session(session);
  if (!product) return;
  const onHand = Math.max(0, product.warehouseStock + product.onboardStock);
  const next =
    product.costPerUnit > 0 && onHand > 0
      ? (onHand * product.costPerUnit + qty * costPerUnit) / (onHand + qty)
      : costPerUnit;
  await Product.updateOne(
    { _id: productId },
    { $set: { costPerUnit: Math.round(next * 1e6) / 1e6, costUpdatedAt: new Date() } },
    { session },
  );
}

/**
 * Recepción física: lo que realmente llegó (en envases) se suma al almacén
 * destino de la compra con su costo. Repetir la misma clave no duplica.
 */
export async function receivePurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const { key, lines, note } = req.body as {
      key?: string;
      lines?: Array<{ index: number; containers: number }>;
      note?: string;
    };
    if (!key) throw badRequest("Falta la clave de la recepción");
    if (!lines?.length) throw badRequest("Indica qué llegó");

    const current = await Purchase.findById(req.params.id);
    if (!current) throw notFound("Compra no encontrada");
    if (current.receipts.some((r) => r.key === key)) {
      res.json({ purchase: await current.populate(PURCHASE_POPULATE), duplicated: true });
      return;
    }

    await mongoose.connection.transaction(async (session) => {
      const purchase = await Purchase.findById(req.params.id).session(session);
      if (!purchase) throw notFound("Compra no encontrada");
      if (!["registrada", "recibida_parcial"].includes(purchase.status)) {
        throw conflict("Esta compra ya se recibió completa o está anulada");
      }
      const picks: Array<{ index: number; qty: number }> = [];
      for (const pick of lines) {
        const line = purchase.lines[pick.index];
        if (!line) throw badRequest("Hay una línea inválida");
        if (!(pick.containers >= 0)) throw badRequest("Cantidad inválida");
        if (pick.containers === 0) continue;
        const qty = round2(pick.containers * line.containerSize);
        const pending = round2(line.qty - line.receivedQty);
        if (qty > pending + 1e-9) {
          throw badRequest(
            `De ${line.name} solo quedan ${round2(pending / line.containerSize)} ${line.containerLabel} por recibir`,
          );
        }
        const costPerUnit = line.containerSize ? line.containerCost / line.containerSize : 0;
        await updateCost(line.product.toString(), qty, costPerUnit, session);
        await moveStock({
          session,
          guard: false,
          type: "compra",
          location: purchase.destination,
          deltas: new Map([[line.product.toString(), qty]]),
          userId: req.auth!.sub,
          purchase: purchase._id,
          cruise: purchase.destination === "abordo" ? await activeCruiseId() : null,
          reason: `${purchase.code}: ${pick.containers} ${line.containerLabel}`,
          supplier: purchase.supplier,
          document: purchase.document,
          unitCost: round4(costPerUnit),
        });
        line.receivedQty = round2(line.receivedQty + qty);
        picks.push({ index: pick.index, qty });
      }
      if (!picks.length) throw badRequest("Indica al menos una cantidad recibida");

      purchase.status = purchase.lines.every((l) => l.receivedQty + 1e-9 >= l.qty)
        ? "recibida"
        : "recibida_parcial";
      purchase.receipts.push({
        key,
        lines: picks,
        note: note?.trim() ?? "",
        by: req.auth!.sub as never,
        at: new Date(),
      });
      await purchase.save({ session });
    });

    const saved = await Purchase.findById(req.params.id).populate(PURCHASE_POPULATE);
    await logEvent(req.auth, {
      kind: "compra",
      title: `Compra ${saved?.code} ${saved?.status === "recibida" ? "recibida" : "recibida parcial"}`,
      detail: lines
        .filter((l) => l.containers > 0)
        .map((l) => `${saved?.lines[l.index]?.name ?? "?"} +${l.containers} ${saved?.lines[l.index]?.containerLabel ?? ""}`)
        .join(", "),
    });
    res.json({ purchase: saved });
  } catch (err) {
    next(err);
  }
}

/** Anular una factura registrada por error (solo si no se recibió nada). */
export async function cancelPurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = (req.body?.reason as string | undefined)?.trim();
    if (!reason) throw badRequest("El motivo es obligatorio");
    const purchase = await Purchase.findOneAndUpdate(
      { _id: req.params.id, status: "registrada", "receipts.0": { $exists: false } },
      { $set: { status: "anulada", cancelReason: reason } },
      { new: true },
    );
    if (!purchase) throw conflict("Solo se anula una compra sin recepciones");
    await logEvent(req.auth, { kind: "compra", title: `Compra ${purchase.code} anulada`, detail: reason });
    res.json({ purchase: await purchase.populate(PURCHASE_POPULATE) });
  } catch (err) {
    next(err);
  }
}
