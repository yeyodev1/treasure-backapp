import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { Cruise } from "../models/cruise.model";
import { chargeableQty, Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { TIMEZONE } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * «Cobro bar» de un crucero en Excel (pedido del cliente, 14-nov-2026): los
 * cobros con su factura y los consumos de cada cabina, para cerrar el crucero.
 */

const METHOD: Record<string, string> = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  online: "Pago en línea",
};
const INVOICE: Record<string, string> = {
  emitida: "Emitida",
  emitiendo: "Emitiendo",
  pendiente: "Pendiente",
  error: "Pendiente",
  parcial: "En la factura del pago final",
  no_aplica: "Sin factura",
};
const LINE: Record<string, string> = { bar: "Bar", wetsuit: "Wetsuits" };
const MONEY = '"$"#,##0.00';
const NAVY = "FF1F3A52";

function when(date: Date | null | undefined): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function day(date: Date | null | undefined): string {
  return when(date).slice(0, 10);
}

/** Encabezado del crucero arriba de cada hoja. */
function heading(ws: ExcelJS.Worksheet, title: string, lines: string[], columns: number) {
  ws.mergeCells(1, 1, 1, columns);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { bold: true, size: 15, color: { argb: NAVY } };
  lines.forEach((text, i) => {
    ws.mergeCells(i + 2, 1, i + 2, columns);
    ws.getCell(i + 2, 1).value = text;
    ws.getCell(i + 2, 1).font = { color: { argb: "FF555555" } };
  });
  return lines.length + 3; // fila del encabezado de la tabla
}

function tableHeader(ws: ExcelJS.Worksheet, row: number, labels: string[]) {
  const r = ws.getRow(row);
  labels.forEach((label, i) => {
    const c = r.getCell(i + 1);
    c.value = label;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    c.alignment = { vertical: "middle", wrapText: true };
  });
  r.height = 22;
  ws.views = [{ state: "frozen", ySplit: row }];
  ws.autoFilter = { from: { row, column: 1 }, to: { row, column: labels.length } };
}

