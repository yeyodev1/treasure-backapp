import mongoose, { Schema, Types } from "mongoose";

/**
 * Pedido semanal (guía Inventario y pedidos, 4-nov-2026). Cada miércoles a
 * las 15h00 (hora de Galápagos) el sistema prepara una propuesta con las
 * existencias del corte; el bar la revisa y la envía a revisión; la
 * directora la modifica y la aprueba para comprar. Nada de esto mueve stock:
 * las compras y recepciones se registran aparte, ligadas a este pedido.
 *
 * - bar: por revisar por el bar
 * - directora: por revisar por la directora
 * - aprobado: listo para atender; el avance sale de las entregas y envíos
 *   registrados dentro del mismo pedido (guía 4 perfiles, 4-nov-2026)
 * - cancelado: se descartó antes de aprobarse
 */
export const WEEKLY_ORDER_STATUSES = ["bar", "directora", "aprobado", "cancelado"] as const;
export type WeeklyOrderStatus = (typeof WEEKLY_ORDER_STATUSES)[number];

/** De dónde sale la cantidad sugerida. */
export const SUGGESTION_BASES = ["objetivo", "consumo", "revisar", "agregado"] as const;
export type SuggestionBasis = (typeof SUGGESTION_BASES)[number];

export interface IWeeklyOrderLine {
  product: Types.ObjectId;
  name: string;
  stockUnit: string;
  containerSize: number;
  containerLabel: string;
  /** Existencias al corte, en unidad base, por ubicación. */
  atCut: { quito: number; puerto: number; abordo: number; bodega: number };
  /** Objetivo del producto al corte (envases); 0 = sin objetivo. */
  target: number;
  /** Lo que ya viene en camino al corte (compras sin recibir y pedidos sin comprar), unidad base. */
  incoming: number;
  /** Consumo de los 7 días previos al corte, unidad base. */
  consumption: number;
  /** Envases sugeridos; null = sin datos suficientes ("Revisa esta cantidad"). */
  suggested: number | null;
  basis: SuggestionBasis;
  /** Cantidad pedida hoy (envases). */
  qty: number;
  /** Lo que el bar envió a revisión y lo que aprobó la directora (trazabilidad). */
  barQty: number | null;
  approvedQty: number | null;
  /** "Hay otra cantidad": aviso de diferencia; no cambia el inventario. */
  observation: string;
  /** Envases que contó el bar a bordo (flujo simple, Gabriel 16-nov-2026); null = no contó. */
  counted: number | null;
  /** Stock estimado al viernes (envases), con el que se calcula la propuesta (Bar-stock, 24-nov-2026). */
  fridayStock: number | null;
  editedByName: string;
  editedAt: Date | null;
}

/** De dónde sale lo que se entrega: bodega de puerto, bodega de Quito o compra nueva. */
export const DELIVERY_SOURCES = ["puerto", "quito", "compra"] as const;
export type DeliverySource = (typeof DELIVERY_SOURCES)[number];

export interface IWeeklyOrderDeliveryItem {
  product: Types.ObjectId;
  name: string;
  source: DeliverySource;
  /** Envases. */
  qty: number;
  /** Costo por envase de una compra nueva (0 = sin costo registrado). */
  cost: number;
  /** Envases que el bar confirmó recibir; null = aún no confirma. */
  received: number | null;
}

/**
 * "Confirmar mi entrega" (administradora: llega al barco en el acto) o
 * "Confirmar mi envío" (dueña: sale de Quito y suma al barco al confirmar la
 * llegada). `key` la genera la app: repetir la misma no duplica.
 */
export interface IWeeklyOrderDelivery {
  key: string;
  kind: "entrega" | "envio";
  at: Date;
  by: Types.ObjectId | null;
  byName: string;
  items: IWeeklyOrderDeliveryItem[];
  document: string;
  arrivedAt: Date | null;
  arrivedByName: string;
  /**
   * Flujo simple (Gabriel, 16-nov-2026): nada sube al barco hasta que el bar
   * confirma lo recibido. Las entregas anteriores (false) ya sumaron al barco.
   */
  awaitsBar: boolean;
  /** El bar marcó «Llegó diferente»: le llega a Gerencia (Bar-stock, 24-nov-2026). */
  different: boolean;
  /** Quien compró es el mismo bartender que recibe: confirma además la directora. */
  needsDirector: boolean;
  directorConfirmedByName: string;
  /** Gerencia: aceptó la diferencia o pidió explicación a quien compró. */
  differenceDecision: { action: "aceptada" | "explicacion"; byName: string; at: Date; note: string } | null;
}

export interface IWeeklyOrderEvent {
  at: Date;
  by: Types.ObjectId | null;
  byName: string;
  action: string;
  detail: string;
}

