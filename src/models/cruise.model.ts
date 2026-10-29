import mongoose, { Schema, Types } from "mongoose";
import crypto from "crypto";

/** Programada → En curso → Finalizada (guía auditada 27-oct-2026). */
export const CRUISE_STATUSES = ["planificado", "abordo", "cerrado"] as const;
export const CRUISE_STATUS_LABELS = {
  planificado: "Programada",
  abordo: "En curso",
  cerrado: "Finalizada",
} as const;
export type CruiseStatus = (typeof CRUISE_STATUSES)[number];

/** Pasajero de una cabina (guía V3): la facturación recupera estos datos. */
export interface IPassenger {
  _id?: Types.ObjectId;
  name: string;
  country: string;
  nationality: string;
  idNumber: string;
  email: string;
  phone: string;
  isPayer: boolean;
}

export interface ICabin {
  number: number;
  passengers: IPassenger[];
  /** Nombre visible de la cabina: el pagador o el primer pasajero. */
  guestName: string;
  /** Token del link público de la cuenta (QR): el pasajero lo abre en su celular. */
  accountToken: string;
  /** Plazas de la cabina: no se registran más pasajeros que esto. */
  capacity: number;
}

/**
 * Salida del barco. Las salidas se generan con el ciclo A → B → C y cada
 * una tiene su código (A-001, B-001…) y sus 9 cabinas limpias.
 */
export interface ICruise {
  code: string;
  leg: string;
  routeFrom: string;
  routeTo: string;
  name: string;
  startDate: Date;
  endDate: Date | null;
  status: CruiseStatus;
  cabins: ICabin[];
  notes: string;
  startedAt: Date | null;
  startedBy: Types.ObjectId | null;
  closedAt: Date | null;
  closedBy: Types.ObjectId | null;
  /** Cierre excepcional (equipo sin responder o envíos pendientes). */
  closeReason: string;
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const passengerSchema = new Schema<IPassenger>({
  name: { type: String, required: true, trim: true },
  country: { type: String, default: "", trim: true },
  nationality: { type: String, default: "", trim: true },
  idNumber: { type: String, default: "", trim: true },
  email: { type: String, default: "", lowercase: true, trim: true },
  phone: { type: String, default: "", trim: true },
  isPayer: { type: Boolean, default: false },
});

const cabinSchema = new Schema<ICabin>(
  {
    number: { type: Number, required: true, min: 1 },
    passengers: { type: [passengerSchema], default: [] },
    guestName: { type: String, default: "", trim: true },
    accountToken: {
      type: String,
      default: () => crypto.randomBytes(12).toString("hex"),
    },
    capacity: { type: Number, default: 2, min: 1, max: 6 },
  },
  { _id: false },
);

const cruiseSchema = new Schema<ICruise>(
  {
    code: { type: String, default: "", trim: true },
    leg: { type: String, default: "" },
    routeFrom: { type: String, default: "" },
    routeTo: { type: String, default: "" },
    name: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    status: { type: String, enum: CRUISE_STATUSES, default: "planificado" },
    cabins: { type: [cabinSchema], default: [] },
    notes: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    startedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closeReason: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

cruiseSchema.index({ status: 1, startDate: -1 });
cruiseSchema.index({ "cabins.accountToken": 1 });
cruiseSchema.index({ leg: 1, startDate: 1 });
// Solo una salida en curso a la vez, garantizado por la base (doble toque o dos equipos).
cruiseSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "abordo" }, name: "una_salida_en_curso" },
);

/** Nombre visible de una cabina a partir de sus pasajeros. */
export function cabinDisplayName(cabin: Pick<ICabin, "passengers">): string {
  const payer = cabin.passengers.find((p) => p.isPayer);
  return (payer ?? cabin.passengers[0])?.name ?? "";
}

export const Cruise =
  (mongoose.models.Cruise as mongoose.Model<ICruise>) ||
  mongoose.model<ICruise>("Cruise", cruiseSchema);
