import { Types } from "mongoose";
import { env } from "../config/env";
import { Account } from "../models/account.model";
import { Cruise } from "../models/cruise.model";
import { Payment } from "../models/payment.model";
import { AuthPayload } from "../middlewares/auth.middleware";
import { isValidOptionalEmail } from "../utils/email";
import { logEvent } from "./audit.service";
import { MailOptions, mailerConfigured, sendMail } from "./mailer.service";
import { ProformaData, dateEn, proformaData, proformaFileName, proformaPdf, usd } from "./proforma.service";

/**
 * Resumen de la cuenta al pagador cuando la cuenta queda pagada (saldo 0).
 *
 * - Sale de los mismos datos que la prefactura (proformaData) para que el
 *   correo, el PDF adjunto, la prefactura y el QR coincidan.
 * - Nunca rompe el cobro: si no hay correo, Resend no está configurado o
 *   falla, queda "Correo no enviado: {causa}" en el historial y en la
 *   bitácora, y Dirección o Gerencia lo reenvían desde la cuenta.
 * - Idempotente: el envío automático ocurre una sola vez por liquidación
 *   (estado guardado en el pago que liquida); un reenvío manual toma un
 *   bloqueo atómico para que un doble clic no envíe dos correos.
 * - No es factura: la factura autorizada sale en otro correo (sendInvoiceEmail).
 */

type Transport = (options: MailOptions) => Promise<{ id: string }>;

let transport: Transport | null = null;

/** Pruebas y ensayo: reemplaza el envío real. Con null vuelve a Resend. */
export function setMailTransport(next: Transport | null) {
  transport = next;
}

function canSend(): boolean {
  return transport !== null || mailerConfigured();
}

const STALE_LOCK_MS = 2 * 60 * 1000;

const valid = (email?: string | null) => {
  const value = (email ?? "").trim();
  return value && isValidOptionalEmail(value) ? value : "";
};

/** Correo de facturación del pago o, si no, el del pagador de la cabina. */
export async function summaryRecipient(payment: {
  cruise: Types.ObjectId | string;
  cabinNumber: number;
  billing?: { email?: string };
}): Promise<string> {
  const typed = valid(payment.billing?.email);
  if (typed) return typed;
  const cruise = await Cruise.findById(payment.cruise).select("cabins");
  const cabin = cruise?.cabins.find((c) => c.number === payment.cabinNumber);
  const payer = cabin?.passengers.find((p) => p.isPayer) ?? cabin?.passengers[0];
  return valid(payer?.email);
}

// ---- HTML (tablas y estilos en línea para los clientes de correo) ----

const C = {
  navy: "#1b3142",
  navy2: "#27445a",
  powder: "#e6eef4",
  cream: "#f3f7fa",
  rule: "#d9e4ec",
  ink: "#1b2b25",
  muted: "#4a5862",
};
const SERIF = "'Cardo', Georgia, 'Times New Roman', serif";
const SANS = "'Geist', 'Helvetica Neue', Helvetica, Arial, sans-serif";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const SUMMARY_NOTE =
  "This is a summary of your onboard account, not a tax invoice. Your electronic invoice will arrive in a separate email once it is authorized by the SRI.";

export function summarySubject(data: Pick<ProformaData, "cabin">): string {
  return `Your onboard account · Treasure of Galápagos · Cabin ${data.cabin}`;
}

function cruiseDates(data: ProformaData): string {
  if (!data.startDate) return "";
  if (!data.endDate) return dateEn(data.startDate);
  return `${dateEn(data.startDate)} – ${dateEn(data.endDate)}`;
}

