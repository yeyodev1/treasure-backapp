import mongoose, { Schema, Types } from "mongoose";

/**
 * Pedido del bar (guía V3): se registra, luego se entrega total o
 * parcialmente. El stock se descuenta solo al entregar. Lo pendiente se
 * puede cancelar con motivo (no toca stock); lo entregado solo se anula
 * por solicitud a Dirección, y devolver stock lo decide Paula.
 */
export interface IOrderItem {
  product: Types.ObjectId;
  name: string;
  qty: number;
  unitPrice: number;
  courtesy: boolean;
  deliveredQty: number;
  cancelledQty: number;
  annulledQty: number;
}

export interface IOrderDelivery {
  key: string;
  items: Array<{ index: number; qty: number }>;
  by: Types.ObjectId;
  at: Date;
}

export interface IOrderCancellation {
  items: Array<{ index: number; qty: number }>;
  reason: string;
  by: Types.ObjectId;
  at: Date;
}

export const ANNULMENT_STATUSES = ["pendiente", "aprobada", "rechazada"] as const;
export type AnnulmentStatus = (typeof ANNULMENT_STATUSES)[number];

export interface IOrderAnnulment {
  _id?: Types.ObjectId;
  index: number;
  qty: number;
  reason: string;
  requestedBy: Types.ObjectId;
  requestedAt: Date;
  status: AnnulmentStatus;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string;
  restocked: boolean;
}

export const ORDER_STATUSES = ["pendiente", "entregada", "cancelada"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface IOrder {
  cruise: Types.ObjectId;
  cabinNumber: number;
  items: IOrderItem[];
  status: OrderStatus;
  /** Saldo cobrable: lo pedido menos lo cancelado y lo anulado (sin cortesías). */
  total: number;
  payment: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  /** Evita registrar dos veces el mismo pedido si se repite el clic. */
  idempotencyKey: string | null;
  deliveries: IOrderDelivery[];
  cancellations: IOrderCancellation[];
  annulments: IOrderAnnulment[];
  createdAt?: Date;
  updatedAt?: Date;
}

const indexQtySchema = new Schema(
  { index: { type: Number, required: true }, qty: { type: Number, required: true, min: 0 } },
  { _id: false },
);

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    courtesy: { type: Boolean, default: false },
    deliveredQty: { type: Number, default: 0, min: 0 },
    cancelledQty: { type: Number, default: 0, min: 0 },
    annulledQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const deliverySchema = new Schema<IOrderDelivery>(
  {
    key: { type: String, required: true },
    items: { type: [indexQtySchema], default: [] },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const cancellationSchema = new Schema<IOrderCancellation>(
  {
    items: { type: [indexQtySchema], default: [] },
    reason: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const annulmentSchema = new Schema<IOrderAnnulment>({
  index: { type: Number, required: true },
  qty: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  requestedAt: { type: Date, default: () => new Date() },
  status: { type: String, enum: ANNULMENT_STATUSES, default: "pendiente" },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: "" },
  restocked: { type: Boolean, default: false },
});

const orderSchema = new Schema<IOrder>(
  {
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
    cabinNumber: { type: Number, required: true, min: 1 },
    items: { type: [orderItemSchema], required: true },
    status: { type: String, enum: ORDER_STATUSES, default: "pendiente" },
    total: { type: Number, required: true, min: 0 },
    payment: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    idempotencyKey: { type: String, default: null },
    deliveries: { type: [deliverySchema], default: [] },
    cancellations: { type: [cancellationSchema], default: [] },
    annulments: { type: [annulmentSchema], default: [] },
  },
  // Dos entregas simultáneas del mismo pedido: la segunda falla en vez de duplicar.
  { timestamps: true, optimisticConcurrency: true },
);

orderSchema.index({ cruise: 1, cabinNumber: 1, status: 1 });
orderSchema.index({ createdBy: 1, createdAt: -1 });
orderSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

/** Unidades aún por entregar de un ítem. */
export function pendingQty(item: IOrderItem): number {
  return Math.max(0, item.qty - item.deliveredQty - item.cancelledQty);
}

/** Unidades que siguen contando para la cuenta. */
export function chargeableQty(item: IOrderItem): number {
  return Math.max(0, item.qty - item.cancelledQty - item.annulledQty);
}

/** Recalcula total y estado tras cualquier entrega, cancelación o anulación. */
export function recomputeOrder(order: IOrder): void {
  let total = 0;
  let anyPending = false;
  let anyLive = false;
  for (const item of order.items) {
    const live = chargeableQty(item);
    if (live > 0) anyLive = true;
    if (pendingQty(item) > 0) anyPending = true;
    if (!item.courtesy) total += live * item.unitPrice;
  }
  order.total = Math.round(total * 100) / 100;
  order.status = !anyLive ? "cancelada" : anyPending ? "pendiente" : "entregada";
}

export const Order =
  (mongoose.models.Order as mongoose.Model<IOrder>) || mongoose.model<IOrder>("Order", orderSchema);
