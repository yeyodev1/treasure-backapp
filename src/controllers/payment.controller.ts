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
import { isValidOptionalEmail } from "../utils/email";
import { sendAccountSummary } from "../services/accountEmail.service";


/** Cobra Dirección de crucero (guía auditada 27-oct-2026) o Gerencia. */
async function assertCanCollect(userId: string, role: string) {
  if (role === "duena") return;
  if (role === "direccion") {
    const user = await User.findById(userId).select("active");
    if (user?.active) return;
  }
  throw forbidden("Los cobros los registra Dirección de crucero o Gerencia");
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Monto pedido: vacío = saldo completo. */
function parseAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "string" ? Number(raw.replace(",", ".")) : Number(raw);
  if (!Number.isFinite(value) || round2(value) <= 0) {
    throw badRequest("Introduce una cantidad mayor que cero.");
  }
  return round2(value);
}

/** Pagos parciales vigentes sobre los consumos abiertos de la cabina. */
async function partialPaidOf(cruiseId: string, cabinNumber: number) {
  const rows = await Payment.find({ cruise: cruiseId, cabinNumber, status: "vigente", settled: false }).select(
    "total",
  );
  return round2(rows.reduce((s, p) => s + p.total, 0));
}

/**
 * Cobra una cuenta aprobada, completa o en partes (checklist 29-oct, P05).
 *
 * - `amount` (opcional, por defecto el saldo): mayor que cero y no más que
 *   el saldo. Cada pago se conserva con su método; se pueden combinar
 *   efectivo, tarjeta, transferencia y pago en línea.
 * - La cuenta sigue "aprobada" mientras haya saldo y pasa a "cobrada"
 *   (Pagada) solo cuando el saldo llega a cero.
 * - Anti doble clic: la toma atómica de la cuenta aprobada (como antes)
 *   serializa los cobros; además, si llega `expectedDue` y el saldo ya no
 *   es ese, se rechaza (un segundo clic no registra otro pago parcial).
 * - Facturación: una sola factura por el total de la cuenta, emitida al
 *   liquidar (el pago que deja el saldo en cero), con un cobro por cada
 *   pago. Los parciales no se facturan solos (invoiceStatus "parcial").
 * - Al liquidar se envía el resumen por correo al pagador (sin romper el cobro).
 */
