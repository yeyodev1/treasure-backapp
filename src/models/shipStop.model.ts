import mongoose, { Schema, Types } from "mongoose";

/**
 * Barco parado (pedido de Gerencia, 17-nov-2026): una «para» es una salida
 * que no se hace; «dique» es el barco en reparación (~2 meses). Sale en el
 * registro de cruceros y en el resumen del año.
 */
export const SHIP_STOP_KINDS = ["para", "dique"] as const;
export type ShipStopKind = (typeof SHIP_STOP_KINDS)[number];

export interface IShipStop {
  kind: ShipStopKind;
  /** Días completos en Galápagos, guardados a mediodía (como los pagos de comisión). */
  from: Date;
  to: Date;
  note: string;
  createdBy: Types.ObjectId;
  createdByName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const shipStopSchema = new Schema<IShipStop>(
  {
    kind: { type: String, enum: SHIP_STOP_KINDS, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    note: { type: String, default: "", trim: true, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

shipStopSchema.index({ from: 1 });

export const ShipStop =
  (mongoose.models.ShipStop as mongoose.Model<IShipStop>) ||
  mongoose.model<IShipStop>("ShipStop", shipStopSchema);
