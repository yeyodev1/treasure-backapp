import { Types } from "mongoose";
import { User } from "../models/user.model";

/**
 * Cuentas y accesos de Registros ISM (especificación ISM, 25-nov-2026,
 * secciones 3, 4 y 5). Se entra por cuenta de área y se firma como persona.
 * El área sale del rol y, en la tripulación, del cargo:
 * - Puente: Capitán. Cubierta: timoneles. Máquinas: jefe y auxiliares.
 * - Hotelería y Servicios: director de crucero, cocina, bar y cabinas.
 * - Persona Designada y Administración (en tierra). Gerencia (ve todo, no llena).
 * Funciones puras (salvo ismAccessOf) para probarlas en check-ism-flow.ts.
 */
export type IsmArea =
  | "puente"
  | "cubierta"
  | "maquinas"
  | "hoteleria"
  | "designada"
  | "administracion"
  | "gerencia"
  | "otros";

export const ONBOARD_AREAS: IsmArea[] = ["puente", "cubierta", "maquinas", "hoteleria"];

export const AREA_LABELS: Record<IsmArea, string> = {
  puente: "Puente",
  cubierta: "Cubierta",
  maquinas: "Máquinas",
  hoteleria: "Hotelería y Servicios",
  designada: "Persona Designada",
  administracion: "Administración",
  gerencia: "Gerencia",
  otros: "Otros",
};

/** Cargos de cada área de abordo (para elegir quién llena y quién está de turno). */
export const AREA_POSITIONS: Partial<Record<IsmArea, string[]>> = {
  puente: ["CAP"],
  cubierta: ["TIM_01", "TIM_02"],
  maquinas: ["MAQ", "AuxMAQ"],
  hoteleria: ["DIR", "COC", "AuxCOC", "BAR", "CABIN"],
};

export function ismArea(role: string, position?: string | null): IsmArea {
  if (role === "duena") return "gerencia";
  if (role === "admin") return "administracion";
  if (role === "designada") return "designada";
  if (role === "capitan" || position === "CAP") return "puente";
  if (position === "TIM_01" || position === "TIM_02") return "cubierta";
  if (position === "MAQ" || position === "AuxMAQ") return "maquinas";
  if (role === "direccion" || role === "bartender" || ["DIR", "COC", "AuxCOC", "BAR", "CABIN"].includes(position ?? "")) {
    return "hoteleria";
  }
  return "otros";
}

/**
 * Qué formato llena cada cuenta («L» de la matriz de la sección 4). Lo que
 * llena «cada tripulante» (R-23, R-29) lo abren todas las áreas de abordo.
 * Gerencia y Administración no llenan (sección 5, «Nuevo: —»).
 */
const FILLS: Record<IsmArea, string[]> = {
  puente: ["R-06", "R-08", "R-09", "R-10", "R-14", "R-15", "R-19", "R-22", "R-23", "R-25", "R-29"],
  cubierta: ["R-05", "R-06", "R-07", "R-08", "R-09", "R-16", "R-17", "R-18_Cubierta", "R-22", "R-23", "R-28", "R-29"],
  maquinas: ["R-05", "R-06", "R-07", "R-08", "R-09", "R-13", "R-16", "R-17", "R-18_Maquinas", "R-22", "R-23", "R-29"],
  hoteleria: ["R-05", "R-06", "R-07", "R-08", "R-09", "R-17", "R-18_Hoteleria", "R-20", "R-22", "R-23", "R-26", "R-29"],
  designada: ["R-04", "R-11", "R-12", "R-21", "R-24", "R-27", "R-30"],
  administracion: [],
  gerencia: [],
  otros: ["R-23"],
};

/** R-25_Alcohol cuenta como R-25; el R-18 va por área (R-18_Cubierta…). */
export function canCreateForm(area: IsmArea, code: string): boolean {
  const list = FILLS[area];
  return list.includes(code) || list.includes(code.split("_")[0]!);
}

/** Datos personales y de salud y evaluación: fuera del Archivo de las áreas (sección 5). */
export const SENSITIVE_CODES = ["R-04", "R-20", "R-22", "R-25_Alcohol", "R-25_Drogas"];
/** Registros de tierra que el Puente no ve («Archivo: todo lo de abordo»). */
export const LAND_CODES = ["R-11", "R-12", "R-24", "R-27"];

