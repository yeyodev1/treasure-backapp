import mongoose, { Schema, Types } from "mongoose";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Conteo físico (guía V3, pantalla 03). Bodega o Bar cuentan; guardar no
 * cambia stock. Solo Gerencia aprueba: se registra una sola diferencia por
 * producto contra el corte y se conservan los movimientos posteriores.
 */
export const COUNT_STATUSES = ["borrador", "enviado", "aprobado", "rechazado"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const COUNT_REASONS = [
  "Rotura",
  "Medida",
  "Error de registro",
  "Consumo interno",
  "Pérdida",
  "Otro",
] as const;

export interface ICountLine {
  product: Types.ObjectId;
  name: string;
  stockUnit: string;
  digitalAtCut: number;
  physical: number | null;
  reason: string;
}

export interface IStockCount {
  code: string;
  location: StockLocation;
  cruise: Types.ObjectId | null;
  status: CountStatus;
  cutAt: Date;
  lines: ICountLine[];
  notes: string;
  createdBy: Types.ObjectId;
  submittedBy: Types.ObjectId | null;
  submittedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const countLineSchema = new Schema<ICountLine>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    stockUnit: { type: String, default: "unidad" },
    digitalAtCut: { type: Number, required: true },
    physical: { type: Number, default: null },
    reason: { type: String, default: "" },
  },
  { _id: false },
);

const stockCountSchema = new Schema<IStockCount>(
  {
    code: { type: String, required: true, unique: true },
    location: { type: String, enum: STOCK_LOCATIONS, required: true },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    status: { type: String, enum: COUNT_STATUSES, default: "borrador" },
    cutAt: { type: Date, required: true },
    lines: { type: [countLineSchema], default: [] },
    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
  },
  { timestamps: true },
);

stockCountSchema.index({ createdAt: -1 });

export const StockCount =
  (mongoose.models.StockCount as mongoose.Model<IStockCount>) ||
  mongoose.model<IStockCount>("StockCount", stockCountSchema);
