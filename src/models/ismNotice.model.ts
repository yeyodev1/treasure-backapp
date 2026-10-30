import mongoose, { Schema, Types } from "mongoose";

/**
 * Avisos de Registros ISM (informe R-14 del 29-oct, "Avisos"). Hoy se
 * entregan dentro de la app; `channel` deja abierta la entrega por correo o
 * Teams cuando la empresa lo decida (pregunta abierta del informe).
 */
export const NOTICE_KINDS = [
  "por_firmar_capitan",
  "por_firmar_designada",
  "devuelto",
  "espera_capitan",
  "espera_designada",
  "clave_bloqueada",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export interface IIsmNotice {
  to: Types.ObjectId;
  kind: NoticeKind;
  title: string;
  body: string;
  record: Types.ObjectId | null;
  /** Ruta de la app que abre el aviso (p. ej. /registro/<id>). */
  link: string;
  channel: "app";
  /** Evita repetir el mismo aviso (p. ej. una alerta de espera por registro). */
  key: string | null;
  readAt: Date | null;
  createdAt?: Date;
}

const ismNoticeSchema = new Schema<IIsmNotice>(
  {
    to: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: NOTICE_KINDS, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    record: { type: Schema.Types.ObjectId, ref: "IsmRecord", default: null },
    link: { type: String, default: "" },
    channel: { type: String, default: "app" },
    key: { type: String, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ismNoticeSchema.index({ to: 1, createdAt: -1 });
ismNoticeSchema.index({ to: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: "string" } } });

export const IsmNotice =
  (mongoose.models.IsmNotice as mongoose.Model<IIsmNotice>) ||
  mongoose.model<IIsmNotice>("IsmNotice", ismNoticeSchema);
