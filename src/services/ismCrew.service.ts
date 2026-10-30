import crypto from "crypto";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { IsmCrew } from "../models/ismCrew.model";
import { User } from "../models/user.model";
import { HttpError } from "../errors/httpError";
import { POSITION_LABELS } from "../utils/roles";
import { notifyRole } from "./ismNotify.service";

/** Roles que forman la lista de tripulantes (quien llena, Capitán y Persona Designada). */
export const CREW_LIST_ROLES = ["tripulante", "capitan", "designada"] as const;

export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

export function positionLabel(code: string | undefined | null): string {
  if (!code) return "";
  return POSITION_LABELS[code as keyof typeof POSITION_LABELS] ?? code;
}

/** Ficha (se crea vacía la primera vez). */
export async function crewProfile(userId: Types.ObjectId | string) {
  return IsmCrew.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * Lista de tripulantes: cuentas activas con rol de tripulación, su cargo y si
 * están a bordo. Las cuentas compartidas (tablet del barco) no son personas:
 * solo salen en la vista de administración (`includeShared`) para marcarlas.
 */
export async function listCrew(opts: { onboardOnly?: boolean; includeInactive?: boolean; includeShared?: boolean } = {}) {
  const users = await User.find({
    role: { $in: CREW_LIST_ROLES },
    ...(opts.includeInactive ? {} : { active: true }),
    ...(opts.includeShared ? {} : { sharedDevice: { $ne: true } }),
  })
    .select("name email role position active sharedDevice")
    .sort({ name: 1 });
  const profiles = await IsmCrew.find({ user: { $in: users.map((u) => u._id) } });
  const byUser = new Map(profiles.map((p) => [p.user.toString(), p]));
  const now = Date.now();
  return users
    .map((u) => {
      const p = byUser.get(u._id.toString());
      return {
        id: u._id.toString(),
        name: u.name,
        role: u.role,
        position: u.position ?? "",
        positionLabel: positionLabel(u.position),
        active: u.active,
        // Sin correo propio: solo firma en la tablet del barco con su clave.
        hasAccount: !u.email.endsWith("@sin-cuenta.treasure.ec"),
        sharedDevice: Boolean(u.sharedDevice),
        onboard: p?.onboard ?? true,
        hasPin: Boolean(p?.pinHash),
        pinTemporary: Boolean(p?.pinTemporary),
        lockedUntil: p?.lockedUntil && p.lockedUntil.getTime() > now ? p.lockedUntil : null,
      };
    })
    .filter((c) => !opts.onboardOnly || c.onboard);
}

const pinError = (status: number, message: string, code: string, data?: Record<string, unknown>) =>
  new HttpError(status, message, code, data);

export function isValidNewPin(pin: unknown): pin is string {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) return false;
  // Ni 0000 ni 1234 ni 4321: claves que cualquiera adivina.
  if (/^(\d)\1{3}$/.test(pin)) return false;
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) return false;
  return true;
}

/**
 * Confirma la clave de quien firma. Errada: cuenta el intento; al quinto se
 * bloquea 15 minutos y se avisa a la Persona Designada. Temporal: exige
 * `newPin` y la reemplaza en el mismo paso (un solo uso).
 */
