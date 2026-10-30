import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Types } from "mongoose";
import { IIsmAnswer, IIsmContext, IIsmFlags, IIsmRecord } from "../models/ismRecord.model";

/**
 * Esquemas versionados de los registros guiados (por ahora R-14). Cada
 * pregunta apunta a sus casillas SI y NO del PDF oficial; el registro guarda
 * la versión con la que se llenó para que el PDF y las validaciones sigan
 * siendo las mismas aunque el esquema cambie después.
 */
export interface IsmSchemaItem {
  id: string;
  n: string;
  official: string;
  prompt: string;
  si: string;
  no: string;
  allowNa: boolean;
}

export interface IsmSchemaSection {
  id: string;
  title: string;
  officialTitle: string;
  hint?: string;
  items: IsmSchemaItem[];
}

export interface IsmSchema {
  code: string;
  version: number;
  template: string;
  templateEdition: string;
  title: string;
  officialTitle: string;
  vessel: string;
  notice: string;
  context: Record<
    "activityDate" | "activityTime" | "place",
    { label: string; pdfField: string; required: boolean; suggestions?: string[] }
  >;
  sections: IsmSchemaSection[];
  /**
   * Casilla "OBS:" de la hoja oficial (fracciones de la página, desde arriba).
   * Recibe el resumen de novedades o "ver página anexa" (informe 29-oct, falla 8).
   */
  obs?: { page: number; x: number; y: number; w: number; h: number };
  /** Carpeta del archivo oficial (OneDrive/SharePoint); el mes sale de la fecha de la actividad. */
  archiveFolder?: string;
  /**
   * Motor de firmas por pasos (informe 29-oct, "El R-14 como plantilla"):
   * cada paso declara quién firma, en qué estado, a qué estado pasa, dónde se
   * imprime y a qué paso se devuelve.
   */
  signers?: IsmSigner[];
}

export interface IsmSigner {
  step: "tripulacion" | "capitan" | "oficina";
  /** "lista": se elige de la lista de tripulantes; si no, el rol de la cuenta. */
  who: "lista" | "capitan" | "designada";
  label: string;
  field: string;
  print: "anexo" | "casilla";
  status: "borrador" | "por_capitan" | "por_oficina";
  next: "por_capitan" | "por_oficina" | "archivado";
  returnsTo: "tripulacion" | "capitan" | null;
}

export interface IsmMissing {
  section: string;
  item: string;
  field: string;
  message: string;
}

const SCHEMAS = path.join(process.cwd(), "assets", "ism", "schemas");
const cache = new Map<string, IsmSchema | null>();

export function ismSchema(code: string, version?: number | null): IsmSchema | null {
  if (!/^R-\d{2}(_[A-Za-z]+)?$/.test(code)) return null;
  if (version === undefined || version === null) {
    const latest = latestSchemaVersion(code);
    if (!latest) return null;
    version = latest;
  }
  const key = `${code}.v${version}`;
  if (!cache.has(key)) {
    const file = path.join(SCHEMAS, `${key}.json`);
    cache.set(key, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  }
  return cache.get(key) ?? null;
}

const latestCache = new Map<string, number | null>();

export function latestSchemaVersion(code: string): number | null {
  if (!latestCache.has(code)) {
    let latest: number | null = null;
    if (fs.existsSync(SCHEMAS)) {
      for (const name of fs.readdirSync(SCHEMAS)) {
        const m = name.match(/^(.+)\.v(\d+)\.json$/);
        if (m && m[1] === code) latest = Math.max(latest ?? 0, Number(m[2]));
      }
    }
    latestCache.set(code, latest);
  }
  return latestCache.get(code) ?? null;
}

export function schemaItems(schema: IsmSchema) {
  return schema.sections.flatMap((s) => s.items.map((item) => ({ section: s, item })));
}

/** Campos del PDF que maneja el esquema: el cliente no los escribe directo. */
export function schemaManagedFields(schema: IsmSchema): Set<string> {
  const names = new Set<string>();
  for (const { item } of schemaItems(schema)) {
    names.add(item.si);
    names.add(item.no);
  }
  for (const c of Object.values(schema.context)) names.add(c.pdfField);
  return names;
}

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Limpia una respuesta recibida del cliente. */
export function sanitizeAnswer(input: unknown, item: IsmSchemaItem): Omit<IIsmAnswer, "at" | "by"> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const value = raw.value === "si" || raw.value === "no" || (raw.value === "na" && item.allowNa) ? raw.value : null;
  const evidencia = Array.isArray(raw.evidencia)
    ? raw.evidencia.filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 4)
    : [];
  // Solo Sí · No · No aplica (informe 29-oct, falla 6): "No" es la única forma de
  // decir que algo está mal. "Hay un problema" ya no se acepta.
  const novedad = value === "no";
  const clean: Omit<IIsmAnswer, "at" | "by"> = {
    value,
    problem: false,
    descripcion: novedad ? clip(raw.descripcion, 1500) : "",
    accion: novedad ? clip(raw.accion, 1500) : "",
    motivo: value === "na" ? clip(raw.motivo, 600) : "",
    evidencia: value === "na" ? [] : evidencia,
  };
  // Seguimiento de la novedad: solo se guarda si se llenó (no cambia la huella de lo anterior).
  if (novedad) {
    const responsable = clip(raw.responsable, 120);
    const plazo = typeof raw.plazo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.plazo) ? raw.plazo : "";
    const estado = raw.estado === "abierta" || raw.estado === "cerrada" ? raw.estado : "";
    if (responsable) clean.responsable = responsable;
    if (plazo) clean.plazo = plazo;
    if (estado) clean.estado = estado;
  }
  return clean;
}

