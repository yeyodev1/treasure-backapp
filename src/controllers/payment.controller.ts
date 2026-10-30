import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment, PAYMENT_METHODS, PaymentMethod } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { User } from "../models/user.model";
import { Account } from "../models/account.model";
import { buildCabinAccount } from "../services/account.service";
import { contificoStatus, issueInvoice } from "../services/contifico.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { parseRangeEdge } from "../utils/dates";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Cobra Dirección de crucero (guía auditada 27-oct-2026) o Gerencia. */
async function assertCanCollect(userId: string, role: string) {
  if (role === "duena") return;
  if (role === "direccion") {
    const user = await User.findById(userId).select("active");
    if (user?.active) return;
  }
  throw forbidden("Los cobros los registra Dirección de crucero o Gerencia");
}

/**
 * Cobra una cuenta aprobada. Los datos de facturación salen del pagador de
 * la cabina y solo se piden los que falten.
 */
export async function collectCabin(req: Request, res: Response, next: NextFunction) {
  try {
    await assertCanCollect(req.auth!.sub, req.auth!.role);

    const { cruiseId, cabinNumber, method, cashConfirmed, billing, reference } = req.body as {
      cruiseId?: string;
      cabinNumber?: number;
      method?: PaymentMethod;
      cashConfirmed?: boolean;
      reference?: string;
      billing?: { name?: string; idNumber?: string; email?: string; country?: string };
    };
    if (!cruiseId || !cabinNumber || !method) {
      throw badRequest("Salida, cabina y método de pago son obligatorios");
    }
    if (!PAYMENT_METHODS.includes(method)) throw badRequest("Método de pago inválido");
    if (method === "efectivo" && !cashConfirmed) {
      throw badRequest("Con efectivo debes confirmar la recaudación en caja");
    }
    if (method === "transferencia" && !reference?.trim()) {
      throw badRequest("Indica la referencia de la transferencia");
    }

    const summary = await buildCabinAccount(cruiseId, cabinNumber);
    if (!summary.orders.length) throw badRequest("La cabina no tiene consumos abiertos");
    if (!summary.readyToCollect) {
      throw conflict("La cuenta debe estar aprobada en su versión vigente antes de cobrar");
    }

    const cruise = await Cruise.findById(cruiseId);
    const cabin = cruise?.cabins.find((c) => c.number === cabinNumber);
    const payer = cabin?.passengers.find((p) => p.isPayer) ?? cabin?.passengers[0];

    const typedEmail = billing?.email?.trim() ?? "";
    if (typedEmail && !EMAIL.test(typedEmail)) {
      throw badRequest("Revisa el correo. Ejemplo: nombre@dominio.com.");
    }
    const finalBilling = {
      name: billing?.name?.trim() || payer?.name || "",
      idNumber: billing?.idNumber?.trim() || payer?.idNumber || "",
      // Un correo guardado inválido no bloquea el cobro: se factura sin correo.
      email: typedEmail || (EMAIL.test(payer?.email ?? "") ? payer!.email : ""),
      country: billing?.country?.trim() || payer?.country || "",
    };
    if (!finalBilling.name || !finalBilling.idNumber) {
      throw badRequest("Falta el nombre o la identificación del pagador para facturar");
    }

    // Doble clic o dos tablets: solo una petición toma la cuenta aprobada
    // (R07: un solo pago). Si algo falla antes de guardar el pago, se libera.
    const claimed = await Account.findOneAndUpdate(
      { cruise: cruiseId, cabinNumber, status: "aprobada", approvedVersion: summary.version },
      { $set: { status: "cobrada" } },
      { new: true },
    );
    if (!claimed) throw conflict("Esta cuenta ya se está cobrando o ya fue pagada");

    let payment;
    try {
      payment = await Payment.create({
        cruise: cruiseId,
        cabinNumber,
        orders: summary.orders.map((o) => o.id),
        accountVersion: summary.version,
        subtotal: summary.subtotal,
        courtesyTotal: summary.courtesyTotal,
        total: summary.total,
        method,
        reference: reference?.trim() ?? "",
        cashConfirmed: Boolean(cashConfirmed),
        billing: finalBilling,
        collectedBy: req.auth!.sub,
      });
    } catch (err) {
      await Account.updateOne({ _id: claimed._id, status: "cobrada" }, { $set: { status: "aprobada" } });
      throw err;
    }

    await Order.updateMany({ _id: { $in: payment.orders } }, { $set: { payment: payment._id } });

    // Si el pagador no tenía identificación o correo, se guardan para la próxima.
    if (cruise && cabin && payer) {
      payer.idNumber = payer.idNumber || finalBilling.idNumber;
      payer.email = payer.email || finalBilling.email;
      payer.country = payer.country || finalBilling.country;
      await cruise.save();
    }

    await Account.updateOne(
      { _id: claimed._id },
      {
        $push: {
          history: {
            action: "cobrada",
            version: claimed.version,
            reason: method,
            by: new Types.ObjectId(req.auth!.sub),
            at: new Date(),
          },
        },
      },
    );

    const invoiced = (await issueInvoice(payment._id)) ?? payment;

    await logEvent(req.auth, {
      kind: "cobro",
      title: `Cobro · cabina ${cabinNumber}`,
      detail: `${method} · ${finalBilling.name}`,
      amount: payment.total,
      cruise: cruiseId,
      cabinNumber,
    });

    res.status(201).json({ payment: invoiced });
  } catch (err) {
    next(err);
  }
}

