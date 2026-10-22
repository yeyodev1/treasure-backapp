/**
 * Roles acordados en la reunión del 21-oct-2026:
 * - admin:     Paula (administradora): métricas, inventario, cortesías, facturas, usuarios.
 * - direccion: dirección de crucero: cobra las cuentas al final del viaje.
 * - bartender: toma pedidos en el bar desde la tablet.
 * - bodega:    verifica inventario en tierra y gestiona reabastecimientos.
 */
export const USER_ROLES = ["admin", "direccion", "bartender", "bodega"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administración",
  direccion: "Dirección de crucero",
  bartender: "Bartender",
  bodega: "Bodega",
};