export function summaryHtml(data: ProformaData): string {
  const seal = `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/brand/seal-pine.png`;
  const td = (content: string, style = "") =>
    `<td style="padding:8px 0;border-bottom:1px solid ${C.rule};font-family:${SANS};font-size:14px;color:${C.ink};${style}">${content}</td>`;
  const meta: Array<[string, string]> = [
    ["Cruise", data.route ? `${data.cruise} · ${data.route}` : data.cruise],
    ["Cabin", String(data.cabin)],
  ];
  const dates = cruiseDates(data);
  if (dates) meta.push(["Dates", dates]);

  const items = data.lines.length
    ? data.lines
        .map((line) => {
          const name = line.complimentary
            ? `${esc(line.item)} <span style="color:${C.muted};font-size:12px">(complimentary)</span>`
            : esc(line.item);
          return `<tr>${td(
            `${name}<br><span style="color:${C.muted};font-size:12px">${esc(dateEn(line.date))}</span>`,
          )}${td(String(line.quantity), "text-align:right;white-space:nowrap;padding-left:12px")}${td(
            usd(line.amount),
            "text-align:right;white-space:nowrap;padding-left:12px",
          )}</tr>`;
        })
        .join("")
    : `<tr>${td(`<span style="color:${C.muted}">No items recorded.</span>`)}${td("")}${td("")}</tr>`;

  const payments = data.payments
    .map(
      (p) =>
        `<tr><td style="padding:4px 0;font-family:${SANS};font-size:13px;color:${C.muted}">${esc(
          `${dateEn(p.date)} · ${p.method}`,
        )}</td><td style="padding:4px 0;font-family:${SANS};font-size:13px;color:${C.muted};text-align:right;white-space:nowrap">${usd(
          p.amount,
        )}</td></tr>`,
    )
    .join("");

  const sumRow = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:6px 0;font-family:${SANS};font-size:${strong ? 16 : 14}px;color:${
      strong ? C.navy : C.ink
    };font-weight:${strong ? 700 : 600}">${label}</td><td style="padding:6px 0;font-family:${SANS};font-size:${
      strong ? 16 : 14
    }px;color:${strong ? C.navy : C.ink};font-weight:${strong ? 700 : 600};text-align:right;white-space:nowrap">${value}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(summarySubject(data))}</title>
</head>
<body style="margin:0;padding:0;background:${C.cream}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;border:1px solid ${C.rule}">
<tr><td style="background:${C.navy};border-radius:14px 14px 0 0;padding:24px 28px" align="left">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:14px;vertical-align:middle"><img src="${esc(seal)}" width="52" height="52" alt="Treasure of Galápagos" style="display:block;border:0;border-radius:50%;background:${C.powder}"></td>
<td style="vertical-align:middle;font-family:${SERIF};font-size:22px;color:#ffffff">Treasure of Galápagos</td>
</tr></table>
</td></tr>
<tr><td style="padding:28px 28px 8px" align="left">
<h1 style="margin:0 0 12px;font-family:${SERIF};font-size:26px;font-weight:700;color:${C.navy}">Your onboard account</h1>
<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink}">Dear ${esc(data.billTo)},</p>
<p style="margin:0 0 20px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink}">Thank you for sailing with us. Here is the summary of your onboard bar account. A PDF copy is attached.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.powder};border-radius:10px">
${meta
  .map(
    ([label, value]) =>
      `<tr><td style="padding:8px 14px;font-family:${SANS};font-size:13px;color:${C.muted};width:90px">${label}</td><td style="padding:8px 14px;font-family:${SANS};font-size:14px;color:${C.ink};font-weight:600">${esc(value)}</td></tr>`,
  )
  .join("")}
