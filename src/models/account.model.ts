import mongoose, { Schema, Types } from "mongoose";

/**
 * Cuenta de una cabina en una salida (guía V3, pantalla 02):
 * abierta → en_revision (Bar envía) → aprobada (Dirección) → cobrada.
 * Cualquier cambio de un cargo sube la versión e invalida la aprobación.
 * Con pagos parciales la cuenta sigue "aprobada" hasta que el saldo llega a
 * cero; recién entonces pasa a "cobrada" (Pagada).
 */
export const ACCOUNT_STATUSES = ["abierta", "en_revision", "aprobada", "cobrada"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_ACTIONS = [
  "creada",
  "cargo_cambiado",
  "enviada_revision",
  "aprobada",
  "devuelta",
  "invalidada",
  "cobrada",
  "pago_parcial",
  "reversada",
  "correo_enviado",
  "correo_no_enviado",
] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

export interface IAccountEvent {
  action: AccountAction;
  version: number;
  reason: string;
  by: Types.ObjectId | null;
  at: Date;
}

export interface IAccount {
  cruise: Types.ObjectId;
  cabinNumber: number;
  status: AccountStatus;
  version: number;
  approvedVersion: number | null;
  approvedTotal: number | null;
  history: IAccountEvent[];
  createdAt?: Date;
  updatedAt?: Date;
}

const accountEventSchema = new Schema<IAccountEvent>(
  {
    action: { type: String, enum: ACCOUNT_ACTIONS, required: true },
    version: { type: Number, required: true },
    reason: { type: String, default: "" },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const accountSchema = new Schema<IAccount>(
  {
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
    cabinNumber: { type: Number, required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: "abierta" },
    version: { type: Number, default: 1 },
    approvedVersion: { type: Number, default: null },
    approvedTotal: { type: Number, default: null },
    history: { type: [accountEventSchema], default: [] },
  },
  { timestamps: true },
);

accountSchema.index({ cruise: 1, cabinNumber: 1 }, { unique: true });

export const Account =
  (mongoose.models.Account as mongoose.Model<IAccount>) ||
  mongoose.model<IAccount>("Account", accountSchema);
