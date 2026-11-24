import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CommissionPayment } from "../models/commissionPayment.model";
import { notFound } from "../errors/httpError";
import { COMMISSION_RATE } from "./commission.service";
import { commercialDateKey } from "../utils/dates";

/**
 * Recibo del pago de comisión para firma (especificación del Resumen,
 * 24-nov-2026, bloque 6): al confirmar el pago se genera para que el
 * bartender firme lo recibido.
 */
const money = (v: number) => `$${v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const METHOD: Record<string, string> = { transferencia: "Transferencia", efectivo: "Efectivo" };

export async function commissionReceiptPdf(id: string) {
  const payment = await CommissionPayment.findById(id).lean();
  if (!payment) throw notFound("Pago de comisión no encontrado");

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.16, 0.2);
  const muted = rgb(0.4, 0.45, 0.5);
  let y = 780;
  const text = (t: string, x: number, size = 11, f = font, color = ink) => page.drawText(t, { x, y, size, font: f, color });

  text("TREASURE OF GALÁPAGOS", 50, 10, bold, muted);
  y -= 26;
  text("Recibo de pago de comisión", 50, 20, bold);
  y -= 22;
  const day = commercialDateKey(new Date(payment.paidAt));
  text(`Fecha: ${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`, 50, 11, font, muted);
  if (payment.status === "anulado") text("ANULADO", 450, 14, bold, rgb(0.6, 0.15, 0.12));
  y -= 36;

  text("Recibí de Treasure of Galápagos la comisión de bar de los cruceros detallados:", 50);
  y -= 30;
  text("Crucero", 50, 10, bold, muted);
  text("Ventas de bar cobradas", 200, 10, bold, muted);
  text("Comisión", 430, 10, bold, muted);
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: muted });
  for (const item of payment.items ?? []) {
    y -= 20;
    text(item.code || "Crucero", 50);
    text(money(item.sales), 200);
    text(money(item.amount), 430);
  }
  y -= 14;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.6, color: muted });
  y -= 22;
  text("Total recibido", 50, 13, bold);
  text(money(payment.amount), 430, 13, bold);
  y -= 26;
  text(
    `${COMMISSION_RATE * 100} % de las ventas de bar cobradas ÷ divisor vigente. Sin wetsuits, servicios ni cortesías.`,
    50,
    9,
    font,
    muted,
  );
  y -= 16;
  const how = [METHOD[payment.method ?? ""] ?? "", payment.reference ? `ref. ${payment.reference}` : ""].filter(Boolean).join(" · ");
  if (how) text(`Forma de pago: ${how}`, 50, 10);

  y = 200;
  page.drawLine({ start: { x: 50, y }, end: { x: 260, y }, thickness: 0.8, color: ink });
  page.drawLine({ start: { x: 335, y }, end: { x: 545, y }, thickness: 0.8, color: ink });
  y -= 16;
  text(payment.bartenderName || "Bartender", 50, 10, bold);
  text(payment.byName || "Gerencia", 335, 10, bold);
  y -= 14;
  text("Recibí conforme", 50, 9, font, muted);
  text("Entregué (Gerencia)", 335, 9, font, muted);

  return { bytes: await doc.save(), name: `recibo-comision-${(payment.bartenderName || "bartender").replace(/\s+/g, "-")}-${day}.pdf` };
}
