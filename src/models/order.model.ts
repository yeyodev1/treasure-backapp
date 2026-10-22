import mongoose, { Schema, Types } from "mongoose";

/**
 * Comanda del bar: el bartender selecciona la cabina y agrega productos.
 * Los pedidos se acumulan por cabina durante todo el crucero (4 a 7 días)
 * y se cobran al final del viaje.
 */
export interface IOrderItem {
  product: Types.ObjectId;
  name: string;
  qty: number;
  unitPrice: number;
  /** Cortesía: no se cobra pero sí descarga inventario. La marca administración/dirección. */
  courtesy: boolean;
}

export const ORDER_STATUSES = ["abierta", "cobrada", "anulada"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface IOrder {
  cruise: Types.ObjectId;
  cabinNumber: number;
  items: IOrderItem[];
  status: OrderStatus;
  total: number;
  payment: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    courtesy: { type: Boolean, default: false },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
    cabinNumber: { type: Number, required: true, min: 1 },
    items: { type: [orderItemSchema], required: true },
    status: { type: String, enum: ORDER_STATUSES, default: "abierta" },
    total: { type: Number, required: true, min: 0 },
    payment: { type: Schema.Types.ObjectId, ref: "Payment", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

orderSchema.index({ cruise: 1, cabinNumber: 1, status: 1 });
orderSchema.index({ createdBy: 1, createdAt: -1 });

export const Order =
  (mongoose.models.Order as mongoose.Model<IOrder>) || mongoose.model<IOrder>("Order", orderSchema);
