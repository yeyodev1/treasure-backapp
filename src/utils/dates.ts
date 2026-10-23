/**
 * Fechas comerciales en hora de Ecuador (UTC−5, sin horario de verano).
 * El servidor corre en UTC: sin esto el "hoy" del panel cambiaba a las 19:00.
 */
const OFFSET_MS = 5 * 60 * 60 * 1000;

export function startOfDayEcuador(date: Date = new Date()): Date {
  const local = new Date(date.getTime() - OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 5, 0, 0),
  );
}

/** 'YYYY-MM-DD' de la fecha comercial en Ecuador. */
export function commercialDateKey(date: Date = new Date()): string {
  const local = new Date(date.getTime() - OFFSET_MS);
  return local.toISOString().slice(0, 10);
}

/** Construye un instante a partir de 'YYYY-MM-DD' y 'HH:mm' en hora de Ecuador. */
export function ecuadorDateTime(dateKey: string, time = "00:00"): Date {
  return new Date(`${dateKey}T${time}:00-05:00`);
}

export function addDaysKey(dateKey: string, days: number): string {
  const base = new Date(`${dateKey}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
