import { Product } from "../models/product.model";

/**
 * Bar, wetsuits y servicios van separados en todas las sumas y en la comisión
 * (especificación del Resumen, 24-nov-2026, «Datos que hay que corregir» 2).
 * - wetsuit: producto con precio por trayecto (legs).
 * - servicio: otro servicio (descorche…).
 * - bar: todo lo demás.
 */
export type SaleLine = "bar" | "wetsuit" | "servicio";

export interface ProductInfo {
  id: string;
  name: string;
  kind: string;
  line: SaleLine;
  costPerUnit: number;
  onboardStock: number;
  active: boolean;
}

export async function productIndex(): Promise<Map<string, ProductInfo>> {
  const products = await Product.find().select("name kind legs costPerUnit onboardStock active").lean();
  return new Map(
    products.map((p) => [
      p._id.toString(),
      {
        id: p._id.toString(),
        name: p.name,
        kind: p.kind,
        line: p.legs?.length ? "wetsuit" : p.kind === "servicio" ? "servicio" : "bar",
        costPerUnit: p.costPerUnit ?? 0,
        onboardStock: p.onboardStock ?? 0,
        active: p.active !== false,
      },
    ]),
  );
}

/** Unidades que siguen contando de un ítem (sin canceladas ni anuladas). */
export const liveUnits = (i: { qty: number; cancelledQty?: number; annulledQty?: number }) =>
  Math.max(0, i.qty - (i.cancelledQty ?? 0) - (i.annulledQty ?? 0));

/**
 * Usuario genérico («Bartender», «Bar»…): sus ventas no tienen persona, así
 * que su comisión queda retenida hasta que Gerencia asigne quién atendió.
 */
export function isGenericName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  return !n || /^(el |la )?(bartender|barman|bar|tablet[a]?( del bar)?|usuario|bar treasure)$/.test(n);
}
