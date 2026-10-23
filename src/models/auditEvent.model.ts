import mongoose, { Schema, Types } from "mongoose";

/**
 * Bitácora general de actividad: todo lo que pasa en el sistema queda con
 * actor, hora y detalle. Alimenta el panel En vivo de administración.
 */
export const AUDIT_KINDS = [
  "pedido",
  "entrega",
  "cancelacion",
  "anulacion",
  "cuenta",
  "cobro",
  "inventario",
  "conteo",
  "catalogo",
  "equipo",
  "salida",
  "registro",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface IAuditEvent {
  kind: AuditKind;
  title: string;
  detail: string;
  amount: number | null;
  by: Types.ObjectId | null;
  byName: string;
  cruise: Types.ObjectId | null;
  cabinNumber: number | null;
  createdAt?: Date;
}

const auditEventSchema = new Schema<IAuditEvent>(
  {
    kind: { type: String, enum: AUDIT_KINDS, required: true },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    amount: { type: Number, default: null },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    cabinNumber: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditEventSchema.index({ createdAt: -1 });

export const AuditEvent =
  (mongoose.models.AuditEvent as mongoose.Model<IAuditEvent>) ||
  mongoose.model<IAuditEvent>("AuditEvent", auditEventSchema);