export async function collectCabin(req: Request, res: Response, next: NextFunction) {
  try {
    await assertCanCollect(req.auth!.sub, req.auth!.role);

    const { cruiseId, cabinNumber, method, cashConfirmed, billing, reference, amount, expectedDue } =
      req.body as {
        cruiseId?: string;
        cabinNumber?: number;
        method?: PaymentMethod;
        cashConfirmed?: boolean;
        reference?: string;
        amount?: number | string;
        expectedDue?: number;
        billing?: { name?: string; idNumber?: string; email?: string; country?: string };
      };
    if (!cruiseId || !cabinNumber || !method) {
      throw badRequest("Crucero, cabina y método de pago son obligatorios");
    }
    if (!PAYMENT_METHODS.includes(method)) throw badRequest("Método de pago inválido");
    const requested = parseAmount(amount);
    if (method === "efectivo" && !cashConfirmed) {
      throw badRequest("Con efectivo, confirma que el dinero ingresó a caja");
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
    if (typedEmail && !isValidOptionalEmail(typedEmail)) {
      throw badRequest("Revisa el correo. Ejemplo: nombre@dominio.com.");
    }
    const finalBilling = {
      name: billing?.name?.trim() || payer?.name || "",
      idNumber: billing?.idNumber?.trim() || payer?.idNumber || "",
      // Un correo guardado inválido no bloquea el cobro: se factura sin correo.
      email: typedEmail || (payer?.email && isValidOptionalEmail(payer.email) ? payer.email : ""),
      country: billing?.country?.trim() || payer?.country || "",
    };
    if (!finalBilling.name || !finalBilling.idNumber) {
      throw badRequest("Falta el nombre o la identificación del pagador para facturar");
    }

    // Doble clic o dos tablets: solo una petición toma la cuenta aprobada.
    // Si queda saldo o algo falla antes de guardar el pago, se libera.
    const claimed = await Account.findOneAndUpdate(
      { cruise: cruiseId, cabinNumber, status: "aprobada", approvedVersion: summary.version },
      { $set: { status: "cobrada" } },
      { new: true },
    );
    if (!claimed) throw conflict("Esta cuenta ya se está cobrando o ya fue pagada");
    const release = () =>
      Account.updateOne({ _id: claimed._id, status: "cobrada" }, { $set: { status: "aprobada" } });

    let payment;
    let settles = false;
    try {
      // Saldo leído con la cuenta tomada: nadie más cobra al mismo tiempo.
      const partialPaid = await partialPaidOf(cruiseId, cabinNumber);
      const due = round2(summary.total - partialPaid);
      if (due <= 0) {
        throw conflict(
          "Los pagos parciales ya cubren la cuenta: reversa el último pago parcial y vuelve a cobrar el saldo",
        );
      }
      if (expectedDue !== undefined && expectedDue !== null && round2(Number(expectedDue)) !== due) {
        throw conflict(`El saldo cambió: ahora es $${due.toFixed(2)}. Revisa la cuenta antes de cobrar.`);
      }
      const charge = requested ?? due;
      if (charge > due) {
        throw badRequest(`El monto no puede ser mayor que el saldo ($${due.toFixed(2)}).`);
      }
      settles = charge === due;

      const id = new Types.ObjectId();
      payment = await Payment.create({
        _id: id,
        cruise: cruiseId,
        cabinNumber,
        orders: summary.orders.map((o) => o.id),
        accountVersion: summary.version,
        // Subtotal y cortesías de la cuenta solo en el pago que la liquida.
        subtotal: settles ? summary.subtotal : charge,
        courtesyTotal: settles ? summary.courtesyTotal : 0,
        total: charge,
        accountTotal: summary.total,
        settled: settles,
        settledBy: settles ? id : null,
        method,
        reference: reference?.trim() ?? "",
        cashConfirmed: Boolean(cashConfirmed),
        billing: finalBilling,
        invoiceStatus: settles ? "pendiente" : "parcial",
        collectedBy: req.auth!.sub,
      });
    } catch (err) {
      await release();
      throw err;
    }

    if (settles) {
      // Los pagos parciales quedan dentro de esta liquidación (y de su factura).
      await Payment.updateMany(
        { cruise: cruiseId, cabinNumber, status: "vigente", settled: false },
        { $set: { settled: true, settledBy: payment._id } },
      );
      await Order.updateMany({ _id: { $in: payment.orders } }, { $set: { payment: payment._id } });
    } else {
      await release();
    }

    // Si el pagador no tenía identificación o correo, se guardan para la próxima.
    if (cruise && cabin && payer) {
      payer.idNumber = payer.idNumber || finalBilling.idNumber;
      payer.email = payer.email || finalBilling.email;
      payer.country = payer.country || finalBilling.country;
      await cruise.save();
    }

    const remaining = settles ? 0 : round2(summary.total - (await partialPaidOf(cruiseId, cabinNumber)));
    await Account.updateOne(
      { _id: claimed._id },
      {
        $push: {
          history: {
            action: settles ? "cobrada" : "pago_parcial",
            version: claimed.version,
            reason: settles
              ? method
              : `${method} · $${payment.total.toFixed(2)} · saldo $${remaining.toFixed(2)}`,
            by: new Types.ObjectId(req.auth!.sub),
            at: new Date(),
          },
        },
      },
    );

    const invoiced = settles ? ((await issueInvoice(payment._id)) ?? payment) : payment;

    await logEvent(req.auth, {
      kind: "cobro",
      title: `${settles ? "Cobro" : "Pago parcial"} · cabina ${cabinNumber}`,
      detail: settles
        ? `${method} · ${finalBilling.name}`
        : `${method} · ${finalBilling.name} · saldo $${remaining.toFixed(2)}`,
      amount: payment.total,
      cruise: cruiseId,
      cabinNumber,
    });

    // Resumen al pagador: nunca rompe el cobro.
    let email = null;
    if (settles) {
      try {
        email = await sendAccountSummary(payment._id, req.auth);
      } catch (err) {
        console.error("[cobro] resumen por correo", err);
      }
    }

    res.status(201).json({ payment: invoiced, settled: settles, due: remaining, email });
  } catch (err) {
    next(err);
  }
}

/** Reenvía el resumen de la cuenta pagada al pagador (Dirección o Gerencia). */
export async function resendSummary(req: Request, res: Response, next: NextFunction) {
  try {
    await assertCanCollect(req.auth!.sub, req.auth!.role);
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.status !== "vigente") throw badRequest("El cobro fue reversado");
    if (payment.settled === false) {
      throw badRequest("El resumen se envía cuando la cuenta queda pagada");
    }
    if (payment.settledBy && !payment.settledBy.equals(payment._id)) {
      throw badRequest("El resumen va con el pago que completó la cuenta");
    }
    const result = await sendAccountSummary(payment._id, req.auth, true);
    if (result.status === "omitido") throw conflict("El resumen se está enviando");
    res.json({ email: result, payment: await Payment.findById(payment._id) });
  } catch (err) {
    next(err);
  }
}

/**
 * Reverso autorizado (solo administración): un cobro con pago o factura no
 * se cancela, se reversa con motivo.
 *
 * - Pago parcial (cuenta con saldo): sale del saldo; la aprobación sigue.
 * - Pago que liquidó la cuenta: la cuenta vuelve a abrirse y sus pagos
 *   parciales vuelven a contar como parciales sobre el saldo.
 * - Un parcial de una cuenta ya liquidada se reversa después del pago que
 *   la liquidó (la factura de la liquidación lo incluye).
 */
export async function reversePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo del reverso es obligatorio");

    const current = await Payment.findById(req.params.id).select("settled settledBy status");
    if (!current || current.status !== "vigente") throw conflict("El cobro no existe o ya fue reversado");
    const liquidator = current.settled !== false && (!current.settledBy || current.settledBy.equals(current._id));
    if (current.settled !== false && !liquidator) {
      throw conflict("Este pago es parte de una cuenta ya pagada: reversa primero el pago que la completó");
    }

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

    const account = await Account.findOne({
      cruise: payment.cruise,
      cabinNumber: payment.cabinNumber,
    });

    if (liquidator) {
      await Order.updateMany({ payment: payment._id }, { $set: { payment: null } });
      await Payment.updateMany(
        { settledBy: payment._id, _id: { $ne: payment._id }, status: "vigente" },
        { $set: { settled: false, settledBy: null } },
      );
      if (account) {
        account.status = "abierta";
        account.version += 1;
        account.approvedVersion = null;
        account.approvedTotal = null;
      }
    }
    if (account) {
      account.history.push({
        action: "reversada",
        version: account.version,
        reason: liquidator ? reason.trim() : `Pago parcial $${payment.total.toFixed(2)} · ${reason.trim()}`,
        by: new Types.ObjectId(req.auth!.sub),
        at: new Date(),
      });
      await account.save();
    }

    await logEvent(req.auth, {
      kind: "cobro",
      title: `${liquidator ? "Cobro" : "Pago parcial"} reversado · cabina ${payment.cabinNumber}`,
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
    if (payment.invoiceStatus === "parcial") {
      throw badRequest("Los pagos parciales se facturan con el pago que completa la cuenta");
    }
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
