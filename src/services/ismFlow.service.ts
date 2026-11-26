/**
 * Orden de firmas de cada formato (especificación ISM «Accesos por cuenta y
 * formato», 25-nov-2026, sección 4). Son las firmas de la hoja oficial, en
 * su orden: cuando firma uno, el registro pasa al siguiente; con la última
 * firma se archiva solo. Funciones puras (sin base) para probarlas con
 * src/scripts/check-ism-flow.ts.
 *
 * - `order`: pasos con el mismo número se firman a la vez (p. ej. los tres
 *   gerentes del R-11, o Timonel 1, Jefe de máquinas y Director en el R-10).
 * - `atFill`: se firma mientras se llena, en el teléfono de quien llena
 *   (el registro sigue en borrador hasta completar estas firmas).
 * - `rows`: «firma su fila» (asistentes, medicinas, toma de conocimiento):
 *   firman las filas que tienen nombre; al menos una.
 * - `virtual`: firma que la hoja no tiene impresa (solicitante del R-18 de
 *   Cubierta o Máquinas): queda en el registro y en su historial.
 */

export type FlowWho = "persona" | "capitan" | "designada" | "admin" | "gerencia" | "externo";
export type ManagerTitle = "general" | "operaciones" | "logistica";

export interface FlowStep {
  order: number;
  who: FlowWho;
  label: string;
  fields: string[];
  atFill?: boolean;
  rows?: boolean;
  virtual?: boolean;
  /** Solo firma una persona de estos cargos (el «de turno» del cargo). */
  positions?: string[];
  /** Firma la persona que llenó el registro (su R-23, su informe R-29). */
  self?: boolean;
  /** Gerencia: qué gerente firma. */
  manager?: ManagerTitle;
  /** Firma la persona cuyo nombre está en la fila (R-20, R-30). */
  rowOwner?: boolean;
  /** Recepción conforme del R-18: firma el área que pidió. */
  requester?: boolean;
}

/** Texto de la fila: firma → campo con el nombre de esa fila (para saber qué filas firman). */
export type RowNames = Record<string, string>;

export interface FormFlow {
  steps: FlowStep[];
  rowNames?: RowNames;
  /** La hoja se envía solo cuando está llena (bitácoras R-16 y R-20). */
  fullBefore?: string[];
}

