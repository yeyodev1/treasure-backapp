import mongoose, { Schema, Types } from "mongoose";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Bitácora de inventario: todo movimiento queda con quién, cuándo, dónde y
 * por qué. Las cantidades van en la unidad base del insumo (ml, unidad…).
 */
export const MOVEMENT_TYPES = [
  "carga", // traslado bodega → a bordo
  "venta", // consumo por bebida entregada
  "merma", // rotura o pérdida reportada en el momento
  "ajuste", // diferencia aprobada por Paula (conteo físico o ajuste manual)
  "compra", // ingreso a bodega con proveedor y documento
  "devolucion", // anulación aprobada por Paula con regreso al stock
  "migracion", // saldo trasladado desde el modelo anterior
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface IStockMovement {
  type: MovementType;
  product: Types.ObjectId;
  location: StockLocation;
  /** Positivo suma al stock de la ubicación, negativo resta. */
  qty: number;
  cruise: Types.ObjectId | null;
  order: Types.ObjectId | null;
  count: Types.ObjectId | null;
  reason: string;
  supplier: string;
  document: string;
  unitCost: number;
  /** Movimientos previos a la v3 están en unidades antiguas (no en ml). */
  legacy: boolean;
  user: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    location: { type: String, enum: STOCK_LOCATIONS, default: "abordo" },
    qty: { type: Number, required: true },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    count: { type: Schema.Types.ObjectId, ref: "StockCount", default: null },
    reason: { type: String, default: "" },
    supplier: { type: String, default: "" },
    document: { type: String, default: "" },
    unitCost: { type: Number, default: 0 },
    legacy: { type: Boolean, default: false },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

stockMovementSchema.index({ cruise: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, createdAt: -1 });
stockMovementSchema.index({ createdAt: -1 });

export const StockMovement =
  (mongoose.models.StockMovement as mongoose.Model<IStockMovement>) ||
  mongoose.model<IStockMovement>("StockMovement", stockMovementSchema);
