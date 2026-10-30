import mongoose, { Schema, Types } from "mongoose";

/**
 * Novedad de un registro guiado como colección propia (informe ISM,
 * plantilla, criterio 5). Nace de una respuesta "No" del chequeo y se sigue
 * aparte: responsable, plazo, estado y enlace opcional a un R-17. El
 * registro (y su PDF archivado) no cambia: la respuesta sigue guardando lo
 * que se firmó; aquí vive el seguimiento posterior.
 */
export const NOVEDAD_STATES = ["abierta", "en_proceso", "cerrada", "anulada"] as const;
export type NovedadState = (typeof NOVEDAD_STATES)[number];

export interface IIsmNovedadEvent {
  action: string;
  byName: string;
  by: Types.ObjectId | null;
  at: Date;
  detail: string;
}

export interface IIsmNovedad {
  record: Types.ObjectId;
  code: string;
  fileName: string;
  itemId: string;
  /** "Ronda de seguridad de cubierta 02" */
  itemLabel: string;
  official: string;
  descripcion: string;
  accion: string;
  responsable: string;
  /** 'YYYY-MM-DD' */
  plazo: string;
  estado: NovedadState;
  /** R-17 (acción correctiva) que la atiende, si existe. */
  r17Record: Types.ObjectId | null;
  test: boolean;
  createdBy: Types.ObjectId | null;
  closedAt: Date | null;
  history: IIsmNovedadEvent[];
  createdAt?: Date;
  updatedAt?: Date;
}

const novedadSchema = new Schema<IIsmNovedad>(
  {
    record: { type: Schema.Types.ObjectId, ref: "IsmRecord", required: true },
    code: { type: String, required: true },
    fileName: { type: String, default: "" },
    itemId: { type: String, required: true },
    itemLabel: { type: String, default: "" },
    official: { type: String, default: "" },
    descripcion: { type: String, default: "" },
    accion: { type: String, default: "" },
    responsable: { type: String, default: "" },
    plazo: { type: String, default: "" },
    estado: { type: String, enum: NOVEDAD_STATES, default: "abierta" },
    r17Record: { type: Schema.Types.ObjectId, ref: "IsmRecord", default: null },
    test: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    closedAt: { type: Date, default: null },
    history: {
      type: [
        new Schema(
          {
            action: { type: String, required: true },
            byName: { type: String, default: "" },
            by: { type: Schema.Types.ObjectId, ref: "User", default: null },
            at: { type: Date, default: () => new Date() },
            detail: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

novedadSchema.index({ record: 1, itemId: 1 }, { unique: true });
novedadSchema.index({ estado: 1, plazo: 1 });

export const IsmNovedad =
  (mongoose.models.IsmNovedad as mongoose.Model<IIsmNovedad>) ||
  mongoose.model<IIsmNovedad>("IsmNovedad", novedadSchema);