/**
 * Reverso autorizado (solo administración): un cobro con pago o factura no
 * se cancela, se reversa con motivo y la cuenta vuelve a abrirse.
 */
export async function reversePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo del reverso es obligatorio");

    const payment = await Payment.findOneAndUpdate(
      { _id: req.params.id, status: "vigente" },
      {
        $set: {
          status: "reversado",
          reversedBy: req.auth!.sub,
          reversedAt: new Date(),
          reverseReason: reason.trim(),
        },
      },
      { new: true },
    );
    if (!payment) throw conflict("El cobro no existe o ya fue reversado");

    if (payment.invoiceStatus === "emitida") {
      payment.invoiceError = "Factura emitida: registrar nota de crédito en Contífico";
      await payment.save();
    }

    await Order.updateMany({ payment: payment._id }, { $set: { payment: null } });

    const account = await Account.findOne({
      cruise: payment.cruise,
      cabinNumber: payment.cabinNumber,
    });
    if (account) {
      account.status = "abierta";
      account.version += 1;
      account.approvedVersion = null;
      account.approvedTotal = null;
      account.history.push({
        action: "reversada",
        version: account.version,
        reason: reason.trim(),
        by: new Types.ObjectId(req.auth!.sub),
        at: new Date(),
      });
      await account.save();
    }

    await logEvent(req.auth, {
      kind: "cobro",
      title: `Cobro reversado · cabina ${payment.cabinNumber}`,
      detail: reason.trim(),
      amount: payment.total,
      cruise: payment.cruise,
      cabinNumber: payment.cabinNumber,
    });

    res.json({ payment });
  } catch (err) {
    next(err);
  }
}

export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to, before, limit, invoice } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    // Facturas pendientes: pagos vigentes cuya factura no se emitió.
    if (invoice === "pendiente") {
      filter.status = "vigente";
      filter.invoiceStatus = { $in: ["pendiente", "error"] };
    }
    // 'YYYY-MM-DD' = día completo en hora de Galápagos.
    const start = parseRangeEdge(from, "start");
    const end = parseRangeEdge(to, "end");
    if (start || end || before) {
      filter.createdAt = {
        ...(start ? { $gte: start } : {}),
        ...(end ? { $lte: end } : {}),
        ...(before ? { $lt: new Date(before) } : {}),
      };
    }

    const pageSize = Math.min(Number(limit) || 40, 300);
    const payments = await Payment.find(filter)
      .populate("collectedBy", "name role")
      .populate("reversedBy", "name")
      .populate("cruise", "name code")
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);

    const hasMore = payments.length > pageSize;
    res.json({ payments: hasMore ? payments.slice(0, pageSize) : payments, hasMore });
  } catch (err) {
    next(err);
  }
}

/** Reintenta la emisión de una factura pendiente o con error en Contífico. */
export async function retryInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.status === "reversado") throw badRequest("El cobro fue reversado");
    if (payment.invoiceStatus === "emitida") throw badRequest("La factura ya fue emitida");
    if (payment.invoiceStatus === "emitiendo") throw conflict("La factura se está emitiendo");

    const invoiced = await issueInvoice(payment._id);
    if (invoiced?.invoiceStatus === "emitida") {
      await logEvent(req.auth, {
        kind: "cobro",
        title: `Factura emitida · cabina ${invoiced.cabinNumber}`,
        detail: invoiced.invoiceNumber,
        amount: invoiced.total,
        cruise: invoiced.cruise,
        cabinNumber: invoiced.cabinNumber,
      });
    }

    res.json({ payment: invoiced });
  } catch (err) {
    next(err);
  }
}

/** Estado de Contífico y su catálogo, para vincular productos. */
export async function contificoInfo(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await contificoStatus());
  } catch (err) {
    next(err);
  }
}
