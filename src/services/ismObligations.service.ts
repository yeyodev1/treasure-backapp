import { IsmRecord } from "../models/ismRecord.model";
import { User } from "../models/user.model";
import { CREW_POSITIONS, POSITION_LABELS } from "../utils/roles";
import { ismCatalog, ismEquipment } from "./ism.service";
import { AREA_POSITIONS, IsmArea, ONBOARD_AREAS, canCreateForm, canFillEquipment, ismArea } from "./ismAccess.service";
import {
  ActiveRule,
  DueState,
  addDays,
  countsFrom,
  dueState,
  equipmentDue,
  frequencyRules,
  periodOf,
  ruleCode,
} from "./ismFrequency.service";
import { R16_LINE_DATES, R16_LINE_FREQ } from "./ismFlow.service";
import { todayKey } from "./ismSigners.service";

/**
 * Obligatorios de Mis tareas (especificación ISM, 25-nov-2026, secciones 5,
 * 7 y 8): salen de las frecuencias que define Gerencia. Lo «cuando ocurre»
 * nunca sale como atrasado; el R-16 vence por equipo según su frecuencia (un
 * mes sin trabajos no es atraso); el R-23 es uno por persona y mes. Las
 * pruebas no cuentan (regla 12).
 */
export interface Obligation {
  code: string;
  title: string;
  rule: string;
  due: string | null;
  state: DueState;
  /** Compatibilidad con la app: hecho o no. */
  done: boolean;
  periodKey: string;
  progress?: { done: number; total: number };
  missing?: string[];
  items?: Array<{ name: string; due: string; state: DueState }>;
}

const SEVERITY: DueState[] = ["hecho", "pendiente", "por_vencer", "vence_hoy", "vencido", "vencido_3"];
const worst = (states: DueState[]) => states.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "hecho" as DueState);

const range = (start: string, end: string) => ({ $gte: new Date(`${start}T00:00:00-06:00`), $lte: new Date(`${end}T23:59:59-06:00`) });
const sent = { status: { $ne: "borrador" }, test: { $ne: true } };

/** Fecha 'AAAA-MM-DD' de una línea del R-16 (acepta también 25/11/2026). */
function lineDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  return dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}` : null;
}

/** Último trabajo de cada equipo (fecha y frecuencia marcada). */
async function lastWorkByEquipment(): Promise<Map<string, { date: string; freq: string | null }>> {
  const sheets = await IsmRecord.find({ code: "R-16", test: { $ne: true } }).select("equipment data").lean();
  const out = new Map<string, { date: string; freq: string | null }>();
  for (const sheet of sheets) {
    const folder = sheet.equipment?.folder;
    if (!folder) continue;
    R16_LINE_DATES.forEach((field, i) => {
      const date = lineDate(sheet.data?.[field]);
      if (!date) return;
      const freq = (Object.entries(R16_LINE_FREQ[i]!).find(([, box]) => sheet.data?.[box] === true)?.[0] ?? null) as string | null;
      const prev = out.get(folder);
      if (!prev || date >= prev.date) out.set(folder, { date, freq: freq ?? prev?.freq ?? null });
    });
  }
  return out;
}

export async function obligations(area: IsmArea, opts: { today?: string; all?: boolean } = {}): Promise<Obligation[]> {
  const today = opts.today ?? todayKey();
  const rules = new Map((await frequencyRules()).map((r) => [r.code, r] as [string, ActiveRule]));
  const seesAll = opts.all || area === "gerencia" || area === "designada";
  const forms = ismCatalog().filter((f) => seesAll || canCreateForm(area, f.code));
  const out: Obligation[] = [];
  const onboard = ONBOARD_AREAS.includes(area);

  for (const form of forms) {
    const active = rules.get(ruleCode(form.code));
    if (!active) continue;
    const { rule, effectiveFrom } = active;

    if (rule.kind === "por_equipo") {
      const last = await lastWorkByEquipment();
      const monthEnd = periodOf({ ...rule, kind: "mensual", day: null }, today)!.end;
      const items = ismEquipment()
        .filter((e) => seesAll || canFillEquipment(area, e))
        .map((e) => {
          const work = last.get(e.folder);
          const due = equipmentDue(work?.date ?? null, work?.freq ?? (e as { frequency?: string }).frequency ?? null);
          return due && countsFrom(due, effectiveFrom)
            ? { name: e.name, due, state: dueState(due, addDays(due, -(rule.warnDays ?? 0)), today, false) }
            : null;
        })
        // Solo lo que vence este mes o ya venció: el resto no es atraso.
        .filter((x): x is { name: string; due: string; state: DueState } => Boolean(x && x.due <= monthEnd));
      out.push({
        code: form.code,
        title: form.title,
        rule: rule.label,
        due: items.map((i) => i.due).sort()[0] ?? null,
        state: items.length ? worst(items.map((i) => i.state)) : "hecho",
        done: !items.length,
        periodKey: today.slice(0, 7),
        items,
      });
      continue;
    }

    const period = periodOf(rule, today);
    if (!period || !countsFrom(period.due, effectiveFrom)) continue;
    const base = { code: form.code, title: form.title, rule: rule.label, due: period.due, periodKey: period.key };
    const when = range(period.start, period.end);

    if (rule.per === "persona") {
      const people = (await User.find({ active: true, sharedDevice: { $ne: true }, role: { $in: ["tripulante", "capitan"] } }).select("name role position"))
        .filter((u) => (onboard ? ismArea(u.role, u.position) === area : ONBOARD_AREAS.includes(ismArea(u.role, u.position))));
      const doneIds = new Set(
        (await IsmRecord.find({ ...sent, code: form.code, recordDate: when }).select("filler createdBy").lean()).map((r) =>
          String(r.filler?.user ?? r.createdBy),
        ),
      );
      const missing = people.filter((u) => !doneIds.has(String(u._id)));
      const state = dueState(period.due, period.warnFrom, today, missing.length === 0);
      out.push({ ...base, state, done: state === "hecho", progress: { done: people.length - missing.length, total: people.length }, missing: missing.map((u) => u.name) });
      continue;
    }

    if (rule.per === "cargo") {
      const positions = onboard ? (AREA_POSITIONS[area] ?? []) : [...CREW_POSITIONS];
      const done = new Set(await IsmRecord.distinct("position", { ...sent, code: form.code, recordDate: when }));
      const missing = positions.filter((p) => !done.has(p));
      const state = dueState(period.due, period.warnFrom, today, missing.length === 0);
      out.push({
        ...base,
        state,
        done: state === "hecho",
        progress: { done: positions.length - missing.length, total: positions.length },
        missing: missing.map((p) => POSITION_LABELS[p as keyof typeof POSITION_LABELS] ?? p),
      });
      continue;
    }

    const done = Boolean(await IsmRecord.exists({ ...sent, code: form.code, recordDate: when }));
    const state = dueState(period.due, period.warnFrom, today, done);
    out.push({ ...base, state, done: state === "hecho" });
  }

  // La PD ve sus obligatorios y los vencidos de todos (sección 5).
  if (area === "designada") {
    return out.filter((o) => canCreateForm("designada", o.code) || o.state === "vencido" || o.state === "vencido_3");
  }
  return out;
}
