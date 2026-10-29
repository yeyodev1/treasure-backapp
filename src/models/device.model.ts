import mongoose, { Schema, Types } from "mongoose";

/**
 * Tablet del bar: cada una avisa cuántos consumos tiene sin confirmar y
 * cuándo sincronizó por última vez. Finalizar el crucero lo muestra.
 */
export interface IDevice {
  deviceId: string;
  label: string;
  user: Types.ObjectId | null;
  userName: string;
  cruise: Types.ObjectId | null;
  pending: number;
  lastSyncAt: Date | null;
  lastSeenAt: Date;
}

const deviceSchema = new Schema<IDevice>({
  deviceId: { type: String, required: true, unique: true },
  label: { type: String, default: "" },
  user: { type: Schema.Types.ObjectId, ref: "User", default: null },
  userName: { type: String, default: "" },
  cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
  pending: { type: Number, default: 0, min: 0 },
  lastSyncAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: () => new Date() },
});

export const Device =
  (mongoose.models.Device as mongoose.Model<IDevice>) ||
  mongoose.model<IDevice>("Device", deviceSchema);
