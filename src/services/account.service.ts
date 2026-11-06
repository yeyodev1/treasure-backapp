import { Types } from "mongoose";
import { Account, AccountStatus, IAccount } from "../models/account.model";
import { chargeableQty, IOrder, Order, pendingQty } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { round2 } from "../utils/units";

export interface AccountLineItem {
  index: number;
  name: string;
  qty: number;
  deliveredQty: number;
  pendingQty: number;
  cancelledQty: number;
  annulledQty: number;
  chargeableQty: number;
  unitPrice: number;
  courtesy: boolean;
  courtesyKind?: string;
}

export interface AccountOrder {
  id: string;
  createdAt: Date;
  /** Trazabilidad: quién registró el pedido. */
  by: string;
  status: string;
  items: AccountLineItem[];
  total: number;
  /** Pasajero de la cabina que lo consumió (null = sin asignar). */
  consumerId: string | null;
  consumerName: string;
}

export interface AccountPayment {
  id: string;
  createdAt: Date;
  method: string;
  total: number;
  /** false: pago parcial de una cuenta que aún tiene saldo. */
  settled: boolean;
  /** Cobro al que pertenece (varias formas de pago = un cobro, una factura). */
  group: string | null;
  /** Parte por porcentaje con su propia factura. */
  part: boolean;
  /** Lleva la factura del cobro. */
  head: boolean;
  /** Quién pagó (datos de la factura). */
  payer: string;
  /** Cabinas cobradas juntas (en la cabeza del cobro). */
  cabins: number[];
  invoiceStatus: string;
  invoiceNumber: string;
  invoiceError: string;
  /** Resumen por correo (solo el pago que liquida la cuenta). */
  summaryEmail: { status: string; to: string; sentAt: Date | null; error: string };
}

export interface AccountSummary {
  cabinNumber: number;
  status: AccountStatus;
  version: number;
  approvedVersion: number | null;
  approvedTotal: number | null;
  /** Cobrar solo con la versión aprobada vigente. */
  readyToCollect: boolean;
  pendingDeliveries: number;
  pendingAnnulments: number;
  /** Consumos sin pago: son los que se revisan, aprueban y cobran. */
  orders: AccountOrder[];
  subtotal: number;
  courtesyTotal: number;
  /** Consumos abiertos (lo que se aprueba). El saldo es `due`. */
  total: number;
  /** Pagos parciales recibidos sobre los consumos abiertos. */
  partialPaid: number;
  /**
   * Consumos ya pagados: la cuenta pagada conserva sus productos e
   * historial (checklist 29-oct, 01).
   */
  paidOrders: AccountOrder[];
  payments: AccountPayment[];
  /**
   * Cuenta completa: consumos (sin cortesías) = pagado + por cobrar.
   * due = consumos abiertos − pagos parciales (nunca negativo).
   */
  consumed: number;
  paid: number;
  due: number;
  /** Cortesías de toda la cuenta (pagadas y abiertas). */
  courtesyAll: number;
  history: Array<{ action: string; version: number; reason: string; by: string; at: Date }>;
}

type CabinRef = { cruise: Types.ObjectId; cabinNumber: number };

async function continuesFromOf(ref: CabinRef): Promise<CabinRef | null> {
  const cruise = await Cruise.findById(ref.cruise).select("cabins.number cabins.continuesFrom").lean();
  const from = cruise?.cabins.find((c) => c.number === ref.cabinNumber)?.continuesFrom;
  return from ? { cruise: from.cruise, cabinNumber: from.cabinNumber } : null;
}

/**
 * Crucero unido: la cabina y las cabinas de cruceros anteriores de las que
 * continúa (A → B → C). Sus consumos y pagos forman una sola cuenta.
 */
export async function accountScope(cruiseId: Types.ObjectId | string, cabinNumber: number): Promise<CabinRef[]> {
  const scope: CabinRef[] = [];
  let ref: CabinRef | null = { cruise: new Types.ObjectId(String(cruiseId)), cabinNumber };
  // Tope de vueltas: un enlace mal hecho nunca deja la cuenta en un bucle.
  while (ref && scope.length < 6 && !scope.some((s) => s.cruise.equals(ref!.cruise) && s.cabinNumber === ref!.cabinNumber)) {
    scope.push(ref);
    ref = await continuesFromOf(ref);
  }
  return scope;
}

