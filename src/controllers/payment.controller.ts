import { NextFunction, Request, Response } from "express";
import { Order } from "../models/order.model";
import { Payment, PAYMENT_METHODS, PaymentMethod } from "../models/payment.model";
import { buildCabinAccount } from "../services/account.service";
import { emitInvoice } from "../services/contifico.service";
import { badRequest, notFound } from "../errors/httpError";

/**
 * Cobra la cuenta completa de una cabina al final del crucero.
 * Con pago en efectivo quien cobra confirma la recaudación; al cobrar se
 * registran los datos de facturación y se dispara la factura en Contífico.
 */
export async function collectCabin(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber, method, cashConfirmed, billing } = req.body as {
      cruiseId?: string;
      cabinNumber?: number;
      method?: PaymentMethod;
      cashConfirmed?: boolean;
      billing?: { name?: string; idNumber?: string; email?: string; country?: string };
    };
    if (!cruiseId || !cabinNumber || !method) {
      throw badRequest("Crucero, cabina y método de pago son obligatorios");
    }
    if (!PAYMENT_METHODS.includes(method)) throw badRequest("Método de pago inválido");
    if (method === "efectivo" && !cashConfirmed) {
      throw badRequest("Con efectivo debes confirmar la recaudación en caja");
    }
    if (!billing?.name || !billing?.idNumber) {
      throw badRequest("Los datos de facturación (nombre e identificación) son obligatorios");
    }

    const account = await buildCabinAccount(cruiseId, cabinNumber);
    if (!account.orders.length) throw badRequest("La cabina no tiene consumos abiertos");

    const payment = await Payment.create({
      cruise: cruiseId,
      cabinNumber,
      orders: account.orders.map((o) => o.id),
      subtotal: account.subtotal,
      courtesyTotal: account.courtesyTotal,
      total: account.total,
      method,
      cashConfirmed: Boolean(cashConfirmed),
      billing: {
        name: billing.name,
        idNumber: billing.idNumber,
        email: billing.email ?? "",
        country: billing.country ?? "",
      },
      collectedBy: req.auth!.sub,
    });

    await Order.updateMany(
      { _id: { $in: payment.orders } },
      { $set: { status: "cobrada", payment: payment._id } },
    );

    const invoice = await emitInvoice(payment);
    payment.invoiceStatus = invoice.status;
    payment.invoiceId = invoice.invoiceId;
    payment.invoiceError = invoice.error;
    await payment.save();

    res.status(201).json({ payment });
  } catch (err) {
    next(err);
  }
}

export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    if (from || to) {
      filter.createdAt = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }
    const payments = await Payment.find(filter)
      .populate("collectedBy", "name role")
      .populate("cruise", "name")
      .sort({ createdAt: -1 })
      .limit(300);
    res.json({ payments });
  } catch (err) {
    next(err);
  }
}

/** Reintenta la emisión de una factura pendiente o con error en Contífico. */
export async function retryInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.invoiceStatus === "emitida") throw badRequest("La factura ya fue emitida");

    const invoice = await emitInvoice(payment);
    payment.invoiceStatus = invoice.status;
    payment.invoiceId = invoice.invoiceId;
    payment.invoiceError = invoice.error;
    await payment.save();

    res.json({ payment });
  } catch (err) {
    next(err);
  }
}