export interface IWeeklyOrder {
  code: string;
  /** Día del corte (miércoles) en Galápagos, AAAA-MM-DD: uno por semana. */
  week: string;
  cutAt: Date;
  /** true si la propuesta se armó después del corte (la tarea automática no corrió a tiempo). */
  generatedLate: boolean;
  status: WeeklyOrderStatus;
  lines: IWeeklyOrderLine[];
  history: IWeeklyOrderEvent[];
  deliveries: IWeeklyOrderDelivery[];
  /** Aprobado en cero: "Cerrado sin necesidades". */
  noNeeds: boolean;
  /** Cambios después de aprobar: cada uno sube la revisión y avisa a compras. */
  revision: number;
  changedAt: Date | null;
  recipient: string;
  /** A las 18h00 sin aprobación se aprueba solo con la propuesta (Bar-stock, 24-nov-2026). */
  autoApproved: boolean;
  /** Pedido fuera de lo normal (más de 20 % sobre la propuesta o un producto que nunca se pide). */
  outliers: string[];
  outlierDecision: { accepted: boolean; byName: string; at: Date } | null;
  /** Compra del jueves: lo que no se consiguió o se reemplazó. */
  shortages: Array<{ product: Types.ObjectId; name: string; status: "no_conseguido" | "reemplazado"; replacement: string }>;
  /** El responsable de compras marcó el pedido como enviado al barco. */
  sentAt: Date | null;
  sentByName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const lineSchema = new Schema<IWeeklyOrderLine>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    stockUnit: { type: String, default: "unidad" },
    containerSize: { type: Number, default: 1 },
    containerLabel: { type: String, default: "unidad" },
    atCut: {
      type: new Schema(
        { quito: Number, puerto: Number, abordo: Number, bodega: Number },
        { _id: false },
      ),
      default: () => ({ quito: 0, puerto: 0, abordo: 0, bodega: 0 }),
    },
    target: { type: Number, default: 0 },
    incoming: { type: Number, default: 0 },
    consumption: { type: Number, default: 0 },
    suggested: { type: Number, default: null },
    basis: { type: String, enum: SUGGESTION_BASES, default: "agregado" },
    qty: { type: Number, default: 0, min: 0 },
    barQty: { type: Number, default: null },
    approvedQty: { type: Number, default: null },
    observation: { type: String, default: "", maxlength: 300 },
    counted: { type: Number, default: null, min: 0 },
    fridayStock: { type: Number, default: null },
    editedByName: { type: String, default: "" },
    editedAt: { type: Date, default: null },
  },
  { _id: false },
);

const eventSchema = new Schema<IWeeklyOrderEvent>(
  {
    at: { type: Date, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    action: { type: String, required: true },
    detail: { type: String, default: "" },
  },
  { _id: false },
);

const deliverySchema = new Schema<IWeeklyOrderDelivery>(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: ["entrega", "envio"], required: true },
    at: { type: Date, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    items: {
      type: [
        new Schema<IWeeklyOrderDeliveryItem>(
          {
            product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
            name: { type: String, required: true },
            source: { type: String, enum: DELIVERY_SOURCES, required: true },
            qty: { type: Number, required: true, min: 1 },
            cost: { type: Number, default: 0, min: 0 },
            received: { type: Number, default: null, min: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    document: { type: String, default: "", maxlength: 120 },
    arrivedAt: { type: Date, default: null },
    arrivedByName: { type: String, default: "" },
    awaitsBar: { type: Boolean, default: false },
    different: { type: Boolean, default: false },
    needsDirector: { type: Boolean, default: false },
    directorConfirmedByName: { type: String, default: "" },
    differenceDecision: {
      type: new Schema({ action: String, byName: String, at: Date, note: String }, { _id: false }),
      default: null,
    },
  },
  { _id: false },
);

const weeklyOrderSchema = new Schema<IWeeklyOrder>(
  {
    code: { type: String, required: true, unique: true },
    week: { type: String, required: true, unique: true },
    cutAt: { type: Date, required: true },
    generatedLate: { type: Boolean, default: false },
    status: { type: String, enum: WEEKLY_ORDER_STATUSES, default: "bar" },
    lines: { type: [lineSchema], default: [] },
    history: { type: [eventSchema], default: [] },
    deliveries: { type: [deliverySchema], default: [] },
    noNeeds: { type: Boolean, default: false },
    revision: { type: Number, default: 0 },
    changedAt: { type: Date, default: null },
    recipient: { type: String, default: "" },
    autoApproved: { type: Boolean, default: false },
    outliers: { type: [String], default: [] },
    outlierDecision: { type: new Schema({ accepted: Boolean, byName: String, at: Date }, { _id: false }), default: null },
    shortages: {
      type: [
        new Schema(
          {
            product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
            name: { type: String, default: "" },
            status: { type: String, enum: ["no_conseguido", "reemplazado"], required: true },
            replacement: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    sentAt: { type: Date, default: null },
    sentByName: { type: String, default: "" },
  },
  { timestamps: true, optimisticConcurrency: true },
);

weeklyOrderSchema.index({ cutAt: -1 });

export const WeeklyOrder =
  (mongoose.models.WeeklyOrder as mongoose.Model<IWeeklyOrder>) ||
  mongoose.model<IWeeklyOrder>("WeeklyOrder", weeklyOrderSchema);
