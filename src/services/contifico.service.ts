import axios, { AxiosInstance } from "axios";
import mongoose, { Types } from "mongoose";
import { env } from "../config/env";
import { BillingLine, IPayment, Payment } from "../models/payment.model";
import { sendInvoiceEmail } from "./accountEmail.service";
import { chargeableQty, Order } from "../models/order.model";
import { IProduct } from "../models/product.model";
import { Cruise } from "../models/cruise.model";
import { commercialDateKey } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Facturación electrónica (SRI) con Contífico.
 *
 * - La API key de sincronización va en el header Authorization y el API
 *   token se envía como "pos" en cada documento.
 * - Treasure guarda los precios con IVA; Contífico los recibe sin IVA. El
 *   subtotal se cuadra al centavo para que la factura sume exactamente lo
 *   cobrado en el barco.
 * - Treasure es la fuente del inventario (descuenta en ml al entregar);
 *   Contífico solo recibe la venta.
 * - El número de factura lo reserva Treasure: toma el último emitido en la
 *   serie y lo incrementa de forma atómica en Mongo para que dos cobros
 *   simultáneos nunca usen el mismo número.
 */

/**
 * Una empresa de Contífico. El bar y los wetsuits son empresas distintas
 * (pedido del cliente, 14-nov-2026): cada cobro va a la de su línea, con su
 * key, su token, su serie y su numeración.
 */
export interface ContificoAccount {
  line: BillingLine;
  apiKey: string;
  token: string;
  serie: string;
  bankAccountId: string;
  cardProcessor: string;
  /** Producto por defecto: cóctel genérico (bar) o «Wetsuit» (wetsuits). */
  productId: string;
  /** Contador de numeración en Mongo (el del bar conserva su clave de siempre). */
  sequenceKey: string;
  http: AxiosInstance;
}

function makeAccount(line: BillingLine, cfg: Omit<ContificoAccount, "line" | "http">): ContificoAccount {
  const http = axios.create({ baseURL: env.CONTIFICO_BASE_URL, timeout: 25_000 });
  http.interceptors.request.use((config) => {
    config.headers.set("Authorization", cfg.apiKey);
    return config;
  });
  return { line, ...cfg, http };
}

const ACCOUNTS: Record<BillingLine, ContificoAccount> = {
  bar: makeAccount("bar", {
    apiKey: env.CONTIFICO_API_KEY,
    token: env.CONTIFICO_API_TOKEN,
    serie: env.CONTIFICO_SERIE,
    bankAccountId: env.CONTIFICO_BANK_ACCOUNT_ID,
    cardProcessor: env.CONTIFICO_CARD_PROCESSOR,
    productId: env.CONTIFICO_GENERIC_PRODUCT_ID,
    sequenceKey: env.CONTIFICO_SERIE,
  }),
  wetsuit: makeAccount("wetsuit", {
    apiKey: env.CONTIFICO_WETSUIT_API_KEY,
    token: env.CONTIFICO_WETSUIT_API_TOKEN,
    serie: env.CONTIFICO_WETSUIT_SERIE,
    bankAccountId: env.CONTIFICO_WETSUIT_BANK_ACCOUNT_ID,
    cardProcessor: env.CONTIFICO_WETSUIT_CARD_PROCESSOR,
    productId: env.CONTIFICO_WETSUIT_PRODUCT_ID,
    sequenceKey: `wetsuit:${env.CONTIFICO_WETSUIT_SERIE}`,
  }),
};

/** Empresa de Contífico de un cobro (los anteriores a la separación son del bar). */
export function contificoAccount(line?: string | null): ContificoAccount {
  return ACCOUNTS[line === "wetsuit" ? "wetsuit" : "bar"];
}

export function contificoConfigured(line?: string | null): boolean {
  const acc = contificoAccount(line);
  return Boolean(acc.apiKey && acc.token);
}

export interface ContificoProduct {
  id: string;
  codigo: string;
  nombre: string;
  pvp: number | null;
  iva: number;
  estado: string;
}