/** R-16: Máquinas llena los equipos de máquinas; Cubierta, el resto (o el área del equipo si la trae). */
export function equipmentArea(eq: { owner: string; area?: string }): IsmArea {
  if (eq.area === "maquinas" || eq.area === "cubierta") return eq.area;
  return /m[aá]quinas/i.test(eq.owner) ? "maquinas" : "cubierta";
}

export function canFillEquipment(area: IsmArea, eq: { owner: string; area?: string }): boolean {
  if (area === "gerencia" || area === "designada") return true;
  return equipmentArea(eq) === area;
}

interface ViewRecord {
  code: string;
  status: string;
  area?: string | null;
  createdBy: unknown;
  handoff?: { to?: unknown } | null;
}

const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v ?? "");

/**
 * Qué ve cada cuenta (sección 5): Gerencia y la PD todo; Administración solo
 * el R-18 de Hotelería; el Puente todo lo de abordo; cada área lo suyo (los
 * borradores son del área), los R-30 abiertos para firmar su fila y el R-07
 * que le entregan. Datos personales archivados: ninguna cuenta de área.
 */
export function canViewRecord(area: IsmArea, uid: string, r: ViewRecord): boolean {
  if (area === "gerencia" || area === "designada") return true;
  if (area === "administracion") return r.code === "R-18_Hoteleria";
  if (area === "puente") return !LAND_CODES.includes(r.code);
  if (r.handoff?.to && idOf(r.handoff.to) === uid && r.status === "borrador") return true;
  const own = r.area ? r.area === area : idOf(r.createdBy) === uid;
  if (r.status === "archivado") return own && !SENSITIVE_CODES.includes(r.code);
  if (own) return true;
  return r.code === "R-30" && ONBOARD_AREAS.includes(area) && r.status === "por_firmar";
}

/** El mismo criterio como filtro de Mongo (listados y conteos). */
export function viewFilter(area: IsmArea, uid: string): Record<string, unknown> {
  if (area === "gerencia" || area === "designada") return {};
  if (area === "administracion") return { code: "R-18_Hoteleria" };
  if (area === "puente") return { code: { $nin: LAND_CODES } };
  const me = new Types.ObjectId(uid);
  const own = { $or: [{ area }, { area: { $in: [null, ""] }, createdBy: me }] };
  return {
    $or: [
      { $and: [own, { status: { $ne: "archivado" } }] },
      { $and: [own, { status: "archivado", code: { $nin: SENSITIVE_CODES } }] },
      { "handoff.to": me, status: "borrador" },
      ...(ONBOARD_AREAS.includes(area) ? [{ code: "R-30", status: "por_firmar" }] : []),
    ],
  };
}

/**
 * Quién edita los datos. Gerencia nunca edita (ve y firma lo suyo). En
 * borrador, el área que lo llena (el reemplazo de turno sigue el borrador del
 * compañero, regla 8). En revisión, quien firma ese paso completa su parte
 * (análisis de causa del Capitán, medida correctiva de la PD, despacho).
 */
export function canEditData(
  area: IsmArea,
  role: string,
  uid: string,
  r: ViewRecord & { schemaVersion?: number | null },
  officeRole = "designada",
): boolean {
  if (r.status === "archivado" || area === "gerencia") return false;
  if (r.status === "borrador") {
    if (r.handoff?.to) return false;
    return r.area ? r.area === area : idOf(r.createdBy) === uid;
  }
  if (r.schemaVersion) return false;
  if (r.status === "por_capitan") return role === "capitan";
  if (r.status === "por_oficina") return role === officeRole;
  return false;
}

/** Enlace «Sistema del bar» (sección 5): Hotelería, Administración y Gerencia. */
export const BAR_LINK_AREAS: IsmArea[] = ["hoteleria", "administracion", "gerencia"];

export async function ismAccessOf(auth: { sub: string; role: string }) {
  const user = await User.findById(auth.sub).select("position");
  const area = ismArea(auth.role, user?.position);
  return { area, position: user?.position ?? "" };
}

export async function ismAreaOf(auth: { sub: string; role: string }): Promise<IsmArea> {
  return (await ismAccessOf(auth)).area;
}
