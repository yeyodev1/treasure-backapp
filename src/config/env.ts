import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 8200),
  MONGODB_URI: required("MONGODB_URI", "mongodb://127.0.0.1:27017/treasure"),
  JWT_SECRET: required("JWT_SECRET", "treasure-dev-secret-cambiar-en-produccion"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "12h",
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  /** URL pública del frontend: se usa para armar los links de cuenta (QR). */
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? "http://localhost:5173",
  /** Credenciales de Contífico: quedan vacías hasta que la clienta contrate el plan con API. */
  CONTIFICO_API_KEY: process.env.CONTIFICO_API_KEY ?? "",
  CONTIFICO_API_TOKEN: process.env.CONTIFICO_API_TOKEN ?? "",
  CONTIFICO_POS_ID: process.env.CONTIFICO_POS_ID ?? "",
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  EMAIL_FROM: process.env.EMAIL_FROM ?? "Treasure <no-reply@bakano.ec>",
  /** Archivos y fotos (logos, recursos, comprobantes). */
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ?? "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET ?? "",
};
