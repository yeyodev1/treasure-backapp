import mongoose, { Schema, Types } from "mongoose";
import { PRODUCT_KINDS, ProductKind, STOCK_UNITS, StockUnit } from "../utils/units";

export const PRODUCT_CATEGORIES = [
  "cerveza",
  "vino",
  "licor",
  "coctel",
  "gaseosa",
  "agua",
  "jugo",
  "snack",
  "insumo",
  "servicio",
  "otro",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface IRecipeItem {
  /** Siempre un producto físico; la cantidad va en su unidad base (ml, unidad…). */
  product: Types.ObjectId;
  qty: number;
}

export interface IPriceChange {
  price: number;
  changedBy: Types.ObjectId;
  at: Date;
}

export interface IProduct {
  name: string;
  category: ProductCategory;
  icon: string;
  /**
   * fisico: botella, lata o insumo con stock propio.
   * receta: se arma con insumos físicos (trago, copa, cóctel).
   * servicio: se cobra pero no mueve inventario (descorche).
   */
  kind: ProductKind;
  /** Precio vigente. Solo administración lo cambia; cada venta guarda el suyo. */
  price: number;
  /** Un físico puede ser solo insumo (no aparece en la carta del bar). */
  sellable: boolean;

  // ---- Inventario (solo físicos) ----
  stockUnit: StockUnit;
  /** Cuánto trae un envase en unidad base: botella 750 ml, lata 355 ml, cerveza 1. */
  containerSize: number;
  containerLabel: string;
  /** Stock en unidad base. Puede quedar negativo: se resuelve con conteo físico. */
  warehouseStock: number;
  onboardStock: number;
  /** Alerta de stock bajo (unidad base). 0 = sin alerta. */
  lowStockThreshold: number;

  /**
   * Referencia para cócteles creados en el bar: cuánto cuesta una medida
   * estándar de este insumo (p. ej. 60 ml de Bacardí = $10).
   */
  servingSize: number;
  servingPrice: number;

  // ---- Receta ----
  recipe: IRecipeItem[];

  isCustom: boolean;
  active: boolean;
  /** Producto equivalente en Contífico (para facturar). Vacío = sin vincular. */
  contificoId: string;
  contificoCode: string;
  priceHistory: IPriceChange[];
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const recipeItemSchema = new Schema<IRecipeItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const priceChangeSchema = new Schema<IPriceChange>(
  {
    price: { type: Number, required: true },
    changedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true },
    icon: { type: String, default: "glass" },
    kind: { type: String, enum: PRODUCT_KINDS, required: true, default: "fisico" },
    price: { type: Number, default: 0, min: 0 },
    sellable: { type: Boolean, default: true },
    stockUnit: { type: String, enum: STOCK_UNITS, default: "unidad" },
    containerSize: { type: Number, default: 1, min: 0 },
    containerLabel: { type: String, default: "unidad" },
    warehouseStock: { type: Number, default: 0 },
    onboardStock: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    servingSize: { type: Number, default: 0, min: 0 },
    servingPrice: { type: Number, default: 0, min: 0 },
    recipe: { type: [recipeItemSchema], default: [] },
    isCustom: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    contificoId: { type: String, default: "" },
    contificoCode: { type: String, default: "" },
    priceHistory: { type: [priceChangeSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

productSchema.index({ name: 1 });
productSchema.index({ kind: 1, active: 1 });

export const Product =
  (mongoose.models.Product as mongoose.Model<IProduct>) ||
  mongoose.model<IProduct>("Product", productSchema);
