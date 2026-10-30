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
  /**
   * Usuario que firma. En el R-14 guiado es la persona de la lista de
   * tripulantes que confirmó con su clave, no la sesión de la tablet.
   */
  user: Types.ObjectId;
  userName: string;
  userRole: string;
  /** Cargo en el momento de firmar (CAP, TIM_01…). */
  position?: string;
  /** Sesión de la tablet con la que se capturó (si es distinta de quien firma). */
  capturedBy?: Types.ObjectId | null;
  capturedByName?: string;
  /** "clave": confirmada con la clave de 4 números. */
  method?: string;
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
  /** Clave restablecida en las 24 h previas a esta firma: cuándo y por quién (se imprime en el anexo). */
  pinResetAt?: Date | null;
  pinResetByName?: string;
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
  /** Seguimiento de la novedad (informe 29-oct): quién la resuelve, para cuándo y si quedó cerrada. */
  responsable?: string;
  plazo?: string;
  estado?: "" | "abierta" | "cerrada";
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
    /** Elegido de la lista de tripulantes (no escrito a mano). */
    fromList?: boolean;
    /** El cargo vino de su ficha: no se cambia en la tablet. */
    positionFixed?: boolean;
  };
  /** Hora de la actividad de cada sección ('HH:MM'): la ronda, el zarpe, el arribo y el fondeo no ocurren a la vez. */
  sectionTimes?: Record<string, string>;
  confirmedAt: Date | null;
}

export interface IIsmFlags {
  answered: number;
  total: number;
  novedades: number;
  noAplica: number;
  /** Marca de novedad: true si hay al menos un "No". */
  hasNovedad?: boolean;
}

export interface IIsmReturnInfo {
  reason: string;
  section: string;
  byName: string;
  at: Date;
}

/** PDF congelado al archivar (GridFS "ismPdf"): se sirve siempre el mismo archivo. */
export interface IIsmArchivedPdf {
  fileId: Types.ObjectId;
  sha256: string;
  size: number;
  generatedAt: Date;
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
  returnInfo: (IIsmReturnInfo & { toStage?: SignatureStage }) | null;
  /** Clave del cliente para que un reintento no duplique el registro. */
  idempotencyKey: string | null;
  /** Edición del formato oficial con que se llenó (p. ej. "Edición 00 · Vigencia 01-05-2025"). */
  formEdition?: string;
  /** Registro de prueba: fuera de indicadores y avisos. */
  test?: boolean;
  /**
   * Firmas anuladas por una devolución (se anulan desde el paso devuelto en
   * adelante). Quedan en el historial; nunca se imprimen.
   */
  annulledSignatures?: Array<IIsmSignature & { annulledAt: Date; annulReason: string }>;
  /** PDF archivado congelado con su sha256 (auditoría 30-oct, punto 3). */
  archivedPdf?: IIsmArchivedPdf | null;
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
    position: { type: String },
    capturedBy: { type: Schema.Types.ObjectId, ref: "User" },
    capturedByName: { type: String },
    method: { type: String },
    pinResetAt: { type: Date },
    pinResetByName: { type: String },
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
        { answered: Number, total: Number, novedades: Number, noAplica: Number, hasNovedad: Boolean },
        { _id: false },
      ),
      default: null,
    },
    returnInfo: {
      type: new Schema(
        { reason: String, section: String, byName: String, at: Date, toStage: String },
        { _id: false },
      ),
      default: null,
    },
    idempotencyKey: { type: String, default: null },
    formEdition: { type: String, default: "" },
    test: { type: Boolean, default: false },
    annulledSignatures: {
      type: [
        new Schema(
          {
            ...(signatureSchema.obj as Record<string, unknown>),
            annulledAt: { type: Date },
            annulReason: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    archivedPdf: {
      type: new Schema(
        {
          fileId: { type: Schema.Types.ObjectId, required: true },
          sha256: { type: String, required: true },
          size: { type: Number, default: 0 },
          generatedAt: { type: Date, default: () => new Date() },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true, minimize: false, optimisticConcurrency: true },
);

/**
 * Historial de solo agregar (auditoría 30-oct, punto 3): ninguna entrada
 * existente se modifica ni se borra. Al guardar un documento se compara con
 * lo que se cargó; en las actualizaciones directas solo se acepta $push.
 */
const HISTORY_ERROR = "El historial del registro solo admite agregar eventos";
const eventKey = (e: unknown) => {
  const o = (e && typeof (e as { toObject?: () => unknown }).toObject === "function"
    ? (e as { toObject: () => IIsmEvent }).toObject()
    : e) as IIsmEvent;
  return JSON.stringify([o?.action, o?.by?.toString() ?? null, o?.byName, o?.at ? new Date(o.at).toISOString() : null, o?.reason, o?.section ?? ""]);
};

ismRecordSchema.post("init", function (doc) {
  if (doc.isSelected("history")) doc.$locals.historyKeys = (doc.history ?? []).map(eventKey);
});

ismRecordSchema.pre("save", function (next) {
  const loaded = this.$locals.historyKeys as string[] | undefined;
  if (this.isNew || !loaded || !this.isModified("history")) return next();
  const now = (this.history ?? []).map(eventKey);
  if (now.length < loaded.length || loaded.some((k, i) => now[i] !== k)) {
    return next(new Error(HISTORY_ERROR));
  }
  next();
});

ismRecordSchema.post("save", function (doc) {
  doc.$locals.historyKeys = (doc.history ?? []).map(eventKey);
});

function assertHistoryAppendOnly(update: unknown) {
  if (!update || typeof update !== "object") return;
  const touches = (key: string) => key === "history" || key.startsWith("history.");
  for (const [op, value] of Object.entries(update as Record<string, unknown>)) {
    if (!op.startsWith("$")) {
      // Actualización sin operador: no puede tocar el historial.
      if (touches(op)) throw new Error(HISTORY_ERROR);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (!touches(key)) continue;
      if (op !== "$push" || key !== "history") throw new Error(HISTORY_ERROR);
      // $push simple o con $each, sin reordenar ni recortar.
      if (v && typeof v === "object" && Object.keys(v).some((k) => k.startsWith("$") && k !== "$each")) {
        throw new Error(HISTORY_ERROR);
      }
    }
  }
}

for (const hook of ["updateOne", "updateMany", "findOneAndUpdate"] as const) {
  ismRecordSchema.pre(hook, function (next) {
    try {
      assertHistoryAppendOnly(this.getUpdate());
      next();
    } catch (err) {
      next(err as Error);
    }
  });
}
// Reemplazar el documento entero podría borrar el historial: no se permite.
for (const hook of ["replaceOne", "findOneAndReplace"] as const) {
  ismRecordSchema.pre(hook, function (next) {
    next(new Error(HISTORY_ERROR));
  });
}

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
