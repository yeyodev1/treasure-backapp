import { Types } from "mongoose";
import { IsmRotationPost, IsmRotationTurn } from "../models/ismRotation.model";
import { addDays } from "./ismFrequency.service";

/**
 * Calendario de rotación (especificación ISM, 25-nov-2026, sección 9). Cada
 * puesto tiene dos personas que rotan; lo que firma un cargo va a quien esté
 * de turno. Lógica pura (turnos ya cargados) + consultas a la base.
 */
export interface TurnLike {
  _id?: unknown;
  post: unknown;
  user: unknown;
  from: string;
  to: string;
}

const id = (v: unknown) => (v ? String((v as { _id?: unknown })._id ?? v) : "");

/** Turnos que cubren un día. */
export function turnsOn<T extends TurnLike>(turns: T[], day: string): T[] {
  return turns.filter((t) => t.from <= day && day <= t.to);
}

/**
 * Tramos sin persona entre `from` y `to` de un puesto: días sin turno o con
 * turno «sin reemplazo» (se marcan en rojo).
 */
export function gapsOf(turns: TurnLike[], from: string, to: string): Array<{ from: string; to: string }> {
  const gaps: Array<{ from: string; to: string }> = [];
  let start: string | null = null;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const covered = turns.some((t) => t.user && t.from <= day && day <= t.to);
    if (!covered && !start) start = day;
    if (covered && start) {
      gaps.push({ from: start, to: addDays(day, -1) });
      start = null;
    }
  }
  if (start) gaps.push({ from: start, to });
  return gaps;
}

/** Relevos: el día que sube el siguiente de un puesto, con el saliente y el entrante. */
export function relevosOf<T extends TurnLike>(turns: T[]): Array<{ day: string; out: T; in: T }> {
  const byPost = new Map<string, T[]>();
  for (const t of turns) byPost.set(id(t.post), [...(byPost.get(id(t.post)) ?? []), t]);
  const out: Array<{ day: string; out: T; in: T }> = [];
  for (const list of byPost.values()) {
    const sorted = [...list].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      if (prev.user && next.user && id(prev.user) !== id(next.user)) out.push({ day: next.from, out: prev, in: next });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** Extender un turno una semana: baja 7 días después y el siguiente sube 7 días después. */
export function extendWeek<T extends TurnLike>(turn: T, next: T | null): { turn: T; next: T | null } {
  const moved = { ...turn, to: addDays(turn.to, 7) };
  if (!next || next.from > addDays(turn.to, 1)) return { turn: moved, next };
  return { turn: moved, next: { ...next, from: addDays(next.from, 7), to: next.to < addDays(next.from, 7) ? addDays(next.from, 7) : next.to } };
}

// ---- Base ----

/** Personas de turno hoy en unos cargos (Capitán, Timonel 1…). Vacío si no hay calendario cargado. */
export async function onDutyUsers(positions: string[], day: string): Promise<Types.ObjectId[]> {
  const posts = await IsmRotationPost.find({ active: true, position: { $in: positions } }).select("_id");
  if (!posts.length) return [];
  const turns = await IsmRotationTurn.find({ post: { $in: posts.map((p) => p._id) }, from: { $lte: day }, to: { $gte: day }, user: { $ne: null } }).select("user");
  return turns.map((t) => t.user!) as Types.ObjectId[];
}

/** ¿Hay calendario cargado para estos cargos? Sin calendario se usa «abordo» de Tripulantes. */
export async function hasRotation(positions: string[]): Promise<boolean> {
  return Boolean(await IsmRotationPost.exists({ active: true, position: { $in: positions } }));
}
