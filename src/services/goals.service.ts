import { Goal } from "../models/goal.model";

/** Metas configurables de Gerencia con su valor inicial (especificación, pág. 20). */
export const GOAL_DEFS = [
  { key: "marginMinPct", label: "Margen mínimo del bar", unit: "%", initial: null },
  { key: "wasteMaxPct", label: "Merma máxima (% de lo vendido)", unit: "%", initial: null },
  { key: "barPerPaxDay", label: "Consumo bar por pasajero por día", unit: "$", initial: null },
  { key: "annulmentsMax", label: "Anulaciones máximas por crucero", unit: "", initial: null },
  { key: "cashMaxDays", label: "Días máximos con efectivo sin depositar", unit: "días", initial: 7 },
  { key: "accountsHoursBefore", label: "Horas antes del fin del crucero para tener cuentas aprobadas", unit: "h", initial: 24 },
  { key: "commissionDivisor", label: "Divisor de la comisión", unit: "", initial: 1.21 },
  { key: "agencyMaxDays", label: "Días máximos de una factura a la agencia sin cobrar", unit: "días", initial: 30 },
  { key: "wetsuitAB", label: "Tarifa de wetsuit, cruceros A y B", unit: "$", initial: 50 },
  { key: "wetsuitC", label: "Tarifa de wetsuit, crucero C", unit: "$", initial: 80 },
  // Bar-stock (especificación del 24-nov-2026, sección 7)
  { key: "wasteLimit", label: "Límite de merma por crucero (más pasa a Gerencia)", unit: "$", initial: 25 },
  { key: "repeatCruises", label: "Repetición que alerta (cruceros seguidos con merma)", unit: "", initial: 3 },
  { key: "openTolerance", label: "Tolerancia de botella abierta", unit: "botella", initial: 0.25 },
  { key: "verifyMaxHours", label: "Horas que tiene la directora para verificar", unit: "h", initial: 1 },
  { key: "orderOutlierPct", label: "Pedido fuera de lo normal (sobre la propuesta)", unit: "%", initial: 20 },
  { key: "receptionLateHours", label: "Recepción atrasada desde el envío", unit: "h", initial: 24 },
] as const;

export type GoalKey = (typeof GOAL_DEFS)[number]["key"];
export type Goals = Record<GoalKey, number | null>;

type GoalRow = { key: string; value: number | null; from: Date };

let cache: { at: number; rows: GoalRow[] } | null = null;

async function rows(): Promise<GoalRow[]> {
  // Se leen muchas veces por resumen: 30 s de caché basta.
  if (!cache || Date.now() - cache.at > 30_000) {
    cache = { at: Date.now(), rows: await Goal.find().select("key value from").sort({ from: -1 }).lean() };
  }
  return cache.rows;
}

export function clearGoalsCache() {
  cache = null;
}

/** Valores que regían en una fecha (por defecto, hoy). */
export async function goalsAt(date: Date = new Date()): Promise<Goals> {
  const all = await rows();
  const out = {} as Goals;
  for (const def of GOAL_DEFS) {
    const hit = all.find((r) => r.key === def.key && r.from <= date);
    out[def.key] = hit ? hit.value : def.initial;
  }
  return out;
}

/** Tarifa de wetsuit de un tipo de crucero en una fecha. */
export function wetsuitRate(goals: Goals, leg: string): number | null {
  return leg === "C" ? goals.wetsuitC : goals.wetsuitAB;
}
