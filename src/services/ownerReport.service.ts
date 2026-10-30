import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { Purchase } from "../models/purchase.model";
import { StockCount } from "../models/stockCount.model";
import { badRequest, notFound } from "../errors/httpError";
import { commercialDateKey, parseRangeEdge } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Resumen del negocio (checklist 29-oct: 05, 08, 09, 10A, 10B y 11). Un solo
 * filtro gobierna todas las cifras:
 *
 * - Crucero: consumos y pagos de esa salida hasta el corte (ahora o el fin
 *   del rango). Las compras no son de una salida: se muestran las recibidas
 *   entre el inicio de la salida y su fin (o el corte).
 * - Periodo: consumos según su fecha de consumo y pagos según su fecha de
 *   pago. Cobrar hoy una deuda de ayer no suma consumos de hoy.
 * - Por cobrar es siempre el saldo al corte: consumos hasta el corte que no
 *   estaban pagados en ese momento, separando lo del periodo y lo anterior.
 *
 * Costo de lo servido = insumos al costo histórico de cada consumo, incluidas
 * las cortesías servidas. Si falta un costo no vale cero: no se informa costo
 * ni margen. Mermas y ajustes van aparte. El margen nunca es utilidad neta.
 */

export interface OwnerReportQuery {
  cruiseId?: string;
  from?: string;
  to?: string;
}

const DETAIL_LIMIT = 3000;

