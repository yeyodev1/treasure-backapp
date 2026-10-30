import { NextFunction, Request, Response } from "express";
import { HttpError } from "../errors/httpError";

export function globalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, code: err.code, ...(err.data ?? {}) });
    return;
  }

  console.error("[error no controlado]", err);
  res.status(500).json({ message: "No se pudo completar por un fallo del servidor. Inténtalo de nuevo." });
}
