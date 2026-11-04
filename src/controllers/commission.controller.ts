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

/** Registra el pago de los cruceros elegidos de un bartender. */
export async function createCommissionPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseIds, paidAt, note } = req.body as { cruiseIds?: unknown; paidAt?: string; note?: string };
    const ids = Array.isArray(cruiseIds) ? [...new Set(cruiseIds.map(String))] : [];
    if (!ids.length) throw badRequest("Elige los cruceros que pagas");

    const today = commercialDateKey();
    const day = paidAt || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest("Fecha de pago inválida");
    if (day > today) throw badRequest("La fecha de pago no puede ser futura");

    // Cada crucero elegido se paga completo (lo pendiente) y el pago guarda el detalle (prefactura).
    const summary = await commissionSummary();
    const picked = [];
    for (const id of ids) {
      const row = summary.cruises.find((c) => c.id === id);
      if (!row || row.pending <= 0) {
        throw conflict(`${row ? `El crucero ${row.code || row.name}` : "Un crucero elegido"} ya no tiene comisión pendiente. Recarga la página.`);
      }
      if (!row.bartenderId) throw badRequest(`Asigna el bartender del crucero ${row.code || row.name} antes de pagar`);
      picked.push(row);
    }
    if (new Set(picked.map((r) => r.bartenderId)).size > 1) {
      throw badRequest("Un pago es de un solo bartender: elige cruceros del mismo");
    }

    const payment = await CommissionPayment.create({
      amount: round2(picked.reduce((s, r) => s + r.pending, 0)),
      bartender: new Types.ObjectId(picked[0]!.bartenderId!),
      bartenderName: picked[0]!.bartenderName,
      items: picked.map((r) => ({ cruise: new Types.ObjectId(r.id), code: r.code || r.name, sales: r.sales, amount: r.pending })),
      // Mediodía en Galápagos: la fecha no cambia de día por la zona horaria.
      paidAt: new Date(parseRangeEdge(day, "start")!.getTime() + 12 * 3600_000),
      note: String(note ?? "").trim().slice(0, 300),
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
    });
    res.status(201).json({ ...(await commissionSummary()), paymentId: payment._id.toString() });
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
