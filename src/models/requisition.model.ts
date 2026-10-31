import mongoose, { Schema, Types } from "mongoose";

/**
 * Requerimiento del bar (guía auditada 27-oct-2026):
 * - abastecimiento: Solicitado → Aprobado / Rechazado (Dirección de crucero) →
 *   Recibido parcial / Recibido (recepción física). Aprobar no suma stock;
 *   recibir traslada la cantidad real de bodega al barco.
 * - revision: el bar encontró un producto "no disponible" que sí tiene en
 *   la mano; Administración lo atiende con un conteo físico.
 */
export const REQUISITION_KINDS = ["abastecimiento", "revision"] as const;
export type RequisitionKind = (typeof REQUISITION_KINDS)[number];

export const REQUISITION_STATUSES = [
  "solicitado",
  "aprobado",
  "rechazado",
  "recibido_parcial",
  "recibido",
  "atendido",
  "cancelado",
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export interface IRequisitionLine {
  product: Types.ObjectId;
  name: string;
  /** Cantidad pedida en unidad base (ml, unidad…). */
  qty: number;
  /** Cómo la pidió el bar: "3 botella" o "500 ml". */
  label: string;
  receivedQty: number;
}

export interface IRequisitionReceipt {
  key: string;
  lines: Array<{ index: number; qty: number }>;
  note: string;
  transferId: string;
  by: Types.ObjectId;
  at: Date;
}

export interface IRequisition {
  code: string;
  kind: RequisitionKind;
  cruise: Types.ObjectId | null;
  lines: IRequisitionLine[];
  note: string;
  status: RequisitionStatus;
  requestedBy: Types.ObjectId;
  idempotencyKey: string | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  reviewNote: string;
  receipts: IRequisitionReceipt[];
  createdAt?: Date;
  updatedAt?: Date;
}

const lineSchema = new Schema<IRequisitionLine>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" },
    receivedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const receiptSchema = new Schema<IRequisitionReceipt>(
  {
    key: { type: String, required: true },
    lines: {
      type: [
        new Schema(
          { index: { type: Number, required: true }, qty: { type: Number, required: true, min: 0 } },
          { _id: false },
        ),
      ],
      default: [],
    },
    note: { type: String, default: "" },
    transferId: { type: String, default: "" },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const requisitionSchema = new Schema<IRequisition>(
  {
    code: { type: String, required: true, unique: true },
    kind: { type: String, enum: REQUISITION_KINDS, default: "abastecimiento" },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    lines: { type: [lineSchema], default: [] },
    note: { type: String, default: "" },
    status: { type: String, enum: REQUISITION_STATUSES, default: "solicitado" },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    idempotencyKey: { type: String, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
    receipts: { type: [receiptSchema], default: [] },
  },
  { timestamps: true, optimisticConcurrency: true },
);

requisitionSchema.index({ status: 1, createdAt: -1 });
requisitionSchema.index({ requestedBy: 1, createdAt: -1 });
requisitionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export const Requisition =
  (mongoose.models.Requisition as mongoose.Model<IRequisition>) ||
  mongoose.model<IRequisition>("Requisition", requisitionSchema);
