import mongoose, { Schema, Types } from "mongoose";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Conteo físico (guía V3, pantalla 03). Bodega o Bar cuentan; guardar no
 * cambia stock. Solo Gerencia aprueba: se registra una sola diferencia por
 * producto contra el corte y se conservan los movimientos posteriores.
 */
/**
 * Conteo de cierre (Bar-stock, 24-nov-2026): borrador (el bar cuenta a
 * ciegas) → enviado (la directora recuenta a ciegas lo que difiere) →
 * gerencia (merma sobre el límite, botella completa o repetición) → aprobado
 * (verificado: pasa a ser la referencia del stock).
 */
export const COUNT_STATUSES = ["borrador", "enviado", "gerencia", "aprobado", "rechazado"] as const;
export const COUNT_KINDS = ["libre", "cierre", "inicial", "admin"] as const;
export type CountKind = (typeof COUNT_KINDS)[number];
export const WASTE_MOTIVES = ["rotura", "cortesia", "consumo", "faltante"] as const;
export type WasteMotive = (typeof WASTE_MOTIVES)[number];
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
  /** Recuento a ciegas de la directora (solo productos con diferencia). */
  recount: number | null;
  /** ok: dentro de tolerancia · corregido: era error de conteo · merma: diferencia real. */
  result: "" | "ok" | "tolerancia" | "corregido" | "merma";
  motive: "" | WasteMotive;
  /** Costo por unidad base al cerrar y valor de la merma (0 si no hay costo). */
  unitCost: number;
  value: number;
  fullBottle: boolean;
  /** Productos con tipos: lo contado por tipo, en envases. La suma va en physical / recount. */
  physicalBy: Record<string, number> | null;
  recountBy: Record<string, number> | null;
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
  kind: CountKind;
  /** Merma total del conteo y por qué pasó a Gerencia. */
  wasteTotal: number;
  toManagement: string[];
  verifiedBy: Types.ObjectId | null;
  verifiedByName: string;
  verifiedAt: Date | null;
  submittedByName: string;
  /** Decisión de Gerencia sobre la merma (rechazar vuelve a la directora con el comentario). */
  decision: { approved: boolean; comment: string; byName: string; at: Date } | null;
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
    recount: { type: Number, default: null },
    result: { type: String, enum: ["", "ok", "tolerancia", "corregido", "merma"], default: "" },
    motive: { type: String, enum: ["", ...WASTE_MOTIVES], default: "" },
    unitCost: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    fullBottle: { type: Boolean, default: false },
    physicalBy: { type: Schema.Types.Mixed, default: null },
    recountBy: { type: Schema.Types.Mixed, default: null },
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
    kind: { type: String, enum: COUNT_KINDS, default: "libre" },
    wasteTotal: { type: Number, default: 0 },
    toManagement: { type: [String], default: [] },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifiedByName: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
    submittedByName: { type: String, default: "" },
    decision: {
      type: new Schema(
        { approved: Boolean, comment: String, byName: String, at: Date },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

stockCountSchema.index({ createdAt: -1 });

export const StockCount =
  (mongoose.models.StockCount as mongoose.Model<IStockCount>) ||
  mongoose.model<IStockCount>("StockCount", stockCountSchema);