interface ContificoDocument {
  id: string;
  documento: string;
  tipo_registro: string;
  tipo_documento: string;
  adicional1?: string;
  url_ride?: string | null;
}

// ---- Catálogo de Contífico (con caché corta: cambia poco) ----

const productCache = new Map<BillingLine, { at: number; items: ContificoProduct[] }>();
const PRODUCT_CACHE_MS = 10 * 60 * 1000;

export async function contificoProducts(force = false, line: BillingLine = "bar"): Promise<ContificoProduct[]> {
  const cached = productCache.get(line);
  if (!force && cached && Date.now() - cached.at < PRODUCT_CACHE_MS) {
    return cached.items;
  }
  const { http } = contificoAccount(line);
  const items: ContificoProduct[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await http.get("/producto/", {
      params: { result_size: 500, result_page: page },
    });
    const rows = Array.isArray(data) ? data : [];
    for (const p of rows) {
      items.push({
        id: String(p.id),
        codigo: String(p.codigo ?? ""),
        nombre: String(p.nombre ?? ""),
        pvp: p.pvp1 === null || p.pvp1 === undefined ? null : Number(p.pvp1),
        iva: Number(p.porcentaje_iva ?? 0),
        estado: String(p.estado ?? "A"),
      });
    }
    if (rows.length < 500) break;
  }
  productCache.set(line, { at: Date.now(), items });
  return items;
}

// ---- Numeración ----

function toContificoDate(date: Date): string {
  const [y, m, d] = commercialDateKey(date).split("-");
  return `${d}/${m}/${y}`;
}

function sequenceOf(documento: string, serie: string): number | null {
  if (!documento.startsWith(`${serie}-`)) return null;
  const n = Number(documento.slice(serie.length + 1));
  return Number.isFinite(n) ? n : null;
}

/** Facturas de venta recientes de Contífico (para numerar y para no duplicar). */
async function recentSalesInvoices(acc: ContificoAccount, days: number): Promise<ContificoDocument[]> {
  const params: Record<string, string | number> = {
    tipo: "FAC",
    tipo_registro: "CLI",
    result_size: 500,
  };
  if (days > 0) {
    params.fecha_inicial = toContificoDate(new Date(Date.now() - days * 86_400_000));
    params.fecha_final = toContificoDate(new Date(Date.now() + 86_400_000));
  }
  const docs: ContificoDocument[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data } = await acc.http.get("/documento/", { params: { ...params, result_page: page } });
    const rows: ContificoDocument[] = Array.isArray(data) ? data : [];
    // Las facturas de proveedores también son FAC: solo cuentan las de venta.
    docs.push(...rows.filter((d) => d.tipo_documento === "FAC" && d.tipo_registro === "CLI"));
    if (rows.length < 500) break;
  }
  return docs;
}

const sequences = () => mongoose.connection.collection<{ _id: string; last: number }>("contificosequences");

/** Reserva el siguiente número de la serie de forma atómica. */
async function reserveNumber(acc: ContificoAccount, remoteDocs: ContificoDocument[]): Promise<string> {
  const serie = acc.serie;
  let remoteMax = 0;
  for (const d of remoteDocs) {
    const n = sequenceOf(d.documento ?? "", serie);
    if (n && n > remoteMax) remoteMax = n;
  }
  await sequences().updateOne({ _id: acc.sequenceKey }, { $max: { last: remoteMax } }, { upsert: true });
  const next = await sequences().findOneAndUpdate(
    { _id: acc.sequenceKey },
    { $inc: { last: 1 } },
    { returnDocument: "after" },
  );
  const n = next?.last ?? remoteMax + 1;
  return `${serie}-${String(n).padStart(9, "0")}`;
}

// ---- Armado de la factura ----

