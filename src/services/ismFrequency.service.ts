import { IFrequencyRule, IsmFrequency } from "../models/ismFrequency.model";

/**
 * Frecuencias y vencimientos (especificación ISM, 25-nov-2026, sección 8).
 * Valores iniciales = columna «Frecuencia» de la sección 4 y la pantalla de
 * Gerencia; Gerencia los cambia y rigen desde la fecha que elija. Las fechas
 * son claves AAAA-MM-DD en hora de Galápagos. Lógica pura (sin base) salvo
 * frequencyRules(), para probarla en check-ism-flow.ts.
 */

type Rule = IFrequencyRule;
const r = (rule: Partial<Rule> & Pick<Rule, "kind" | "label">): Rule => ({
  weekday: null,
  day: null,
  closeDays: null,
  per: "",
  warnDays: null,
  warn: "—",
  escalate: "",
  ...rule,
});

/** Valores iniciales (sección 8, «Valores iniciales prellenados»). */
export const DEFAULT_RULES: Record<string, Rule> = {
  "R-04": r({ kind: "anual", label: "Al ingresar · revisión anual", warnDays: 30, warn: "30 días antes", escalate: "PD" }),
  "R-05": r({ kind: "evento", label: "24 h después de embarcar", warn: "Al embarcar", escalate: "Jefe de área · Capitán" }),
  "R-06": r({ kind: "trimestral", label: "Trimestral", warnDays: 15, warn: "15 días antes", escalate: "Capitán · PD" }),
  "R-07": r({ kind: "evento", label: "Cada cambio de tripulante", warn: "Fecha del calendario", escalate: "Saliente · Capitán" }),
  "R-08": r({ kind: "cuando_ocurre", closeDays: 7, label: "Cuando ocurre · cerrar en 7 días", escalate: "Capitán · PD" }),
  "R-09": r({ kind: "cuando_ocurre", closeDays: 7, label: "Cuando ocurre · cerrar en 7 días", escalate: "Capitán · PD" }),
  "R-10": r({ kind: "crucero", label: "Cada crucero", warn: "Al cerrar crucero", escalate: "Capitán · PD" }),
  "R-11": r({ kind: "anual", label: "Anual", warnDays: 30, warn: "30 días antes", escalate: "PD · Gerencia" }),
  "R-12": r({ kind: "cuando_ocurre", closeDays: 0, label: "Cuando ocurre", escalate: "PD" }),
  "R-13": r({ kind: "evento", label: "Cada carga de combustible", warn: "Al registrar la carga", escalate: "Jefe de máquinas · Capitán" }),
  "R-14": r({ kind: "zarpe", label: "Cada zarpe de puerto", warn: "Antes de zarpar", escalate: "Capitán · PD" }),
  "R-15": r({ kind: "evento", label: "Antes de cada trabajo", escalate: "Capitán" }),
  "R-16": r({ kind: "por_equipo", label: "Por equipo (S, M, SM, A, B)", warnDays: 7, warn: "7 días antes", escalate: "Máquinas/Cubierta · Capitán" }),
  "R-17": r({ kind: "cuando_ocurre", closeDays: 15, label: "Cuando ocurre · cerrar en 15 días", escalate: "Capitán · PD" }),
  "R-18": r({ kind: "semanal", weekday: 3, label: "Semanal · miércoles", warnDays: 0, warn: "Miércoles 08h00", escalate: "Cada área · Capitán" }),
  "R-19": r({ kind: "semanal", weekday: 7, label: "Semanal (cada crucero)", warnDays: 1, warn: "1 día antes", escalate: "Capitán · PD" }),
  "R-20": r({ kind: "evento", label: "Cada entrega", escalate: "Director · Capitán" }),
  "R-21": r({ kind: "anual", label: "Al ingresar · revisión anual", warnDays: 30, warn: "30 días antes", escalate: "PD" }),
  "R-22": r({ kind: "semestral", per: "cargo", label: "Semestral por cargo", warnDays: 15, warn: "15 días antes", escalate: "Jefe de área · PD" }),
  "R-23": r({ kind: "mensual", per: "persona", day: 25, label: "Mensual por persona", warn: "Día 25", escalate: "Cada área · Capitán · PD" }),
  "R-24": r({ kind: "cuando_ocurre", closeDays: 0, label: "Cuando ocurre (con cada R-12)", escalate: "PD · Gerencia" }),
  "R-25": r({ kind: "mensual", day: 20, label: "Mensual", warn: "Día 20", escalate: "Capitán · PD" }),
  "R-26": r({ kind: "crucero", label: "Cada crucero (al cerrar)", warn: "Al cerrar crucero", escalate: "Director · Capitán · PD" }),
  "R-27": r({ kind: "anual", label: "Anual y al cambiar una actividad", warnDays: 30, warn: "30 días antes", escalate: "PD" }),
  "R-28": r({ kind: "mensual", day: 20, label: "Mensual", warn: "Día 20", escalate: "Timonel 1 · Capitán · PD" }),
  "R-29": r({ kind: "cuando_ocurre", closeDays: 0, label: "Cuando ocurre", escalate: "Capitán · PD" }),
  "R-30": r({ kind: "cuando_ocurre", closeDays: 15, label: "Cada documento nuevo · 15 días", warn: "Al publicar el documento", escalate: "Cada tripulante · PD" }),
};

