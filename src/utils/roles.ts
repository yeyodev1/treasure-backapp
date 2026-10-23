/**
 * Roles del sistema.
 * Bar (reunión 21-oct-2026):
 * - admin:     Paula (administradora): todo, en el bar y en los registros ISM.
 * - direccion: dirección de crucero.
 * - bartender: toma pedidos en el bar desde la tablet.
 * - bodega:    inventario en tierra.
 * Registros ISM (reunión 22-oct-2026 con Felipe):
 * - capitan:    revisa y firma los registros como Capitán.
 * - tripulante: timoneles, maquinistas y demás tripulación que llena registros.
 * - designada:  Persona Designada en oficina: recibe, firma y archiva.
 */
export const USER_ROLES = [
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
  DIR: "Director de Crucero",
};