/** Cabinas de un crucero que siguen en otro: número de cabina → "B-006 · cabina 3". */
export async function continuesToOf(cruiseId: Types.ObjectId | string) {
  const next = await Cruise.find({ "cabins.continuesFrom.cruise": cruiseId })
    .select("code name cabins.number cabins.continuesFrom")
    .lean();
  const map = new Map<number, string>();
  for (const c of next) {
    for (const cabin of c.cabins) {
      if (cabin.continuesFrom?.cruise.equals(String(cruiseId))) {
        map.set(cabin.continuesFrom.cabinNumber, `${c.code || c.name} · cabina ${cabin.number}`);
      }
    }
  }
  return map;
}

/** Obtiene (o crea) la cuenta de una cabina en una salida. */
export async function ensureAccount(cruiseId: Types.ObjectId | string, cabinNumber: number) {
  const existing = await Account.findOne({ cruise: cruiseId, cabinNumber });
  if (existing) return existing;
  try {
    return await Account.create({
      cruise: cruiseId,
      cabinNumber,
      history: [{ action: "creada", version: 1, reason: "", by: null }],
    });
  } catch {
    // Otra petición la creó al mismo tiempo.
    return (await Account.findOne({ cruise: cruiseId, cabinNumber }))!;
  }
}

/**
 * Un cargo cambió (pedido nuevo, cancelación, anulación): sube la versión
 * y, si la cuenta estaba en revisión o aprobada, invalida la aprobación.
 */
export async function chargesChanged(
  cruiseId: Types.ObjectId | string,
  cabinNumber: number,
  userId: string | null,
  reason: string,
) {
  const account = await ensureAccount(cruiseId, cabinNumber);
  const nextVersion = account.version + 1;
  const wasReviewed = account.status === "en_revision" || account.status === "aprobada";

  const history: IAccount["history"] = [];
  if (wasReviewed) {
    history.push({
      action: "invalidada",
      version: nextVersion,
      reason: `Aprobación anulada: ${reason}`,
      by: userId ? new Types.ObjectId(userId) : null,
      at: new Date(),
    });
  }
  history.push({
    action: "cargo_cambiado",
    version: nextVersion,
    reason,
    by: userId ? new Types.ObjectId(userId) : null,
    at: new Date(),
  });

  account.version = nextVersion;
  if (account.status !== "abierta") {
    account.status = "abierta";
    account.approvedVersion = null;
    account.approvedTotal = null;
  }
  account.history.push(...history);
  await account.save();
  return account;
}

type PopulatedOrder = IOrder & { _id: Types.ObjectId };

/** Lo paga la agencia: va a su factura, nunca a la cuenta ni a la prefactura de la cabina. */
const isAgencyCourtesy = (item: { courtesy: boolean; courtesyKind?: string }) =>
  item.courtesy && item.courtesyKind === "agencia";

/** Líneas de un pedido con su estado de entrega y lo que sigue contando (sin las de agencia). */
function mapOrder(order: PopulatedOrder) {
  let total = 0;
  let courtesy = 0;
  let pending = 0;
  // Se filtra después de mapear: cada línea conserva su índice real en el pedido (correcciones).
  const items = order.items.map((item, index) => {
    if (isAgencyCourtesy(item)) return null;
    const live = chargeableQty(item);
    const waiting = pendingQty(item);
    pending += waiting;
    const line = live * item.unitPrice;
    if (item.courtesy) courtesy += line;
    else total += line;
    return {
      index,
      name: item.name,
      qty: item.qty,
      deliveredQty: item.deliveredQty,
      pendingQty: waiting,
      cancelledQty: item.cancelledQty,
      annulledQty: item.annulledQty,
      chargeableQty: live,
      unitPrice: item.unitPrice,
      courtesy: item.courtesy,
      courtesyKind: item.courtesy ? (item.courtesyKind ?? "casa") : undefined,
    };
  }).filter((i) => i !== null);
  return {
    order: {
      id: order._id.toString(),
      createdAt: order.createdAt as Date,
      by: (order.createdBy as unknown as { name?: string })?.name ?? "",
      status: order.status,
      items,
      total: round2(total),
      consumerId: order.consumer ? order.consumer.toString() : null,
      consumerName: order.consumer ? (order.consumerName ?? "") : "",
    },
    total,
    courtesy,
    pending,
  };
}

