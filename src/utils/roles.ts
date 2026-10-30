/**
 * Roles del sistema.
 * Bar (reunión 21-oct-2026 y guía auditada 27-oct-2026). Los códigos internos
 * se conservan; lo visible usa el área sin género (checklist 29-oct, 19 y 20):
 * - duena:     Gerencia: toda la operación y finanzas; autoriza precios,
 *              ajustes de inventario y reversos. Puede todo lo de los demás roles.
 * - admin:     Administración: conteo físico, diferencias, compras y recepciones.
 * - direccion: Dirección de crucero: pasajeros, cabinas, inicio/fin,
 *              aprobación de cuentas y abastecimiento, cobros.
 * - bartender: registra consumos y requerimientos desde la tablet.
 * - bodega:    inventario en tierra (compras, recepciones, cargas).
 * Registros ISM (reunión 22-oct-2026 con Felipe):
 * - capitan:    revisa y firma los registros como Capitán.
 * - tripulante: timoneles, maquinistas y demás tripulación que llena registros.
 * - designada:  Persona Designada en oficina: recibe, firma y archiva.
 */
export const USER_ROLES = [
  "duena",
  "admin",
  "direccion",
  "bartender",
  "bodega",
  "capitan",
  "tripulante",
  "designada",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  duena: "Gerencia",
  admin: "Administración",
  direccion: "Dirección de crucero",
  bartender: "Bartender",
  bodega: "Bodega",
  capitan: "Capitán",
  tripulante: "Tripulante",
  designada: "Persona Designada",
};

/** Cargos a bordo usados por los registros R-07, R-22 y R-23. */
export const CREW_POSITIONS = [
  "CAP",
  "TIM_01",
  "TIM_02",
  "MAQ",
  "AuxMAQ",
  "COC",
  "AuxCOC",
  "BAR",
  "CABIN",
  "DIR",
] as const;
export type CrewPosition = (typeof CREW_POSITIONS)[number];

export const POSITION_LABELS: Record<CrewPosition, string> = {
  CAP: "Capitán",
  TIM_01: "Timonel 1",
  TIM_02: "Timonel 2",
  MAQ: "Jefe de Máquinas",
  AuxMAQ: "Auxiliar de Máquinas",
  COC: "Cocina",
  AuxCOC: "Auxiliar de Cocina",
  BAR: "Bar",
  CABIN: "Cabinas",
  DIR: "Dirección de crucero",
};

/** Gerencia puede todo; Administración conserva lo operativo. */
export function isOwner(role: string | undefined): boolean {
  return role === "duena";
}

/** Gerencia o Administración (antes "admin" lo era todo). */
export function isManager(role: string | undefined): boolean {
  return role === "duena" || role === "admin";
}
