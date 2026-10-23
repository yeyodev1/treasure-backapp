import { NextFunction, Request, Response } from "express";
import { PipelineStage, Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";

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
      status: { $ne: "cancelada" },
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
