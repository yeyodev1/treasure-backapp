import mongoose, { Schema, Types } from "mongoose";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Compra en dos pasos (guía auditada 27-oct-2026): registrar la factura no
 * mueve stock; solo la recepción física suma la cantidad real al almacén
 * destino, con su costo. Una compra va a un solo almacén.
 */
export const PURCHASE_STATUSES = ["registrada", "recibida_parcial", "recibida", "anulada"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export interface IPurchaseLine {
  product: Types.ObjectId;
  name: string;
  /** Envases facturados (botellas, cajas de 24…) y su tamaño en unidad base. */
  containers: number;
  containerSize: number;
  containerLabel: string;
  stockUnit: string;
  /** Total en unidad base: containers × containerSize. */
  qty: number;
  /** Costo por envase, sin IVA o como lo registre Administración. */
  containerCost: number;
  receivedQty: number;
}

export interface IPurchaseReceipt {
  key: string;
  lines: Array<{ index: number; qty: number }>;
  note: string;
  by: Types.ObjectId;
  at: Date;
}

export interface IPurchase {
  code: string;
  supplier: string;
  document: string;
  documentDate: Date | null;
  destination: StockLocation;
  lines: IPurchaseLine[];
  total: number;
  status: PurchaseStatus;
  note: string;
  idempotencyKey: string | null;
  receipts: IPurchaseReceipt[];
  createdBy: Types.ObjectId;
  cancelReason: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const lineSchema = new Schema<IPurchaseLine>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    containers: { type: Number, required: true, min: 0 },
    containerSize: { type: Number, default: 1, min: 0 },
    containerLabel: { type: String, default: "unidad" },
    stockUnit: { type: String, default: "unidad" },
    qty: { type: Number, required: true, min: 0 },
    containerCost: { type: Number, default: 0, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const receiptSchema = new Schema<IPurchaseReceipt>(
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
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const purchaseSchema = new Schema<IPurchase>(
  {
    code: { type: String, required: true, unique: true },
    supplier: { type: String, required: true, trim: true },
    document: { type: String, required: true, trim: true },
    documentDate: { type: Date, default: null },
    destination: { type: String, enum: STOCK_LOCATIONS, default: "bodega" },
    lines: { type: [lineSchema], default: [] },
    total: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: PURCHASE_STATUSES, default: "registrada" },
    note: { type: String, default: "" },
    idempotencyKey: { type: String, default: null },
    receipts: { type: [receiptSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    cancelReason: { type: String, default: "" },
  },
  { timestamps: true, optimisticConcurrency: true },
);

purchaseSchema.index({ status: 1, createdAt: -1 });
purchaseSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export const Purchase =
  (mongoose.models.Purchase as mongoose.Model<IPurchase>) ||
  mongoose.model<IPurchase>("Purchase", purchaseSchema);
