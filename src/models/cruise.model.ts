import mongoose, { Schema, Types } from "mongoose";
import crypto from "crypto";

export const CRUISE_STATUSES = ["planificado", "abordo", "cerrado"] as const;
export type CruiseStatus = (typeof CRUISE_STATUSES)[number];

export interface ICabin {
  number: number;
  guestName: string;
  guestCount: number;
  /** País de origen: la administración lo quiere para métricas de consumo por nacionalidad. */
  country: string;
  /** Correo y teléfono son opcionales al inicio; se exigen recién al facturar. */
  email: string;
  phone: string;
  /** Token del link público de la cuenta (QR): el pasajero lo abre en su celular. */
  accountToken: string;
}

export interface ICruise {
  name: string;
  startDate: Date;
  endDate: Date | null;
  status: CruiseStatus;
  cabins: ICabin[];
  notes: string;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const cabinSchema = new Schema<ICabin>(
  {
    number: { type: Number, required: true, min: 1 },
    guestName: { type: String, default: "", trim: true },
    guestCount: { type: Number, default: 0, min: 0 },
    country: { type: String, default: "", trim: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    accountToken: {
      type: String,
      default: () => crypto.randomBytes(12).toString("hex"),
    },
  },
  { _id: false },
);

const cruiseSchema = new Schema<ICruise>(
  {
    name: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    status: { type: String, enum: CRUISE_STATUSES, default: "planificado" },
    cabins: { type: [cabinSchema], default: [] },
    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

cruiseSchema.index({ status: 1, startDate: -1 });
cruiseSchema.index({ "cabins.accountToken": 1 });

export const Cruise =
  (mongoose.models.Cruise as mongoose.Model<ICruise>) ||
  mongoose.model<ICruise>("Cruise", cruiseSchema);
