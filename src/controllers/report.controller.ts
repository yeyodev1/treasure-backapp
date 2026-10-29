import { NextFunction, Request, Response } from "express";
import { PipelineStage, Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { StockMovement } from "../models/stockMovement.model";

function dateMatch(from?: string, to?: string) {
  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  return Object.keys(range).length ? { createdAt: range } : {};
}

/** Unidades que siguen contando (pedido − cancelado − anulado). */
const NET_QTY = {
  $subtract: [
    "$items.qty",
    { $add: [{ $ifNull: ["$items.cancelledQty", 0] }, { $ifNull: ["$items.annulledQty", 0] }] },
  ],
};

/**
 * Resumen de ventas para administración: por día (hora de Ecuador), por
 * persona y top de productos, filtrable por salida y rango de fechas.
 */
export async function salesSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to } = req.query as Record<string, string>;
    const match: Record<string, unknown> = {
      status: { $nin: ["cancelada", "retenida"] },
      ...dateMatch(from, to),
    };
    if (cruiseId) match.cruise = new Types.ObjectId(cruiseId);

    const byDayPipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "America/Guayaquil" },
          },
          total: { $sum: "$total" },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const byUserPipeline: PipelineStage[] = [
      { $match: match },
      { $group: { _id: "$createdBy", total: { $sum: "$total" }, orders: { $sum: 1 } } },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
      { $unwind: "$user" },
      { $project: { _id: 0, name: "$user.name", role: "$user.role", total: 1, orders: 1 } },
      { $sort: { total: -1 } },
    ];

    const topProductsPipeline: PipelineStage[] = [
      { $match: match },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.name",
          qty: { $sum: NET_QTY },
          total: {
            $sum: { $cond: ["$items.courtesy", 0, { $multiply: [NET_QTY, "$items.unitPrice"] }] },
          },
          courtesyQty: { $sum: { $cond: ["$items.courtesy", NET_QTY, 0] } },
        },
      },
      { $match: { qty: { $gt: 0 } } },
      { $sort: { qty: -1 } },
      { $limit: 15 },
      { $project: { _id: 0, name: "$_id", qty: 1, total: 1, courtesyQty: 1 } },
    ];

    const totalsPipeline: PipelineStage[] = [
      { $match: match },
      { $group: { _id: null, total: { $sum: "$total" }, orders: { $sum: 1 } } },
    ];

    const [byDay, byUser, topProducts, totalsArr] = await Promise.all([
      Order.aggregate(byDayPipeline),
      Order.aggregate(byUserPipeline),
      Order.aggregate(topProductsPipeline),
      Order.aggregate(totalsPipeline),
    ]);

    res.json({
      totals: { total: totalsArr[0]?.total ?? 0, orders: totalsArr[0]?.orders ?? 0 },
      byDay: byDay.map((d) => ({ date: d._id, total: d.total, orders: d.orders })),
      byUser,
      topProducts,
    });
  } catch (err) {
    next(err);
  }
}

/** Recaudado por salida (cobros vigentes, sin los reversados). */
export async function salesByCruise(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await Payment.aggregate([
      { $match: { status: { $ne: "reversado" } } },
      {
        $group: {
          _id: "$cruise",
          collected: { $sum: "$total" },
          courtesies: { $sum: "$courtesyTotal" },
          payments: { $sum: 1 },
        },
      },
      { $limit: 48 },
    ]);
    const cruises = await Cruise.find({ _id: { $in: rows.map((r) => r._id) } }).select(
      "name code startDate status",
    );
    const cruiseMap = new Map(cruises.map((c) => [c._id.toString(), c]));

    res.json({
      cruises: rows
        .map((r) => {
          const cruise = cruiseMap.get(r._id?.toString());
          return cruise
            ? {
                id: r._id,
                name: cruise.code || cruise.name,
                startDate: cruise.startDate,
                status: cruise.status,
                collected: r.collected,
                courtesies: r.courtesies,
                payments: r.payments,
              }
            : null;
        })
        .filter(Boolean)
        .sort(
          (a, b) => new Date(b!.startDate).getTime() - new Date(a!.startDate).getTime(),
        ),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Panel de la dueña (guía auditada 27-oct-2026), filtrable por salida y
 * fechas. Separa: consumos netos registrados, dinero cobrado, saldo por
 * cobrar, compras recibidas y costo de lo consumido. El margen solo se
 * calcula si todos los consumos tienen costo; nunca es "utilidad neta".
 */
export async function ownerPanel(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to } = req.query as Record<string, string>;
    const range = dateMatch(from, to);
    const orderMatch: Record<string, unknown> = { status: { $in: ["entregada", "pendiente"] }, ...range };
    const paymentMatch: Record<string, unknown> = { status: "vigente", ...range };
    if (cruiseId) {
      orderMatch.cruise = new Types.ObjectId(cruiseId);
      paymentMatch.cruise = new Types.ObjectId(cruiseId);
    }

    const [orders, payments, purchaseMoves, held] = await Promise.all([
      Order.find(orderMatch).select("items total payment cruise cabinNumber"),
      Payment.find(paymentMatch).select("total method"),
      StockMovement.find({ type: "compra", qty: { $gt: 0 }, ...range }).select("qty unitCost product"),
      Order.countDocuments({ status: "retenida", ...(cruiseId ? { cruise: cruiseId } : {}) }),
    ]);

    let net = 0;
    let courtesy = 0;
    let cost = 0;
    let unpaid = 0;
    const missingCost = new Map<string, string>();
    for (const order of orders) {
      if (!order.payment) unpaid += order.total;
      for (const item of order.items) {
        const units = Math.max(0, item.qty - item.cancelledQty - item.annulledQty);
        if (!units) continue;
        if (item.courtesy) courtesy += units * item.unitPrice;
        else net += units * item.unitPrice;
        cost += units * (item.unitCost ?? 0);
        if (!item.costComplete) missingCost.set(item.product.toString(), item.name);
      }
    }
    const collected = payments.reduce((s, p) => s + p.total, 0);
    const byMethod: Record<string, number> = {};
    for (const p of payments) byMethod[p.method] = round(byMethod[p.method] ?? 0) + p.total;
    const purchases = purchaseMoves.reduce((s, m) => s + m.qty * m.unitCost, 0);
    const costsComplete = missingCost.size === 0 && orders.length > 0;

    res.json({
      netConsumption: round(net),
      courtesy: round(courtesy),
      collected: round(collected),
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, round(v)])),
      pendingCollection: round(unpaid),
      purchases: round(purchases),
      consumedCost: round(cost),
      costsComplete,
      missingCost: [...missingCost.values()].slice(0, 30),
      missingCostCount: missingCost.size,
      margin: costsComplete ? round(net - cost) : null,
      heldConsumptions: held,
    });
  } catch (err) {
    next(err);
  }
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
