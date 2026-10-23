import mongoose, { Schema } from "mongoose";

/**
 * Configuración del ciclo de salidas (guía V3): A sábado→martes,
 * B martes→sábado, C sábado→sábado, y vuelve a A.
 */
export interface ICycleLeg {
  code: string;
  label: string;
  routeFrom: string;
  routeTo: string;
  durationDays: number;
  departureTime: string;
}

export interface ICycleSettings {
  key: string;
  legs: ICycleLeg[];
  cabinCount: number;
}

export const DEFAULT_LEGS: ICycleLeg[] = [
  {
    code: "A",
    label: "Sábado a martes",
    routeFrom: "Baltra",
    routeTo: "San Cristóbal",
    durationDays: 3,
    departureTime: "10:00",
  },
  {
    code: "B",
    label: "Martes a sábado",
    routeFrom: "San Cristóbal",
    routeTo: "Puerto Ayora",
    durationDays: 4,
    departureTime: "10:00",
  },
  {
    code: "C",
    label: "Sábado a sábado",
    routeFrom: "Puerto Ayora",
    routeTo: "Baltra",
    durationDays: 7,
    departureTime: "10:00",
  },
];

const legSchema = new Schema<ICycleLeg>(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    routeFrom: { type: String, required: true },
    routeTo: { type: String, required: true },
    durationDays: { type: Number, required: true, min: 1 },
    departureTime: { type: String, default: "10:00" },
  },
  { _id: false },
);

const cycleSettingsSchema = new Schema<ICycleSettings>(
  {
    key: { type: String, default: "main", unique: true },
    legs: { type: [legSchema], default: () => DEFAULT_LEGS },
    cabinCount: { type: Number, default: 9, min: 1 },
  },
  { timestamps: true },
);

export const CycleSettings =
  (mongoose.models.CycleSettings as mongoose.Model<ICycleSettings>) ||
  mongoose.model<ICycleSettings>("CycleSettings", cycleSettingsSchema);
