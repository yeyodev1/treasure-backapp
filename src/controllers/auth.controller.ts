import { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { IUser, User } from "../models/user.model";
import { badRequest, HttpError, unauthorized } from "../errors/httpError";
import { IsmCrew } from "../models/ismCrew.model";
import { LOGIN_CARGOS } from "../utils/roles";
import { Types } from "mongoose";
import { CREW_LIST_ROLES, verifyPin } from "../services/ismCrew.service";

function signToken(user: IUser & { _id: Types.ObjectId }, remember: boolean): string {
  return jwt.sign(
    { sub: user._id.toString(), name: user.name, role: user.role, remember },
    env.JWT_SECRET,
    { expiresIn: remember ? env.JWT_REMEMBER_EXPIRES_IN : env.JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

function publicUser(user: IUser & { _id: Types.ObjectId }) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isCashier: user.isCashier,
    position: user.position,
  };
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, remember } = req.body as {
      email?: string;
      password?: string;
      remember?: boolean;
    };
    if (!email || !password) throw badRequest("Correo y contraseña son obligatorios");

    const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw unauthorized("Credenciales incorrectas");
    }

    res.json({ token: signToken(user, Boolean(remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/**
 * Tripulación: entra eligiendo su cargo (área → cargo) y su clave de 4
 * números, o con su usuario (nombre.apellido) y la clave. Misma clave y mismo
 * bloqueo que al firmar (5 intentos → 15 min). Con clave temporal pide crear
 * la propia en el mismo paso (`newPin`).
 */
export async function crewLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { username, cargo, pin, newPin, remember } = req.body as {
      username?: string;
      cargo?: string;
      pin?: string;
      newPin?: string;
      remember?: boolean;
    };
    const crew = { active: true, role: { $in: CREW_LIST_ROLES }, sharedDevice: { $ne: true } };
    let user: (IUser & { _id: Types.ObjectId }) | null;
    if (typeof cargo === "string" && cargo) {
      const positions = Object.hasOwn(LOGIN_CARGOS, cargo) ? LOGIN_CARGOS[cargo]! : [];
      user = await userByPin(await User.find({ ...crew, position: { $in: positions } }).sort({ name: 1 }), pin);
    } else {
      if (typeof username !== "string" || !username.trim()) throw badRequest("Escribe tu usuario");
      user = await User.findOne({ ...crew, username: username.toLowerCase().trim() });
      if (!user) throw unauthorized("Usuario o clave incorrectos");
    }
    await verifyPin(user._id, pin, newPin);
    res.json({ token: signToken(user, Boolean(remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/**
 * De quién es la clave entre las personas de un cargo. Si no es de nadie, el
 * intento fallido se le cuenta a todas (mismo bloqueo que con usuario): sin
 * eso la clave de 4 números se adivinaría probando.
 */
async function userByPin(
  candidates: Array<IUser & { _id: Types.ObjectId }>,
  pin: unknown,
  empty = "Nadie tiene ese cargo todavía. Pide a la Persona Designada que te registre.",
) {
  if (!candidates.length) throw unauthorized(empty);
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw badRequest("La clave tiene 4 números");
  const now = new Date();
  const profiles = await IsmCrew.find({ user: { $in: candidates.map((c) => c._id) } });
  const live = profiles.filter((p) => p.pinHash && !(p.lockedUntil && p.lockedUntil > now));
  let matches: typeof live = [];
  for (const p of live) if (await bcrypt.compare(pin, p.pinHash)) matches.push(p);
  // Dos personas del cargo con la misma clave: decide quién está a bordo.
  if (matches.length > 1) matches = matches.filter((p) => p.onboard);
  if (matches.length === 1) return candidates.find((c) => c._id.equals(matches[0]!.user))!;
  if (matches.length > 1) {
    throw new HttpError(409, "Esa clave la usa más de una persona de este cargo. Entra por Gerencia con tu usuario y cambia tu clave.", "clave_repetida");
  }
  // Nadie coincide: verifyPin cuenta el intento (o dice «bloqueada» / «sin clave») y lanza el error.
  const targets = live.length ? live.map((p) => p.user) : [candidates[0]!._id];
  let first: unknown;
  for (const id of targets) await verifyPin(id, pin).catch((err) => (first ??= err));
  throw first ?? unauthorized("Clave incorrecta");
}

/** Departamentos del bar: se entra eligiendo uno y con la clave de 4 números (pedido del cliente, 12-nov-2026). */
const BAR_DEPARTMENTS = ["bartender", "direccion", "bodega", "admin", "duena"];

export async function departmentLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { department, pin, remember } = req.body as { department?: string; pin?: string; remember?: boolean };
    if (typeof department !== "string" || !BAR_DEPARTMENTS.includes(department)) throw badRequest("Elige tu departamento");
    const candidates = await User.find({ active: true, role: department }).sort({ name: 1 });
    const noPin = "Nadie de ese departamento tiene clave todavía. Pídela a Gerencia.";
    const user = await userByPin(candidates, pin, noPin).catch((err) => {
      // El aviso de ISM habla de la Persona Designada: en el bar la clave la pone Gerencia.
      throw err instanceof HttpError && err.code === "sin_clave" ? unauthorized(noPin) : err;
    });
    await verifyPin(user._id, pin);
    res.json({ token: signToken(user, Boolean(remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.auth!.sub).select("name email role active isCashier position");
    if (!user || !user.active) throw unauthorized();
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/**
 * Sesión deslizante: mientras la tableta se usa, el token se renueva con la
 * misma duración (12 h o 30 días) y el rol vigente del usuario.
 */
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.auth!.sub).select("name email role active isCashier position");
    if (!user || !user.active) throw unauthorized();
    res.json({ token: signToken(user, Boolean(req.auth!.remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}
