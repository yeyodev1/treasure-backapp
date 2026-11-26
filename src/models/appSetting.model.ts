import mongoose, { Schema } from "mongoose";

/**
 * Ajuste de la app que no es una cifra (las cifras van en metas, con vigencia).
 * Hoy: responsable de compras de Bar-stock (por defecto Administración; Gerencia
 * lo cambia por una semana o de forma fija, especificación del 24-nov-2026).
 */
export interface IAppSetting {
  key: string;
  value: Record<string, unknown>;
  updatedByName: string;
  updatedAt?: Date;
}

const appSettingSchema = new Schema<IAppSetting>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: {} },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true },
);

export const AppSetting =
  (mongoose.models.AppSetting as mongoose.Model<IAppSetting>) || mongoose.model<IAppSetting>("AppSetting", appSettingSchema);
