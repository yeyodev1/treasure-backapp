import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { CommissionPayment } from "../models/commissionPayment.model";
import { round2 } from "../utils/units";

/**
 * Comisión del bartender (pedido de Gerencia, 3-nov-2026). Solo el bartender
 * comisiona; la Dirección de crucero y el resto de la tripulación no.
 *
 * Comisión neta = ventas del bar × 10 % ÷ 1,21. Ej.: $10 → $1,00 → $0,83.
 *
 * Ventas del bar = la misma cifra "Consumos del bar" del Resumen: lo cargado a
 * las cabinas (entregado o por entregar), sin cortesías, cancelaciones,
 * anulaciones ni consumos retenidos. Se cuenta lo consumido, no lo cobrado.
 *
 * Las comisiones se acumulan y se pagan juntas. Los pagos cubren primero los
 * cruceros más antiguos, así cada crucero muestra si ya está pagado.
 */
export const COMMISSION_RATE = 0.1;
export const COMMISSION_DIVISOR = 1.21;

export function netCommission(sales: number): number {
  return round2((sales * COMMISSION_RATE) / COMMISSION_DIVISOR);
}

export type CruiseCommissionState = "pagada" | "parcial" | "pendiente";

export async function commissionSummary() {
  const [salesRows, payments] = await Promise.all([
    Order.aggregate<{ _id: Types.ObjectId; sales: number; orders: number }>([
      { $match: { status: { $in: ["entregada", "pendiente"] } } },
      { $group: { _id: "$cruise", sales: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    CommissionPayment.find().sort({ paidAt: -1, createdAt: -1 }).lean(),
  ]);

  const cruises = await Cruise.find({ _id: { $in: salesRows.map((r) => r._id) } })
    .select("code name routeFrom routeTo startDate endDate startedAt closedAt status")
    .lean();
  const salesByCruise = new Map(salesRows.map((r) => [r._id.toString(), r]));

  const paidTotal = round2(
    payments.filter((p) => p.status === "vigente").reduce((s, p) => s + p.amount, 0),
  );

  // Del más antiguo al más reciente: los pagos cubren primero lo más viejo.
  const ordered = cruises
    .map((c) => {
      const row = salesByCruise.get(c._id.toString())!;
      const sales = round2(row.sales);
      return {
        id: c._id.toString(),
        code: c.code,
        name: c.name,
        routeFrom: c.routeFrom ?? "",
        routeTo: c.routeTo ?? "",
        startDate: c.startDate,
        endDate: c.endDate ?? null,
        startedAt: c.startedAt ?? null,
        closedAt: c.closedAt ?? null,
        status: c.status,
        orders: row.orders,
        sales,
        commission: netCommission(sales),
      };
    })
    .filter((c) => c.sales > 0)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  let pool = paidTotal;
  let generated = 0;
  let sales = 0;
  const rows = ordered.map((c) => {
    generated += c.commission;
    sales += c.sales;
    const covered = round2(Math.min(c.commission, pool));
    pool = round2(pool - covered);
    const pending = round2(c.commission - covered);
    const state: CruiseCommissionState = pending <= 0 ? "pagada" : covered > 0 ? "parcial" : "pendiente";
    return { ...c, paid: covered, pending, state, accumulated: round2(generated) };
  });

  generated = round2(generated);
  return {
    rate: COMMISSION_RATE,
    divisor: COMMISSION_DIVISOR,
    totals: {
      sales: round2(sales),
      generated,
      paid: paidTotal,
      pending: round2(Math.max(0, generated - paidTotal)),
      cruises: rows.length,
    },
    // Lo más reciente arriba.
    cruises: rows.reverse(),
    payments: payments.map((p) => ({
      id: p._id.toString(),
      amount: p.amount,
      paidAt: p.paidAt,
      note: p.note,
      status: p.status,
      by: p.byName,
      createdAt: p.createdAt,
      voided: p.voided
        ? { by: p.voided.byName, at: p.voided.at, reason: p.voided.reason }
        : null,
    })),
  };
}
