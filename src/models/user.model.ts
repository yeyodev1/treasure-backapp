import mongoose, { Schema, Types } from "mongoose";
import { CREW_POSITIONS, USER_ROLES, UserRole } from "../utils/roles";

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  /** Dirección solo cobra si administración la designa como cajera. */
  isCashier: boolean;
  /** Cargo a bordo (registros ISM): CAP, TIM_01, MAQ… */
  position: string;
  /**
   * Cuenta compartida de un dispositivo (p. ej. la tablet del barco): no es
   * una persona, así que no aparece para elegir quién hace el chequeo ni
   * firma. Se marca a mano en Tripulantes; nunca se deduce del nombre.
   */
  sharedDevice?: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: USER_ROLES, required: true },
    active: { type: Boolean, default: true },
    isCashier: { type: Boolean, default: false },
    position: { type: String, enum: ["", ...CREW_POSITIONS], default: "" },
    sharedDevice: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export const User =
  (mongoose.models.User as mongoose.Model<IUser>) || mongoose.model<IUser>("User", userSchema);
