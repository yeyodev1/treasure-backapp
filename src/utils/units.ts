/**
 * Unidades base del inventario. Todo el stock se guarda en la unidad base
 * del insumo (ml para líquidos), así cada trago resta su medida exacta y la
 * botella llega a cero (pedido de Gerencia, 22-oct-2026).
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

/** Mensaje único de cantidad inválida (checklist 29-oct, 16). */
export const QTY_POSITIVE_ERROR = "Introduce una cantidad mayor que cero.";

/** Número real mayor que cero: rechaza 0, negativos, texto y NaN (sin convertirlos). */
export function isPositiveQty(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Cero o más (recepciones: una línea puede no haber llegado). */
export function isNonNegativeQty(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