</table>
</td></tr>
<tr><td style="padding:16px 28px 0" align="left">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr>
<th align="left" style="padding:6px 0;border-bottom:2px solid ${C.navy2};font-family:${SANS};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em">Item</th>
<th align="right" style="padding:6px 0 6px 12px;border-bottom:2px solid ${C.navy2};font-family:${SANS};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em">Qty</th>
<th align="right" style="padding:6px 0 6px 12px;border-bottom:2px solid ${C.navy2};font-family:${SANS};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em">Amount</th>
</tr>
${items}
</table>
</td></tr>
<tr><td style="padding:12px 28px 0" align="left">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${sumRow("Total", usd(data.total))}
${data.complimentary > 0 ? `<tr><td style="padding:2px 0;font-family:${SANS};font-size:13px;color:${C.muted}">Complimentary items (not charged)</td><td style="padding:2px 0;font-family:${SANS};font-size:13px;color:${C.muted};text-align:right">${usd(data.complimentary)}</td></tr>` : ""}
${sumRow("Payments received", usd(data.paid))}
${payments}
<tr><td colspan="2" style="padding:6px 0 0;border-bottom:1px solid ${C.rule}"></td></tr>
${sumRow("Balance due", usd(data.balance), true)}
</table>
</td></tr>
<tr><td style="padding:20px 28px 28px" align="left">
<p style="margin:0;padding:14px 16px;background:${C.cream};border-left:3px solid ${C.navy2};border-radius:6px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted}">${esc(SUMMARY_NOTE)}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${SANS};font-size:12px;color:${C.muted}">Treasure of Galápagos · Galápagos, Ecuador</p>
</td></tr>
</table>
</body>
</html>`;
}

export function summaryText(data: ProformaData): string {
  const lines = [
    `Dear ${data.billTo},`,
    "",
    "Here is the summary of your onboard bar account.",
    "",
    `Cruise: ${data.route ? `${data.cruise} · ${data.route}` : data.cruise}`,
    `Cabin: ${data.cabin}`,
    ...(cruiseDates(data) ? [`Dates: ${cruiseDates(data)}`] : []),
    "",
    ...data.lines.map(
      (l) => `${l.quantity} x ${l.item}${l.complimentary ? " (complimentary)" : ""}  ${usd(l.amount)}`,
    ),
    "",
    `Total: ${usd(data.total)}`,
    `Payments received: ${usd(data.paid)}`,
    ...data.payments.map((p) => `  ${dateEn(p.date)} · ${p.method}  ${usd(p.amount)}`),
    `Balance due: ${usd(data.balance)}`,
    "",
    SUMMARY_NOTE,
  ];
  return lines.join("\n");
}

// ---- Envío ----

export interface SummaryEmailResult {
  status: "enviado" | "error" | "omitido";
  to: string;
  error: string;
}

async function record(
  payment: { cruise: Types.ObjectId; cabinNumber: number; _id: Types.ObjectId },
  auth: AuthPayload | null | undefined,
  ok: boolean,
  text: string,
) {
  const account = await Account.findOne({ cruise: payment.cruise, cabinNumber: payment.cabinNumber });
  if (account) {
    account.history.push({
      action: ok ? "correo_enviado" : "correo_no_enviado",
      version: account.version,
      reason: text,
      by: auth?.sub ? new Types.ObjectId(auth.sub) : null,
      at: new Date(),
    });
    await account.save();
  }
  await logEvent(auth, {
    kind: "cobro",
    title: `${ok ? "Resumen enviado por correo" : "Correo no enviado"} · cabina ${payment.cabinNumber}`,
    detail: text,
    cruise: payment.cruise,
    cabinNumber: payment.cabinNumber,
  });
}

/**
 * Envía el resumen de la cuenta pagada. `manual`: reenvío pedido desde la
 * cuenta; si no, es el envío automático al liquidar (una sola vez).
 */
export async function sendAccountSummary(
  paymentId: Types.ObjectId | string,
  auth: AuthPayload | null | undefined,
  manual = false,
): Promise<SummaryEmailResult> {
  const stale = new Date(Date.now() - STALE_LOCK_MS);
  const base = { _id: paymentId, status: "vigente", settled: { $ne: false } };
  const filter = manual
    ? {
        ...base,
        $or: [
          { "summaryEmail.status": { $ne: "enviando" } },
          { "summaryEmail.status": "enviando", updatedAt: { $lt: stale } },
        ],
      }
    : { ...base, "summaryEmail.status": "no_aplica", "summaryEmail.attempts": 0 };

  const payment = await Payment.findOneAndUpdate(
    filter,
    { $set: { "summaryEmail.status": "enviando" }, $inc: { "summaryEmail.attempts": 1 } },
    { new: true },
  );
  if (!payment) return { status: "omitido", to: "", error: "" };

  const to = await summaryRecipient(payment);
  let error = "";
  if (!to) error = "no se ingresó correo";
  else if (!canSend()) error = "el envío de correos no está configurado";

  if (!error) {
    try {
      const data = await proformaData(payment.cruise.toString(), payment.cabinNumber);
      const pdf = await proformaPdf(data);
      const options: MailOptions = {
        to,
        subject: summarySubject(data),
        html: summaryHtml(data),
        text: summaryText(data),
        attachments: [{ filename: proformaFileName(data), content: Buffer.from(pdf) }],
      };
      await (transport ?? sendMail)(options);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        "summaryEmail.status": error ? "error" : "enviado",
        "summaryEmail.to": to,
        "summaryEmail.error": error,
        ...(error ? {} : { "summaryEmail.sentAt": new Date() }),
      },
    },
  );
  await record(
    payment,
    auth,
    !error,
    error ? `Correo no enviado: ${error}` : `Resumen enviado a ${to}`,
  );
  return { status: error ? "error" : "enviado", to, error };
}

// ---- Factura electrónica por correo (pedido del cliente, 12-nov-2026) ----

export interface InvoiceEmailData {
  billTo: string;
  invoiceNumber: string;
  cruise: string;
  cabin: number;
  total: number;
  pdfUrl: string;
  /** Número y fecha de autorización del SRI (12-nov-2026). */
  authNumber?: string;
  authDate?: string;
}

export function invoiceSubject(data: Pick<InvoiceEmailData, "invoiceNumber">): string {
  return `Your electronic invoice ${data.invoiceNumber} · Treasure of Galápagos`;
}

/** Mismo encabezado, colores y sello que el resumen de la cuenta. */
export function invoiceHtml(data: InvoiceEmailData): string {
  const seal = `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/brand/seal-pine.png`;
  const row = (label: string, value: string) =>
    `<tr><td style="padding:8px 14px;font-family:${SANS};font-size:13px;color:${C.muted};width:120px">${label}</td><td style="padding:8px 14px;font-family:${SANS};font-size:14px;color:${C.ink};font-weight:600">${esc(value)}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(invoiceSubject(data))}</title>