export async function verifyPin(userId: Types.ObjectId | string, pin: unknown, newPin?: unknown) {
  const profile = await crewProfile(userId);
  const now = new Date();
  if (profile.lockedUntil && profile.lockedUntil > now) {
    const minutes = Math.ceil((profile.lockedUntil.getTime() - now.getTime()) / 60000);
    throw pinError(423, `Clave bloqueada por ${minutes} min. Ya avisamos a la Persona Designada.`, "clave_bloqueada", {
      minutes,
    });
  }
  if (!profile.pinHash) {
    throw pinError(409, "Aún no tienes clave. Pide a la Persona Designada una clave temporal.", "sin_clave");
  }
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw pinError(400, "La clave tiene 4 números", "clave_formato");
  }

  const ok = await bcrypt.compare(pin, profile.pinHash);
  if (!ok) {
    const updated = await IsmCrew.findOneAndUpdate(
      { _id: profile._id },
      { $inc: { failedAttempts: 1 } },
      { new: true },
    );
    const attempts = updated?.failedAttempts ?? MAX_PIN_ATTEMPTS;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      await IsmCrew.updateOne(
        { _id: profile._id },
        { $set: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) } },
      );
      const user = await User.findById(userId).select("name position");
      await notifyRole("designada", {
        kind: "clave_bloqueada",
        title: `Clave bloqueada: ${user?.name ?? "tripulante"}`,
        body: `${MAX_PIN_ATTEMPTS} intentos fallidos. Se desbloquea sola en 15 minutos; si no la recuerda, dale una clave temporal.`,
        key: `clave_bloqueada:${userId}:${now.getTime()}`,
      });
      throw pinError(423, "Clave bloqueada por 15 min. Ya avisamos a la Persona Designada.", "clave_bloqueada", {
        minutes: 15,
      });
    }
    const left = MAX_PIN_ATTEMPTS - attempts;
    throw pinError(
      403,
      `Clave incorrecta. Te ${left === 1 ? "queda 1 intento" : `quedan ${left} intentos`}.`,
      "clave_incorrecta",
      { attemptsLeft: left },
    );
  }

  if (profile.pinTemporary) {
    if (newPin === undefined || newPin === null || newPin === "") {
      throw pinError(428, "Es tu primera firma: crea tu clave de 4 números.", "clave_temporal");
    }
    if (!isValidNewPin(newPin)) {
      throw pinError(400, "Elige otra clave: 4 números que no sean seguidos ni repetidos.", "clave_debil");
    }
    if (newPin === pin) throw pinError(400, "La clave nueva no puede ser la temporal.", "clave_debil");
    profile.pinHash = await bcrypt.hash(newPin, 10);
    profile.pinTemporary = false;
    profile.pinSetAt = now;
  }
  profile.failedAttempts = 0;
  profile.lockedUntil = null;
  await profile.save();
  return profile;
}

/** Restablecimiento de clave que se informa en el anexo (24 h antes de firmar). */
export const PIN_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Clave temporal de 4 números, de un solo uso (la ve solo la Persona Designada, una vez). */
export async function issueTemporaryPin(userId: Types.ObjectId | string, by: string, byName = "") {
  let pin = "";
  do {
    pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  } while (!isValidNewPin(pin));
  const profile = await crewProfile(userId);
  profile.pinHash = await bcrypt.hash(pin, 10);
  profile.pinTemporary = true;
  profile.pinSetAt = new Date();
  profile.failedAttempts = 0;
  profile.lockedUntil = null;
  profile.updatedBy = new Types.ObjectId(by);
  profile.pinResetAt = profile.pinSetAt;
  profile.pinResetBy = new Types.ObjectId(by);
  profile.pinResetByName = byName;
  await profile.save();
  return pin;
}

/** Cambio de clave por su dueño (sabe la actual). */
export async function changeOwnPin(userId: string, current: unknown, next: unknown) {
  if (!isValidNewPin(next)) {
    throw pinError(400, "Elige otra clave: 4 números que no sean seguidos ni repetidos.", "clave_debil");
  }
  const profile = await crewProfile(userId);
  if (profile.pinTemporary) {
    // La temporal se cambia con el mismo paso de la firma.
    await verifyPin(userId, current, next);
    return;
  }
  await verifyPin(userId, current);
  profile.pinHash = await bcrypt.hash(next, 10);
  profile.pinTemporary = false;
  profile.pinSetAt = new Date();
  await IsmCrew.updateOne(
    { _id: profile._id },
    { $set: { pinHash: profile.pinHash, pinTemporary: false, pinSetAt: profile.pinSetAt } },
  );
}
