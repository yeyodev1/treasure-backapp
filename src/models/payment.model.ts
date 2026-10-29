import mongoose, { Schema, Types } from "mongoose";

/**
 * Cobro de la cuenta de una cabina al final del crucero.
 * Quien cobra marca el método; con efectivo debe confirmar la recaudación en caja.
 * Al cobrar se exigen los datos de facturación y se dispara la factura (Contífico).
 */
export const PAYMENT_METHODS = ["efectivo", "tarjeta", "transferencia", "online"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** emitiendo: hay una emisión en curso (evita facturar dos veces con doble clic). */
export const INVOICE_STATUSES = ["pendiente", "emitiendo", "emitida", "error", "no_aplica"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface IBillingInfo {
  name: string;
  /** Cédula, RUC o pasaporte. */
  idNumber: string;
  email: string;
  country: string;
}

export const PAYMENT_STATUSES = ["vigente", "reversado"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface IPayment {
  cruise: Types.ObjectId;
  cabinNumber: number;
  orders: Types.ObjectId[];
  /** Versión de la cuenta aprobada que se cobró. */
  accountVersion: number;
  status: PaymentStatus;
  reversedBy: Types.ObjectId | null;
  reversedAt: Date | null;
  reverseReason: string;
  subtotal: number;
  courtesyTotal: number;
  total: number;
  method: PaymentMethod;
  /** Confirmación de que el efectivo entró a caja (exigencia de la administración). */
  cashConfirmed: boolean;
  billing: IBillingInfo;
  invoiceStatus: InvoiceStatus;
  /** Id del documento en Contífico. */
  invoiceId: string;
  /** Número de factura (001-100-000000783). */
  invoiceNumber: string;
  /** PDF (RIDE) de la factura en Contífico. */
  invoiceUrl: string;
  invoiceError: string;
  collectedBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const billingSchema = new Schema<IBillingInfo>(
  {
    name: { type: String, default: "", trim: true },
    idNumber: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    country: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const paymentSchema = new Schema<IPayment>(
  {
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
    cabinNumber: { type: Number, required: true },
    orders: [{ type: Schema.Types.ObjectId, ref: "Order" }],
    accountVersion: { type: Number, default: 1 },
    status: { type: String, enum: PAYMENT_STATUSES, default: "vigente" },
    reversedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reversedAt: { type: Date, default: null },
    reverseReason: { type: String, default: "" },
    subtotal: { type: Number, required: true, min: 0 },
    courtesyTotal: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    cashConfirmed: { type: Boolean, default: false },
    billing: { type: billingSchema, default: () => ({}) },
    invoiceStatus: { type: String, enum: INVOICE_STATUSES, default: "pendiente" },
    invoiceId: { type: String, default: "" },
    invoiceNumber: { type: String, default: "" },
    invoiceUrl: { type: String, default: "" },
    invoiceError: { type: String, default: "" },
    collectedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

paymentSchema.index({ cruise: 1, cabinNumber: 1 });
paymentSchema.index({ createdAt: -1 });

export const Payment =
  (mongoose.models.Payment as mongoose.Model<IPayment>) ||
  mongoose.model<IPayment>("Payment", paymentSchema);