/** Campos de seguimiento de una novedad, vacíos si no se llenaron. */
function followUp(a: Partial<IIsmAnswer> | undefined) {
  return [a?.responsable ?? "", a?.plazo ?? "", a?.estado ?? ""];
}

function sameAnswer(a: Partial<IIsmAnswer> | undefined, b: Omit<IIsmAnswer, "at" | "by">) {
  if (!a) return false;
  return (
    a.value === b.value &&
    Boolean(a.problem) === b.problem &&
    (a.descripcion ?? "") === b.descripcion &&
    (a.accion ?? "") === b.accion &&
    (a.motivo ?? "") === b.motivo &&
    JSON.stringify(a.evidencia ?? []) === JSON.stringify(b.evidencia) &&
    JSON.stringify(followUp(a)) === JSON.stringify(followUp(b))
  );
}

/**
 * Aplica las respuestas recibidas sobre las guardadas. Solo cambia el
 * momento de captura de las que de verdad cambiaron.
 */
export function mergeAnswers(
  schema: IsmSchema,
  current: Record<string, IIsmAnswer>,
  incoming: Record<string, unknown>,
  userId: string,
): { answers: Record<string, IIsmAnswer>; changed: number; changedIds: string[] } {
  const byId = new Map(schemaItems(schema).map(({ item }) => [item.id, item]));
  const answers = { ...(current ?? {}) };
  let changed = 0;
  const changedIds: string[] = [];
  for (const [id, raw] of Object.entries(incoming ?? {})) {
    const item = byId.get(id);
    if (!item) continue;
    const clean = sanitizeAnswer(raw, item);
    if (sameAnswer(answers[id], clean)) continue;
    answers[id] = { ...clean, at: new Date(), by: new Types.ObjectId(userId) };
    changed++;
    changedIds.push(id);
  }
  return { answers, changed, changedIds };
}

export function mergeContext(
  current: IIsmContext | null,
  incoming: Record<string, unknown>,
): IIsmContext | null {
  if (!current) return current;
  const next: IIsmContext = { ...current, filledBy: { ...current.filledBy } };
  if (typeof incoming.activityDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(incoming.activityDate)) {
    next.activityDate = incoming.activityDate;
  }
  if (typeof incoming.activityTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(incoming.activityTime)) {
    next.activityTime = incoming.activityTime;
  }
  if (typeof incoming.place === "string") next.place = clip(incoming.place, 120);
  // Quien hace el chequeo se elige de la lista (el controlador resuelve crewId);
  // el nombre ya no se escribe a mano.
  if (typeof incoming.position === "string" && !next.filledBy.positionFixed) {
    next.filledBy.position = clip(incoming.position, 20);
  }
  if (incoming.sectionTimes && typeof incoming.sectionTimes === "object") {
    const times = { ...(current.sectionTimes ?? {}) };
    for (const [id, t] of Object.entries(incoming.sectionTimes as Record<string, unknown>)) {
      if (!/^[a-z_]{1,30}$/.test(id)) continue;
      if (typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) times[id] = t;
      else if (t === "") delete times[id];
    }
    next.sectionTimes = times;
  }
  if (incoming.confirmed === true && !next.confirmedAt) next.confirmedAt = new Date();
  return next;
}

/** Las respuestas y el contexto se escriben en las casillas y campos del PDF. */
export function projectToData(
  schema: IsmSchema,
  record: Pick<IIsmRecord, "data" | "answers" | "context">,
): Record<string, string | boolean> {
  const data = { ...(record.data ?? {}) };
  for (const { item } of schemaItems(schema)) {
    const value = record.answers?.[item.id]?.value ?? null;
    data[item.si] = value === "si";
    data[item.no] = value === "no";
  }
  const ctx = record.context;
  if (ctx) {
    const [y, m, d] = (ctx.activityDate || "").split("-");
    data[schema.context.activityDate.pdfField] = y && m && d ? `${d}/${m}/${y}` : "";
    data[schema.context.activityTime.pdfField] = ctx.activityTime || "";
    data[schema.context.place.pdfField] = ctx.place || "";
  }
  return data;
}

