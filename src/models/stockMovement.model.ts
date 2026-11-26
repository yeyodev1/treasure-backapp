import mongoose, { Schema, Types } from "mongoose";
import { STOCK_LOCATIONS, StockLocation } from "../utils/units";

/**
 * Bitácora de inventario: todo movimiento queda con quién, cuándo, dónde y
 * por qué. Las cantidades van en la unidad base del insumo (ml, unidad…).
 */
export const MOVEMENT_TYPES = [
  "carga", // traslado bodega → a bordo
  "venta", // consumo por bebida entregada
  "merma", // rotura o pérdida reportada en el momento
  "ajuste", // diferencia aprobada por Gerencia (conteo físico o ajuste manual)
  "compra", // recepción física de una compra (factura sin recepción no mueve stock)
  "reverso", // deshacer un consumo registrado por error (devuelve lo descontado)
  "devolucion", // anulación aprobada por Gerencia con regreso al stock
  "migracion", // saldo trasladado desde el modelo anterior
  "rotura", // botella rota registrada en el momento, con foto (Bar-stock, 24-nov-2026)
  "salida", // a cocina, tripulación o brindis, con quién autorizó (no es venta ni merma)
  "devolucion_tierra", // vencido o dañado que vuelve a tierra (no es merma)
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface IStockMovement {
  type: MovementType;
  product: Types.ObjectId;
  location: StockLocation;
  /** Positivo suma al stock de la ubicación, negativo resta. */
  qty: number;
  cruise: Types.ObjectId | null;
  order: Types.ObjectId | null;
  count: Types.ObjectId | null;
  reason: string;
  supplier: string;
  document: string;
  unitCost: number;
  /** Une las dos patas de un traslado (bodega −, a bordo +). */
  transferId: string;
  requisition: Types.ObjectId | null;
  purchase: Types.ObjectId | null;
  /** Movimientos previos a la v3 están en unidades antiguas (no en ml). */
  legacy: boolean;
  /** Rotura: foto obligatoria. */
  photo: string;
  /** Salida: cocina, tripulación o brindis. */
  exitKind: "" | "cocina" | "tripulacion" | "brindis";
  /** Salida: quién la autorizó. */
  authorizedByName: string;
  user: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    location: { type: String, enum: STOCK_LOCATIONS, default: "abordo" },
    qty: { type: Number, required: true },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    count: { type: Schema.Types.ObjectId, ref: "StockCount", default: null },
    reason: { type: String, default: "" },
    supplier: { type: String, default: "" },
    document: { type: String, default: "" },
    unitCost: { type: Number, default: 0 },
    transferId: { type: String, default: "" },
    requisition: { type: Schema.Types.ObjectId, ref: "Requisition", default: null },
    purchase: { type: Schema.Types.ObjectId, ref: "Purchase", default: null },
    legacy: { type: Boolean, default: false },
    photo: { type: String, default: "" },
    exitKind: { type: String, enum: ["", "cocina", "tripulacion", "brindis"], default: "" },
    authorizedByName: { type: String, default: "" },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

stockMovementSchema.index({ cruise: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, createdAt: -1 });
stockMovementSchema.index({ createdAt: -1 });

export const StockMovement =
  (mongoose.models.StockMovement as mongoose.Model<IStockMovement>) ||
  mongoose.model<IStockMovement>("StockMovement", stockMovementSchema);
