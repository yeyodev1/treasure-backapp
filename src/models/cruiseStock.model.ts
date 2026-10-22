import mongoose, { Schema, Types } from "mongoose";

/**
 * Stock a bordo por crucero. Se carga al inicio del viaje (desde bodega)
 * y cada venta, merma o cortesía lo descuenta en tiempo real.
 */
export interface ICruiseStock {
  cruise: Types.ObjectId;
  product: Types.ObjectId;
  initialQty: number;
  currentQty: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const cruiseStockSchema = new Schema<ICruiseStock>(
  {
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    initialQty: { type: Number, required: true, min: 0 },
    currentQty: { type: Number, required: true },
  },
  { timestamps: true },
);

cruiseStockSchema.index({ cruise: 1, product: 1 }, { unique: true });

export const CruiseStock =
  (mongoose.models.CruiseStock as mongoose.Model<ICruiseStock>) ||
  mongoose.model<ICruiseStock>("CruiseStock", cruiseStockSchema);
