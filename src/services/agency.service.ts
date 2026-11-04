import { Cruise } from "../models/cruise.model";
import { Order, chargeableQty } from "../models/order.model";
import { AgencyInvoice } from "../models/agencyInvoice.model";
import { commercialDateKey } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Cortesías de agencia (pedido del cliente, 31-oct y 4-nov-2026): no se
 * cobran a la cabina; se juntan por crucero y se le facturan a la agencia una
 * vez al mes. Importe = precio vigente al registrar × unidades. Igual que
 * cualquier bebida entregada, descuentan inventario al entregarse.
 */
export interface AgencyItem {
  cruiseId: string;
  orderId: string;
  cabinNumber: number;
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  reason: string;
  by: string;
  at: Date;
}

/** Desde el día 28 de cada mes se avisa a Gerencia que toca facturar a la agencia. */
export const REMINDER_DAY = 28;

export async function agencyCourtesyItems(cruiseId?: string): Promise<AgencyItem[]> {
  const orders = await Order.find({
    ...(cruiseId ? { cruise: cruiseId } : {}),
    status: { $nin: ["cancelada", "retenida"] },
    items: { $elemMatch: { courtesy: true, courtesyKind: "agencia" } },
  })
    .populate("createdBy", "name")
    .sort({ createdAt: 1 });

  const items: AgencyItem[] = [];
  for (const order of orders) {
    const reason =
      [...order.cancellations].reverse().find((c) => /cortes/i.test(c.reason))?.reason.replace(/^Cortesía:\s*/, "") ?? "";
    for (const item of order.items) {
      const qty = chargeableQty(item);
      if (!item.courtesy || item.courtesyKind !== "agencia" || qty <= 0) continue;
      items.push({
        cruiseId: order.cruise.toString(),
        orderId: order._id.toString(),
        cabinNumber: order.cabinNumber,
        name: item.name,
        qty,
        unitPrice: item.unitPrice,
        total: round2(qty * item.unitPrice),
        reason,
        by: (order.createdBy as unknown as { name?: string })?.name ?? "",
        at: (order.clientAt ?? order.createdAt) as Date,
      });
    }
  }
  return items;
}

export const sumTotal = (items: Array<{ total: number }>) => round2(items.reduce((s, i) => s + i.total, 0));

/**
 * Por crucero: lo de agencia, lo ya facturado (facturas vigentes) y lo
 * pendiente. Un crucero con cortesías nuevas después de facturarlo vuelve a
 * tener pendiente solo la diferencia.
 */
