import { User } from "../models/user.model";

/**
 * Qué R llena cada área (tabla del cliente, 5-nov-2026). El área sale del rol
 * y, en la tripulación, del cargo (las cuentas compartidas también tienen cargo).
 * - Gerencia y Administración: todo.
 * - Puente (Capitán): todo salvo R-26, R-29 y R-30.
 * - Cubierta (timoneles): R-05, 06, 07, 10, 14, 16, 17, 23, 28 (el R-14 sigue en cubierta).
 * - Máquinas: R-07, 12, 13, 16, 23.
 * - Dirección de crucero: R-07, 09, 17, 20, 21, 22, 23, 25, 26.
 * - Oficina (Persona Designada): R-07 y R-16, más su bandeja de firma.
 * - Cocina, Bar y Cabinas (no están en la tabla): R-07 y R-23.
 * El Archivo ISM (registros archivados) solo lo ven Capitán, Persona Designada,
 * Gerencia y Administración: son los roles de SEES_ALL.
 */
export type IsmArea = "gerencia" | "puente" | "cubierta" | "maquinas" | "direccion" | "oficina" | "otros";

const AREA_FORMS: Record<Exclude<IsmArea, "gerencia" | "puente">, string[]> = {
  cubierta: ["R-05", "R-06", "R-07", "R-10", "R-14", "R-16", "R-17", "R-23", "R-28"],
  maquinas: ["R-07", "R-12", "R-13", "R-16", "R-23"],
  direccion: ["R-07", "R-09", "R-17", "R-20", "R-21", "R-22", "R-23", "R-25", "R-26"],
  oficina: ["R-07", "R-16"],
  otros: ["R-07", "R-23"],
};
const PUENTE_EXCLUDED = ["R-26", "R-29", "R-30"];

export function ismArea(role: string, position?: string | null): IsmArea {
  if (role === "duena" || role === "admin") return "gerencia";
  if (role === "designada") return "oficina";
  if (role === "capitan" || position === "CAP") return "puente";
  if (role === "direccion" || position === "DIR") return "direccion";
  if (position === "TIM_01" || position === "TIM_02") return "cubierta";
  if (position === "MAQ" || position === "AuxMAQ") return "maquinas";
  return "otros";
}

/** R-25_Alcohol cuenta como R-25, R-18_Cubierta como R-18. */
export function canCreateForm(area: IsmArea, code: string, officeOnly = false): boolean {
  const base = code.split("_")[0];
  if (area === "gerencia") return true;
  // Los de oficina (R-11, R-24) siguen siendo solo de oficina: con la tabla quedan en Gerencia.
  if (officeOnly) return false;
  if (area === "puente") return !PUENTE_EXCLUDED.includes(base);
  return AREA_FORMS[area].includes(base);
}

export async function ismAreaOf(auth: { sub: string; role: string }): Promise<IsmArea> {
  const user = await User.findById(auth.sub).select("position");
  return ismArea(auth.role, user?.position);
}
