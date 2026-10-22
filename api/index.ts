import "dotenv/config";
import type { Express } from "express";
import { dbConnect, isConnected } from "../src/config/mongo";
import { createApp } from "../src/app";

/**
 * Entrada para Vercel. El arranque se guarda como promesa para que dos
 * peticiones simultáneas en una instancia fría esperen la misma conexión,
 * y se reintenta si la conexión murió con la instancia viva.
 */
let arranque: Promise<Express> | null = null;

async function ensureApp(): Promise<Express> {
  if (!arranque) {
    arranque = (async () => {
      await dbConnect();
      return createApp().app;
    })().catch((error) => {
      arranque = null;
      throw error;
    });
  }

  const app = await arranque;

  if (!isConnected()) {
    await dbConnect();
  }

  return app;
}

export default async function handler(req: any, res: any) {
  try {
    const application = await ensureApp();
    application(req, res);
  } catch (error) {
    console.error("[api] no se pudo iniciar la aplicación:", error);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "Servicio no disponible. Intenta de nuevo." }));
  }
}
