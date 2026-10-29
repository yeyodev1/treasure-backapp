import mongoose, { Schema, Types } from "mongoose";

/**
 * Registro ISM (listado de registros del Manual de Gestión de Seguridad).
 * Circuito: borrador (se llena y firma la tripulación) → por_capitan →
 * por_oficina (Persona Designada) → archivado (inmutable).
 */
export const ISM_STATUSES = ["borrador", "por_capitan", "por_oficina", "archivado"] as const;
export type IsmStatus = (typeof ISM_STATUSES)[number];

export const SIGNATURE_STAGES = ["tripulacion", "capitan", "oficina"] as const;
export type SignatureStage = (typeof SIGNATURE_STAGES)[number];

export interface IIsmSignature {
  field: string;
  stage: SignatureStage;
  label: string;
  /** Quién firma (puede ser un asistente sin cuenta que firma en la tablet). */
  signerName: string;
  /** Usuario con sesión iniciada que capturó la firma. */
  user: Types.ObjectId;
  userName: string;
  userRole: string;
  /** PNG de la firma dibujada con el dedo (data URL). */
  image: string;
  signedAt: Date;
  /** Huella del contenido del registro en el momento de firmar. */
  dataHash: string;
  /**
   * Versión de la huella. 2: solo el contenido (datos, respuestas y contexto),
   * sin las firmas; si el contenido cambia después, la firma queda invalidada.
   * Las firmas anteriores (sin versión) no se pueden verificar y se respetan.
   */
  hashV?: number;
}

export interface IIsmEvent {
  action: string;
  by: Types.ObjectId | null;
  byName: string;
  at: Date;
  reason: string;
  /** Sección afectada (devoluciones). */
  section?: string;
}

/** Respuesta de un punto de un registro guiado (R-14…). */
export interface IIsmAnswer {
  value: "si" | "no" | "na" | null;
  /** "Hay un problema" aunque la respuesta sea SI. */
  problem: boolean;
  /** Novedad: qué se encontró y qué se hizo. */
  descripcion: string;
  accion: string;
  /** Motivo del "No aplica". */
  motivo: string;
  /** Fotos de evidencia (URL). */
  evidencia: string[];
  /** Momento de captura y quién respondió. */
  at: Date | null;
  by: Types.ObjectId | null;
}

/** Contexto confirmado al iniciar un registro guiado. */
export interface IIsmContext {
  vessel: string;
  /** Fecha y hora de la actividad (no de captura ni de firma). */
  activityDate: string;
  activityTime: string;
  place: string;
  filledBy: {
    user: Types.ObjectId;
    /** Cuenta con la que se inició sesión. */
    accountName: string;
    /** Nombre de quien hace la guardia (puede diferir si la cuenta es compartida). */
    name: string;
    role: string;
    position: string;
  };
  confirmedAt: Date | null;
}

export interface IIsmFlags {
  answered: number;
  total: number;
  novedades: number;
  noAplica: number;
}

export interface IIsmReturnInfo {
  reason: string;
  section: string;
  byName: string;
  at: Date;
}

export interface IIsmRecord {
  code: string;
  title: string;
  status: IsmStatus;
  /** Fecha real del registro (día en Galápagos) — define año y mes del archivo. */
  recordDate: Date;
  fileName: string;
  /** Valores de los campos del formulario oficial (nombre del campo → valor). */
  data: Record<string, string | boolean>;
  signatures: IIsmSignature[];
  position: string;
  equipment: { folder: string; name: string; category: string } | null;
  cruise: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  submittedAt: Date | null;
  captainApprovedBy: Types.ObjectId | null;
  captainApprovedAt: Date | null;
  officeApprovedBy: Types.ObjectId | null;
  archivedAt: Date | null;
  contentHash: string;
  history: IIsmEvent[];
  /** Registros guiados: versión del esquema de preguntas (assets/ism/schemas). */
  schemaVersion: number | null;
  context: IIsmContext | null;
  answers: Record<string, IIsmAnswer>;
  flags: IIsmFlags | null;
  /** Última devolución vigente (se limpia al reenviar). */
  returnInfo: IIsmReturnInfo | null;
  /** Clave del cliente para que un reintento no duplique el registro. */
  idempotencyKey: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const signatureSchema = new Schema<IIsmSignature>(
  {
    field: { type: String, required: true },
    stage: { type: String, enum: SIGNATURE_STAGES, required: true },
    label: { type: String, default: "" },
    signerName: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, default: "" },
    userRole: { type: String, default: "" },
    image: { type: String, required: true },
    signedAt: { type: Date, default: () => new Date() },
    dataHash: { type: String, default: "" },
    hashV: { type: Number },
  },
  { _id: false },
);

const eventSchema = new Schema<IIsmEvent>(
  {
    action: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
    reason: { type: String, default: "" },
    section: { type: String, default: "" },
  },
  { _id: false },
);

const ismRecordSchema = new Schema<IIsmRecord>(
  {
    code: { type: String, required: true },
    title: { type: String, required: true },
    status: { type: String, enum: ISM_STATUSES, default: "borrador" },
    recordDate: { type: Date, required: true },
    fileName: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    signatures: { type: [signatureSchema], default: [] },
    position: { type: String, default: "" },
    equipment: {
      type: new Schema(
        { folder: String, name: String, category: String },
        { _id: false },
      ),
      default: null,
    },
    cruise: { type: Schema.Types.ObjectId, ref: "Cruise", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    submittedAt: { type: Date, default: null },
    captainApprovedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    captainApprovedAt: { type: Date, default: null },
    officeApprovedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt: { type: Date, default: null },
    contentHash: { type: String, default: "" },
    history: { type: [eventSchema], default: [] },
    schemaVersion: { type: Number, default: null },
    context: { type: Schema.Types.Mixed, default: null },
    answers: { type: Schema.Types.Mixed, default: {} },
    flags: {
      type: new Schema(
        { answered: Number, total: Number, novedades: Number, noAplica: Number },
        { _id: false },
      ),
      default: null,
    },
    returnInfo: {
      type: new Schema(
        { reason: String, section: String, byName: String, at: Date },
        { _id: false },
      ),
      default: null,
    },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true, minimize: false, optimisticConcurrency: true },
);

ismRecordSchema.index({ code: 1, recordDate: -1 });
ismRecordSchema.index({ status: 1, updatedAt: -1 });
ismRecordSchema.index({ createdBy: 1, status: 1 });
ismRecordSchema.index({ recordDate: -1 });
// Un reintento de creación con la misma clave devuelve el mismo registro.
ismRecordSchema.index(
  { createdBy: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export const IsmRecord =
  (mongoose.models.IsmRecord as mongoose.Model<IIsmRecord>) ||
  mongoose.model<IIsmRecord>("IsmRecord", ismRecordSchema);
