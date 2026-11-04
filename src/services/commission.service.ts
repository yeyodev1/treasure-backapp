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
 * Cada crucero tiene su bartender (lo elige la Dirección o queda el primero que
 * registra un consumo). Gerencia elige qué cruceros de un bartender paga y el
 * pago guarda ese detalle (prefactura). Los pagos antiguos sin detalle (antes
 * del 4-nov-2026) cubren primero los cruceros más antiguos.
 */
export const COMMISSION_RATE = 0.1;
export const COMMISSION_DIVISOR = 1.21;

export function netCommission(sales: number): number {
  return round2((sales * COMMISSION_RATE) / COMMISSION_DIVISOR);
}

export type CruiseCommissionState = "pagada" | "parcial" | "pendiente";

/**
 * El primer bartender que registra un consumo en un crucero sin bartender
 * queda como su bartender (pedido 4-nov: "el nombre sale de sus credenciales").
 * La Dirección puede cambiarlo después.
 */
export async function claimBartender(cruiseId: Types.ObjectId | string, auth: { sub: string; name: string; role: string }) {
  if (auth.role !== "bartender") return;
  await Cruise.updateOne(
    { _id: cruiseId, bartender: null },
    { $set: { bartender: new Types.ObjectId(auth.sub), bartenderName: auth.name } },
  );
}

export async function commissionSummary() {
  const [salesRows, payments] = await Promise.all([
    Order.aggregate<{ _id: Types.ObjectId; sales: number; orders: number }>([
      { $match: { status: { $in: ["entregada", "pendiente"] } } },
      { $group: { _id: "$cruise", sales: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    CommissionPayment.find().sort({ paidAt: -1, createdAt: -1 }).lean(),
  ]);

  const cruises = await Cruise.find({ _id: { $in: salesRows.map((r) => r._id) } })
    .select("code name routeFrom routeTo startDate endDate startedAt closedAt status bartender bartenderName")
    .lean();
  const salesByCruise = new Map(salesRows.map((r) => [r._id.toString(), r]));

  const valid = payments.filter((p) => p.status === "vigente");
  const paidTotal = round2(valid.reduce((s, p) => s + p.amount, 0));
  // Pagos por crucero elegido (desde 4-nov) y pagos antiguos sin detalle (cubren lo más viejo primero).
  const paidByCruise = new Map<string, number>();
  for (const p of valid) {
    for (const i of p.items ?? []) {
      const key = i.cruise.toString();
      paidByCruise.set(key, round2((paidByCruise.get(key) ?? 0) + i.amount));
    }
  }
  let pool = round2(valid.filter((p) => !p.items?.length).reduce((s, p) => s + p.amount, 0));

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
        bartenderId: c.bartender ? c.bartender.toString() : null,
        bartenderName: c.bartender ? c.bartenderName || "Bartender" : "",
        orders: row.orders,
        sales,
        commission: netCommission(sales),
      };
    })
    .filter((c) => c.sales > 0)
    // Orden real de operación: cuándo se inició (o su fecha programada si no consta).
    .sort(
      (a, b) =>
        new Date(a.startedAt ?? a.startDate).getTime() - new Date(b.startedAt ?? b.startDate).getTime(),
    );

  let generated = 0;
  let sales = 0;
  const rows = ordered.map((c) => {
    generated += c.commission;
    sales += c.sales;
    const itemized = Math.min(c.commission, paidByCruise.get(c.id) ?? 0);
    const legacy = Math.min(c.commission - itemized, pool);
    pool = round2(pool - legacy);
    const covered = round2(itemized + legacy);
    const pending = round2(c.commission - covered);
    const state: CruiseCommissionState = pending <= 0 ? "pagada" : covered > 0 ? "parcial" : "pendiente";
    return { ...c, paid: covered, pending, state, accumulated: round2(generated) };
  });

  // Por bartender: lo generado, pagado y pendiente de cada uno ("" = sin asignar).
  const byBartender = new Map<string, { id: string | null; name: string; cruises: number; sales: number; generated: number; paid: number; pending: number }>();
  for (const r of rows) {
    const key = r.bartenderId ?? "";
    const b = byBartender.get(key) ?? { id: r.bartenderId, name: r.bartenderName, cruises: 0, sales: 0, generated: 0, paid: 0, pending: 0 };
    b.cruises += 1;
    b.sales = round2(b.sales + r.sales);
    b.generated = round2(b.generated + r.commission);
    b.paid = round2(b.paid + r.paid);
    b.pending = round2(b.pending + r.pending);
    byBartender.set(key, b);
  }

  generated = round2(generated);
  return {
    rate: COMMISSION_RATE,
    divisor: COMMISSION_DIVISOR,
    totals: {
      sales: round2(sales),
      generated,
      paid: paidTotal,
      pending: round2(rows.reduce((s, r) => s + r.pending, 0)),
      cruises: rows.length,
    },
    bartenders: [...byBartender.values()].sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name)),
    // Lo más reciente arriba.
    cruises: rows.reverse(),
    payments: payments.map((p) => ({
      id: p._id.toString(),
      amount: p.amount,
      paidAt: p.paidAt,
      note: p.note,
      status: p.status,
      by: p.byName,
      bartenderId: p.bartender ? p.bartender.toString() : null,
      bartenderName: p.bartenderName ?? "",
      items: (p.items ?? []).map((i) => ({ cruiseId: i.cruise.toString(), code: i.code, sales: i.sales, amount: i.amount })),
      createdAt: p.createdAt,
      voided: p.voided
        ? { by: p.voided.byName, at: p.voided.at, reason: p.voided.reason }
        : null,
    })),
  };
}
