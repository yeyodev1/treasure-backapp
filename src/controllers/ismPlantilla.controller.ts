import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { IsmRecord } from "../models/ismRecord.model";
import { IsmNovedad, NOVEDAD_STATES, NovedadState } from "../models/ismNovedad.model";
import { backfillNovedades } from "../services/ismNovedad.service";
import { isDateKey } from "../services/ism.service";
import { badRequest, forbidden, notFound } from "../errors/httpError";

/**
 * Plantilla de formatos guiados (informe ISM, criterio 5): novedades como
 * colección propia y métricas básicas del circuito de firmas.
 */

const SEES_NOVEDADES = new Set(["duena", "admin", "capitan", "designada"]);
const FOLLOWS_NOVEDADES = new Set(["duena", "admin", "capitan", "designada"]);
const SEES_METRICS = new Set(["duena", "designada"]);

/** Novedades (abiertas por defecto), con su seguimiento. */
export async function listNovedades(req: Request, res: Response, next: NextFunction) {
  try {
    if (!SEES_NOVEDADES.has(req.auth!.role)) throw forbidden("Las novedades las ven el Capitán, la Persona Designada y Gerencia");
    await backfillNovedades();
    const { estado, record, code } = req.query as Record<string, string | undefined>;
    const filter: Record<string, unknown> = { test: { $ne: true } };
    const states = (estado ?? "abierta,en_proceso").split(",").filter((s) => NOVEDAD_STATES.includes(s as NovedadState));
    if (estado !== "todas") filter.estado = { $in: states };
    if (record && Types.ObjectId.isValid(record)) filter.record = record;
    if (code) filter.code = code;
    const novedades = await IsmNovedad.find(filter).sort({ plazo: 1, createdAt: -1 }).limit(200);
    res.json({ novedades });
  } catch (err) {
    next(err);
  }
}

