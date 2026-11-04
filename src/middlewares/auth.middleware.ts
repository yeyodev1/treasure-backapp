import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { unauthorized, forbidden } from "../errors/httpError";
import { USER_ROLES, UserRole } from "../utils/roles";

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

/**
 * "Ver como" (4-nov-2026): Gerencia mira la app como otro rol y el servidor le
 * aplica los permisos de ese rol, así lo que no puede el bar tampoco se puede
 * desde "ver como Bar". Solo baja permisos (solo Gerencia lo usa) y nunca en
 * /auth: la sesión y su renovación siguen siendo las reales.
 */
export function asViewedRole(payload: AuthPayload, header: unknown, path: string): AuthPayload {
  const viewAs = typeof header === "string" ? header.trim() : "";
  if (payload.role !== "duena" || !viewAs || viewAs === "duena" || path.startsWith("/auth/")) return payload;
  if (!USER_ROLES.includes(viewAs as UserRole)) return payload;
  return { ...payload, role: viewAs as UserRole };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized("Sesión requerida"));
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as AuthPayload;
    req.auth = asViewedRole(payload, req.headers["x-view-as"], req.path);
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
