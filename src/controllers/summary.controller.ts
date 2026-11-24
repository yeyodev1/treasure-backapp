import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { barSummary, operationSummary } from "../services/summary.service";
import { GOAL_DEFS, clearGoalsCache, goalsAt } from "../services/goals.service";
import { Goal } from "../models/goal.model";
import { Payment } from "../models/payment.model";
import { AgencyInvoice } from "../models/agencyInvoice.model";
import { Product } from "../models/product.model";
import { commissionReceiptPdf } from "../services/commissionReceipt.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { commercialDateKey, parseRangeEdge } from "../utils/dates";
import { round2 } from "../utils/units";

/** GET /reports/summary/bar?periodo=ano|mes|crucero&valor=… (solo Gerencia). */
export async function barView(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await barSummary(req.query.periodo, req.query.valor));
  } catch (err) {
    next(err);
  }
}

/** GET /reports/summary/operacion?periodo=…&valor=… (sin dinero; se exporta a PDF para los socios). */
export async function operationView(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await operationSummary(req.query.periodo, req.query.valor));
  } catch (err) {
    next(err);
  }
}

/** Metas con su valor vigente hoy y su historial. */
export async function listGoals(_req: Request, res: Response, next: NextFunction) {
  try {
    const [current, history] = await Promise.all([goalsAt(), Goal.find().sort({ from: -1, createdAt: -1 }).limit(200).lean()]);
    res.json({
      goals: GOAL_DEFS.map((d) => ({ ...d, value: current[d.key] })),
      history: history.map((h) => ({ key: h.key, value: h.value, from: commercialDateKey(h.from), by: h.byName, at: h.createdAt })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Guarda una meta desde una fecha (por defecto hoy). No reescribe el pasado:
 * los períodos anteriores siguen con el valor que regía entonces. Las tarifas
 * de wetsuit también actualizan el precio del catálogo.
 */
export async function saveGoal(req: Request, res: Response, next: NextFunction) {
  try {
    const { key, value, from } = req.body as { key?: string; value?: unknown; from?: string };
    const def = GOAL_DEFS.find((d) => d.key === key);
    if (!def) throw badRequest("Meta desconocida");
    const empty = value === null || value === "" || value === undefined;
    const num = empty ? null : Number(value);
    if (num !== null && (!Number.isFinite(num) || num < 0 || num > 100_000)) throw badRequest("Valor inválido");
    if (empty && (def.key === "commissionDivisor" || def.key.startsWith("wetsuit"))) throw badRequest("Este valor no puede quedar vacío");
    if (def.key === "commissionDivisor" && num !== null && num < 1) throw badRequest("El divisor debe ser 1 o más");
    const day = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : commercialDateKey();
    await Goal.create({ key: def.key, value: num, from: parseRangeEdge(day, "start")!, by: req.auth!.sub, byName: req.auth!.name });
    clearGoalsCache();

    if (num !== null && (def.key === "wetsuitAB" || def.key === "wetsuitC")) {
      const legs = def.key === "wetsuitC" ? ["C"] : ["A", "B"];
      // Cada consumo guarda su precio: cambiar la tarifa no toca lo ya registrado.
      await Product.updateMany(
        { legs: { $in: legs }, price: { $ne: num } },
        { $set: { price: num }, $push: { priceHistory: { price: num, changedBy: req.auth!.sub, at: new Date() } } },
      );
    }
    await logEvent(req.auth, { kind: "catalogo", title: `Meta · ${def.label}`, detail: `${num ?? "vacía"} desde ${day}` });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Registra el depósito en el banco de cobros en efectivo (bloque 8). */
export async function depositCash(req: Request, res: Response, next: NextFunction) {
  try {
    const { ids, reference, date } = req.body as { ids?: unknown; reference?: string; date?: string };
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))].filter((id) => Types.ObjectId.isValid(id)) : [];
    if (!list.length) throw badRequest("Elige los cobros en efectivo que depositaste");
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : commercialDateKey();
    if (day > commercialDateKey()) throw badRequest("La fecha del depósito no puede ser futura");
    const at = new Date(parseRangeEdge(day, "start")!.getTime() + 12 * 3600_000);
    const done = await Payment.updateMany(
      { _id: { $in: list }, method: "efectivo", status: "vigente", deposit: null },
      { $set: { deposit: { at, reference: String(reference ?? "").trim().slice(0, 80), by: req.auth!.sub, byName: req.auth!.name } } },
    );
    if (!done.modifiedCount) throw conflict("Esos cobros ya estaban depositados o no son en efectivo");
    const total = round2(
      (await Payment.find({ _id: { $in: list } }).select("total").lean()).reduce((s, p) => s + p.total, 0),
    );
    await logEvent(req.auth, {
      kind: "cobro",
      title: `Efectivo depositado · ${done.modifiedCount} cobro(s)`,
      detail: String(reference ?? "").trim(),
      amount: total,
    });
    res.json({ deposited: done.modifiedCount, total });
  } catch (err) {
    next(err);
  }
}

/** Registra un cobro (acepta parcial) de una factura a la agencia (bloque 7, paso 2). */
export async function agencyInvoicePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { amount, date, reference } = req.body as { amount?: unknown; date?: string; reference?: string };
    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value <= 0) throw badRequest("Indica el monto cobrado");
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : commercialDateKey();
    if (day > commercialDateKey()) throw badRequest("La fecha del cobro no puede ser futura");
    const invoice = await AgencyInvoice.findById(req.params.id);
    if (!invoice || invoice.status !== "vigente") throw notFound("Factura no encontrada o anulada");
    const paid = round2((invoice.payments ?? []).reduce((s, p) => s + p.amount, 0));
    if (value > round2(invoice.amount - paid) + 0.005) throw badRequest(`Falta cobrar ${round2(invoice.amount - paid).toFixed(2)}: el monto es mayor`);
    invoice.payments.push({
      at: new Date(parseRangeEdge(day, "start")!.getTime() + 12 * 3600_000),
      amount: value,
      reference: String(reference ?? "").trim().slice(0, 80),
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
    });
    await invoice.save();
    await logEvent(req.auth, {
      kind: "cuenta",
      title: `Cobro de la agencia · factura ${invoice.invoiceNumber || invoice.month}`,
      detail: String(reference ?? "").trim(),
      amount: value,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Recibo en PDF del pago de comisión, para firma. */
export async function commissionReceipt(req: Request, res: Response, next: NextFunction) {
  try {
    const { bytes, name } = await commissionReceiptPdf(String(req.params.id));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
}