export const FREQUENCY_CODES = Object.keys(DEFAULT_RULES);

/** Código de la regla de un formato: R-25_Alcohol → R-25, R-18_Cubierta → R-18. */
export const ruleCode = (code: string) => code.split("_")[0]!;

// ---- Fechas (claves AAAA-MM-DD) ----

const toDate = (k: string) => new Date(`${k}T12:00:00Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (k: string, n: number) => keyOf(new Date(toDate(k).getTime() + n * 86400000));
export const diffDays = (a: string, b: string) => Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86400000);
export function addMonths(k: string, n: number): string {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return keyOf(target);
}
const lastOfMonth = (y: number, m: number) => keyOf(new Date(Date.UTC(y, m, 0, 12)));
/** 1 lunes … 7 domingo. */
const weekdayOf = (k: string) => ((toDate(k).getUTCDay() + 6) % 7) + 1;

export interface Period {
  /** Clave del periodo (para no repetir avisos): 2026-11, 2026-W47… */
  key: string;
  start: string;
  end: string;
  due: string;
  /** Desde cuándo se avisa «por vencer». */
  warnFrom: string;
}

/** Periodo vigente de una regla periódica; null para las de evento, zarpe o crucero. */
export function periodOf(rule: Rule, today: string): Period | null {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const warn = (due: string) => (rule.warnDays === null || rule.warnDays === undefined ? due : addDays(due, -rule.warnDays));
  switch (rule.kind) {
    case "diaria":
      return { key: today, start: today, end: today, due: today, warnFrom: today };
    case "semanal": {
      const start = addDays(today, 1 - weekdayOf(today));
      const due = addDays(start, (rule.weekday || 7) - 1);
      return { key: `S${start}`, start, end: addDays(start, 6), due, warnFrom: warn(due) };
    }
    case "mensual": {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const due = lastOfMonth(y, m);
      // «Avisa: día 20»: desde ese día del mes.
      const warnFrom = rule.day ? `${start.slice(0, 8)}${String(Math.min(rule.day, Number(due.slice(8)))).padStart(2, "0")}` : warn(due);
      return { key: start.slice(0, 7), start, end: due, due, warnFrom };
    }
    case "trimestral":
    case "semestral":
    case "anual": {
      const size = rule.kind === "trimestral" ? 3 : rule.kind === "semestral" ? 6 : 12;
      const first = Math.floor((m - 1) / size) * size + 1;
      const start = `${y}-${String(first).padStart(2, "0")}-01`;
      const due = lastOfMonth(y, first + size - 1);
      return { key: `${start.slice(0, 7)}+${size}`, start, end: due, due, warnFrom: warn(due) };
    }
    default:
      return null;
  }
}

export type DueState = "hecho" | "pendiente" | "por_vencer" | "vence_hoy" | "vencido" | "vencido_3";

export function dueState(due: string, warnFrom: string, today: string, done: boolean): DueState {
  if (done) return "hecho";
  const late = diffDays(today, due);
  if (late >= 3) return "vencido_3";
  if (late > 0) return "vencido";
  if (late === 0) return "vence_hoy";
  return today >= warnFrom ? "por_vencer" : "pendiente";
}

/** Sin atrasos hacia atrás: un periodo que vencía antes de la fecha desde la que rige no cuenta. */
export function countsFrom(due: string, effectiveFrom: string): boolean {
  return due >= effectiveFrom;
}

/** R-16: el equipo vence según la frecuencia de su último trabajo (S, M, SM, A, B). */
export function equipmentDue(lastDate: string | null, freq: string | null): string | null {
  if (!lastDate || !freq) return null;
  const months: Record<string, number> = { M: 1, SM: 6, A: 12, B: 24 };
  if (freq === "S") return addDays(lastDate, 7);
  return months[freq] ? addMonths(lastDate, months[freq]!) : null;
}

/** Plazo de cierre de lo «cuando ocurre»: nunca sale como atrasado, solo avisa (sección 8). */
export function closeDue(createdKey: string, closeDays: number | null | undefined): string | null {
  return closeDays ? addDays(createdKey, closeDays) : null;
}

/** Texto de la regla para la pantalla y los avisos. */
export function ruleText(rule: Rule): string {
  return rule.label || rule.kind;
}

// ---- Base ----

export interface ActiveRule {
  code: string;
  rule: Rule;
  effectiveFrom: string;
  previous: Array<Rule & { effectiveFrom: string; until: string }>;
  updatedByName: string;
  custom: boolean;
}

/** Reglas vigentes: lo que guardó Gerencia o el valor inicial (rige desde el 01-dic-2026 por defecto). */
export const DEFAULT_EFFECTIVE_FROM = "2026-12-01";

export async function frequencyRules(): Promise<ActiveRule[]> {
  const saved = await IsmFrequency.find({}).lean();
  const byCode = new Map(saved.map((f) => [f.code, f]));
  return FREQUENCY_CODES.map((code) => {
    const s = byCode.get(code);
    return s
      ? { code, rule: s.rule, effectiveFrom: s.effectiveFrom, previous: s.previous ?? [], updatedByName: s.updatedByName, custom: true }
      : { code, rule: DEFAULT_RULES[code]!, effectiveFrom: DEFAULT_EFFECTIVE_FROM, previous: [], updatedByName: "", custom: false };
  });
}
