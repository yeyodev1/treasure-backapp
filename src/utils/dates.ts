/**
 * Fechas comerciales en hora de Galápagos (Pacific/Galapagos, UTC−6, sin
 * horario de verano): el barco opera allí. Cuenta, bitácora, filtros y
 * gráficos usan esta misma fecha (checklist 29-oct, 04). El servidor corre
 * en UTC: sin esto el "hoy" del panel cambiaba a media tarde.
 */
export const TIMEZONE = "Pacific/Galapagos";
/** Mongo no siempre trae la base de zonas horarias: en agregaciones va el desfase fijo. */
export const UTC_OFFSET = "-06:00";
const OFFSET_HOURS = 6;
const OFFSET_MS = OFFSET_HOURS * 60 * 60 * 1000;

export function startOfDayLocal(date: Date = new Date()): Date {
  const local = new Date(date.getTime() - OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), OFFSET_HOURS, 0, 0),
  );
}

/** 'YYYY-MM-DD' de la fecha comercial en Galápagos. */
export function commercialDateKey(date: Date = new Date()): string {
  const local = new Date(date.getTime() - OFFSET_MS);
  return local.toISOString().slice(0, 10);
}

/** Construye un instante a partir de 'YYYY-MM-DD' y 'HH:mm' en hora de Galápagos. */
export function localDateTime(dateKey: string, time = "00:00"): Date {
  return new Date(`${dateKey}T${time}:00${UTC_OFFSET}`);
}

/**
 * Lee un límite de filtro: 'YYYY-MM-DD' es el día local completo (inicio o
 * fin según `edge`); un instante ISO se respeta tal cual.
 */
export function parseRangeEdge(value: string | undefined, edge: "start" | "end"): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === "start"
      ? localDateTime(value, "00:00")
      : new Date(localDateTime(addDaysKey(value, 1), "00:00").getTime() - 1);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDaysKey(dateKey: string, days: number): string {
  const base = new Date(`${dateKey}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Nombres anteriores: siguen funcionando, ahora en hora de Galápagos.
export const startOfDayEcuador = startOfDayLocal;
export const ecuadorDateTime = localDateTime;