export async function agencySummary(now: Date = new Date()) {
  const [items, invoices] = await Promise.all([
    agencyCourtesyItems(),
    AgencyInvoice.find().sort({ createdAt: -1 }).lean(),
  ]);
  const byCruise = new Map<string, AgencyItem[]>();
  for (const i of items) byCruise.set(i.cruiseId, [...(byCruise.get(i.cruiseId) ?? []), i]);

  const invoiced = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status !== "vigente") continue;
    for (const it of inv.items) invoiced.set(it.cruise.toString(), round2((invoiced.get(it.cruise.toString()) ?? 0) + it.amount));
  }

  const cruises = await Cruise.find({ _id: { $in: [...byCruise.keys()] } })
    .select("code name routeFrom routeTo startDate endDate startedAt closedAt status")
    .lean();
  const rows = cruises
    .map((c) => {
      const list = byCruise.get(c._id.toString()) ?? [];
      const total = sumTotal(list);
      const done = Math.min(total, invoiced.get(c._id.toString()) ?? 0);
      const pending = round2(total - done);
      const start = c.startedAt ?? c.startDate;
      return {
        id: c._id.toString(),
        code: c.code,
        name: c.name,
        routeFrom: c.routeFrom ?? "",
        routeTo: c.routeTo ?? "",
        startDate: start,
        endDate: c.closedAt ?? c.endDate ?? null,
        status: c.status,
        /** Mes del crucero (por su inicio), para agrupar. */
        month: commercialDateKey(new Date(start)).slice(0, 7),
        count: list.reduce((s, i) => s + i.qty, 0),
        total,
        invoiced: round2(done),
        pending,
        state: pending <= 0 ? "facturada" : done > 0 ? "parcial" : "pendiente",
        items: list,
      };
    })
    .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());

  const pending = rows.filter((r) => r.pending > 0);
  const today = commercialDateKey(now);
  const reminder =
    Number(today.slice(8, 10)) >= REMINDER_DAY && pending.length
      ? { month: today.slice(0, 7), amount: round2(pending.reduce((s, r) => s + r.pending, 0)), cruises: pending.length }
      : null;
  const lastEmail = invoices.find((i) => i.sentTo)?.sentTo ?? "";

  return {
    reminderDay: REMINDER_DAY,
    reminder,
    lastEmail,
    totals: {
      total: sumTotal(rows),
      invoiced: round2(rows.reduce((s, r) => s + r.invoiced, 0)),
      pending: round2(rows.reduce((s, r) => s + r.pending, 0)),
    },
    cruises: rows,
    invoices: invoices.map((i) => ({
      id: i._id.toString(),
      month: i.month,
      amount: i.amount,
      items: i.items.map((it) => ({ cruiseId: it.cruise.toString(), code: it.code, count: it.count, amount: it.amount })),
      invoiceNumber: i.invoiceNumber,
      sentTo: i.sentTo,
      sentAt: i.sentAt,
      note: i.note,
      status: i.status,
      by: i.byName,
      createdAt: i.createdAt,
      voided: i.voided ? { by: i.voided.byName, at: i.voided.at, reason: i.voided.reason } : null,
    })),
  };
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (v: number) => `$${v.toFixed(2)}`;
const cell = 'style="padding:6px 8px;border-bottom:1px solid #eee"';
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "2026-11" → "noviembre 2026". */
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** Correo a la agencia: el detalle por crucero y el total del mes. No es la factura electrónica. */
export function agencyEmail(
  month: string,
  cruises: Array<{ label: string; amount: number; items: AgencyItem[] }>,
  total: number,
) {
  const blocks = cruises
    .map(
      (c) =>
        `<h3 style="margin:20px 0 6px;font-size:16px">Crucero ${esc(c.label)} · ${money(c.amount)}</h3>` +
        `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
        c.items
          .map(
            (i) =>
              `<tr><td ${cell}>Cabina ${i.cabinNumber}</td><td ${cell}>${i.qty} × ${esc(i.name)}` +
              `${i.reason ? `<br><small style="color:#777">${esc(i.reason)}</small>` : ""}</td>` +
              `<td ${cell} align="right">${money(i.total)}</td></tr>`,
          )
          .join("") +
        `</table>`,
    )
    .join("");
  const html =
    `<div style="font-family:Arial,sans-serif;color:#222;max-width:640px">` +
    `<h2 style="margin:0 0 4px">Cortesías de agencia · ${monthName(month)}</h2>` +
    `<p style="margin:0;color:#555">Detalle por crucero de las cortesías servidas a pedido de la agencia. La factura electrónica llega por separado.</p>` +
    blocks +
    `<p style="margin:20px 0 0;font-size:16px"><b>Total: ${money(total)}</b></p></div>`;
  const text = [
    `Cortesías de agencia · ${monthName(month)}`,
    ...cruises.flatMap((c) => [
      "",
      `Crucero ${c.label} · ${money(c.amount)}`,
      ...c.items.map((i) => `  Cabina ${i.cabinNumber} · ${i.qty} × ${i.name} · ${money(i.total)}`),
    ]),
    "",
    `Total: ${money(total)}`,
  ].join("\n");
  return { subject: `Cortesías de agencia · ${monthName(month)} · ${money(total)}`, html, text };
}

export type AgencySummary = Awaited<ReturnType<typeof agencySummary>>;
export type AgencyCruiseRow = AgencySummary["cruises"][number];
