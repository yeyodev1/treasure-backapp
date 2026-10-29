import { Types } from "mongoose";
import { Account, AccountStatus, IAccount } from "../models/account.model";
import { chargeableQty, Order, pendingQty } from "../models/order.model";
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
  orders: Array<{
    id: string;
    createdAt: Date;
    /** Trazabilidad: quién registró el pedido. */
    by: string;
    status: string;
    items: AccountLineItem[];
    total: number;
  }>;
  subtotal: number;
  courtesyTotal: number;
  total: number;
  history: Array<{ action: string; version: number; reason: string; by: string; at: Date }>;
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
      reason: `La aprobación quedó sin efecto: ${reason}`,
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

/** Cuenta de una cabina: pedidos aún no cobrados, con su estado de entrega. */
export async function buildCabinAccount(
  cruiseId: Types.ObjectId | string,
  cabinNumber: number,
): Promise<AccountSummary> {
  const [account, orders] = await Promise.all([
    Account.findOne({ cruise: cruiseId, cabinNumber }).populate("history.by", "name"),
    Order.find({
      cruise: cruiseId,
      cabinNumber,
      payment: null,
      status: { $nin: ["cancelada", "retenida"] },
    })
      .populate("createdBy", "name")
      .sort({ createdAt: 1 }),
  ]);

  let subtotal = 0;
  let courtesyTotal = 0;
  let pendingDeliveries = 0;
  let pendingAnnulments = 0;

  const mapped = orders.map((order) => {
    let orderTotal = 0;
    const items = order.items.map((item, index) => {
      const live = chargeableQty(item);
      const pending = pendingQty(item);
      pendingDeliveries += pending;
      const line = live * item.unitPrice;
      if (item.courtesy) courtesyTotal += line;
      else orderTotal += line;
      return {
        index,
        name: item.name,
        qty: item.qty,
        deliveredQty: item.deliveredQty,
        pendingQty: pending,
        cancelledQty: item.cancelledQty,
        annulledQty: item.annulledQty,
        chargeableQty: live,
        unitPrice: item.unitPrice,
        courtesy: item.courtesy,
      };
    });
    pendingAnnulments += order.annulments.filter((a) => a.status === "pendiente").length;
    subtotal += orderTotal;
    return {
      id: order._id.toString(),
      createdAt: order.createdAt as Date,
      by: (order.createdBy as unknown as { name?: string })?.name ?? "",
      status: order.status,
      items,
      total: round2(orderTotal),
    };
  });

  const status = account?.status ?? "abierta";
  const version = account?.version ?? 1;
  const total = round2(subtotal);

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
    orders: mapped,
    subtotal: total,
    courtesyTotal: round2(courtesyTotal),
    total,
    history: (account?.history ?? []).map((h) => ({
      action: h.action,
      version: h.version,
      reason: h.reason,
      by: (h.by as unknown as { name?: string } | null)?.name ?? "",
      at: h.at,
    })),
  };
}
