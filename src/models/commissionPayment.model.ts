import mongoose, { Schema, Types } from "mongoose";

/**
 * Pago de comisión al bartender (pedido de Gerencia, 3-nov-2026). Las
 * comisiones se acumulan durante varios cruceros y se pagan juntas: cada pago
 * se descuenta del saldo acumulado. Un pago mal registrado no se borra, se
 * anula con motivo y deja de descontar.
 */
export const COMMISSION_PAYMENT_STATUSES = ["vigente", "anulado"] as const;
export type CommissionPaymentStatus = (typeof COMMISSION_PAYMENT_STATUSES)[number];

export interface ICommissionPayment {
  amount: number;
  /** Día en que se le pagó (puede ser anterior al registro). */
  paidAt: Date;
  note: string;
  status: CommissionPaymentStatus;
  by: Types.ObjectId;
  byName: string;
  voided: { by: Types.ObjectId; byName: string; at: Date; reason: string } | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const commissionPaymentSchema = new Schema<ICommissionPayment>(
  {
    amount: { type: Number, required: true, min: 0.01 },
    paidAt: { type: Date, required: true },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    status: { type: String, enum: COMMISSION_PAYMENT_STATUSES, default: "vigente" },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byName: { type: String, default: "" },
    voided: {
      type: new Schema(
        {
          by: { type: Schema.Types.ObjectId, ref: "User", required: true },
          byName: { type: String, default: "" },
          at: { type: Date, required: true },
          reason: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

commissionPaymentSchema.index({ paidAt: -1 });

export const CommissionPayment =
  (mongoose.models.CommissionPayment as mongoose.Model<ICommissionPayment>) ||
  mongoose.model<ICommissionPayment>("CommissionPayment", commissionPaymentSchema);
