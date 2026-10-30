import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Account } from "../models/account.model";
import { Cruise } from "../models/cruise.model";
import { Order, chargeableQty, pendingQty } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { buildCabinAccount, ensureAccount } from "../services/account.service";
import { logEvent } from "../services/audit.service";
import { proformaData, proformaFileName, proformaPdf } from "../services/proforma.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { round2 } from "../utils/units";

/**
 * Resumen de todas las cabinas de una salida: estado, consumos, pagado y
 * por cobrar. Una cuenta pagada conserva sus importes (checklist 29-oct, 01).
 */
export async function cruiseAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.cruiseId);
    if (!cruise) throw notFound("Salida no encontrada");

    const [accounts, orders, payments] = await Promise.all([
      Account.find({ cruise: cruise._id }),
      Order.find({ cruise: cruise._id, status: { $nin: ["cancelada", "retenida"] } }),
      Payment.find({ cruise: cruise._id, status: "vigente" }).select("cabinNumber total"),
    ]);
    const accountMap = new Map(accounts.map((a) => [a.cabinNumber, a]));

    const totals = new Map<
      number,
      { total: number; orders: number; pending: number; consumed: number; paidOrders: number; paid: number }
    >();
    const entryOf = (cabin: number) => {
      const entry = totals.get(cabin) ?? { total: 0, orders: 0, pending: 0, consumed: 0, paidOrders: 0, paid: 0 };
      totals.set(cabin, entry);
      return entry;
    };
    for (const order of orders) {
      const entry = entryOf(order.cabinNumber);
      let amount = 0;
      for (const item of order.items) {
        if (!item.courtesy) amount += chargeableQty(item) * item.unitPrice;
        if (!order.payment) entry.pending += pendingQty(item);
      }
      entry.consumed += amount;
      if (order.payment) {
        entry.paidOrders += 1;
      } else {
        entry.orders += 1;
        entry.total += amount;
      }
    }
    for (const payment of payments) entryOf(payment.cabinNumber).paid += payment.total;

    res.json({
      cabins: cruise.cabins.map((cabin) => {
        const account = accountMap.get(cabin.number);
        const t = totals.get(cabin.number);
        return {
          cabinNumber: cabin.number,
          guestName: cabin.guestName,
          passengers: cabin.passengers.length,
          status: account?.status ?? "abierta",
          version: account?.version ?? 1,
          total: round2(t?.total ?? 0),
          orders: t?.orders ?? 0,
          pendingDeliveries: t?.pending ?? 0,
          paidOrders: t?.paidOrders ?? 0,
          consumed: round2(t?.consumed ?? 0),
          paid: round2(t?.paid ?? 0),
          due: round2(t?.total ?? 0),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

function params(req: Request) {
  const cruiseId = String(req.params.cruiseId);
  const cabinNumber = Number(req.params.cabinNumber);
  if (!Types.ObjectId.isValid(cruiseId) || !cabinNumber) throw badRequest("Cuenta inválida");
  return { cruiseId, cabinNumber };
}

/** Bar envía la cuenta a revisión: sin entregas pendientes y con consumos. */
export async function submitForReview(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = params(req);
    const summary = await buildCabinAccount(cruiseId, cabinNumber);
    if (!summary.orders.length) throw badRequest("La cabina no tiene consumos por revisar");
    if (summary.pendingDeliveries > 0) {
      throw badRequest(
        `Hay ${summary.pendingDeliveries} bebida(s) sin entregar: entrégalas o cancélalas antes`,
      );
    }

    const account = await ensureAccount(cruiseId, cabinNumber);
    if (account.status !== "abierta") throw conflict("La cuenta ya está en revisión o aprobada");

    account.status = "en_revision";
    account.history.push({
      action: "enviada_revision",
      version: account.version,
      reason: "",
      by: new Types.ObjectId(req.auth!.sub),
      at: new Date(),
    });
    await account.save();

    await logEvent(req.auth, {
      kind: "cuenta",
      title: `Cuenta enviada a revisión · cabina ${cabinNumber}`,
      detail: `Versión ${account.version}`,
      amount: summary.total,
      cruise: cruiseId,
      cabinNumber,
    });

    res.json({ account: await buildCabinAccount(cruiseId, cabinNumber) });
  } catch (err) {
    next(err);
  }
}

/** Dirección aprueba la versión vigente; el cobro queda habilitado. */
export async function approveAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = params(req);
    const summary = await buildCabinAccount(cruiseId, cabinNumber);
    if (summary.pendingDeliveries > 0) throw badRequest("Hay bebidas sin entregar en esta cuenta");
    if (summary.pendingAnnulments > 0) {
      throw badRequest("Resuelve primero las solicitudes de anulación pendientes");
    }

    const account = await ensureAccount(cruiseId, cabinNumber);
    if (account.status !== "en_revision") {
      throw conflict("Solo se aprueba una cuenta que está en revisión");
    }

    account.status = "aprobada";
    account.approvedVersion = account.version;
    account.approvedTotal = summary.total;
    account.history.push({
      action: "aprobada",
      version: account.version,
      reason: "",
      by: new Types.ObjectId(req.auth!.sub),
      at: new Date(),
    });
    await account.save();

    await logEvent(req.auth, {
      kind: "cuenta",
      title: `Cuenta aprobada · cabina ${cabinNumber}`,
      detail: `Versión ${account.version}`,
      amount: summary.total,
      cruise: cruiseId,
      cabinNumber,
    });

    res.json({ account: await buildCabinAccount(cruiseId, cabinNumber) });
  } catch (err) {
    next(err);
  }
}

/** Dirección devuelve la cuenta al bar con un motivo. */
export async function returnAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = params(req);
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo es obligatorio para devolver la cuenta");

    const account = await ensureAccount(cruiseId, cabinNumber);
    if (account.status !== "en_revision" && account.status !== "aprobada") {
      throw conflict("Solo se devuelve una cuenta en revisión o aprobada");
    }

    account.status = "abierta";
    account.approvedVersion = null;
    account.approvedTotal = null;
    account.history.push({
      action: "devuelta",
      version: account.version,
      reason: reason.trim(),
      by: new Types.ObjectId(req.auth!.sub),
      at: new Date(),
    });
    await account.save();

    await logEvent(req.auth, {
      kind: "cuenta",
      title: `Cuenta devuelta · cabina ${cabinNumber}`,
      detail: reason.trim(),
      cruise: cruiseId,
      cabinNumber,
    });

    res.json({ account: await buildCabinAccount(cruiseId, cabinNumber) });
  } catch (err) {
    next(err);
  }
}

/**
 * Prefactura en inglés (PDF), antes o después de pagar. Solo genera el
 * archivo: no envía correo ni llama a Contífico (checklist 29-oct, 02).
 */
export async function proforma(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, cabinNumber } = params(req);
    const data = await proformaData(cruiseId, cabinNumber);
    const bytes = await proformaPdf(data);
    const name = proformaFileName(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${req.query.download ? "attachment" : "inline"}; filename="${name}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    // La app lee el nombre del archivo desde otro dominio.
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.send(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
}