const SF = (n: number) => `Signature Field ${n}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Filas con nombre (de las guías de llenado de la app de registros).
const R06_ROWS: RowNames = Object.fromEntries(
  [25, 27, 29, 31, 47, 48, 49, 50, 51, 52, 53, 54].map((t, i) => [SF(20 - i), `Text Field ${t}`]),
);
const R20_ROWS: RowNames = Object.fromEntries(
  [46, 52, 57, 62, 67, 72, 77, 82, 87, 92, 97, 102, 107, 1012].map((t, i) => [SF(4 + i), `Text Field ${t}`]),
);
const R30_NAME_FIELDS = [
  1093, 1098, 10103, 10108, 101013, 101018, 101023, 101028, 101033, 101038, 101043, 101048, 101053, 101058, 101063,
  101068, 101073, 101078, 101083,
];
const R30_ROWS: RowNames = Object.fromEntries(R30_NAME_FIELDS.map((t, i) => [SF(40 + i), `Text Field ${t}`]));
const R12_DATES = [
  72, 104, 1010, 1016, 1022, 1028, 1034, 1040, 1046, 1052, 1058, 1064, 1070, 1076, 1082, 1088, 1094, 10100, 10106, 101012,
  101018, 101024, 101030, 101036, 101042,
];
const R12_ROWS: RowNames = Object.fromEntries(
  R12_DATES.map((t, i) => [`Firma_Responsable_${String(i + 1).padStart(2, "0")}`, `Text Field ${t}`]),
);
/** Fechas de las 13 líneas del R-16 (una por trabajo). */
export const R16_LINE_DATES = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37].map((n) => `Text Field ${n}`);
/** Frecuencia marcada en cada línea del R-16: S, M, SM, A, B. */
export const R16_LINE_FREQ: Array<Record<"S" | "M" | "SM" | "A" | "B", string>> = [
  [3, 4, 5, 6, 7],
  [10, 11, 12, 13, 14],
  [17, 18, 19, 20, 21],
  [24, 25, 26, 27, 28],
  [31, 32, 33, 34, 35],
  [38, 39, 40, 41, 42],
  [45, 46, 47, 48, 49],
  [52, 53, 54, 55, 56],
  [59, 60, 61, 62, 63],
  [66, 67, 68, 69, 70],
  [73, 74, 75, 76, 77],
  [80, 81, 82, 83, 84],
  [87, 88, 89, 90, 91],
].map(([s, m, sm, a, b]) => ({ S: `Check Box ${s}`, M: `Check Box ${m}`, SM: `Check Box ${sm}`, A: `Check Box ${a}`, B: `Check Box ${b}` }));

const cap = (order: number, field: string, label = "Capitán", atFill = false): FlowStep => ({
  order,
  who: "capitan",
  label,
  fields: [field],
  ...(atFill ? { atFill } : {}),
});
const pd = (order: number, field: string, label = "Persona Designada"): FlowStep => ({ order, who: "designada", label, fields: [field] });

const R18_AREA: FormFlow = {
  steps: [
    { order: 1, who: "persona", label: "Solicitante", fields: ["Firma_Solicitante"], atFill: true, virtual: true, self: true },
    cap(2, SF(29), "Capitán (aprueba)"),
    pd(3, SF(28), "Persona Designada (despacha)"),
    { order: 4, who: "persona", label: "Recepción conforme (quien pidió)", fields: [SF(21)], requester: true },
  ],
};
const R25: FormFlow = { steps: [cap(1, SF(37), "Capitán", true), pd(2, SF(35))] };
const R08_09: FormFlow = {
  steps: [
    cap(1, SF(8), "Capitán (análisis de causa)"),
    cap(2, SF(11), "Capitán (acción correctiva)"),
    pd(3, SF(10), "Persona Designada (medida correctiva y cierre)"),
  ],
};

export const FLOWS: Record<string, FormFlow> = {
  "R-04": { steps: [{ order: 1, who: "persona", label: "Tripulante", fields: [SF(2)], atFill: true }, pd(2, SF(1))] },
  "R-05": {
    steps: [
      { order: 1, who: "persona", label: "Tripulante familiarizado", fields: [SF(4)], atFill: true },
      cap(2, SF(5)),
      pd(3, SF(6)),
    ],
  },
  "R-06": {
    steps: [
      { order: 1, who: "persona", label: "Expositor", fields: [SF(8)], atFill: true, self: true },
      { order: 1, who: "persona", label: "Asistentes", fields: range(9, 20).map(SF), atFill: true, rows: true },
      cap(2, SF(4)),
      pd(3, SF(7)),
    ],
    rowNames: R06_ROWS,
  },
  "R-07": {
    steps: [
      { order: 1, who: "persona", label: "Saliente", fields: [SF(8)], atFill: true },
      { order: 2, who: "persona", label: "Entrante", fields: [SF(9)], atFill: true },
      cap(3, SF(10)),
      pd(4, SF(11)),
    ],
  },
  "R-08": R08_09,
  "R-09": R08_09,
  "R-10": {
    steps: [
      { order: 1, who: "persona", label: "Marinero de Primera Puente (Timonel 1)", fields: [SF(12)], atFill: true, positions: ["TIM_01"] },
      { order: 1, who: "persona", label: "Marinero de Primera Máquinas (Jefe de máquinas)", fields: [SF(20)], atFill: true, positions: ["MAQ"] },
      { order: 1, who: "persona", label: "Director de crucero", fields: [SF(21)], atFill: true, positions: ["DIR"] },
      // Lo llena el Capitán: su firma va al llenar y no pasa por su bandeja (sección 6).
      cap(2, SF(22), "Capitán", true),
      pd(3, SF(23)),
    ],
  },
  "R-11": {
    steps: [
      { order: 1, who: "gerencia", label: "Gerente de Operaciones", fields: [SF(12)], manager: "operaciones" },
      { order: 1, who: "gerencia", label: "Gerente General", fields: [SF(17)], manager: "general" },
      { order: 1, who: "gerencia", label: "Logística y Mantenimiento", fields: [SF(18)], manager: "logistica" },
      pd(2, SF(19)),
    ],
  },
  "R-12": {
    steps: [{ order: 1, who: "persona", label: "Responsable del cambio", fields: Object.keys(R12_ROWS), atFill: true, rows: true }],
    rowNames: R12_ROWS,
  },
  "R-13": {
    steps: [{ order: 1, who: "persona", label: "Jefe de máquinas", fields: [SF(24)], atFill: true, positions: ["MAQ"] }, cap(2, SF(25))],
  },
  "R-15": {
    steps: [{ order: 1, who: "externo", label: "Prestador del servicio", fields: [SF(26)], atFill: true }, cap(2, SF(27), "Capitán", true)],
  },
  "R-16": {
    steps: [{ order: 1, who: "persona", label: "Encargado del equipo", fields: [SF(2)], atFill: true }, cap(2, SF(1)), pd(3, SF(3))],
    fullBefore: R16_LINE_DATES,
  },
  "R-17": {
    steps: [{ order: 1, who: "externo", label: "Taller encargado", fields: [SF(29)], atFill: true }, cap(2, SF(28)), pd(3, SF(27))],
  },
  "R-18_Cubierta": R18_AREA,
  "R-18_Maquinas": R18_AREA,
  "R-18_Hoteleria": {
    steps: [
      { order: 1, who: "persona", label: "Directora de crucero (pide)", fields: [SF(1)], atFill: true, self: true },
      { order: 2, who: "admin", label: "Administración (despacha)", fields: [SF(2)] },
      { order: 3, who: "persona", label: "Recepción conforme (directora)", fields: [SF(3)], requester: true },
    ],
  },
  "R-19": { steps: [cap(1, SF(28), "Capitán", true), pd(2, SF(27))] },
  "R-20": {
    steps: [
      { order: 1, who: "persona", label: "Quien recibe (su fila)", fields: range(4, 17).map(SF), atFill: true, rows: true, rowOwner: true },
      cap(2, SF(1)),
      pd(3, SF(3)),
    ],
    rowNames: R20_ROWS,
    fullBefore: Object.values(R20_ROWS),
  },
  "R-21": { steps: [{ order: 1, who: "persona", label: "Empleado que recibe", fields: [SF(28)], atFill: true }, pd(2, SF(32))] },
  "R-22": {
    steps: [
      { order: 1, who: "persona", label: "Evaluado", fields: [SF(33)], atFill: true },
      { order: 2, who: "persona", label: "Evaluador (jefe del área)", fields: [SF(34)], atFill: true, self: true },
      pd(3, SF(35)),
    ],
  },
  "R-23": {
    steps: [
      { order: 1, who: "persona", label: "Tripulante", fields: ["Firma_Tripulante"], atFill: true, self: true },
      cap(2, "Firma_Capitan"),
      pd(3, "Firma_Persona_Designada"),
    ],
  },
  "R-24": {
    steps: [{ order: 1, who: "gerencia", label: "Gerente General", fields: [SF(35)], manager: "general" }, pd(2, SF(37))],
  },
  "R-25_Alcohol": R25,
  "R-25_Drogas": R25,
  "R-26": {
    steps: [
      {
        order: 1,
        who: "externo",
        label: "Responsables 1 y 2, charla PNG e inducción",
        fields: [SF(39), SF(40), "Firma_Charla_PNG", "Firma_Charla_Induccion"],
        atFill: true,
        rows: true,
      },
      cap(2, SF(37)),
      pd(3, SF(38)),
    ],
    rowNames: { [SF(39)]: "Text Field 1095", [SF(40)]: "Text Field 1096", Firma_Charla_PNG: "Fecha_Charla_PNG", Firma_Charla_Induccion: "Fecha_Charla_Induccion" },
  },
  "R-27": { steps: [{ order: 1, who: "externo", label: "Evaluador de riesgos", fields: [SF(18)], atFill: true }] },
  "R-28": {
    steps: [
      { order: 1, who: "persona", label: "Timonel 1 (Marinero de Primera Puente)", fields: [SF(40)], atFill: true, positions: ["TIM_01"] },
      cap(2, SF(43)),
      pd(3, SF(44)),
    ],
  },
  "R-29": {
    steps: [{ order: 1, who: "persona", label: "Quien informa", fields: [SF(37)], atFill: true, self: true }, cap(2, SF(38)), pd(3, SF(39))],
  },
  "R-30": {
    steps: [
      // Cada tripulante firma su fila desde su área, en los 15 días (no en el teléfono de la PD).
      { order: 1, who: "persona", label: "Tripulante (su fila)", fields: Object.keys(R30_ROWS), rows: true, rowOwner: true },
      pd(2, SF(37)),
      { order: 3, who: "gerencia", label: "Gerente General", fields: [SF(39)], manager: "general" },
    ],
    rowNames: R30_ROWS,
  },
};

export function flowOf(code: string): FormFlow | null {
  return FLOWS[code] ?? null;
}

export function stepOfField(flow: FormFlow, field: string): FlowStep | null {
  return flow.steps.find((s) => s.fields.includes(field)) ?? null;
}

const filled = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v === true);

/** Campos de firma que pide un paso con los datos actuales (en filas: las que tienen nombre). */
export function requiredFields(flow: FormFlow, step: FlowStep, data: Record<string, unknown>): string[] {
  if (!step.rows) return step.fields;
  return step.fields.filter((f) => filled(data[flow.rowNames?.[f] ?? ""]));
}

/**
 * Paso completo: todas sus firmas válidas. En filas, las filas con nombre
 * firmadas y al menos una (una fila firmada sin nombre también cuenta).
 */
export function stepDone(flow: FormFlow, step: FlowStep, data: Record<string, unknown>, signed: Set<string>): boolean {
  if (!step.rows) return step.fields.every((f) => signed.has(f));
  const required = requiredFields(flow, step, data);
  return required.every((f) => signed.has(f)) && step.fields.some((f) => signed.has(f));
}

/** Número de orden pendiente (el primero con un paso incompleto); null = todo firmado. */
export function pendingOrder(
  flow: FormFlow,
  data: Record<string, unknown>,
  signed: Set<string>,
  filter: (s: FlowStep) => boolean = () => true,
): number | null {
  const orders = [...new Set(flow.steps.filter(filter).map((s) => s.order))].sort((a, b) => a - b);
  for (const o of orders) {
    if (flow.steps.some((s) => s.order === o && filter(s) && !stepDone(flow, s, data, signed))) return o;
  }
  return null;
}

export function stepsAt(flow: FormFlow, order: number): FlowStep[] {
  return flow.steps.filter((s) => s.order === order);
}

export type FlowStatus = "borrador" | "por_capitan" | "por_oficina" | "por_gerencia" | "por_firmar" | "archivado";

/** Estado del registro según quién firma el paso pendiente. */
export function statusForOrder(flow: FormFlow, order: number | null): FlowStatus {
  if (order === null) return "archivado";
  const who = stepsAt(flow, order)[0]!.who;
  if (who === "capitan") return "por_capitan";
  if (who === "designada" || who === "admin") return "por_oficina";
  if (who === "gerencia") return "por_gerencia";
  return "por_firmar";
}

/** Estado al salir del borrador: firmas de llenado completas → el siguiente paso pendiente. */
export function statusAfterFill(flow: FormFlow, data: Record<string, unknown>, signed: Set<string>): FlowStatus {
  return statusForOrder(flow, pendingOrder(flow, data, signed));
}

/** Etapa con que se guarda la firma (la usan el PDF y los listados de antes). */
export function stageOf(who: FlowWho): "tripulacion" | "capitan" | "oficina" {
  if (who === "capitan") return "capitan";
  if (who === "designada" || who === "admin" || who === "gerencia") return "oficina";
  return "tripulacion";
}

/** Al devolver: se anulan las firmas del paso de quien devuelve y las posteriores. */
export function fieldsToAnnul(flow: FormFlow, fromOrder: number): Set<string> {
  return new Set(flow.steps.filter((s) => s.order >= fromOrder).flatMap((s) => s.fields));
}

/** Bitácoras: la hoja se envía cuando todas sus líneas tienen fecha (o nombre). */
export function missingLines(flow: FormFlow, data: Record<string, unknown>): number {
  return (flow.fullBefore ?? []).filter((f) => !filled(data[f])).length;
}

const norm = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** La fila es de esta persona: su nombre está en la fila (con o sin grado). */
export function rowBelongsTo(rowText: unknown, personName: string): boolean {
  if (typeof rowText !== "string" || !rowText.trim()) return true;
  const row = norm(rowText);
  const parts = norm(personName).split(" ").filter((p) => p.length > 1);
  return parts.length > 0 && parts.every((p) => row.includes(p));
}

/** Fecha real de una firma hecha sin señal: la del teléfono, si es creíble (hasta 7 días atrás). */
export function offlineSignedAt(deviceAt: Date | null, now: Date): Date {
  if (!deviceAt || Number.isNaN(deviceAt.getTime())) return now;
  const diff = now.getTime() - deviceAt.getTime();
  if (diff < -5 * 60 * 1000 || diff > 7 * 24 * 60 * 60 * 1000) return now;
  return deviceAt;
}