export function computeFlags(schema: IsmSchema, answers: Record<string, IIsmAnswer>): IIsmFlags {
  const items = schemaItems(schema);
  let answered = 0;
  let novedades = 0;
  let noAplica = 0;
  for (const { item } of items) {
    const a = answers?.[item.id];
    if (!a?.value) continue;
    answered++;
    if (a.value === "no" || a.problem) novedades++;
    if (a.value === "na") noAplica++;
  }
  return { answered, total: items.length, novedades, noAplica, hasNovedad: novedades > 0 };
}

/** Misma validación que corre en la tablet antes de "Revisar y enviar". */
export function validateGuided(
  schema: IsmSchema,
  record: Pick<IIsmRecord, "answers" | "context">,
): IsmMissing[] {
  const missing: IsmMissing[] = [];
  const ctx = record.context;
  const need = (field: string, message: string) => missing.push({ section: "contexto", item: "", field, message });
  if (!ctx?.activityDate) need("activityDate", "Falta la fecha de la actividad");
  if (!ctx?.activityTime) need("activityTime", "Falta la hora de la actividad");
  if (!ctx?.place) need("place", "Falta el lugar");
  if (!ctx?.filledBy?.name || !ctx.filledBy.fromList) need("name", "Elige quién hace el chequeo de la lista");
  if (!ctx?.filledBy?.position) need("position", "Falta el cargo");

  for (const { section, item } of schemaItems(schema)) {
    const a = record.answers?.[item.id];
    const add = (field: string, message: string) =>
      missing.push({ section: section.id, item: item.id, field, message });
    if (!a?.value) {
      add("value", "Falta la respuesta");
      continue;
    }
    if (a.value === "na") {
      if (!item.allowNa) add("value", "Este punto no admite «No aplica»");
      else if (!a.motivo?.trim()) add("motivo", "Indica por qué no aplica");
      continue;
    }
    if (a.value === "no" || a.problem) {
      if (!a.descripcion?.trim()) add("descripcion", "Describe la novedad");
      if (!a.accion?.trim()) add("accion", "Indica la acción tomada");
    }
  }
  return missing;
}

/** Horas por sección, ordenadas; vacío si no hay (no cambia la huella de lo anterior). */
function sectionTimesKey(times: Record<string, string> | undefined): string[] {
  const entries = Object.entries(times ?? {}).filter(([, t]) => t).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? [entries.map(([k, t]) => `${k}=${t}`).join(",")] : [];
}

/** Valores vacíos o falsos no cuentan: guardar "nada" no cambia la huella. */
function compact(obj: Record<string, unknown> | null | undefined) {
  return Object.keys(obj ?? {})
    .sort()
    .filter((k) => {
      const v = (obj as Record<string, unknown>)[k];
      return !(v === "" || v === false || v === null || v === undefined);
    })
    .map((k) => [k, (obj as Record<string, unknown>)[k]]);
}

/**
 * Huella del contenido (sin firmas): datos del formato, respuestas sin su
 * momento de captura y contexto. Se guarda en cada firma; si después
 * cambia, la firma deja de ser válida y hay que volver a firmar.
 */
export function hashContent(record: Pick<IIsmRecord, "code" | "data" | "recordDate" | "answers" | "context">) {
  const answers = Object.keys(record.answers ?? {})
    .sort()
    .map((id) => {
      const a = record.answers[id]!;
      const row: unknown[] = [id, a.value, Boolean(a.problem), a.descripcion ?? "", a.accion ?? "", a.motivo ?? "", a.evidencia ?? []];
      // El seguimiento entra en la huella solo si existe: las firmas anteriores siguen valiendo.
      const extra = followUp(a);
      if (extra.some(Boolean)) row.push(extra);
      return row;
    })
    .filter((row) => row[1]);
  const ctx = record.context
    ? [
        record.context.vessel,
        record.context.activityDate,
        record.context.activityTime,
        record.context.place,
        record.context.filledBy?.name,
        record.context.filledBy?.position,
        ...sectionTimesKey(record.context.sectionTimes),
      ]
    : null;
  const payload = JSON.stringify({
    code: record.code,
    recordDate: new Date(record.recordDate).toISOString(),
    data: compact(record.data as Record<string, unknown>),
    answers,
    ctx,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function signatureIsValid(sig: { hashV?: number; dataHash?: string }, currentHash: string): boolean {
  if (sig.hashV !== 2) return true;
  return sig.dataHash === currentHash;
}
