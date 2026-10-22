import mongoose, { Schema, Types } from "mongoose";

/**
 * Bitácora de inventario: todo movimiento queda registrado con quién lo hizo
 * y por qué (acuerdo de reunión: accesos por persona para auditar cada acción).
 */
export const MOVEMENT_TYPES = [
  "carga", // carga inicial o reabastecimiento del crucero desde bodega
  "venta", // descuento por pedido
  "merma", // se cayó/rompió algo: se registra para no descuadrar inventario
  "cortesia", // botella de vino u otro ítem regalado: gratis pero descarga inventario
  "ajuste", // corrección manual tras verificación física
  "compra", // ingreso a bodega (tierra)
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface IStockMovement {
  type: MovementType;
  product: Types.ObjectId;
  /** Positivo suma al stock, negativo resta. */
  qty: number;
  cruise: Types.ObjectId | null;
  order: Types.ObjectId | null;
  reason: string;
  user: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    reason: { type: String, default: "" },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

stockMovementSchema.index({ cruise: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, createdAt: -1 });

export const StockMovement =
  (mongoose.models.StockMovement as mongoose.Model<IStockMovement>) ||
  mongoose.model<IStockMovement>("StockMovement", stockMovementSchema);
