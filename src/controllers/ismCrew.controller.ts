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
import {
  CREW_LIST_ROLES,
  changeOwnPin,
  crewProfile,
  freeUsername,
  hasRealEmail,
  issueTemporaryPin,
  isValidNewPin,
  listCrew,
  placeholderEmail,
  setPinFor,
} from "../services/ismCrew.service";
import { EMAIL_ERROR, isValidOptionalEmail } from "../utils/email";
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
    const manage = keeper && req.query.all === "1";
    const crew = await listCrew({ onboardOnly: req.query.onboard === "1", includeInactive: manage, includeShared: manage });
    res.json({ crew });
  } catch (err) {
    next(err);
  }
}

const cleanText = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/** Correo opcional: vacío = sin correo (avisos solo dentro de la app). */
async function emailFor(raw: unknown, userId?: Types.ObjectId): Promise<string | null> {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email) return null;
  if (!isValidOptionalEmail(email)) throw badRequest(EMAIL_ERROR);
  const taken = await User.exists({ email, ...(userId ? { _id: { $ne: userId } } : {}) });
  if (taken) throw badRequest("Ese correo ya lo usa otra cuenta");
  return email;
}

/** Cargo Capitán → rol de Capitán (firma el paso del Capitán); el resto, tripulante. */
const roleForPosition = (position: string) => (position === "CAP" ? "capitan" : "tripulante");

/**
 * Alta de un tripulante con nombre y apellido: se le crea un usuario
 * (nombre.apellido) para entrar con su clave de 4 números. El correo es
 * opcional: sin correo, sus avisos quedan solo dentro de la app.
 */