/**
 * Cuenta de una cabina: lo abierto (se revisa y se cobra) y lo ya pagado
 * con sus pagos, para que una cuenta pagada no aparezca vacía.
 */
export async function buildCabinAccount(
  cruiseId: Types.ObjectId | string,
  cabinNumber: number,
): Promise<AccountSummary> {
  const scope = await accountScope(cruiseId, cabinNumber);
  const [account, orders, payments] = await Promise.all([
    Account.findOne({ cruise: cruiseId, cabinNumber }).populate("history.by", "name"),
    Order.find({ $or: scope, status: { $nin: ["cancelada", "retenida"] } })
      .populate("createdBy", "name")
      .sort({ createdAt: 1 }),
    Payment.find({ $or: scope, status: "vigente" }).sort({ createdAt: 1 }),
  ]);

  let subtotal = 0;
  let courtesyTotal = 0;
  let paidTotal = 0;
  let courtesyAll = 0;
  let pendingDeliveries = 0;
  let pendingAnnulments = 0;
  const open: AccountOrder[] = [];
  const paidOrders: AccountOrder[] = [];

  for (const order of orders as PopulatedOrder[]) {
    const mapped = mapOrder(order);
    // Pedido solo de cortesías de agencia: no es de la cabina.
    if (!mapped.order.items.length) continue;
    courtesyAll += mapped.courtesy;
    if (order.payment) {
      paidTotal += mapped.total;
      paidOrders.push(mapped.order);
      continue;
    }
    pendingDeliveries += mapped.pending;
    pendingAnnulments += order.annulments.filter((a) => a.status === "pendiente").length;
    subtotal += mapped.total;
    courtesyTotal += mapped.courtesy;
    open.push(mapped.order);
  }

  const status = account?.status ?? "abierta";
  const version = account?.version ?? 1;
  const total = round2(subtotal);
  const paid = round2(payments.reduce((s, p) => s + p.total, 0));
  const partialPaid = round2(
    payments.filter((p) => p.settled === false).reduce((s, p) => s + p.total, 0),
  );

  return {
    cabinNumber,
    status,
    version,
    approvedVersion: account?.approvedVersion ?? null,
    approvedTotal: account?.approvedTotal ?? null,
    readyToCollect:
      status === "aprobada" &&
      account?.approvedVersion === version &&
      account?.approvedTotal === total &&
      pendingDeliveries === 0,
    pendingDeliveries,
    pendingAnnulments,
    orders: open,
    subtotal: total,
    courtesyTotal: round2(courtesyTotal),
    total,
    partialPaid,
    paidOrders,
    payments: payments.map((p) => ({
      id: p._id.toString(),
      createdAt: p.createdAt as Date,
      method: p.method,
      total: p.total,
      settled: p.settled !== false,
      group: p.group ? p.group.toString() : null,
      part: Boolean(p.part),
      head: !p.group || p.group.equals(p._id),
      payer: p.billing?.name ?? "",
      cabins: p.cabins ?? [],
      invoiceStatus: p.invoiceStatus,
      invoiceNumber: p.invoiceNumber,
      invoiceError: p.invoiceError,
      summaryEmail: {
        status: p.summaryEmail?.status ?? "no_aplica",
        to: p.summaryEmail?.to ?? "",
        sentAt: p.summaryEmail?.sentAt ?? null,
        error: p.summaryEmail?.error ?? "",
      },
    })),
    consumed: round2(paidTotal + subtotal),
    paid,
    due: round2(Math.max(0, total - partialPaid)),
    courtesyAll: round2(courtesyAll),
    history: (account?.history ?? []).map((h) => ({
      action: h.action,
      version: h.version,
      reason: h.reason,
      by: (h.by as unknown as { name?: string } | null)?.name ?? "",
      at: h.at,
    })),
  };
}
