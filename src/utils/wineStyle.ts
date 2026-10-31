import type { WineStyle } from "../models/product.model";

/**
 * Tipo de cada vino de la carta (pedido del cliente, 31-oct-2026: dividir
 * Vinos en tinto, blanco y espumantes). Se reconoce por el nombre sin
 * "(botella)" / "(copa)"; lo que no está aquí queda sin tipo y se asigna
 * desde Catálogo.
 */
const STYLES: Array<[WineStyle, string[]]> = [
  [
    "espumante",
    [
      "VDV Ice Rosé",
      "VDV Ice",
      "Calvet Celebration Brut",
      "Calvet Celebration Brut Rosé",
      "Demi Sec Concha y Toro",
      "Blue Nun 24k",
      "Brut Reserva Vilarnau",
      "Demi Sec Vilarnau",
      "VDV Ice mini 200ml",
      "VDV Ice Rosé mini 200ml",
      "Henkell Trocken Dry Piccolo 200ml",
      "Henkell Trocken Dry 375ml",
    ],
  ],
  ["rosado", ["Rosé D'Anjou", "Rosé Cotes de Provence", "Adobe Reserva Rosé mini 375ml"]],
  [
    "blanco",
    [
      "Sauvignon Blanc Casillero",
      "Chardonnay Casillero",
      "Blanco de Blancas",
      "Reservado Sauvignon",
      "Calvet Sauvignon Blanc mini 187ml",
      "Adobe Reserva Chardonnay mini 375ml",
    ],
  ],
  [
    "tinto",
    [
      "Faustino V Reserva",
      "Malbec Piel de Lobo",
      "Merlot Casillero",
      "Carmenere Casillero",
      "Malbec Casillero",
      "Pinot Noir Casillero",
      "Syrah Casillero",
      "Cabernet Sauvignon Casillero",
      "Reservado Cabernet Sauvignon",
      "Reservado Merlot",
      "Cabernet Sauvignon mini 375ml",
      "Calvet Merlot mini 187ml",
      "Adobe Reserva Carmenere mini 375ml",
    ],
  ],
];

function key(name: string): string {
  return name
    .replace(/\s*\((botella|copa)\)\s*$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'")
    .trim()
    .toLowerCase();
}

const BY_NAME = new Map<string, WineStyle>(
  STYLES.flatMap(([style, names]) => names.map((n) => [key(n), style] as const)),
);

/** Tipo del vino por su nombre; "" si no se reconoce. */
export function wineStyleOf(name: string): WineStyle | "" {
  return BY_NAME.get(key(name)) ?? "";
}
