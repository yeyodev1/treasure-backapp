import { NextFunction, Request, Response } from "express";
import { AuditEvent } from "../models/auditEvent.model";
import { Order, chargeableQty, pendingQty } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { Account } from "../models/account.model";
import { StockCount } from "../models/stockCount.model";
import { commercialDateKey, startOfDayEcuador } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Pulso en vivo para administración: fecha comercial (Ecuador), saldo por
 * cabina, pendientes por resolver y el feed de toda la actividad con autor.
 */
export async function livePulse(req: Request, res: Response, next: NextFunction) {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const dayStart = startOfDayEcuador();

    const cruise =
      (await Cruise.findOne({ status: "abordo" }).sort({ startDate: -1 })) ??
      (await Cruise.findOne({ status: "planificado" }).sort({ startDate: 1 }));

    const [feed, todayOrders, openOrders, reviews, annulments, counts] = await Promise.all([
      AuditEvent.find(since ? { createdAt: { $gt: since } } : {})
        .sort({ createdAt: -1 })
        .limit(50),
      Order.find({ createdAt: { $gte: dayStart }, status: { $ne: "cancelada" } }).select(
        "total",
      ),
      cruise
        ? Order.find({ cruise: cruise._id, payment: null, status: { $ne: "cancelada" } })
        : Promise.resolve([]),
      cruise ? Account.countDocuments({ cruise: cruise._id, status: "en_revision" }) : 0,
      Order.countDocuments({ "annulments.status": "pendiente" }),
      StockCount.countDocuments({ status: "enviado" }),
    ]);

    const byCabin = new Map<number, { total: number; orders: number; pending: number }>();
    let pendingDeliveries = 0;
    for (const order of openOrders) {
      const entry = byCabin.get(order.cabinNumber) ?? { total: 0, orders: 0, pending: 0 };
      entry.orders += 1;
      for (const item of order.items) {
        if (!item.courtesy) entry.total += chargeableQty(item) * item.unitPrice;
        const p = pendingQty(item);
        entry.pending += p;
        pendingDeliveries += p;
      }
      byCabin.set(order.cabinNumber, entry);
    }

    res.json({
      now: new Date().toISOString(),
      commercialDate: commercialDateKey(),
      cruise: cruise
        ? { id: cruise._id, code: cruise.code, name: cruise.name, status: cruise.status }
        : null,
      today: {
        total: round2(todayOrders.reduce((sum, o) => sum + o.total, 0)),
        orders: todayOrders.length,
      },
      pending: {
        deliveries: pendingDeliveries,
        reviews,
        annulments,
        counts,
      },
      openAccounts: [...byCabin.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cabinNumber, v]) => ({
          cabinNumber,
          total: round2(v.total),
          orders: v.orders,
          pending: v.pending,
        })),
      feed: feed.map((e) => ({
        id: e._id,
        kind: e.kind,
        at: e.createdAt,
        title: e.title,
        detail: e.detail,
        amount: e.amount,
        by: e.byName,
      })),
    });
  } catch (err) {
    next(err);
  }
}
