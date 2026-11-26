import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { FREQUENCY_KINDS, IFrequencyRule, IsmFrequency } from "../models/ismFrequency.model";
import { IsmRotationPost, IsmRotationTurn } from "../models/ismRotation.model";
import { User } from "../models/user.model";
import { badRequest, forbidden, notFound } from "../errors/httpError";
import { logEvent } from "../services/audit.service";
import { isDateKey, ismCatalog } from "../services/ism.service";
import { DEFAULT_RULES, FREQUENCY_CODES, frequencyRules } from "../services/ismFrequency.service";
import { addDays } from "../services/ismFrequency.service";
import { extendWeek, gapsOf, relevosOf } from "../services/ismRotation.service";
import { CREW_POSITIONS, POSITION_LABELS } from "../utils/roles";
import { todayKey } from "../services/ismSigners.service";

/**
 * Pantallas de Gerencia del ISM (especificación ISM, 25-nov-2026):
 * Frecuencias y avisos (sección 8: solo Gerencia edita, la PD ve) y
 * Calendario de rotación (sección 9: módulo aparte, solo Gerencia).
 */

const titleOf = (code: string) => ismCatalog().find((f) => f.code === code || f.code.startsWith(`${code}_`))?.title ?? code;

export async function listFrequencies(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.auth!.role !== "duena" && req.auth!.role !== "designada") throw forbidden("Las frecuencias las ve la Persona Designada y las edita Gerencia");
    const rules = await frequencyRules();
    res.json({
      canEdit: req.auth!.role === "duena",
      kinds: FREQUENCY_KINDS,
      frequencies: rules.map((r) => ({ ...r, title: titleOf(r.code), initial: DEFAULT_RULES[r.code] })),
    });
  } catch (err) {
    next(err);
  }
}

const int = (v: unknown, min: number, max: number) =>
  v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : NaN;
const text = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Gerencia cambia la frecuencia de un R; rige desde la fecha elegida (lo anterior se mide con la regla anterior). */
export async function updateFrequency(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.auth!.role !== "duena") throw forbidden("Solo Gerencia cambia las frecuencias");
    const code = String(req.params.code);
    if (!FREQUENCY_CODES.includes(code)) throw notFound("Formato no encontrado");
    const body = req.body as Partial<IFrequencyRule> & { effectiveFrom?: string };
    if (!FREQUENCY_KINDS.includes(body.kind as never)) throw badRequest("Elige la frecuencia");
    if (!isDateKey(body.effectiveFrom)) throw badRequest("Elige desde qué fecha rige");
    const rule: IFrequencyRule = {
      kind: body.kind!,
      weekday: int(body.weekday, 1, 7),
      day: int(body.day, 1, 31),
      closeDays: int(body.closeDays, 0, 365),
      per: body.per === "persona" || body.per === "cargo" ? body.per : "",
      label: text(body.label) || body.kind!,
      warnDays: int(body.warnDays, 0, 365),
      warn: text(body.warn) || "—",
      escalate: text(body.escalate),
    };
    if ([rule.weekday, rule.day, rule.closeDays, rule.warnDays].some((n) => Number.isNaN(n))) throw badRequest("Revisa los números");
    const current = (await frequencyRules()).find((r) => r.code === code)!;
    const doc = (await IsmFrequency.findOne({ code })) ?? new IsmFrequency({ code, rule: current.rule, effectiveFrom: current.effectiveFrom, previous: [] });
    // La regla anterior queda para medir lo de antes de la fecha nueva (sin atrasos hacia atrás).
    doc.previous.push({ ...current.rule, effectiveFrom: current.effectiveFrom, until: addDays(body.effectiveFrom!, -1) });
    doc.rule = rule;
    doc.effectiveFrom = body.effectiveFrom!;
    doc.updatedBy = new Types.ObjectId(req.auth!.sub);
    doc.updatedByName = req.auth!.name;
    doc.markModified("rule");
    await doc.save();
    await logEvent(req.auth, { kind: "registro", title: `Frecuencia ${code}`, detail: `${rule.label} · rige desde ${body.effectiveFrom}` });
    res.json({ frequency: (await frequencyRules()).find((r) => r.code === code) });
  } catch (err) {
    next(err);
  }
}

// ---- Calendario de rotación ----

function assertOwner(req: Request) {
  if (req.auth!.role !== "duena") throw forbidden("El calendario de rotación lo ve y edita Gerencia");
}

