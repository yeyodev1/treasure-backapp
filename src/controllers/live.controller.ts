import { NextFunction, Request, Response } from "express";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { StockMovement } from "../models/stockMovement.model";
import { Cruise } from "../models/cruise.model";

/**
 * Pulso en vivo para administración: todo lo que va pasando a bordo.
 * El panel lo consulta cada pocos segundos (con `since` para traer solo
 * lo nuevo) y arma el feed de actividad en tiempo real.
 */
export async function livePulse(req: Request, res: Response, next: NextFunction) {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const sinceFilter = since ? { createdAt: { $gt: since } } : {};

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const cruise =
      (await Cruise.findOne({ status: "abordo" }).sort({ startDate: -1 })) ??
      (await Cruise.findOne({ status: "planificado" }).sort({ startDate: 1 }));

    const [orders, payments, movements, todayTotals, openAccounts] = await Promise.all([
      Order.find(sinceFilter).populate("createdBy", "name role").sort({ createdAt: -1 }).limit(30),
      Payment.find(sinceFilter)
        .populate("collectedBy", "name role")
        .sort({ createdAt: -1 })
        .limit(30),
      StockMovement.find({ ...sinceFilter, type: { $in: ["merma", "ajuste", "carga", "compra"] } })
        .populate("product", "name unit icon")
        .populate("user", "name role")
        .sort({ createdAt: -1 })
        .limit(30),
      Order.aggregate([
        { $match: { status: { $ne: "anulada" }, createdAt: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: "$total" }, orders: { $sum: 1 } } },
      ]),
      cruise
        ? Order.aggregate([
            { $match: { cruise: cruise._id, status: "abierta" } },
            { $group: { _id: "$cabinNumber", total: { $sum: "$total" }, orders: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ])
        : Promise.resolve([]),
    ]);

    type FeedEvent = {
      id: string;
      kind: "pedido" | "cobro" | "inventario";
      at: Date;
      title: string;
      detail: string;
      amount: number | null;
      by: string;
    };

    const feed: FeedEvent[] = [
      ...orders.map((o): FeedEvent => {
        const by = (o.createdBy as unknown as { name?: string })?.name ?? "";
        const items = o.items
          .map((i) => `${i.qty}× ${i.name}${i.courtesy ? " (cortesía)" : ""}`)
          .join(", ");
        return {
          id: `o-${o._id}`,
          kind: "pedido",
          at: o.createdAt as Date,
          title: `Pedido · cabina ${o.cabinNumber}`,
          detail: items,
          amount: o.total,
          by,
        };
      }),
      ...payments.map((p): FeedEvent => {
        const by = (p.collectedBy as unknown as { name?: string })?.name ?? "";
        return {
          id: `p-${p._id}`,
          kind: "cobro",
          at: p.createdAt as Date,
          title: `Cobro · cabina ${p.cabinNumber}`,
          detail: `${p.method}${p.courtesyTotal ? ` · cortesías $${p.courtesyTotal}` : ""}`,
          amount: p.total,
          by,
        };
      }),
      ...movements.map((m): FeedEvent => {
        const by = (m.user as unknown as { name?: string })?.name ?? "";
        const productName = (m.product as unknown as { name?: string })?.name ?? "";
        return {
          id: `m-${m._id}`,
          kind: "inventario",
          at: m.createdAt as Date,
          title: `${m.type[0]!.toUpperCase()}${m.type.slice(1)} · ${productName}`,
          detail: `${m.qty > 0 ? "+" : ""}${m.qty}${m.reason ? ` · ${m.reason}` : ""}`,
          amount: null,
          by,
        };
      }),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 40);

    res.json({
      now: new Date().toISOString(),
      cruise: cruise ? { id: cruise._id, name: cruise.name, status: cruise.status } : null,
      today: todayTotals[0] ?? { total: 0, orders: 0 },
      openAccounts: openAccounts.map((a: { _id: number; total: number; orders: number }) => ({
        cabinNumber: a._id,
        total: a.total,
        orders: a.orders,
      })),
      feed,
    });
  } catch (err) {
    next(err);
  }
}