export async function createCrewMember(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const { firstName, lastName, email, position, onboard, pin } = req.body as {
      pin?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      position?: string;
      onboard?: boolean;
    };
    const first = cleanText(firstName);
    const last = cleanText(lastName);
    if (first.length < 2) throw badRequest("Escribe el nombre");
    if (last.length < 2) throw badRequest("Escribe el apellido");
    if (!validPosition(position)) throw badRequest("Elige el cargo");
    if (pin && !isValidNewPin(pin)) throw badRequest("La clave son 4 números que no sean seguidos ni repetidos.");
    const clean = `${first} ${last}`;
    const exists = await User.findOne({
      role: { $in: CREW_LIST_ROLES },
      active: true,
      name: { $regex: `^${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (exists) throw badRequest("Ya hay un tripulante con ese nombre en la lista");
    const realEmail = await emailFor(email);
    const user = await User.create({
      name: clean,
      email: realEmail ?? placeholderEmail(),
      username: await freeUsername(first, last),
      crewManaged: true,
      // Contraseña aleatoria que nadie conoce: entra con su usuario y su clave de 4 números.
      passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10),
      role: roleForPosition(position),
      position,
      createdBy: req.auth!.sub,
    });
    const profile = await crewProfile(user._id);
    profile.onboard = onboard !== false;
    profile.updatedBy = new Types.ObjectId(req.auth!.sub);
    await profile.save();
    if (pin) await setPinFor(user._id, pin, req.auth!.sub, req.auth!.name);
    await logEvent(req.auth, { kind: "equipo", title: `Tripulante agregado · ${user.name}`, detail: position });
    const crew = await listCrew({ includeInactive: true });
    res.status(201).json({ member: crew.find((c) => c.id === user._id.toString()) });
  } catch (err) {
    next(err);
  }
}

/** Nombre, correo, cargo, a bordo y activo. El rol de las cuentas con contraseña lo cambia Gerencia. */
export async function updateCrewMember(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const user = await User.findById(req.params.id);
    if (!user || !CREW_LIST_ROLES.includes(user.role as never)) throw notFound("Tripulante no encontrado");
    const { name, email, position, onboard, active, sharedDevice, pin } = req.body as {
      pin?: string;
      name?: string;
      email?: string;
      position?: string;
      onboard?: boolean;
      active?: boolean;
      sharedDevice?: boolean;
    };
    // Altas de Tripulantes (y las antiguas sin correo): las maneja la Persona Designada.
    const managed = Boolean(user.crewManaged) || !hasRealEmail(user.email);
    if (typeof name === "string") {
      const clean = cleanText(name, 120);
      if (clean.length < 3) throw badRequest("Escribe el nombre completo");
      user.name = clean;
    }
    if (typeof email === "string" && managed) {
      user.email = (await emailFor(email, user._id)) ?? (hasRealEmail(user.email) ? placeholderEmail() : user.email);
      user.crewManaged = true;
    }
    if (position !== undefined) {
      if (position !== "" && !validPosition(position)) throw badRequest("Cargo inválido");
      user.position = position;
      if (managed && user.role !== "designada" && position) user.role = roleForPosition(position);
    }
    if (typeof active === "boolean" && managed) user.active = active;
    // Cuenta compartida (tablet del barco): solo se marca a mano, nunca por el nombre o el correo.
    if (pin && !isValidNewPin(pin)) throw badRequest("La clave son 4 números que no sean seguidos ni repetidos.");
    if (typeof sharedDevice === "boolean") {
      if (sharedDevice && user.role !== "tripulante") throw badRequest("Solo una cuenta de tripulante puede ser la tablet compartida");
      user.sharedDevice = sharedDevice;
    }
    user.updatedBy = new Types.ObjectId(req.auth!.sub);
    await user.save();
    if (pin) {
      await setPinFor(user._id, pin, req.auth!.sub, req.auth!.name);
      await logEvent(req.auth, { kind: "equipo", title: `Clave de firma · ${user.name}` });
    }
    if (typeof onboard === "boolean") {
      const profile = await crewProfile(user._id);
      profile.onboard = onboard;
      profile.updatedBy = new Types.ObjectId(req.auth!.sub);
      await profile.save();
    }
    const crew = await listCrew({ includeInactive: true, includeShared: true });
    res.json({ member: crew.find((c) => c.id === user._id.toString()) });
  } catch (err) {
    next(err);
  }
}

/** Firma guardada de una persona de la lista, para estamparla con su clave (vacía si aún no dibujó). */
export async function crewSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await IsmCrew.findOne({ user: req.params.id }).select("signatureImage");
    res.json({ image: p?.signatureImage ?? "" });
  } catch (err) {
    next(err);
  }
}

/**
 * Firmas de la tripulación (pedido del cliente, 5-nov-2026): la Persona
 * Designada recoge la firma de cada persona (la dibuja ella misma en la
 * tablet) y queda asignada a su usuario. Desde su cuenta, «Firmar» la pone.
 */
export async function setCrewSignature(req: Request, res: Response, next: NextFunction) {
  try {
    assertKeeper(req);
    const { image } = req.body as { image?: unknown };
    if (typeof image !== "string" || !image.startsWith("data:image/png;base64,")) throw badRequest("Firma con el dedo en el recuadro");
    if (image.length > 400_000) throw badRequest("La firma es demasiado grande");
    const user = Types.ObjectId.isValid(String(req.params.id))
      ? await User.findById(req.params.id).select("name role active sharedDevice")
      : null;
    if (!user || !CREW_LIST_ROLES.includes(user.role as never) || !user.active || user.sharedDevice) {
      throw notFound("Tripulante no encontrado");
    }
    const profile = await crewProfile(user._id);
    profile.signatureImage = image;
    profile.signatureSetAt = new Date();
    await profile.save();
    await logEvent(req.auth, { kind: "equipo", title: `Firma registrada · ${user.name}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Mi firma (pedido del cliente, 8-nov-2026: «que cuando entres ya esté pre
 * establecida tu firma»): cualquier cuenta guarda la suya al firmar y las
 * siguientes veces se pone con un toque. La de un tripulante también la
 * puede registrar la Persona Designada (setCrewSignature).
 */
export async function setMySignature(req: Request, res: Response, next: NextFunction) {
  try {
    const { image } = req.body as { image?: unknown };
    if (typeof image !== "string" || !image.startsWith("data:image/png;base64,")) throw badRequest("Firma con el dedo en el recuadro");
    if (image.length > 400_000) throw badRequest("La firma es demasiado grande");
    const profile = await crewProfile(req.auth!.sub);
    profile.signatureImage = image;
    profile.signatureSetAt = new Date();
    await profile.save();
    await logEvent(req.auth, { kind: "equipo", title: `Firma registrada · ${req.auth!.name}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Clave temporal de un solo uso. Se muestra una sola vez a la Persona
 * Designada; el tripulante la cambia en su primera firma. También desbloquea.
 * Queda quién y cuándo la restableció: si fue en las 24 h previas a una
 * firma, el anexo del PDF lo dice.
 */
export async function temporaryPin(req: Request, res: Response, next: NextFunction) {
  try {
    // Persona Designada y Gerencia (9-nov: Gerencia también la da; antes solo la Designada).
    if (req.auth!.role !== "designada" && req.auth!.role !== "duena") {
      throw forbidden("La clave temporal la da la Persona Designada o Gerencia");
    }
    const user = await User.findById(req.params.id).select("name role active");
    if (!user || !CREW_LIST_ROLES.includes(user.role as never) || !user.active) {
      throw notFound("Tripulante no encontrado");
    }
    const pin = await issueTemporaryPin(user._id, req.auth!.sub, req.auth!.name);
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