/** Seguimiento: responsable, plazo, estado y enlace a un R-17. No toca el registro firmado. */
export async function updateNovedad(req: Request, res: Response, next: NextFunction) {
  try {
    if (!FOLLOWS_NOVEDADES.has(req.auth!.role)) throw forbidden("El seguimiento lo llevan el Capitán, la Persona Designada y Gerencia");
    const nov = await IsmNovedad.findById(req.params.id);
    if (!nov) throw notFound("Novedad no encontrada");
    const { responsable, plazo, estado, r17Record } = req.body as Record<string, unknown>;
    const changes: string[] = [];
    if (typeof responsable === "string") {
      nov.responsable = responsable.trim().slice(0, 120);
      changes.push(`responsable: ${nov.responsable || "—"}`);
    }
    if (plazo !== undefined) {
      if (plazo !== "" && !isDateKey(plazo)) throw badRequest("El plazo no es una fecha válida. Elige otra en el calendario.");
      nov.plazo = plazo as string;
      changes.push(`plazo: ${nov.plazo || "—"}`);
    }
    if (estado !== undefined) {
      if (!NOVEDAD_STATES.includes(estado as NovedadState)) throw badRequest("Estado inválido");
      nov.estado = estado as NovedadState;
      nov.closedAt = estado === "cerrada" ? new Date() : null;
      changes.push(`estado: ${estado}`);
    }
    if (r17Record !== undefined) {
      if (r17Record === null || r17Record === "") nov.r17Record = null;
      else {
        if (typeof r17Record !== "string" || !Types.ObjectId.isValid(r17Record)) throw badRequest("R-17 inválido");
        const r17 = await IsmRecord.findOne({ _id: r17Record, code: "R-17" }).select("_id fileName");
        if (!r17) throw badRequest("Ese registro no es un R-17");
        nov.r17Record = r17._id;
        changes.push(`R-17: ${r17.fileName}`);
      }
    }
    if (!changes.length) throw badRequest("Nada que cambiar");
    nov.history.push({
      action: "seguimiento",
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
      at: new Date(),
      detail: changes.join(" · "),
    });
    await nov.save();
    res.json({ novedad: nov });
  } catch (err) {
    next(err);
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (x: number | null, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Métricas básicas (Gerencia y Persona Designada): tiempo por paso,
 * borradores abandonados, devoluciones por motivo y días hasta archivar.
 * Sin registros de prueba. ?code=R-14&from=AAAA-MM-DD&to=AAAA-MM-DD
 */
export async function metrics(req: Request, res: Response, next: NextFunction) {
  try {
    if (!SEES_METRICS.has(req.auth!.role)) throw forbidden("Las métricas las ven Gerencia y la Persona Designada");
    const { code, from, to, abandonedHours } = req.query as Record<string, string | undefined>;
    for (const v of [from, to]) if (v && !isDateKey(v)) throw badRequest("La fecha no es válida. Elige otra en el calendario.");
    const filter: Record<string, unknown> = { test: { $ne: true } };
    if (code) filter.code = code;
    if (from || to) {
      filter.recordDate = {
        ...(from ? { $gte: new Date(`${from}T00:00:00-06:00`) } : {}),
        ...(to ? { $lte: new Date(`${to}T23:59:59-06:00`) } : {}),
      };
    }
    const records = await IsmRecord.find(filter)
      .select("code status recordDate createdAt updatedAt submittedAt captainApprovedAt archivedAt history.action history.reason history.section history.at fileName")
      .lean();

    const crew: number[] = [];
    const captain: number[] = [];
    const office: number[] = [];
    const toArchive: number[] = [];
    const reasons = new Map<string, number>();
    const sections = new Map<string, number>();
    let returns = 0;
    const staleMs = Math.max(1, Number(abandonedHours) || 48) * HOUR;
    const now = Date.now();
    const abandoned: Array<{ id: string; code: string; fileName: string; updatedAt: Date; hours: number }> = [];

    for (const r of records) {
      const created = r.createdAt ? new Date(r.createdAt).getTime() : null;
      const submitted = r.submittedAt ? new Date(r.submittedAt).getTime() : null;
      const capOk = r.captainApprovedAt ? new Date(r.captainApprovedAt).getTime() : null;
      const archived = r.archivedAt ? new Date(r.archivedAt).getTime() : null;
      if (created && submitted && submitted >= created) crew.push((submitted - created) / HOUR);
      if (submitted && capOk && capOk >= submitted) captain.push((capOk - submitted) / HOUR);
      if (capOk && archived && archived >= capOk) office.push((archived - capOk) / HOUR);
      if (archived) toArchive.push((archived - new Date(r.recordDate).getTime()) / DAY);
      if (r.status === "borrador" && r.updatedAt && now - new Date(r.updatedAt).getTime() > staleMs) {
        abandoned.push({
          id: String(r._id),
          code: r.code,
          fileName: r.fileName,
          updatedAt: r.updatedAt,
          hours: Math.round((now - new Date(r.updatedAt).getTime()) / HOUR),
        });
      }
      for (const h of r.history ?? []) {
        if (!h.action?.startsWith("devuelto")) continue;
        returns++;
        const reason = (h.reason || "Sin motivo").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        if (h.section) sections.set(h.section, (sections.get(h.section) ?? 0) + 1);
      }
    }

    const step = (xs: number[]) => ({ n: xs.length, avgHours: round(avg(xs)), medianHours: round(median(xs)) });
    const top = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, n]) => ({ label, n }));

    res.json({
      filter: { code: code ?? null, from: from ?? null, to: to ?? null },
      total: records.length,
      byStatus: records.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
      timePerStep: { tripulacion: step(crew), capitan: step(captain), oficina: step(office) },
      abandonedDrafts: {
        thresholdHours: staleMs / HOUR,
        n: abandoned.length,
        records: abandoned.sort((a, b) => b.hours - a.hours).slice(0, 20),
      },
      returns: { n: returns, byReason: top(reasons), bySection: top(sections) },
      daysToArchive: { n: toArchive.length, avg: round(avg(toArchive)), median: round(median(toArchive)) },
    });
  } catch (err) {
    next(err);
  }
}
