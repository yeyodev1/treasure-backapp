/**
 * Unidades base del inventario. Todo el stock se guarda en la unidad base
 * del insumo (ml para líquidos), así cada trago resta su medida exacta y la
 * botella llega a cero (pedido de Paula, 22-oct-2026).
 */
export const STOCK_UNITS = [
  "ml",
  "unidad",
  "g",
  "cucharadita",
  "cucharada",
  "ramita",
  "rodaja",
  "gota",
  "golpe",
  "porción",
] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

/** Tipos de producto del catálogo (guía visual V3). */
export const PRODUCT_KINDS = ["fisico", "receta", "servicio"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** Ubicaciones de inventario. */
export const STOCK_LOCATIONS = ["bodega", "abordo"] as const;
export type StockLocation = (typeof STOCK_LOCATIONS)[number];

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
