import mongoose, { Schema, Types } from "mongoose";

/**
 * Calendario de rotación (especificación ISM, 25-nov-2026, sección 9;
 * módulo aparte, solo Gerencia). Una fila por puesto y una barra por turno
 * con su subida y bajada. De aquí sale el «de turno» del ISM, el «abordo /
 * en tierra» de Tripulantes y el R-07 de cada relevo.
 */
export interface IIsmRotationPost {
  label: string;
  /** Cargo de la app (CAP, MAQ, DIR, COC, AuxCOC, BAR, TIM_01…). */
  position: string;
  order: number;
  active: boolean;
}

export interface IIsmRotationTurn {
  post: Types.ObjectId;
  /** null = sin reemplazo (se marca en rojo). */
  user: Types.ObjectId | null;
  /** Sube y baja (AAAA-MM-DD, ambos días incluidos). */
  from: string;
  to: string;
  /** Días agregados con «Extender 1 semana». */
  extendedDays: number;
  updatedBy: Types.ObjectId | null;
}

const postSchema = new Schema<IIsmRotationPost>(
  {
    label: { type: String, required: true, trim: true },
    position: { type: String, default: "" },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const turnSchema = new Schema<IIsmRotationTurn>(
  {
    post: { type: Schema.Types.ObjectId, ref: "IsmRotationPost", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    from: { type: String, required: true },
    to: { type: String, required: true },
    extendedDays: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
turnSchema.index({ post: 1, from: 1 });

export const IsmRotationPost =
  (mongoose.models.IsmRotationPost as mongoose.Model<IIsmRotationPost>) ||
  mongoose.model<IIsmRotationPost>("IsmRotationPost", postSchema);

export const IsmRotationTurn =
  (mongoose.models.IsmRotationTurn as mongoose.Model<IIsmRotationTurn>) ||
  mongoose.model<IIsmRotationTurn>("IsmRotationTurn", turnSchema);
