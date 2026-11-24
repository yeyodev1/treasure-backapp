import mongoose, { Schema, Types } from "mongoose";

/**
 * Meta o tarifa con fecha de vigencia (especificación del Resumen, 24-nov-2026):
 * cada cambio es un registro nuevo desde su fecha, así un cambio en 2027 no
 * altera las cifras de 2026. value null = meta vacía (se compara con el
 * período anterior).
 */
export interface IGoal {
  key: string;
  value: number | null;
  /** Desde cuándo rige (inicio del día en Galápagos). */
  from: Date;
  by: Types.ObjectId;
  byName: string;
  createdAt?: Date;
}

const goalSchema = new Schema<IGoal>(
  {
    key: { type: String, required: true },
    value: { type: Number, default: null },
    from: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    byName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

goalSchema.index({ key: 1, from: -1 });

export const Goal = (mongoose.models.Goal as mongoose.Model<IGoal>) || mongoose.model<IGoal>("Goal", goalSchema);