export async function cobroBarWorkbook(cruiseId: string) {
  const cruise = await Cruise.findById(cruiseId).select("code name routeFrom routeTo startDate endDate status");
  if (!cruise) return null;
  const id = new Types.ObjectId(cruiseId);
  const [payments, orders] = await Promise.all([
    Payment.find({ cruise: id }).populate("collectedBy", "name").sort({ cabinNumber: 1, createdAt: 1 }),
    Order.find({ cruise: id, status: { $nin: ["cancelada", "retenida"] } }).populate("items.product", "legs").sort({ cabinNumber: 1, createdAt: 1 }),
  ]);

  const label = cruise.code || cruise.name;
  const info = [
    `Ruta: ${[cruise.routeFrom, cruise.routeTo].filter(Boolean).join(" → ") || "—"}`,
    `Fechas: ${day(cruise.startDate)}${cruise.endDate ? ` al ${day(cruise.endDate)}` : ""}${cruise.status === "cerrado" ? " · finalizado" : ""}`,
    `Generado: ${when(new Date())}`,
  ];
  // Número de factura de cada cobro: las formas de pago de un cobro comparten la factura de su cabeza.
  const byId = new Map(payments.map((p) => [p._id.toString(), p]));
  const invoiceOf = (p: (typeof payments)[number]) => {
    const head = p.group ? byId.get(p.group.toString()) : null;
    const owner = p.invoiceNumber ? p : head?.invoiceNumber ? head : p.settledBy ? byId.get(p.settledBy.toString()) : null;
    return owner ?? p;
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = "Treasure of Galápagos";

  // ---- Hoja 1: cobros ----
  const ws = wb.addWorksheet("Cobros");
  const cols = ["Fecha", "Cabina", "Pagador", "Identificación", "Correo", "Línea", "Forma de pago", "Referencia", "Monto", "Factura N.º", "Estado factura", "SRI", "Cobró", "Estado"];
  ws.columns = [16, 9, 28, 16, 28, 10, 15, 16, 12, 20, 22, 14, 18, 12].map((width) => ({ width }));
  const head = heading(ws, `COBRO BAR · Crucero ${label}`, info, cols.length);
  tableHeader(ws, head, cols);

  const byMethod = new Map<string, number>();
  const byLine = new Map<string, number>();
  let total = 0;
  for (const p of payments) {
    const inv = invoiceOf(p);
    const live = p.status === "vigente";
    const row = ws.addRow([
      when(p.createdAt),
      p.cabins?.length > 1 ? p.cabins.join(", ") : p.cabinNumber,
      p.billing?.name ?? "",
      p.billing?.idNumber ?? "",
      p.billing?.email ?? "",
      LINE[p.line ?? "bar"] ?? "Bar",
      METHOD[p.method] ?? p.method,
      p.reference ?? "",
      p.total,
      inv.invoiceNumber || "",
      INVOICE[inv.invoiceStatus] ?? inv.invoiceStatus,
      inv.invoiceSriStatus || "",
      (p.collectedBy as unknown as { name?: string } | null)?.name ?? "",
      live ? "Vigente" : "Reversado",
    ]);
    row.getCell(9).numFmt = MONEY;
    if (!live) row.font = { strike: true, color: { argb: "FF999999" } };
    else {
      total += p.total;
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.total);
      byLine.set(p.line ?? "bar", (byLine.get(p.line ?? "bar") ?? 0) + p.total);
      if (inv.invoiceStatus !== "emitida" && inv.invoiceStatus !== "parcial") {
        row.getCell(11).font = { bold: true, color: { argb: "FFB3261E" } };
      }
    }
  }
  if (!payments.length) ws.addRow(["Sin cobros en este crucero"]);

  ws.addRow([]);
  const summary = (text: string, amount: number, bold = false) => {
    const r = ws.addRow(["", "", "", "", "", "", text, "", round2(amount)]);
    r.getCell(9).numFmt = MONEY;
    r.getCell(7).font = { bold };
    r.getCell(9).font = { bold };
  };
  for (const [method, amount] of byMethod) summary(METHOD[method] ?? method, amount);
  if (byLine.size > 1) for (const [line, amount] of byLine) summary(`Total ${LINE[line] ?? line}`, amount);
  summary("TOTAL COBRADO", total, true);

  // ---- Hoja 2: consumos por cabina ----
  const wc = wb.addWorksheet("Consumos");
  const ccols = ["Fecha", "Cabina", "Consumió", "Producto", "Línea", "Cant.", "Precio unit.", "Total", "Tipo", "Factura N.º"];
  wc.columns = [16, 9, 20, 34, 10, 7, 12, 12, 18, 20].map((width) => ({ width }));
  const chead = heading(wc, `CONSUMOS · Crucero ${label}`, info, ccols.length);
  tableHeader(wc, chead, ccols);
  let consumed = 0;
  let courtesies = 0;
  for (const o of orders) {
    const paid = o.payment ? byId.get(o.payment.toString()) : null;
    const isWetsuit = o.items.some((i) => ((i.product as unknown as { legs?: string[] } | null)?.legs?.length ?? 0) > 0);
    for (const item of o.items) {
      const qty = chargeableQty(item);
      if (qty <= 0) continue;
      const amount = round2(qty * item.unitPrice);
      const kind = item.courtesy
        ? item.courtesyKind === "agencia" ? "Cortesía agencia" : "Cortesía casa"
        : paid ? "Cobrado" : "Por cobrar";
      if (item.courtesy) courtesies += amount;
      else consumed += amount;
      const r = wc.addRow([
        when(o.createdAt),
        o.cabinNumber,
        o.consumerName || "",
        item.name,
        isWetsuit ? "Wetsuits" : "Bar",
        qty,
        item.unitPrice,
        item.courtesy ? 0 : amount,
        kind,
        paid ? invoiceOf(paid).invoiceNumber || "" : "",
      ]);
      r.getCell(7).numFmt = MONEY;
      r.getCell(8).numFmt = MONEY;
      if (kind === "Por cobrar") r.getCell(9).font = { bold: true, color: { argb: "FFB3261E" } };
    }
  }
  wc.addRow([]);
  for (const [text, amount, bold] of [["Consumos cobrables", consumed, true], ["Cortesías (a precio de venta)", courtesies, false]] as const) {
    const r = wc.addRow(["", "", "", "", "", "", text, round2(amount)]);
    r.getCell(8).numFmt = MONEY;
    r.getCell(7).font = { bold };
    r.getCell(8).font = { bold };
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: `cobro-bar-${label.replace(/[^\w-]+/g, "_")}.xlsx` };
}
