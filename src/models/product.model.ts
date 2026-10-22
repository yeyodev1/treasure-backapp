import mongoose, { Schema, Types } from "mongoose";

export const PRODUCT_CATEGORIES = [
  "cerveza",
  "vino",
  "licor",
  "coctel",
  "gaseosa",
  "agua",
  "jugo",
  "snack",
  "otro",
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface IRecipeItem {
  product: Types.ObjectId;
  qty: number;
}

export interface IProduct {
  name: string;
  category: ProductCategory;
  /** Nombre de icono del set del frontend; el catálogo es por iconos, sin fotos (acuerdo de reunión). */
  icon: string;
  price: number;
  /** Unidad de inventario: unidad, botella, onza, vaso… */
  unit: string;
  /** Stock en bodega (tierra). El stock a bordo vive por crucero en CruiseStock. */
  warehouseStock: number;
  /** Cócteles: receta con cálculo automático de precio según ingredientes. */
  isCocktail: boolean;
  recipe: IRecipeItem[];
  /** Cócteles creados sobre la marcha desde la tablet quedan marcados para revisarlos. */
  isCustom: boolean;
  active: boolean;
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

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true },
    icon: { type: String, default: "glass" },
    price: { type: Number, required: true, min: 0 },
    unit: { type: String, default: "unidad" },
    warehouseStock: { type: Number, default: 0, min: 0 },
    isCocktail: { type: Boolean, default: false },
    recipe: { type: [recipeItemSchema], default: [] },
    isCustom: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

productSchema.index({ name: 1 });
productSchema.index({ category: 1, active: 1 });

export const Product =
  (mongoose.models.Product as mongoose.Model<IProduct>) ||
  mongoose.model<IProduct>("Product", productSchema);