/** Cédula, RUC o pasaporte → cliente de Contífico. */
function buildClient(billing: IPayment["billing"]) {
  const id = billing.idNumber.replace(/\s|-/g, "");
  const base = {
    razon_social: billing.name.slice(0, 300),
    email: billing.email.slice(0, 50),
    telefonos: "",
    direccion: billing.country || "",
  };
  if (/^\d{13}$/.test(id)) {
    const juridica = id[2] === "9" || id[2] === "6";
    return {
      ...base,
      ruc: id,
      cedula: juridica ? null : id.slice(0, 10),
      tipo: juridica ? "J" : "N",
      es_extranjero: false,
    };
  }
  if (/^\d{10}$/.test(id)) {
    return { ...base, ruc: null, cedula: id, tipo: "N", es_extranjero: false };
  }
  // Pasajero extranjero: pasaporte.
  return { ...base, ruc: null, cedula: id.slice(0, 20), tipo: "N", es_extranjero: true };
}

interface DraftLine {
  productId: string;
  name: string;
  qty: number;
  gross: number;
  iva: number;
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Convierte las líneas con IVA en detalles sin IVA y cuadra el subtotal de
 * cada tarifa: el centavo de redondeo va a la línea más grande.
 */
function buildDetails(lines: DraftLine[]) {
  const byRate = new Map<number, DraftLine[]>();
  for (const line of lines) {
    const group = byRate.get(line.iva) ?? [];
    group.push(line);
    byRate.set(line.iva, group);
  }

  const detalles: Array<Record<string, unknown>> = [];
  let subtotal0 = 0;
  let subtotalTaxed = 0;
  let grossTotal = 0;

  for (const [rate, group] of byRate) {
    const factor = 1 + rate / 100;
    const gross = round2(group.reduce((s, l) => s + l.qty * l.gross, 0));
    grossTotal += gross;
    const subtotal = round2(gross / factor);
    const bases = group.map((l) => round2((l.qty * l.gross) / factor));
    const residual = round2(subtotal - bases.reduce((s, b) => s + b, 0));
    if (residual !== 0) {
      const biggest = bases.indexOf(Math.max(...bases));
      bases[biggest] = round2(bases[biggest] + residual);
    }
    group.forEach((l, i) => {
      detalles.push({
        producto_id: l.productId,
        descripcion: l.name,
        cantidad: l.qty,
        precio: round6(bases[i] / l.qty),
        porcentaje_iva: rate,
        porcentaje_descuento: 0,
        base_cero: rate === 0 ? bases[i] : 0,
        base_gravable: rate === 0 ? 0 : bases[i],
        base_no_gravable: 0,
      });
    });
    if (rate === 0) subtotal0 += subtotal;
    else subtotalTaxed += subtotal;
  }

  grossTotal = round2(grossTotal);
  subtotal0 = round2(subtotal0);
  subtotalTaxed = round2(subtotalTaxed);
  return {
    detalles,
    subtotal0,
    subtotalTaxed,
    iva: round2(grossTotal - subtotal0 - subtotalTaxed),
    total: grossTotal,
  };
}

type CobroSource = Pick<IPayment, "method" | "reference" | "total" | "createdAt"> & { _id: Types.ObjectId };

/** Un pago del barco → cobro de Contífico, cuando se puede identificar. */
function cobroOf(payment: CobroSource, acc: ContificoAccount) {
  const fecha = toContificoDate(payment.createdAt ?? new Date());
  const monto = round2(payment.total);
  if (payment.method === "efectivo") return { forma_cobro: "EF", monto, fecha };
  if (payment.method === "transferencia" && acc.bankAccountId) {
    return {
      forma_cobro: "TRA",
      monto,
      fecha,
      cuenta_bancaria_id: acc.bankAccountId,
      numero_comprobante: (payment.reference || `TRE${payment._id.toString().slice(-12)}`).slice(0, 15),
    };
  }
  if ((payment.method === "tarjeta" || payment.method === "online") && acc.cardProcessor) {
    return { forma_cobro: "TC", monto, fecha, tipo_ping: acc.cardProcessor };
  }
  // Sin datos para identificar el cobro: esa parte queda por cobrar en Contífico.
  return null;
}

/**
 * Pagos que cubre la factura: el que liquidó la cuenta y sus pagos
 * parciales (uno por medio de pago). Un cobro antiguo es uno solo.
 */
async function invoicePayments(payment: IPayment & { _id: Types.ObjectId }): Promise<CobroSource[]> {
  // Formas de pago del mismo cobro y parciales que esta factura completa
  // (las partes por porcentaje tienen su propia factura).
  const group = await Payment.find({
    status: "vigente",
    $or: [{ group: payment._id }, { settledBy: payment._id, part: { $ne: true }, group: { $ne: payment._id } }],
  })
    .select("method reference total createdAt")
    .sort({ createdAt: 1 });
  return group.length ? group : [payment];
}

/** Cobros de la factura: uno por cada pago identificable de la liquidación. */
export async function invoiceCobros(payment: IPayment & { _id: Types.ObjectId }) {
  const acc = contificoAccount(payment.line);
  return (await invoicePayments(payment)).map((p) => cobroOf(p, acc)).filter((c) => c !== null);
}

/** Importe de la factura: el total de la cuenta liquidada (todos sus pagos). */
export function invoiceAmount(payment: Pick<IPayment, "total" | "accountTotal"> & { invoiceTotal?: number | null }): number {
  return payment.invoiceTotal ?? payment.accountTotal ?? payment.total;
}

async function invoiceLines(payment: IPayment, acc: ContificoAccount): Promise<DraftLine[]> {
  const orders = await Order.find({ _id: { $in: payment.orders } }).populate<{
    items: Array<{ product: IProduct & { _id: Types.ObjectId } }>;
  }>("items.product", "name contificoId");
  const products = await contificoProducts(false, acc.line);
  const catalog = new Map(products.map((p) => [p.id, p]));
  // Bar: cócteles creados en el bar → genérico configurado o "CAUTOR" (Cóctel de autor).
  // Wetsuits: el producto configurado o el que se llame «Wetsuit» en su empresa.
  const generic =
    acc.productId ||
    products.find((p) =>
      p.estado === "A" && (acc.line === "wetsuit" ? /wetsuit/i.test(p.nombre) : p.codigo === "CAUTOR"),
    )?.id ||
    "";

  const lines: DraftLine[] = [];
  const unlinked = new Set<string>();
  for (const order of orders) {
    for (const raw of order.items) {
      const item = raw as unknown as Parameters<typeof chargeableQty>[0] & {
        product: { name?: string; contificoId?: string } | null;
      };
      const qty = chargeableQty(item);
      if (item.courtesy || qty <= 0) continue;

      let productId = item.product?.contificoId || "";
      if (productId && !catalog.has(productId)) productId = "";
      if (!productId) productId = generic;
      if (!productId || !catalog.has(productId)) {
        unlinked.add(item.name);
        continue;
      }

      const iva = catalog.get(productId)!.iva;
      const same = lines.find(
        (l) => l.productId === productId && l.gross === item.unitPrice && l.name === item.name,
      );
      if (same) same.qty += qty;
      else lines.push({ productId, name: item.name, qty, gross: item.unitPrice, iva });
    }
  }

  if (unlinked.size) {
    throw new Error(
      acc.line === "wetsuit"
        ? `El Contífico de wetsuits no tiene el producto «Wetsuit» (${[...unlinked].join(", ")}). Créalo allí y reintenta.`
        : `Productos sin vincular con Contífico: ${[...unlinked].join(", ")}. Vincúlalos en Catálogo y reintenta.`,
    );
  }
  return prorate(lines, payment.share ?? 1, invoiceAmount(payment));
}

/**
 * Cuenta dividida en porcentaje: cada línea a su parte del precio; el
 * centavo de diferencia va a la línea más grande para que cuadre exacto.
 */
function prorate(lines: DraftLine[], share: number, expected: number): DraftLine[] {
  if (!(share > 0) || share >= 1 || !lines.length) return lines;
  const out = lines.map((l) => ({ ...l, gross: round6(l.gross * share) }));
  const diff = round2(expected - out.reduce((s, l) => s + l.qty * l.gross, 0));
  if (diff !== 0) {
    const biggest = out.reduce((b, l) => (l.qty * l.gross > b.qty * b.gross ? l : b), out[0]!);
    biggest.gross = round6(biggest.gross + diff / biggest.qty);
  }
  return out;
}

function errorText(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data;
    if (data && typeof data === "object") return JSON.stringify(data);
    if (typeof data === "string" && data.length < 300) return data;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const DUPLICATE_NUMBER = /exist|duplic|secuen|registrad/i;

export interface InvoiceResult {
  status: "emitida" | "pendiente" | "error";
  invoiceId: string;
  invoiceNumber: string;
  invoiceUrl: string;
  error: string;
}

/** Envía al SRI un documento ya creado (si falla, Contífico lo reintenta cada hora). */
async function sendToSri(acc: ContificoAccount, documentId: string) {
  try {
    await acc.http.put(`/documento/${documentId}/sri/`);
  } catch {
    // El script horario de Contífico lo envía igual.
  }
}

async function emitInvoice(payment: IPayment & { _id: Types.ObjectId }): Promise<InvoiceResult> {
  const empty = { invoiceId: "", invoiceNumber: "", invoiceUrl: "" };
  const acc = contificoAccount(payment.line);
  if (!contificoConfigured(payment.line)) {
    // El pago ya quedó registrado; la factura espera (checklist 29-oct, L03).
    return {
      status: "pendiente",
      ...empty,
      error:
        acc.line === "wetsuit"
          ? "Falta configurar el Contífico de wetsuits (API key y token). Al configurarlo, reintenta."
          : "La facturación no está configurada.",
    };
  }

  // Ya existe en Contífico (un intento anterior llegó pero no respondió): solo se envía al SRI.
  if (payment.invoiceId) {
    await sendToSri(acc, payment.invoiceId);
    return {
      status: "emitida",
      invoiceId: payment.invoiceId,
      invoiceNumber: payment.invoiceNumber,
      invoiceUrl: payment.invoiceUrl,
      error: "",
    };
  }

  try {
    const lines = await invoiceLines(payment, acc);
    if (!lines.length) {
      return { status: "error", ...empty, error: "La cuenta no tiene consumos facturables" };
    }
    const totals = buildDetails(lines);
    const expected = invoiceAmount(payment);
    if (Math.abs(totals.total - expected) > 0.01) {
      return {
        status: "error",
        ...empty,
        error: `Los consumos suman ${totals.total} y el cobro ${expected}: revisa la cuenta`,
      };
    }

    const marker = `Treasure ${payment._id.toString()}`;
    let remote = await recentSalesInvoices(acc, 120);
    const previous = remote.find((d) => d.adicional1 === marker);
    if (previous) {
      await sendToSri(acc, previous.id);
      return {
        status: "emitida",
        invoiceId: previous.id,
        invoiceNumber: previous.documento,
        invoiceUrl: previous.url_ride ?? "",
        error: "",
      };
    }
    if (!remote.some((d) => sequenceOf(d.documento ?? "", acc.serie))) {
      remote = await recentSalesInvoices(acc, 0);
    }

    const cruise = await Cruise.findById(payment.cruise).select("code name");
    const body = {
      pos: acc.token,
      fecha_emision: toContificoDate(new Date()),
      tipo_documento: "FAC",
      documento: "",
      estado: "P",
      electronico: true,
      autorizacion: "",
      caja_id: null,
      cliente: buildClient(payment.billing),
      vendedor: null,
      descripcion: `${acc.line === "wetsuit" ? "Wetsuits" : "Consumos bar"} · ${cruise?.code || cruise?.name || "salida"} · ${
        payment.cabins?.length > 1 ? `cabinas ${payment.cabins.join(", ")}` : `cabina ${payment.cabinNumber}`
      }${payment.share < 1 ? ` · ${Math.round(payment.share * 100)}% de la cuenta` : ""}`,
      subtotal_0: totals.subtotal0,
      subtotal_12: totals.subtotalTaxed,
      iva: totals.iva,
      ice: 0,
      servicio: 0,
      total: totals.total,
      adicional1: marker,
      adicional2: "",
      detalles: totals.detalles,
      cobros: await invoiceCobros(payment),
    };

    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      body.documento = await reserveNumber(acc, remote);
      try {
        const { data } = await acc.http.post("/documento/", body);
        const id = String(data?.id ?? "");
        if (id) await sendToSri(acc, id);
        return {
          status: "emitida",
          invoiceId: id,
          invoiceNumber: String(data?.documento ?? body.documento),
          invoiceUrl: String(data?.url_ride ?? ""),
          error: "",
        };
      } catch (err) {
        lastError = errorText(err);
        const rejected = axios.isAxiosError(err) && err.response?.status === 400;
        // Número usado desde la web de Contífico: se toma el siguiente.
        if (rejected && DUPLICATE_NUMBER.test(lastError)) {
          remote = await recentSalesInvoices(acc, 120);
          continue;
        }
        break;
      }
    }
    return { status: "error", ...empty, error: lastError };
  } catch (err) {
    return { status: "error", ...empty, error: errorText(err) };
  }
}

const STALE_LOCK_MS = 2 * 60 * 1000;

/**
 * Emite la factura de un cobro una sola vez: marca "emitiendo" de forma
 * atómica (doble clic o dos tablets no facturan dos veces) y guarda el
 * resultado.
 */
export async function issueInvoice(paymentId: Types.ObjectId | string) {
  const payment = await Payment.findOneAndUpdate(
    {
      _id: paymentId,
      status: "vigente",
      $or: [
        { invoiceStatus: { $in: ["pendiente", "error"] } },
        { invoiceStatus: "emitiendo", updatedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
      ],
    },
    { $set: { invoiceStatus: "emitiendo" } },
    { new: true },
  );
  if (!payment) return Payment.findById(paymentId);

  const result = await emitInvoice(payment);
  payment.invoiceStatus = result.status;
  payment.invoiceId = result.invoiceId || payment.invoiceId;
  payment.invoiceNumber = result.invoiceNumber || payment.invoiceNumber;
  payment.invoiceUrl = result.invoiceUrl || payment.invoiceUrl;
  payment.invoiceError = result.error;
  await payment.save();
  return payment;
}

/**
 * Facturas emitidas que esperan al SRI (12-nov-2026): trae el PDF (RIDE) de
 * Contífico, que no llega al crearla, y cuando el SRI la autoriza («Autorizado»)
 * la envía por correo con Resend. Se llama al listar Cobros y en la tarea de cada hora.
 */
const SRI_RETRY_MS = 30 * 60 * 1000;

export async function syncInvoices(limit = 10) {
  if (!contificoConfigured("bar") && !contificoConfigured("wetsuit")) return 0;
  const waiting = await Payment.find({
    status: "vigente",
    invoiceStatus: "emitida",
    invoiceId: { $ne: "" },
    $or: [{ invoiceUrl: "" }, { "invoiceEmail.status": { $in: ["no_aplica", "enviando", null] } }, { invoiceEmail: { $exists: false } }],
  })
    .sort({ createdAt: -1 })
    .limit(limit);
  let sent = 0;
  for (const p of waiting) {
    try {
      if (!contificoConfigured(p.line)) continue;
      const acc = contificoAccount(p.line);
      const { data } = await acc.http.get(`/documento/${p.invoiceId}/`);
      const pdfUrl = String(data?.url_ride ?? "");
      if (pdfUrl && !p.invoiceUrl) await Payment.updateOne({ _id: p._id }, { $set: { invoiceUrl: pdfUrl } });
      // Ojo: `estado: "A"` del documento es «anulado». La autorización la da
      // GET /documento/<id>/estado/ → "Autorizado" (contifico.github.io, documento electrónico).
      const sri = data?.anulado ? null : (await acc.http.get(`/documento/${p.invoiceId}/estado/`)).data;
      const sriStatus = data?.anulado ? "Anulada" : String(sri?.estado ?? "");
      if (sriStatus && sriStatus !== p.invoiceSriStatus) {
        await Payment.updateOne({ _id: p._id }, { $set: { invoiceSriStatus: sriStatus } });
      }
      // Atascada antes del SRI (Firmado o sin firmar): se le vuelve a pedir a
      // Contífico que la envíe, a lo más cada 30 min (12-nov-2026).
      const stuck = sriStatus === "Firmado" || sriStatus === "No se ha firmado";
      if (stuck && (!p.invoiceSriRetryAt || Date.now() - p.invoiceSriRetryAt.getTime() > SRI_RETRY_MS)) {
        await sendToSri(acc, p.invoiceId);
        await Payment.updateOne({ _id: p._id }, { $set: { invoiceSriRetryAt: new Date() } });
      }
      // Contífico tarda en marcar «Autorizado»: con «Enviado Sri» se le pregunta directo al SRI.
      const xmlUrl = String(data?.url_xml ?? "");
      const auth =
        (sriStatus === "Autorizado" || /^enviado sri$/i.test(sriStatus)) && xmlUrl ? await sriAuthorization(xmlUrl) : null;
      if (auth && sriStatus !== "Autorizado") {
        await Payment.updateOne({ _id: p._id }, { $set: { invoiceSriStatus: "Autorizado" } });
      }
      if ((auth || sriStatus === "Autorizado") && pdfUrl) {
        const result = await sendInvoiceEmail(
          p._id,
          { pdfUrl, xmlUrl, xml: auth?.xml, authNumber: auth?.number, authDate: auth?.date },
          downloadFile,
        );
        if (result.status === "enviado") sent++;
      }
    } catch {
      // Sin respuesta de Contífico: se intenta en la próxima revisión.
    }
  }
  return sent;
}

const SRI_AUTH_URL = "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline";

/**
 * Autorización consultada al SRI (servicio público de comprobantes electrónicos)
 * con la clave de acceso del XML de Contífico. null si no está AUTORIZADO.
 */
export async function sriAuthorization(xmlUrl: string): Promise<{ number: string; date: string; xml: Buffer } | null> {
  const xml = (await downloadFile(xmlUrl)).toString("utf8");
  const clave = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xml)?.[1];
  if (!clave) return null;
  const envelope =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">' +
    `<soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${clave}</claveAccesoComprobante>` +
    "</ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>";
  const { data } = await axios.post<string>(SRI_AUTH_URL, envelope, {
    headers: { "Content-Type": "text/xml;charset=UTF-8" },
    responseType: "text",
    timeout: 30_000,
  });
  const block = /<autorizacion>[\s\S]*?<\/autorizacion>/.exec(data)?.[0] ?? "";
  if (!/<estado>AUTORIZADO<\/estado>/.test(block)) return null;
  const number = /<numeroAutorizacion>([^<]+)<\/numeroAutorizacion>/.exec(block)?.[1] ?? clave;
  const date = /<fechaAutorizacion>([^<]+)<\/fechaAutorizacion>/.exec(block)?.[1] ?? "";
  return { number, date, xml: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${block}`, "utf8") };
}

async function downloadFile(url: string): Promise<Buffer> {
  const { data } = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 20_000 });
  return Buffer.from(data);
}

/** Estado de la integración para la pantalla de administración. */
export async function contificoStatus() {
  if (!contificoConfigured()) {
    return {
      configured: false,
      serie: env.CONTIFICO_SERIE,
      wetsuitConfigured: contificoConfigured("wetsuit"),
      products: [] as ContificoProduct[],
    };
  }
  const products = await contificoProducts();
  return {
    configured: true,
    serie: env.CONTIFICO_SERIE,
    transfersLinked: Boolean(env.CONTIFICO_BANK_ACCOUNT_ID),
    cardProcessor: env.CONTIFICO_CARD_PROCESSOR,
    genericProduct: env.CONTIFICO_GENERIC_PRODUCT_ID,
    wetsuitConfigured: contificoConfigured("wetsuit"),
    products: products.filter((p) => p.estado === "A"),
  };
}