</head>
<body style="margin:0;padding:0;background:${C.cream}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;border:1px solid ${C.rule}">
<tr><td style="background:${C.navy};border-radius:14px 14px 0 0;padding:24px 28px" align="left">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:14px;vertical-align:middle"><img src="${esc(seal)}" width="52" height="52" alt="Treasure of Galápagos" style="display:block;border:0;border-radius:50%;background:${C.powder}"></td>
<td style="vertical-align:middle;font-family:${SERIF};font-size:22px;color:#ffffff">Treasure of Galápagos</td>
</tr></table>
</td></tr>
<tr><td style="padding:28px 28px 8px" align="left">
<h1 style="margin:0 0 4px;font-family:${SERIF};font-size:26px;font-weight:700;color:${C.navy}">Your electronic invoice</h1>
<p style="margin:0 0 16px;font-family:${SERIF};font-size:17px;color:${C.muted}">Su factura electrónica</p>
<p style="margin:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink}">Dear ${esc(data.billTo)},</p>
<p style="margin:0 0 20px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink}">Thank you for sailing with us. Your electronic invoice has been authorized by the SRI (Ecuador's tax authority). The PDF and XML files are attached.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.powder};border-radius:10px">
${row("Invoice", data.invoiceNumber)}
${row("Cruise", data.cruise)}
${row("Cabin", String(data.cabin))}
${row("Total", usd(data.total))}
${data.authNumber ? row("SRI authorization", data.authNumber) : ""}
${data.authDate ? row("Authorized on", data.authDate) : ""}
</table>
</td></tr>
<tr><td style="padding:20px 28px 8px" align="left">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.navy};border-radius:8px">
<a href="${esc(data.pdfUrl)}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">View invoice (PDF)</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:16px 28px 28px" align="left">
<p style="margin:0;padding:14px 16px;background:${C.cream};border-left:3px solid ${C.navy2};border-radius:6px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted}">Factura electrónica autorizada por el SRI. Conserve este correo: el XML adjunto es el documento tributario válido.</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${SANS};font-size:12px;color:${C.muted}">Treasure of Galápagos · Galápagos, Ecuador</p>
</td></tr>
</table>
</body>
</html>`;
}

export function invoiceText(data: InvoiceEmailData): string {
  return [
    `Dear ${data.billTo},`,
    "",
    "Your electronic invoice has been authorized by the SRI. The PDF and XML files are attached.",
    "Su factura electrónica fue autorizada por el SRI. Adjuntamos el PDF y el XML.",
    "",
    `Invoice: ${data.invoiceNumber}`,
    `Cruise: ${data.cruise}`,
    `Cabin: ${data.cabin}`,
    `Total: ${usd(data.total)}`,
    ...(data.authNumber ? [`SRI authorization: ${data.authNumber}`] : []),
    ...(data.authDate ? [`Authorized on: ${data.authDate}`] : []),
    "",
    `PDF: ${data.pdfUrl}`,
  ].join("\n");
}

/**
 * Envía la factura autorizada al correo de facturación. Una sola vez
 * (bloqueo atómico); nunca rompe nada: el error queda en el pago y en la bitácora.
 */
export async function sendInvoiceEmail(
  paymentId: Types.ObjectId | string,
  files: { pdfUrl: string; xmlUrl: string; xml?: Buffer; authNumber?: string; authDate?: string },
  fetchFile: (url: string) => Promise<Buffer>,
): Promise<SummaryEmailResult> {
  const stale = new Date(Date.now() - STALE_LOCK_MS);
  const payment = await Payment.findOneAndUpdate(
    {
      _id: paymentId,
      status: "vigente",
      invoiceStatus: "emitida",
      $or: [
        { "invoiceEmail.status": { $in: ["no_aplica", null] } },
        { "invoiceEmail.status": { $exists: false } },
        { "invoiceEmail.status": "enviando", updatedAt: { $lt: stale } },
      ],
    },
    { $set: { "invoiceEmail.status": "enviando" }, $inc: { "invoiceEmail.attempts": 1 } },
    { new: true },
  );
  if (!payment) return { status: "omitido", to: "", error: "" };

  const to = await summaryRecipient(payment);
  let error = "";
  if (!to) error = "no se ingresó correo";
  else if (!canSend()) error = "el envío de correos no está configurado";

  if (!error) {
    try {
      const cruise = await Cruise.findById(payment.cruise).select("code name");
      const data: InvoiceEmailData = {
        billTo: payment.billing?.name || "guest",
        invoiceNumber: payment.invoiceNumber,
        cruise: cruise?.code || cruise?.name || "",
        cabin: payment.cabinNumber,
        total: payment.invoiceTotal ?? payment.total,
        pdfUrl: files.pdfUrl,
        authNumber: files.authNumber,
        authDate: files.authDate,
      };
      const attachments = [{ filename: `Factura-${payment.invoiceNumber}.pdf`, content: await fetchFile(files.pdfUrl) }];
      // El XML autorizado del SRI es el documento válido; si no llegó, el de Contífico.
      if (files.xml || files.xmlUrl) {
        attachments.push({
          filename: `Factura-${payment.invoiceNumber}.xml`,
          content: files.xml ?? (await fetchFile(files.xmlUrl)),
        });
      }
      await (transport ?? sendMail)({
        to,
        subject: invoiceSubject(data),
        html: invoiceHtml(data),
        text: invoiceText(data),
        attachments,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        "invoiceEmail.status": error ? "error" : "enviado",
        "invoiceEmail.to": to,
        "invoiceEmail.error": error,
        ...(error ? {} : { "invoiceEmail.sentAt": new Date() }),
      },
    },
  );
  await logEvent(null, {
    kind: "cobro",
    title: `${error ? "Factura no enviada por correo" : "Factura enviada por correo"} · cabina ${payment.cabinNumber}`,
    detail: error ? `${payment.invoiceNumber}: ${error}` : `${payment.invoiceNumber} a ${to}`,
    cruise: payment.cruise,
    cabinNumber: payment.cabinNumber,
  });
  return { status: error ? "error" : "enviado", to, error };
}
