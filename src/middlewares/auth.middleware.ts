import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { unauthorized, forbidden } from "../errors/httpError";
import { UserRole } from "../utils/roles";

export interface AuthPayload {
  sub: string;
  name: string;
  role: UserRole;
  /** "Mantener sesión en esta tableta": la renovación conserva la duración larga. */
  remember?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized("Sesión requerida"));
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    next(unauthorized("Sesión caducada o inválida"));
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    // Gerencia puede todo lo que pueden los demás roles.
    if (req.auth.role !== "duena" && !roles.includes(req.auth.role)) {
      next(forbidden());
      return;
    }
    next();
  };
}
