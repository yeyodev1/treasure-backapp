import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Cruise } from "../models/cruise.model";
import { CommissionPayment } from "../models/commissionPayment.model";
import { Payment } from "../models/payment.model";
import { round2 } from "../utils/units";
import { goalsAt } from "./goals.service";
import { isGenericName, liveUnits, productIndex } from "./lines.service";

/**
 * Comisión del bartender (pedido de Gerencia, 3-nov-2026; regla nueva de la
 * especificación del Resumen, 24-nov-2026). Solo el bartender comisiona.
 *
 * Comisión = ventas de bar COBRADAS del crucero × 10 % ÷ divisor (1,21 por
 * defecto; meta con vigencia, se usa la que regía al zarpar). No incluye
 * wetsuits, descorche ni otros servicios, ni cortesías.
 *
 * - Crucero en curso: se muestra la comisión proyectada (sobre todo lo
 *   vendido) y no se puede pagar.
 * - Sin bartender o con un usuario genérico: la comisión queda retenida hasta
 *   que Gerencia asigne la persona.
 *
 * Gerencia elige qué cruceros de un bartender paga y el pago guarda ese
 * detalle. Los pagos antiguos sin detalle (antes del 4-nov-2026) cubren
 * primero los cruceros más antiguos.
 */
export const COMMISSION_RATE = 0.1;
export const COMMISSION_DIVISOR = 1.21;

export function netCommission(sales: number, divisor: number = COMMISSION_DIVISOR): number {
  return round2((sales * COMMISSION_RATE) / (divisor > 0 ? divisor : COMMISSION_DIVISOR));
}

export type CruiseCommissionState = "pagada" | "parcial" | "pendiente" | "en_curso" | "retenida";

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
  const [products, orders, livePayments, payments] = await Promise.all([
    productIndex(),
    Order.find({ status: { $in: ["entregada", "pendiente"] } }).select("cruise items payment").lean(),
    Payment.find({ status: "vigente" }).select("_id").lean(),
    CommissionPayment.find().sort({ paidAt: -1, createdAt: -1 }).lean(),
  ]);
  const paidIds = new Set(livePayments.map((p) => p._id.toString()));
  // Ventas de bar por crucero: todas (proyección) y las cobradas (base de la comisión).
  const salesRows = new Map<string, { all: number; paid: number; orders: number }>();
  for (const o of orders) {
    let bar = 0;
    for (const i of o.items) {
      if (i.courtesy || products.get(i.product.toString())?.line === "wetsuit") continue;
      if (products.get(i.product.toString())?.line === "servicio") continue;
      bar += liveUnits(i) * i.unitPrice;
    }
    if (!bar) continue;
    const row = salesRows.get(o.cruise.toString()) ?? { all: 0, paid: 0, orders: 0 };
    row.all += bar;
    row.orders += 1;
    if (o.payment && paidIds.has(o.payment.toString())) row.paid += bar;
    salesRows.set(o.cruise.toString(), row);
  }

  const cruises = await Cruise.find({ _id: { $in: [...salesRows.keys()] } })
    .select("code name routeFrom routeTo startDate endDate startedAt closedAt status bartender bartenderName")
    .lean();
  const salesByCruise = salesRows;

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
      const sales = round2(row.paid);
      const retained = !c.bartender || isGenericName(c.bartenderName);
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
        salesAll: round2(row.all),
        retained,
        divisor: COMMISSION_DIVISOR,
        commission: netCommission(sales),
        projected: 0,
      };
    })
    // Orden real de operación: cuándo se inició (o su fecha programada si no consta).
    .sort(
      (a, b) =>
        new Date(a.startedAt ?? a.startDate).getTime() - new Date(b.startedAt ?? b.startDate).getTime(),
    );

  // Divisor que regía al zarpar cada crucero (un cambio de 2027 no toca 2026).
  for (const c of ordered) {
    c.divisor = (await goalsAt(new Date(c.startDate))).commissionDivisor ?? COMMISSION_DIVISOR;
    c.commission = c.status === "abordo" ? 0 : netCommission(c.sales, c.divisor);
    c.projected = c.status === "abordo" ? netCommission(c.salesAll, c.divisor) : 0;
  }

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
    const state: CruiseCommissionState =
      c.status === "abordo"
        ? "en_curso"
        : pending <= 0
          ? "pagada"
          : c.retained
            ? "retenida"
            : covered > 0
              ? "parcial"
              : "pendiente";
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
      // Por pagar: sin las retenidas (falta asignar la persona).
      pending: round2(rows.filter((r) => r.state !== "retenida").reduce((s, r) => s + r.pending, 0)),
      retained: round2(rows.filter((r) => r.state === "retenida").reduce((s, r) => s + r.pending, 0)),
      projected: round2(rows.reduce((s, r) => s + r.projected, 0)),
      cruises: rows.length,
    },
    bartenders: [...byBartender.values()].sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name)),
    // Lo más reciente arriba.
    cruises: rows.reverse(),
    payments: payments.map((p) => ({
      id: p._id.toString(),
      amount: p.amount,
      paidAt: p.paidAt,
      method: p.method ?? "",
      reference: p.reference ?? "",
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
