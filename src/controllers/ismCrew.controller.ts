import crypto from "crypto";
import bcrypt from "bcryptjs";
import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { User } from "../models/user.model";
import { IsmCrew } from "../models/ismCrew.model";
import { IsmNotice } from "../models/ismNotice.model";
import { badRequest, forbidden, notFound } from "../errors/httpError";
import { CREW_POSITIONS } from "../utils/roles";
import { logEvent } from "../services/audit.service";
import { CREW_LIST_ROLES, changeOwnPin, crewProfile, issueTemporaryPin, listCrew } from "../services/ismCrew.service";
import { sweepOverdue } from "../services/ismNotify.service";

/**
 * Lista de tripulantes y claves de firma (informe R-14 del 29-oct). La
 * mantiene la Persona Designada: alta de tripulantes, cargo, a bordo y clave
 * temporal. Gerencia también puede (requireRole la deja pasar siempre).
 */
function assertKeeper(req: Request) {
  const role = req.auth!.role;
  if (role !== "designada" && role !== "duena") {
    throw forbidden("La lista de tripulantes la mantiene la Persona Designada");
  }
}

const validPosition = (p: unknown): p is string => typeof p === "string" && CREW_POSITIONS.includes(p as never);

/** Lista para elegir quién hace el chequeo (todos) y para administrarla (Persona Designada). */
export async function listCrewMembers(req: Request, res: Response, next: NextFunction) {
  try {
    const keeper = req.auth!.role === "designada" || req.auth!.role === "duena";
    const crew = await listCrew({ onboardOnly: req.query.onboard === "1", includeInactive: keeper && req.query.all === "1" });
    res.json({ crew });
  } catch (err) {
    next(err);
  }
}

/**
 * Alta de un tripulante. Sin correo, la persona no inicia sesión: firma en
 * la tablet del barco eligiéndose de la lista y poniendo su clave.
 */
export async function createCrewMember(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const { name, position, onboard } = req.body as { name?: string; position?: string; onboard?: boolean };
    const clean = (name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (clean.length < 3) throw badRequest("Escribe el nombre completo");
    if (!validPosition(position)) throw badRequest("Elige el cargo");
    const exists = await User.findOne({
      role: { $in: CREW_LIST_ROLES },
      active: true,
      name: { $regex: `^${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (exists) throw badRequest("Ya hay un tripulante con ese nombre en la lista");
    const user = await User.create({
      name: clean,
      email: `tripulante-${crypto.randomUUID()}@sin-cuenta.treasure.ec`,
      // Contraseña aleatoria que nadie conoce: esta persona no inicia sesión.
      passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10),
      role: "tripulante",
      position,
      createdBy: req.auth!.sub,
    });
    const profile = await crewProfile(user._id);
    profile.onboard = onboard !== false;
    profile.updatedBy = new Types.ObjectId(req.auth!.sub);
    await profile.save();
    await logEvent(req.auth, { kind: "equipo", title: `Tripulante agregado · ${user.name}`, detail: position });
    const crew = await listCrew({ includeInactive: true });
    res.status(201).json({ member: crew.find((c) => c.id === user._id.toString()) });
  } catch (err) {
    next(err);
  }
}

/** Nombre, cargo, a bordo y activo. El rol de las cuentas lo cambia Gerencia. */
export async function updateCrewMember(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const user = await User.findById(req.params.id);
    if (!user || !CREW_LIST_ROLES.includes(user.role as never)) throw notFound("Tripulante no encontrado");
    const { name, position, onboard, active } = req.body as {
      name?: string;
      position?: string;
      onboard?: boolean;
      active?: boolean;
    };
    if (typeof name === "string") {
      const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
      if (clean.length < 3) throw badRequest("Escribe el nombre completo");
      user.name = clean;
    }
    if (position !== undefined) {
      if (position !== "" && !validPosition(position)) throw badRequest("Cargo inválido");
      user.position = position;
    }
    // Solo se desactiva a quien no tiene cuenta propia (las cuentas las maneja Gerencia).
    if (typeof active === "boolean" && user.email.endsWith("@sin-cuenta.treasure.ec")) user.active = active;
    user.updatedBy = new Types.ObjectId(req.auth!.sub);
    await user.save();
    if (typeof onboard === "boolean") {
      const profile = await crewProfile(user._id);
      profile.onboard = onboard;
      profile.updatedBy = new Types.ObjectId(req.auth!.sub);
      await profile.save();
    }
    const crew = await listCrew({ includeInactive: true });
    res.json({ member: crew.find((c) => c.id === user._id.toString()) });
  } catch (err) {
    next(err);
  }
}

/**
 * Clave temporal de un solo uso. Se muestra una sola vez a la Persona
 * Designada; el tripulante la cambia en su primera firma. También desbloquea.
 */
export async function temporaryPin(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const user = await User.findById(req.params.id).select("name role active");
    if (!user || !CREW_LIST_ROLES.includes(user.role as never) || !user.active) {
      throw notFound("Tripulante no encontrado");
    }
    const pin = await issueTemporaryPin(user._id, req.auth!.sub);
    await logEvent(req.auth, { kind: "equipo", title: `Clave temporal de firma · ${user.name}` });
    res.json({ pin, name: user.name });
  } catch (err) {
    next(err);
  }
}

/** Estado de la clave propia (Capitán y Persona Designada antes de firmar). */
export async function myPin(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await IsmCrew.findOne({ user: req.auth!.sub });
    res.json({
      hasPin: Boolean(p?.pinHash),
      pinTemporary: Boolean(p?.pinTemporary),
      lockedUntil: p?.lockedUntil && p.lockedUntil > new Date() ? p.lockedUntil : null,
    });
  } catch (err) {
    next(err);
  }
}

export async function changeMyPin(req: Request, res: Response, next: NextFunction) {
  try {
    const { current, next: nextPin } = req.body as { current?: string; next?: string };
    await changeOwnPin(req.auth!.sub, current, nextPin);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---- Avisos dentro de la app ----

export async function listNotices(req: Request, res: Response, next: NextFunction) {
  try {
    await sweepOverdue();
    const to = new Types.ObjectId(req.auth!.sub);
    const [notices, unread] = await Promise.all([
      IsmNotice.find({ to }).sort({ createdAt: -1 }).limit(30),
      IsmNotice.countDocuments({ to, readAt: null }),
    ]);
    res.json({ notices, unread });
  } catch (err) {
    next(err);
  }
}

export async function readNotices(req: Request, res: Response, next: NextFunction) {
  try {
    const { ids } = req.body as { ids?: string[] };
    const to = new Types.ObjectId(req.auth!.sub);
    const filter =
      Array.isArray(ids) && ids.length
        ? { to, _id: { $in: ids.filter((i) => Types.ObjectId.isValid(i)) } }
        : { to, readAt: null };
    await IsmNotice.updateMany(filter, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
