import mongoose, { Schema, Types } from "mongoose";

/**
 * Factura mensual a la agencia (pedido de Gerencia, 4-nov-2026): las
 * cortesías de agencia se le facturan cada mes. Gerencia elige qué cruceros
 * entran, se guarda el detalle fijo al registrar y se le envía por correo. La
 * factura electrónica se emite aparte en Contífico. Una mal registrada no se
 * borra: se anula con motivo y sus cruceros vuelven a quedar pendientes.
 */
export const AGENCY_INVOICE_STATUSES = ["vigente", "anulada"] as const;
export type AgencyInvoiceStatus = (typeof AGENCY_INVOICE_STATUSES)[number];

export interface IAgencyInvoiceItem {
  cruise: Types.ObjectId;
  code: string;
  count: number;
  amount: number;
}

export interface IAgencyInvoice {
  /** Mes que se factura: AAAA-MM (hora de Galápagos). */
  month: string;
  amount: number;
  items: IAgencyInvoiceItem[];
  /** Número de la factura de Contífico (opcional, se puede anotar después). */
  invoiceNumber: string;
  sentTo: string;
  sentAt: Date | null;
  note: string;
  status: AgencyInvoiceStatus;
  by: Types.ObjectId;
  byName: string;
  voided: { by: Types.ObjectId; byName: string; at: Date; reason: string } | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const agencyInvoiceSchema = new Schema<IAgencyInvoice>(
  {
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    amount: { type: Number, required: true, min: 0.01 },
    items: {
      type: [
        new Schema(
          {
            cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
            code: { type: String, default: "" },
            count: { type: Number, default: 0 },
            amount: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    invoiceNumber: { type: String, default: "", trim: true, maxlength: 60 },
    sentTo: { type: String, default: "", trim: true },
    sentAt: { type: Date, default: null },
    note: { type: String, default: "", trim: true, maxlength: 300 },
    status: { type: String, enum: AGENCY_INVOICE_STATUSES, default: "vigente" },
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

agencyInvoiceSchema.index({ createdAt: -1 });

export const AgencyInvoice =
  (mongoose.models.AgencyInvoice as mongoose.Model<IAgencyInvoice>) ||
  mongoose.model<IAgencyInvoice>("AgencyInvoice", agencyInvoiceSchema);