/** Puestos y turnos de un rango (por defecto 10 semanas desde el lunes de esta semana), con alertas. */
export async function rotation(req: Request, res: Response, next: NextFunction) {
  try {
    assertOwner(req);
    const today = todayKey();
    const from = isDateKey(req.query.from) ? String(req.query.from) : addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    const to = isDateKey(req.query.to) ? String(req.query.to) : addDays(from, 69);
    const posts = await IsmRotationPost.find({ active: true }).sort({ order: 1, createdAt: 1 });
    const turns = await IsmRotationTurn.find({ post: { $in: posts.map((p) => p._id) }, to: { $gte: from }, from: { $lte: to } })
      .populate("user", "name")
      .sort({ from: 1 });
    const alerts: Array<{ kind: "sin_reemplazo" | "extension" | "relevo"; text: string; day: string }> = [];
    for (const p of posts) {
      const mine = turns.filter((t) => String(t.post) === String(p._id));
      for (const g of gapsOf(mine, from, to)) alerts.push({ kind: "sin_reemplazo", day: g.from, text: `${p.label} · ${g.from} a ${g.to}` });
      for (const t of mine.filter((x) => x.extendedDays > 0)) {
        alerts.push({ kind: "extension", day: t.to, text: `${p.label} ${(t.user as unknown as { name?: string })?.name ?? ""} · ${t.extendedDays / 7} semana(s) más` });
      }
    }
    for (const r of relevosOf(turns).filter((x) => x.day >= today && x.day <= to)) {
      const post = posts.find((p) => String(p._id) === String(r.in.post));
      alerts.push({ kind: "relevo", day: r.day, text: `${post?.label ?? ""}: el ${r.day} se crea el R-07 para firmar` });
    }
    res.json({
      from,
      to,
      today,
      posts,
      turns,
      alerts: alerts.sort((a, b) => a.day.localeCompare(b.day)),
      positions: CREW_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
    });
  } catch (err) {
    next(err);
  }
}

export async function createPost(req: Request, res: Response, next: NextFunction) {
  try {
    assertOwner(req);
    const { label, position } = req.body as { label?: string; position?: string };
    if (!text(label)) throw badRequest("Escribe el nombre del puesto");
    if (position && !CREW_POSITIONS.includes(position as never)) throw badRequest("Cargo inválido");
    const order = (await IsmRotationPost.countDocuments()) + 1;
    const post = await IsmRotationPost.create({ label: text(label), position: position ?? "", order });
    res.status(201).json({ post });
  } catch (err) {
    next(err);
  }
}

async function cleanTurn(body: Record<string, unknown>) {
  const from = body.from;
  const to = body.to;
  if (!isDateKey(from) || !isDateKey(to) || to < from) throw badRequest("Revisa las fechas de subida y bajada");
  let user: Types.ObjectId | null = null;
  if (body.user) {
    const u = Types.ObjectId.isValid(String(body.user)) ? await User.findOne({ _id: body.user, active: true }).select("_id") : null;
    if (!u) throw badRequest("Esa persona no está en Tripulantes");
    user = u._id;
  }
  return { from, to, user };
}

export async function createTurn(req: Request, res: Response, next: NextFunction) {
  try {
    assertOwner(req);
    const post = Types.ObjectId.isValid(String(req.body?.post)) ? await IsmRotationPost.findById(req.body.post) : null;
    if (!post) throw badRequest("Elige el puesto");
    const turn = await IsmRotationTurn.create({ post: post._id, ...(await cleanTurn(req.body)), updatedBy: req.auth!.sub });
    res.status(201).json({ turn });
  } catch (err) {
    next(err);
  }
}

/** Cambiar reemplazo o mover fechas; `extend: true` = extender una semana (el siguiente sube una semana después). */
export async function updateTurn(req: Request, res: Response, next: NextFunction) {
  try {
    assertOwner(req);
    const turn = await IsmRotationTurn.findById(req.params.id);
    if (!turn) throw notFound("Turno no encontrado");
    if (req.body?.extend === true) {
      const next = await IsmRotationTurn.findOne({ post: turn.post, from: { $gt: turn.from }, _id: { $ne: turn._id } }).sort({ from: 1 });
      const moved = extendWeek(turn.toObject(), next ? next.toObject() : null);
      turn.to = moved.turn.to;
      turn.extendedDays += 7;
      if (next && moved.next) {
        next.from = moved.next.from;
        next.to = moved.next.to;
        await next.save();
      }
    } else {
      const clean = await cleanTurn({ from: turn.from, to: turn.to, user: turn.user, ...req.body });
      Object.assign(turn, clean);
    }
    turn.updatedBy = new Types.ObjectId(req.auth!.sub);
    await turn.save();
    res.json({ turn });
  } catch (err) {
    next(err);
  }
}

export async function deleteTurn(req: Request, res: Response, next: NextFunction) {
  try {
    assertOwner(req);
    await IsmRotationTurn.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
