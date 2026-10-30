import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { Cruise } from "../models/cruise.model";
import { Payment } from "../models/payment.model";
import { notFound } from "../errors/httpError";
import { AccountOrder, buildCabinAccount } from "./account.service";
import { round2 } from "../utils/units";

/**
 * Prefactura en inglés de la cuenta de una cabina (checklist 29-oct, 02 y
 * L13). Se descarga antes o después de pagar: no envía correo, no llama a
 * Contífico y no es factura fiscal ni recibo de pago.
 */

/** Conceptos genéricos en inglés; marcas y nombres propios se conservan. */
const TERMS: Array<[RegExp, string]> = [
  [/\(botella mini\)/gi, "(mini bottle)"],
  [/\(botella\)/gi, "(bottle)"],
  [/\(copa\)/gi, "(glass)"],
  [/\(trago\)/gi, "(shot)"],
  [/\(lata\)/gi, "(can)"],
];

const NAMES: Record<string, string> = {
  "agua tónica": "Tonic water",
  "agua con gas güitig": "Güitig sparkling water",
  "jugo de naranja": "Orange juice",
  "jugo de piña": "Pineapple juice",
  "jugo de lima": "Lime juice",
  "jugo de limón": "Lemon juice",
  "piña colada": "Piña Colada",
};

export function englishItemName(name: string): string {
  const trimmed = name.trim();
  // Descorche en la app; en el documento en inglés, Corkage fee.
  if (/corkage|descorche/i.test(trimmed)) return "Corkage fee";
  const known = NAMES[trimmed.toLowerCase()];
  if (known) return known;
  return TERMS.reduce((text, [pattern, english]) => text.replace(pattern, english), trimmed);
}

