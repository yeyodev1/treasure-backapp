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

/**
 * Ubicaciones de inventario (guía Inventario y pedidos, 4-nov-2026): Quito
 * (UIO), puerto en Galápagos y a bordo, cada una con su cantidad. "bodega" es
 * el saldo anterior sin separar: no recibe mercadería nueva y se cierra cuando
 * Quito y Puerto tienen su conteo físico aprobado.
 */
export const STOCK_LOCATIONS = ["quito", "puerto", "abordo", "bodega"] as const;
export type StockLocation = (typeof STOCK_LOCATIONS)[number];
/** Donde llega o se guarda mercadería nueva. */
export const ACTIVE_LOCATIONS = ["quito", "puerto", "abordo"] as const;
export const LOCATION_LABELS: Record<StockLocation, string> = {
  quito: "Quito",
  puerto: "Puerto en Galápagos",
  abordo: "A bordo",
  bodega: "Bodega sin separar",
};
export function isActiveLocation(value: unknown): value is (typeof ACTIVE_LOCATIONS)[number] {
  return (ACTIVE_LOCATIONS as readonly unknown[]).includes(value);
}

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
