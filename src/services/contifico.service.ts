import axios from "axios";
import mongoose, { Types } from "mongoose";
import { env } from "../config/env";
import { IPayment, Payment } from "../models/payment.model";
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

const http = axios.create({ baseURL: env.CONTIFICO_BASE_URL, timeout: 25_000 });
http.interceptors.request.use((config) => {
  config.headers.set("Authorization", env.CONTIFICO_API_KEY);
  return config;
});

export function contificoConfigured(): boolean {
  return Boolean(env.CONTIFICO_API_KEY && env.CONTIFICO_API_TOKEN);
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

let productCache: { at: number; items: ContificoProduct[] } | null = null;
const PRODUCT_CACHE_MS = 10 * 60 * 1000;

export async function contificoProducts(force = false): Promise<ContificoProduct[]> {
  if (!force && productCache && Date.now() - productCache.at < PRODUCT_CACHE_MS) {
    return productCache.items;
  }
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
  productCache = { at: Date.now(), items };
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
async function recentSalesInvoices(days: number): Promise<ContificoDocument[]> {
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
    const { data } = await http.get("/documento/", { params: { ...params, result_page: page } });
    const rows: ContificoDocument[] = Array.isArray(data) ? data : [];
    // Las facturas de proveedores también son FAC: solo cuentan las de venta.
    docs.push(...rows.filter((d) => d.tipo_documento === "FAC" && d.tipo_registro === "CLI"));
    if (rows.length < 500) break;
  }
  return docs;
}

const sequences = () => mongoose.connection.collection<{ _id: string; last: number }>("contificosequences");

/** Reserva el siguiente número de la serie de forma atómica. */
async function reserveNumber(serie: string, remoteDocs: ContificoDocument[]): Promise<string> {
  let remoteMax = 0;
  for (const d of remoteDocs) {
    const n = sequenceOf(d.documento ?? "", serie);
    if (n && n > remoteMax) remoteMax = n;
  }
  await sequences().updateOne({ _id: serie }, { $max: { last: remoteMax } }, { upsert: true });
  const next = await sequences().findOneAndUpdate(
    { _id: serie },
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
function cobroOf(payment: CobroSource) {
  const fecha = toContificoDate(payment.createdAt ?? new Date());
  const monto = round2(payment.total);
  if (payment.method === "efectivo") return { forma_cobro: "EF", monto, fecha };
  if (payment.method === "transferencia" && env.CONTIFICO_BANK_ACCOUNT_ID) {
    return {
      forma_cobro: "TRA",
      monto,
      fecha,
      cuenta_bancaria_id: env.CONTIFICO_BANK_ACCOUNT_ID,
      numero_comprobante: (payment.reference || `TRE${payment._id.toString().slice(-12)}`).slice(0, 15),
    };
  }
  if ((payment.method === "tarjeta" || payment.method === "online") && env.CONTIFICO_CARD_PROCESSOR) {
    return { forma_cobro: "TC", monto, fecha, tipo_ping: env.CONTIFICO_CARD_PROCESSOR };
  }
  // Sin datos para identificar el cobro: esa parte queda por cobrar en Contífico.
  return null;
}

/**
 * Pagos que cubre la factura: el que liquidó la cuenta y sus pagos
 * parciales (uno por medio de pago). Un cobro antiguo es uno solo.
 */
async function invoicePayments(payment: IPayment & { _id: Types.ObjectId }): Promise<CobroSource[]> {
  const group = await Payment.find({ settledBy: payment._id, status: "vigente" })
    .select("method reference total createdAt")
    .sort({ createdAt: 1 });
  return group.length ? group : [payment];
}

/** Cobros de la factura: uno por cada pago identificable de la liquidación. */
export async function invoiceCobros(payment: IPayment & { _id: Types.ObjectId }) {
  return (await invoicePayments(payment)).map(cobroOf).filter((c) => c !== null);
}

/** Importe de la factura: el total de la cuenta liquidada (todos sus pagos). */
export function invoiceAmount(payment: Pick<IPayment, "total" | "accountTotal">): number {
  return payment.accountTotal ?? payment.total;
}

async function invoiceLines(payment: IPayment): Promise<DraftLine[]> {
  const orders = await Order.find({ _id: { $in: payment.orders } }).populate<{
    items: Array<{ product: IProduct & { _id: Types.ObjectId } }>;
  }>("items.product", "name contificoId");
  const products = await contificoProducts();
  const catalog = new Map(products.map((p) => [p.id, p]));
  // Cócteles creados en el bar: producto genérico configurado o "CAUTOR" (Cóctel de autor).
  const generic =
    env.CONTIFICO_GENERIC_PRODUCT_ID || products.find((p) => p.codigo === "CAUTOR" && p.estado === "A")?.id || "";

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
      `Productos sin vincular con Contífico: ${[...unlinked].join(", ")}. Vincúlalos en Catálogo y reintenta.`,
    );
  }
  return lines;
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
async function sendToSri(documentId: string) {
  try {
    await http.put(`/documento/${documentId}/sri/`);
  } catch {
    // El script horario de Contífico lo envía igual.
  }
}

async function emitInvoice(payment: IPayment & { _id: Types.ObjectId }): Promise<InvoiceResult> {
  const empty = { invoiceId: "", invoiceNumber: "", invoiceUrl: "" };
  if (!contificoConfigured()) {
    // El pago ya quedó registrado; la factura espera (checklist 29-oct, L03).
    return { status: "pendiente", ...empty, error: "La facturación no está configurada." };
  }

  // Ya existe en Contífico (un intento anterior llegó pero no respondió): solo se envía al SRI.
  if (payment.invoiceId) {
    await sendToSri(payment.invoiceId);
    return {
      status: "emitida",
      invoiceId: payment.invoiceId,
      invoiceNumber: payment.invoiceNumber,
      invoiceUrl: payment.invoiceUrl,
      error: "",
    };
  }

  try {
    const lines = await invoiceLines(payment);
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
    let remote = await recentSalesInvoices(120);
    const previous = remote.find((d) => d.adicional1 === marker);
    if (previous) {
      await sendToSri(previous.id);
      return {
        status: "emitida",
        invoiceId: previous.id,
        invoiceNumber: previous.documento,
        invoiceUrl: previous.url_ride ?? "",
        error: "",
      };
    }
    if (!remote.some((d) => sequenceOf(d.documento ?? "", env.CONTIFICO_SERIE))) {
      remote = await recentSalesInvoices(0);
    }

    const cruise = await Cruise.findById(payment.cruise).select("code name");
    const body = {
      pos: env.CONTIFICO_API_TOKEN,
      fecha_emision: toContificoDate(new Date()),
      tipo_documento: "FAC",
      documento: "",
      estado: "P",
      electronico: true,
      autorizacion: "",
      caja_id: null,
      cliente: buildClient(payment.billing),
      vendedor: null,
      descripcion: `Consumos bar · ${cruise?.code || cruise?.name || "salida"} · cabina ${payment.cabinNumber}`,
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
      body.documento = await reserveNumber(env.CONTIFICO_SERIE, remote);
      try {
        const { data } = await http.post("/documento/", body);
        const id = String(data?.id ?? "");
        if (id) await sendToSri(id);
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
          remote = await recentSalesInvoices(120);
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

/** Estado de la integración para la pantalla de administración. */
export async function contificoStatus() {
  if (!contificoConfigured()) {
    return { configured: false, serie: env.CONTIFICO_SERIE, products: [] as ContificoProduct[] };
  }
  const products = await contificoProducts();
  return {
    configured: true,
    serie: env.CONTIFICO_SERIE,
    transfersLinked: Boolean(env.CONTIFICO_BANK_ACCOUNT_ID),
    cardProcessor: env.CONTIFICO_CARD_PROCESSOR,
    genericProduct: env.CONTIFICO_GENERIC_PRODUCT_ID,
    products: products.filter((p) => p.estado === "A"),
  };
}