export async function ownerReport(query: OwnerReportQuery) {
  const generatedAt = new Date();
  const toEdge = parseRangeEdge(query.to, "end");
  const cut = toEdge && toEdge < generatedAt ? toEdge : generatedAt;
  const start = parseRangeEdge(query.from, "start");
  if (start && start > cut) throw badRequest("La fecha inicial es posterior al corte");

  let cruise: {
    _id: Types.ObjectId;
    code: string;
    name: string;
    routeFrom: string;
    routeTo: string;
    startDate: Date;
    endDate: Date | null;
    startedAt: Date | null;
    closedAt: Date | null;
    status: string;
  } | null = null;
  if (query.cruiseId) {
    if (!Types.ObjectId.isValid(query.cruiseId)) throw badRequest("Crucero inválido");
    cruise = await Cruise.findById(query.cruiseId)
      .select("code name routeFrom routeTo startDate endDate startedAt closedAt status")
      .lean();
    if (!cruise) throw notFound("Crucero no encontrado");
  }
  const mode: "crucero" | "periodo" | "todo" = cruise ? "crucero" : start || toEdge ? "periodo" : "todo";

  // ---- Consumos hasta el corte (y del periodo, si lo hay)
  const scopeMatch: Record<string, unknown> = { status: { $in: ["entregada", "pendiente"] } };
  if (cruise) scopeMatch.cruise = cruise._id;
  const [orders, cruises] = await Promise.all([
    Order.find({ ...scopeMatch, createdAt: { $lte: cut } })
      .select("cruise cabinNumber items total payment createdAt createdBy")
      .populate("createdBy", "name")
      .sort({ createdAt: 1 })
      .lean(),
    Cruise.find().select("code name startDate").lean(),
  ]);
  const cruiseName = new Map(cruises.map((c) => [c._id.toString(), c.code || c.name]));
  const inPeriod = (date: Date) => !start || date >= start;

  // Pagos de esos consumos: ¿estaban pagados al corte?
  const paymentIds = [...new Set(orders.filter((o) => o.payment).map((o) => o.payment!.toString()))];
  const paidAt = new Map(
    (await Payment.find({ _id: { $in: paymentIds } }).select("createdAt status").lean())
      .filter((p) => p.status === "vigente")
      .map((p) => [p._id.toString(), p.createdAt as Date]),
  );

  let net = 0;
  let courtesy = 0;
  let pendingPeriod = 0;
  let pendingBefore = 0;
  const missingCost = new Map<string, string>();
  const consumptionLines: Array<Record<string, unknown>> = [];
  const courtesyLines: Array<Record<string, unknown>> = [];
  const costByProduct = new Map<string, { name: string; qty: number; cost: number; complete: boolean }>();
  const byDay = new Map<string, { total: number; orders: number }>();
  const byBartender = new Map<string, { total: number; orders: number }>();
  const byProduct = new Map<string, { qty: number; total: number; courtesyQty: number }>();
  const pendingByCabin = new Map<
    string,
    {
      cruiseId: string;
      cruise: string;
      cabin: number;
      amount: number;
      orders: number;
      oldest: Date;
      previous: boolean;
      /** Parte del saldo que viene de antes del periodo. */
      before: number;
    }
  >();
  let periodOrders = 0;

  for (const order of orders) {
    const createdAt = order.createdAt as Date;
    const counts = inPeriod(createdAt);
    const cruiseLabel = cruiseName.get(order.cruise.toString()) ?? "";
    const by = (order.createdBy as unknown as { name?: string } | null)?.name ?? "";
    let orderAmount = 0;

    for (const item of order.items) {
      const units = Math.max(0, item.qty - item.cancelledQty - item.annulledQty);
      if (!units) continue;
      const amount = units * item.unitPrice;
      if (!item.courtesy) orderAmount += amount;
      if (!counts) continue;

      const line = {
        at: createdAt,
        cruise: cruiseLabel,
        cabin: order.cabinNumber,
        item: item.name,
        qty: units,
        unitPrice: item.unitPrice,
        amount: round2(item.courtesy ? 0 : amount),
        courtesy: item.courtesy,
        by,
      };
      if (item.courtesy) {
        courtesy += amount;
        courtesyLines.push({ ...line, amount: round2(amount) });
      } else {
        net += amount;
        consumptionLines.push(line);
      }

      // Costo de lo servido: incluye cortesías; un costo faltante no vale cero.
      const lineCost = units * (item.unitCost ?? 0);
      const key = item.product.toString();
      const entry = costByProduct.get(key) ?? { name: item.name, qty: 0, cost: 0, complete: true };
      entry.qty += units;
      entry.cost += lineCost;
      if (!item.costComplete) {
        entry.complete = false;
        missingCost.set(key, item.name);
      }
      costByProduct.set(key, entry);

      const product = byProduct.get(item.name) ?? { qty: 0, total: 0, courtesyQty: 0 };
      product.qty += units;
      if (item.courtesy) product.courtesyQty += units;
      else product.total += amount;
      byProduct.set(item.name, product);
    }

    if (counts) {
      periodOrders += 1;
      const day = commercialDateKey(createdAt);
      const d = byDay.get(day) ?? { total: 0, orders: 0 };
      d.total += orderAmount;
      d.orders += 1;
      byDay.set(day, d);
      const b = byBartender.get(by || "Sin nombre") ?? { total: 0, orders: 0 };
      b.total += orderAmount;
      b.orders += 1;
      byBartender.set(by || "Sin nombre", b);
    }

    // Saldo al corte: sin pago, o pagado después del corte.
    const paymentDate = order.payment ? paidAt.get(order.payment.toString()) : undefined;
    const unpaidAtCut = !paymentDate || paymentDate > cut;
    if (unpaidAtCut && orderAmount > 0) {
      if (counts) pendingPeriod += orderAmount;
      else pendingBefore += orderAmount;
      const key = `${order.cruise.toString()}-${order.cabinNumber}`;
      const p = pendingByCabin.get(key) ?? {
        cruiseId: order.cruise.toString(),
        cruise: cruiseLabel,
        cabin: order.cabinNumber,
        amount: 0,
        orders: 0,
        oldest: createdAt,
        previous: false,
        before: 0,
      };
      p.amount += orderAmount;
      p.orders += 1;
      if (!counts) {
        p.previous = true;
        p.before += orderAmount;
      }
      if (createdAt < p.oldest) p.oldest = createdAt;
      pendingByCabin.set(key, p);
    }
  }

  // Pagos parciales recibidos hasta el corte cuya cuenta no estaba liquidada
  // al corte: bajan el saldo de su cabina (primero lo más antiguo).
  const partials = await Payment.find({
    status: "vigente",
    invoiceStatus: "parcial",
    createdAt: { $lte: cut },
    ...(cruise ? { cruise: cruise._id } : {}),
  })
    .select("cruise cabinNumber total settledBy")
    .lean();
  const liquidatedAt = new Map(
    (
      await Payment.find({ _id: { $in: partials.map((p) => p.settledBy).filter(Boolean) }, status: "vigente" })
        .select("createdAt")
        .lean()
    ).map((p) => [p._id.toString(), p.createdAt as Date]),
  );
  for (const partial of partials) {
    const settledAt = partial.settledBy ? liquidatedAt.get(partial.settledBy.toString()) : undefined;
    if (settledAt && settledAt <= cut) continue;
    const entry = pendingByCabin.get(`${partial.cruise.toString()}-${partial.cabinNumber}`);
    if (!entry) continue;
    const applied = Math.min(entry.amount, partial.total);
    const fromBefore = Math.min(entry.before, applied);
    entry.before -= fromBefore;
    entry.amount -= applied;
    pendingBefore -= fromBefore;
    pendingPeriod -= applied - fromBefore;
  }
  for (const [key, entry] of pendingByCabin) {
    if (round2(entry.amount) <= 0) pendingByCabin.delete(key);
  }

  // ---- Pagos: según su fecha de pago, hasta el corte
  const paymentMatch: Record<string, unknown> = {
    status: "vigente",
    createdAt: { $lte: cut, ...(start ? { $gte: start } : {}) },
  };
  if (cruise) paymentMatch.cruise = cruise._id;
  const payments = await Payment.find(paymentMatch)
    .select("cruise cabinNumber total method createdAt invoiceStatus")
    .sort({ createdAt: 1 })
    .lean();
  let collected = 0;
  const byMethod: Record<string, number> = {};
  const collectedByCruise = new Map<string, { collected: number; payments: number }>();
  for (const p of payments) {
    collected += p.total;
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.total;
    const c = collectedByCruise.get(p.cruise.toString()) ?? { collected: 0, payments: 0 };
    c.collected += p.total;
    c.payments += 1;
    collectedByCruise.set(p.cruise.toString(), c);
  }

  // ---- Compras recibidas: importe exacto de cada recepción (envases × costo).
  // Antes se sumaba cantidad × costo por ml redondeado a 4 decimales y se
  // perdían centavos ($101,87 frente a $84 + $18).
  let purchaseFrom = start;
  let purchaseTo = cut;
  if (cruise) {
    purchaseFrom = cruise.startedAt ?? cruise.startDate;
    const end = cruise.closedAt ?? null;
    if (end && end < purchaseTo) purchaseTo = end;
  }
  const purchaseDocs = await Purchase.find({
    "receipts.at": { $lte: purchaseTo, ...(purchaseFrom ? { $gte: purchaseFrom } : {}) },
  })
    .select("code supplier document status total lines receipts destination")
    .lean();
  let purchases = 0;
  const purchaseRows: Array<Record<string, unknown>> = [];
  for (const purchase of purchaseDocs) {
    let amount = 0;
    const lines = new Map<number, { name: string; containers: number; label: string; amount: number }>();
    let lastAt = 0;
    for (const receipt of purchase.receipts) {
      const at = new Date(receipt.at);
      if (at > purchaseTo || (purchaseFrom && at < purchaseFrom)) continue;
      lastAt = Math.max(lastAt, at.getTime());
      for (const pick of receipt.lines) {
        const line = purchase.lines[pick.index];
        if (!line) continue;
        const containers = line.containerSize ? pick.qty / line.containerSize : pick.qty;
        const lineAmount = containers * line.containerCost;
        amount += lineAmount;
        const row = lines.get(pick.index) ?? { name: line.name, containers: 0, label: line.containerLabel, amount: 0 };
        row.containers += containers;
        row.amount += lineAmount;
        lines.set(pick.index, row);
      }
    }
    if (!lastAt) continue;
    purchases += round2(amount);
    purchaseRows.push({
      code: purchase.code,
      supplier: purchase.supplier,
      document: purchase.document,
      at: new Date(lastAt),
      status: purchase.status,
      partial: purchase.status === "recibida_parcial",
      invoiceTotal: purchase.total,
      amount: round2(amount),
      lines: [...lines.values()].map((l) => ({ ...l, containers: round2(l.containers), amount: round2(l.amount) })),
    });
  }
  purchaseRows.sort((a, b) => String(a.code).localeCompare(String(b.code)));

  // ---- Alertas: solo incidencias que existen, con su acción
  const [held, countsPending, invoicesPending] = await Promise.all([
    Order.countDocuments({ status: "retenida", heldReview: null, ...(cruise ? { cruise: cruise._id } : {}) }),
    StockCount.countDocuments({ status: "enviado" }),
    Payment.countDocuments({
      status: "vigente",
      invoiceStatus: { $in: ["pendiente", "error"] },
      ...(cruise ? { cruise: cruise._id } : {}),
    }),
  ]);
  const pendingCabins = [...pendingByCabin.values()];
  const alerts: Array<{ kind: string; count: number; amount?: number; text: string; action: string }> = [];
  if (pendingCabins.length) {
    alerts.push({
      kind: "cuentas",
      count: pendingCabins.length,
      amount: round2(pendingPeriod + pendingBefore),
      text: `${pendingCabins.length} cuenta(s) con saldo por cobrar`,
      action: "Ver cuentas pendientes",
    });
  }
  if (missingCost.size) {
    alerts.push({
      kind: "costos",
      count: missingCost.size,
      text: `${missingCost.size} producto(s) servidos sin costo`,
      action: "Ver productos sin costo",
    });
  }
  if (countsPending) {
    alerts.push({
      kind: "conteos",
      count: countsPending,
      text: `${countsPending} conteo(s) pendiente(s) de aprobación`,
      action: "Revisar conteos",
    });
  }
  if (invoicesPending) {
    alerts.push({
      kind: "facturas",
      count: invoicesPending,
      text: `${invoicesPending} pago(s) con factura pendiente`,
      action: "Ver facturas pendientes",
    });
  }
  if (held) {
    alerts.push({
      kind: "retenidos",
      count: held,
      text: `${held} consumo(s) enviados tarde, pendientes de revisión`,
      action: "Revisar consumos retenidos",
    });
  }

  const costsComplete = missingCost.size === 0 && periodOrders > 0;
  // Costo como suma de lo que muestra el detalle (sin diferencias de centavos).
  const servedCost = [...costByProduct.values()].reduce((s, c) => s + round2(c.cost), 0);
  const cruiseRows = [...collectedByCruise.entries()]
    .map(([id, c]) => {
      const info = cruises.find((x) => x._id.toString() === id);
      return {
        id,
        name: info?.code || info?.name || "",
        startDate: info?.startDate ?? null,
        collected: round2(c.collected),
        payments: c.payments,
      };
    })
    .sort((a, b) => new Date(b.startDate ?? 0).getTime() - new Date(a.startDate ?? 0).getTime());

  const round = (m: Map<string, { total: number; orders: number }>) =>
    [...m.entries()].map(([k, v]) => ({ key: k, total: round2(v.total), orders: v.orders }));

  return {
    scope: {
      mode,
      cruise: cruise
        ? {
            id: cruise._id.toString(),
            code: cruise.code,
            name: cruise.name,
            route: cruise.routeFrom && cruise.routeTo ? `${cruise.routeFrom} → ${cruise.routeTo}` : "",
            status: cruise.status,
            startDate: cruise.startedAt ?? cruise.startDate,
            endDate: cruise.closedAt ?? cruise.endDate,
          }
        : null,
      from: start,
      cut,
      generatedAt,
      purchasesFrom: purchaseFrom,
      purchasesTo: purchaseTo,
    },
    // Orden del resumen: consumos del bar, cobrado, por cobrar; luego costo y margen.
    netConsumption: round2(net),
    collected: round2(collected),
    byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, round2(v)])),
    pendingCollection: round2(pendingPeriod + pendingBefore),
    pendingFromPeriod: round2(pendingPeriod),
    pendingFromBefore: round2(pendingBefore),
    consumedCost: costsComplete ? round2(servedCost) : null,
    costsComplete,
    missingCost: [...missingCost.values()].slice(0, 30),
    missingCostCount: missingCost.size,
    margin: costsComplete ? round2(net - servedCost) : null,
    // Información secundaria.
    courtesy: round2(courtesy),
    purchases: round2(purchases),
    heldConsumptions: held,
    alerts,
    // Bloque antiguo, con el mismo filtro (L24).
    byDay: round(byDay)
      .map((d) => ({ date: d.key, total: d.total, orders: d.orders }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byBartender: round(byBartender)
      .map((d) => ({ name: d.key, total: d.total, orders: d.orders }))
      .sort((a, b) => b.total - a.total),
    topProducts: [...byProduct.entries()]
      .map(([name, v]) => ({ name, qty: v.qty, total: round2(v.total), courtesyQty: v.courtesyQty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 15),
    byCruise: cruiseRows,
    // Detalle de cada cifra: suma exactamente lo mostrado.
    details: {
      consumption: consumptionLines.slice(-DETAIL_LIMIT),
      courtesy: courtesyLines.slice(-DETAIL_LIMIT),
      truncated: consumptionLines.length > DETAIL_LIMIT || courtesyLines.length > DETAIL_LIMIT,
      payments: payments.map((p) => ({
        at: p.createdAt,
        cruise: cruiseName.get(p.cruise.toString()) ?? "",
        cabin: p.cabinNumber,
        method: p.method,
        total: p.total,
        invoiceStatus: p.invoiceStatus,
      })),
      pending: pendingCabins
        .map(({ before: _before, ...p }) => ({ ...p, amount: round2(p.amount) }))
        .sort((a, b) => b.amount - a.amount),
      cost: [...costByProduct.values()]
        .map((c) => ({ name: c.name, qty: c.qty, cost: c.complete ? round2(c.cost) : null }))
        .sort((a, b) => (a.cost === null ? -1 : b.cost === null ? 1 : b.cost - a.cost)),
      purchases: purchaseRows,
    },
  };
}
