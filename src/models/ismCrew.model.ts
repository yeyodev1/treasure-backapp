import mongoose, { Schema, Types } from "mongoose";

/**
 * Ficha de tripulante para los Registros ISM (informe R-14 del 29-oct,
 * decisiones del piloto 1–4). Complementa al usuario (nombre, rol y cargo
 * viven en la cuenta): si está a bordo y su clave de 4 números para firmar.
 *
 * La clave se guarda cifrada (bcrypt) y nunca se devuelve. La Persona
 * Designada da una clave temporal de un solo uso; el tripulante la cambia la
 * primera vez que firma y nadie más la conoce. Tras 5 intentos fallidos el
 * servidor la bloquea 15 minutos.
 */
export interface IIsmCrew {
  user: Types.ObjectId;
  onboard: boolean;
  pinHash: string;
  /** Clave temporal dada por la Persona Designada: se cambia al primer uso. */
  pinTemporary: boolean;
  pinSetAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  updatedBy: Types.ObjectId | null;
  /** Última clave temporal dada (restablecimiento): cuándo y quién. Se imprime en el anexo si fue en las 24 h previas a una firma. */
  pinResetAt?: Date | null;
  pinResetBy?: Types.ObjectId | null;
  pinResetByName?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ismCrewSchema = new Schema<IIsmCrew>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    onboard: { type: Boolean, default: true },
    pinHash: { type: String, default: "" },
    pinTemporary: { type: Boolean, default: false },
    pinSetAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    pinResetAt: { type: Date, default: null },
    pinResetBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    pinResetByName: { type: String, default: "" },
  },
  { timestamps: true },
);

export const IsmCrew =
  (mongoose.models.IsmCrew as mongoose.Model<IIsmCrew>) || mongoose.model<IIsmCrew>("IsmCrew", ismCrewSchema);