export const PAYMENT_METHOD_EN: Record<string, string> = {
  efectivo: "Cash",
  tarjeta: "Card",
  transferencia: "Bank transfer",
  online: "Online payment",
};

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (v: number) => money.format(round2(v));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 29, 2026" (y "· 21:30") en hora de Galápagos, sin depender del ICU del servidor. */
function dateEn(date: Date, withTime = false): string {
  const local = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${MONTHS[local.getUTCMonth()]} ${pad(local.getUTCDate())}, ${local.getUTCFullYear()}`;
  return withTime ? `${day} · ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}` : day;
}

/** Texto apto para la fuente estándar del PDF (WinAnsi). */
function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

export interface ProformaLine {
  date: Date;
  item: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  complimentary: boolean;
}

export interface ProformaData {
  cruise: string;
  route: string;
  cabin: number;
  billTo: string;
  date: Date;
  lines: ProformaLine[];
  total: number;
  complimentary: number;
  payments: Array<{ date: Date; method: string; amount: number }>;
  paid: number;
  balance: number;
}

function linesOf(orders: AccountOrder[]): ProformaLine[] {
  return orders.flatMap((order) =>
    order.items
      .filter((i) => i.chargeableQty > 0)
      .map((i) => ({
        date: new Date(order.createdAt),
        item: englishItemName(i.name),
        quantity: i.chargeableQty,
        unitPrice: i.unitPrice,
        amount: i.courtesy ? 0 : round2(i.chargeableQty * i.unitPrice),
        complimentary: i.courtesy,
      })),
  );
}

/** Datos de la prefactura: toda la cuenta (pagada y abierta), pagos y saldo. */
export async function proformaData(cruiseId: string, cabinNumber: number): Promise<ProformaData> {
  const cruise = await Cruise.findById(cruiseId).select("code name routeFrom routeTo cabins");
  const cabin = cruise?.cabins.find((c) => c.number === cabinNumber);
  if (!cruise || !cabin) throw notFound("Cuenta no encontrada");

  const account = await buildCabinAccount(cruiseId, cabinNumber);
  const lastPayment = await Payment.findOne({ cruise: cruiseId, cabinNumber, status: "vigente" })
    .sort({ createdAt: -1 })
    .select("billing");
  const payer = cabin.passengers.find((p) => p.isPayer) ?? cabin.passengers[0];

  const lines = linesOf([...account.paidOrders, ...account.orders]).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  return {
    cruise: cruise.code || cruise.name,
    route: cruise.routeFrom && cruise.routeTo ? `${cruise.routeFrom} - ${cruise.routeTo}` : "",
    cabin: cabinNumber,
    billTo: lastPayment?.billing?.name || payer?.name || cabin.guestName || `Cabin ${cabinNumber}`,
    date: new Date(),
    lines,
    total: account.consumed,
    complimentary: account.courtesyAll,
    payments: account.payments.map((p) => ({
      date: new Date(p.createdAt),
      method: PAYMENT_METHOD_EN[p.method] ?? p.method,
      amount: p.total,
    })),
    paid: account.paid,
    balance: account.due,
  };
}

// ---- Dibujo (A4, Helvetica) ----

const INK = rgb(0.106, 0.169, 0.145);
const MUTED = rgb(0.42, 0.45, 0.47);
const NAVY = rgb(0.153, 0.267, 0.353);
const RULE = rgb(0.82, 0.85, 0.88);
const PAGE: [number, number] = [595.28, 841.89];
const MARGIN = 48;

interface Pen {
  pdf: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
}

function text(pen: Pen, value: string, x: number, size = 10, options: { bold?: boolean; color?: typeof INK } = {}) {
  pen.page.drawText(safe(value), {
    x,
    y: pen.y,
    size,
    font: options.bold ? pen.bold : pen.font,
    color: options.color ?? INK,
  });
}

function textRight(pen: Pen, value: string, right: number, size = 10, options: { bold?: boolean; color?: typeof INK } = {}) {
  const font = options.bold ? pen.bold : pen.font;
  const width = font.widthOfTextAtSize(safe(value), size);
  text(pen, value, right - width, size, options);
}

function rule(pen: Pen, color = RULE) {
  pen.page.drawLine({
    start: { x: MARGIN, y: pen.y },
    end: { x: PAGE[0] - MARGIN, y: pen.y },
    thickness: 0.7,
    color,
  });
}

/** Recorta un texto al ancho disponible. */
function fit(font: PDFFont, value: string, size: number, width: number): string {
  let out = safe(value);
  if (font.widthOfTextAtSize(out, size) <= width) return out;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1);
  return `${out}...`;
}

const COL = {
  date: MARGIN,
  item: MARGIN + 82,
  qty: PAGE[0] - MARGIN - 170,
  unit: PAGE[0] - MARGIN - 80,
  amount: PAGE[0] - MARGIN,
};

function tableHeader(pen: Pen) {
  text(pen, "Date", COL.date, 9, { bold: true, color: MUTED });
  text(pen, "Item", COL.item, 9, { bold: true, color: MUTED });
  textRight(pen, "Quantity", COL.qty, 9, { bold: true, color: MUTED });
  textRight(pen, "Unit price", COL.unit, 9, { bold: true, color: MUTED });
  textRight(pen, "Amount", COL.amount, 9, { bold: true, color: MUTED });
  pen.y -= 8;
  rule(pen);
  pen.y -= 15;
}

function ensureSpace(pen: Pen, needed: number, header = false) {
  if (pen.y - needed > MARGIN + 30) return;
  pen.page = pen.pdf.addPage(PAGE);
  pen.y = PAGE[1] - MARGIN;
  if (header) tableHeader(pen);
}

export async function proformaPdf(data: ProformaData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Pro forma invoice - ${data.cruise} - Cabin ${data.cabin}`);
  pdf.setProducer("Treasure of Galapagos");
  const pen: Pen = {
    pdf,
    page: pdf.addPage(PAGE),
    y: PAGE[1] - MARGIN,
    font: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  text(pen, "TREASURE OF GALAPAGOS", MARGIN, 9, { bold: true, color: NAVY });
  textRight(pen, "Currency: USD", COL.amount, 9, { color: MUTED });
  pen.y -= 26;
  text(pen, "Pro forma invoice", MARGIN, 22, { bold: true, color: NAVY });
  pen.y -= 16;
  text(pen, "Not a tax invoice. Not a payment receipt.", MARGIN, 9.5, { color: MUTED });
  pen.y -= 26;

  const meta: Array<[string, string]> = [
    ["Cruise", data.route ? `${data.cruise} · ${data.route}` : data.cruise],
    ["Cabin", String(data.cabin)],
    ["Bill to", data.billTo],
    ["Date", dateEn(data.date, true)],
  ];
  for (const [label, value] of meta) {
    text(pen, label, MARGIN, 10, { bold: true, color: MUTED });
    text(pen, fit(pen.font, value, 10.5, PAGE[0] - 2 * MARGIN - 70), MARGIN + 70, 10.5);
    pen.y -= 16;
  }
  pen.y -= 12;

  tableHeader(pen);
  if (!data.lines.length) {
    text(pen, "No items recorded.", COL.item, 10, { color: MUTED });
    pen.y -= 16;
  }
  for (const line of data.lines) {
    ensureSpace(pen, 18, true);
    const item = line.complimentary ? `${line.item} (complimentary)` : line.item;
    text(pen, dateEn(line.date), COL.date, 9.5, { color: MUTED });
    text(pen, fit(pen.font, item, 10, COL.qty - COL.item - 60), COL.item, 10);
    textRight(pen, String(line.quantity), COL.qty, 10);
    textRight(pen, usd(line.unitPrice), COL.unit, 10);
    textRight(pen, usd(line.amount), COL.amount, 10);
    pen.y -= 17;
  }
  pen.y += 5;
  rule(pen);
  pen.y -= 20;

  ensureSpace(pen, 120 + data.payments.length * 16);
  const labelX = COL.qty - 60;
  text(pen, "Total", labelX, 11, { bold: true });
  textRight(pen, usd(data.total), COL.amount, 11, { bold: true });
  pen.y -= 16;
  if (data.complimentary > 0) {
    text(pen, "Complimentary items (not charged)", labelX, 9, { color: MUTED });
    textRight(pen, usd(data.complimentary), COL.amount, 9, { color: MUTED });
    pen.y -= 16;
  }

  text(pen, "Payments received", labelX, 10.5, { bold: true });
  textRight(pen, usd(data.paid), COL.amount, 10.5);
  pen.y -= 15;
  for (const p of data.payments) {
    text(pen, `${dateEn(p.date)} · ${p.method}`, labelX + 10, 9, { color: MUTED });
    textRight(pen, usd(p.amount), COL.amount, 9, { color: MUTED });
    pen.y -= 13;
  }
  pen.y -= 4;
  pen.page.drawLine({
    start: { x: labelX, y: pen.y + 8 },
    end: { x: COL.amount, y: pen.y + 8 },
    thickness: 0.7,
    color: RULE,
  });
  pen.y -= 8;
  text(pen, "Balance due", labelX, 12, { bold: true, color: NAVY });
  textRight(pen, usd(data.balance), COL.amount, 12, { bold: true, color: NAVY });

  // Pie en cada página.
  for (const page of pdf.getPages()) {
    page.drawText(safe("Pro forma invoice · Currency: USD · Not a tax invoice. Not a payment receipt."), {
      x: MARGIN,
      y: MARGIN - 12,
      size: 8,
      font: pen.font,
      color: MUTED,
    });
  }
  return pdf.save();
}

export function proformaFileName(data: Pick<ProformaData, "cruise" | "cabin">): string {
  const cruise = data.cruise.replace(/[^A-Za-z0-9-]+/g, "_");
  return `proforma-${cruise}-cabin-${data.cabin}.pdf`;
}

