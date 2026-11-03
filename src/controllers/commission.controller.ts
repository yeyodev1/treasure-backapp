import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { CommissionPayment } from "../models/commissionPayment.model";
import { commissionSummary } from "../services/commission.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { commercialDateKey, parseRangeEdge } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Comisiones del bartender (solo Gerencia): lo generado por crucero, lo
 * pagado y lo pendiente. Ver services/commission.service.ts.
 */
export async function listCommissions(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await commissionSummary());
  } catch (err) {
    next(err);
  }
}

/** Registra un pago consolidado: se descuenta del saldo acumulado. */
export async function createCommissionPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { amount, paidAt, note } = req.body as { amount?: unknown; paidAt?: string; note?: string };
    const value = round2(Number(amount));
    if (!Number.isFinite(value) || value <= 0) throw badRequest("Escribe un monto mayor a $0");

    const today = commercialDateKey();
    const day = paidAt || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest("Fecha de pago inválida");
    if (day > today) throw badRequest("La fecha de pago no puede ser futura");

    const summary = await commissionSummary();
    if (value > summary.totals.pending + 0.004) {
      throw conflict(
        `El pago supera lo pendiente ($${summary.totals.pending.toFixed(2)}). Revisa el monto.`,
      );
    }

    await CommissionPayment.create({
      amount: value,
      // Mediodía en Galápagos: la fecha no cambia de día por la zona horaria.
      paidAt: new Date(parseRangeEdge(day, "start")!.getTime() + 12 * 3600_000),
      note: String(note ?? "").trim().slice(0, 300),
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
    });
    res.status(201).json(await commissionSummary());
  } catch (err) {
    next(err);
  }
}

/** Un pago mal registrado no se borra: se anula con motivo y deja de descontar. */
export async function voidCommissionPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const reason = String((req.body as { reason?: string })?.reason ?? "").trim();
    if (!Types.ObjectId.isValid(id)) throw notFound("Pago no encontrado");
    if (!reason) throw badRequest("Escribe el motivo de la anulación");

    const payment = await CommissionPayment.findById(id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.status === "anulado") throw conflict("Ese pago ya está anulado");

    payment.status = "anulado";
    payment.voided = {
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
      at: new Date(),
      reason: reason.slice(0, 300),
    };
    await payment.save();
    res.json(await commissionSummary());
  } catch (err) {
    next(err);
  }
}
