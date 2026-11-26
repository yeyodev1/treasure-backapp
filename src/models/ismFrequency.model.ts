import mongoose, { Schema, Types } from "mongoose";

/**
 * Frecuencias y avisos de cada R (especificación ISM, 25-nov-2026,
 * sección 8). Solo Gerencia las cambia; la PD las ve. Un cambio rige desde
 * la fecha elegida: la regla anterior queda en `previous` para medir lo de
 * antes, sin atrasos hacia atrás. Sin documento, vale el valor inicial de
 * services/ismFrequency.service.ts.
 */
export const FREQUENCY_KINDS = [
  "diaria",
  "zarpe",
  "crucero",
  "semanal",
  "mensual",
  "trimestral",
  "semestral",
  "anual",
  "por_equipo",
  "evento",
  "cuando_ocurre",
] as const;
export type FrequencyKind = (typeof FREQUENCY_KINDS)[number];

export interface IFrequencyRule {
  kind: FrequencyKind;
  /** Semanal: día (1 lunes … 7 domingo). */
  weekday?: number | null;
  /** Mensual: día del mes. */
  day?: number | null;
  /** Cuando ocurre: días para cerrarlo (0 = sin plazo). */
  closeDays?: number | null;
  /** Uno por persona (R-23) o por cargo (R-22). */
  per?: "" | "persona" | "cargo";
  /** Texto de la frecuencia como la ve Gerencia («Al ingresar · revisión anual»). */
  label: string;
  /** Cuándo avisar: días antes del vencimiento (null = sin aviso previo) y su texto. */
  warnDays: number | null;
  warn: string;
  /** «Si vence, avisa a» (texto de la pantalla). */
  escalate: string;
}

export interface IIsmFrequency {
  code: string;
  rule: IFrequencyRule;
  effectiveFrom: string;
  previous: Array<IFrequencyRule & { effectiveFrom: string; until: string }>;
  updatedBy: Types.ObjectId | null;
  updatedByName: string;
}

const ruleFields = {
  kind: { type: String, enum: FREQUENCY_KINDS, required: true },
  weekday: { type: Number, default: null },
  day: { type: Number, default: null },
  closeDays: { type: Number, default: null },
  per: { type: String, default: "" },
  label: { type: String, default: "" },
  warnDays: { type: Number, default: null },
  warn: { type: String, default: "" },
  escalate: { type: String, default: "" },
};

const frequencySchema = new Schema<IIsmFrequency>(
  {
    code: { type: String, required: true, unique: true },
    rule: { type: new Schema(ruleFields, { _id: false }), required: true },
    effectiveFrom: { type: String, required: true },
    previous: {
      type: [new Schema({ ...ruleFields, effectiveFrom: String, until: String }, { _id: false })],
      default: [],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

export const IsmFrequency =
  (mongoose.models.IsmFrequency as mongoose.Model<IIsmFrequency>) ||
  mongoose.model<IIsmFrequency>("IsmFrequency", frequencySchema);
