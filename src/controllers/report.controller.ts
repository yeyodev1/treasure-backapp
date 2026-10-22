import { NextFunction, Request, Response } from "express";
import { PipelineStage, Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { CruiseStock } from "../models/cruiseStock.model";
import { Cruise } from "../models/cruise.model";

function dateMatch(from?: string, to?: string) {
  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  return Object.keys(range).length ? { createdAt: range } : {};
}

/**
 * Resumen de ventas para la administración: por día, por persona y top de
 * productos; filtrable por crucero y rango de fechas (semana, mes…).
 */
export async function salesSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to } = req.query as Record<string, string>;
    const match: Record<string, unknown> = {
      status: { $ne: "anulada" },
      ...dateMatch(from, to),
    };
    if (cruiseId) match.cruise = new Types.ObjectId(cruiseId);

    const byDayPipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt",
              timezone: "America/Guayaquil",
            },
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
      {
        $project: { _id: 0, name: "$user.name", role: "$user.role", total: 1, orders: 1 },
      },
      { $sort: { total: -1 } },
    ];

    const topProductsPipeline: PipelineStage[] = [
      { $match: match },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.name",
          qty: { $sum: "$items.qty" },
          total: {
            $sum: {
              $cond: ["$items.courtesy", 0, { $multiply: ["$items.qty", "$items.unitPrice"] }],
            },
          },
          courtesyQty: { $sum: { $cond: ["$items.courtesy", "$items.qty", 0] } },
        },
      },
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
      totals: totalsArr[0] ?? { total: 0, orders: 0 },
      byDay: byDay.map((d) => ({ date: d._id, total: d.total, orders: d.orders })),
      byUser,
      topProducts,
    });
  } catch (err) {
    next(err);
  }
}

/** Comparativo de ventas por crucero: lo que Paula quiere revisar crucero a crucero. */
export async function salesByCruise(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await Payment.aggregate([
      {
        $group: {
          _id: "$cruise",
          collected: { $sum: "$total" },
          courtesies: { $sum: "$courtesyTotal" },
          payments: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 24 },
    ]);
    const cruises = await Cruise.find({ _id: { $in: rows.map((r) => r._id) } }).select(
      "name startDate endDate status",
    );
    const cruiseMap = new Map(cruises.map((c) => [c._id.toString(), c]));

    res.json({
      cruises: rows
        .map((r) => {
          const cruise = cruiseMap.get(r._id?.toString());
          return cruise
            ? {
                id: r._id,
                name: cruise.name,
                startDate: cruise.startDate,
                status: cruise.status,
                collected: r.collected,
                courtesies: r.courtesies,
                payments: r.payments,
              }
            : null;
        })
        .filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
}

/** Estado de inventario del crucero con alertas de stock bajo. */
export async function inventoryStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId } = req.params;
    const stock = await CruiseStock.find({ cruise: cruiseId }).populate(
      "product",
      "name category icon unit",
    );
    const items = stock.map((s) => {
      const consumed = s.initialQty - s.currentQty;
      const ratio = s.initialQty > 0 ? s.currentQty / s.initialQty : 0;
      return {
        product: s.product,
        initialQty: s.initialQty,
        currentQty: s.currentQty,
        consumed,
        low: s.initialQty > 0 && ratio <= 0.2,
      };
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
}
