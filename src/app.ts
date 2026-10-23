import express from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { env } from "./config/env";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "https://teseturis.app",
  "https://www.teseturis.app",
  "https://registros.teseturis.app",
  ...env.CORS_ORIGINS,
];

/** Previews de Vercel y túneles de desarrollo: permitidos. */
const allowedPatterns: RegExp[] = [
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i,
  /^https:\/\/[a-z0-9-]+\.bakano\.ec$/i,
];

function isOriginAllowed(origin: string): boolean {
  if (whitelist.includes(origin)) return true;
  return allowedPatterns.some((p) => p.test(origin));
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

export function createApp() {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "5mb" }));

  app.get("/", (_req, res) => {
    res.send("Treasure API viva");
  });

  routerApi(app);

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}
