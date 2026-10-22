import mongoose from "mongoose";
import { env } from "./env";

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Conexión tolerante a serverless: reutiliza la conexión viva si existe. */
export async function dbConnect(): Promise<boolean> {
  if (isConnected()) return false;
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  return true;
}
