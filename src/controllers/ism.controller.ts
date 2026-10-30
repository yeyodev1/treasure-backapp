import { NextFunction, Request, Response } from "express";
import { Error as MongooseError, Types } from "mongoose";
import {
  IIsmContext,
  IIsmRecord,
  IIsmSignature,
  IsmRecord,
  IsmStatus,
  SignatureStage,
} from "../models/ismRecord.model";
import { Cruise } from "../models/cruise.model";
import { User } from "../models/user.model";
import {
  activityFileName,
  buildFileName,
  defaultVessel,
  galapagosParts,
  hashRecord,
  isDateKey,
  uniqueFileName,
  ismCatalog,
  ismDefinition,
  ismEquipment,
  monthRangeGalapagos,
  recordDateFromKey,
  renderRecordPdf,
} from "../services/ism.service";
import {
  computeFlags,
  hashContent,
  ismSchema,
  latestSchemaVersion,
  mergeAnswers,
  mergeContext,
  projectToData,
  schemaItems,
  schemaManagedFields,
  signatureIsValid,
  validateGuided,
  IsmSchema,
  IsmSigner,
} from "../services/ismSchema.service";
import { logEvent } from "../services/audit.service";
import { CREW_LIST_ROLES, positionLabel, verifyPin } from "../services/ismCrew.service";
import { notifyRole, notifyUsers } from "../services/ismNotify.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { CREW_POSITIONS, POSITION_LABELS, isManager } from "../utils/roles";

/** Quién puede ver todos los registros (la tripulación ve los suyos). La dueña ve todo. */
const SEES_ALL = new Set(["duena", "admin", "capitan", "designada"]);

const STATUS_LABEL: Record<IsmStatus, string> = {
  borrador: "Borrador",
  por_capitan: "Por firmar · Capitán",
  por_oficina: "Por firmar · Persona Designada",
  archivado: "Archivado",
};

/** Hora actual en Galápagos 'HH:MM'. */
function nowTimeGalapagos(): string {
  const t = galapagosParts(new Date());
  return `${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")}`;
}

/**
 * Fecha real del registro guiado y su nombre: R-14_AAAAMMDD_HHMM.pdf con la
 * hora de la actividad; si otro registro ya lo tiene, _2, _3…
 */
async function applyActivityDate(record: IIsmRecord & { _id?: Types.ObjectId }) {
  const ctx = record.context;
  if (!ctx?.activityDate) return;
  record.recordDate = recordDateFromKey(ctx.activityDate, ctx.activityTime);
  const base = activityFileName(record.code, ctx.activityDate, ctx.activityTime);
  // Mismo minuto que ya tenía (con o sin sufijo): conserva su nombre.
  const stem = base.replace(/\.pdf$/, "");
  if (record.fileName === base || new RegExp(`^${stem}_\\d+\\.pdf$`).test(record.fileName ?? "")) return;
  record.fileName = await uniqueFileName(base, async (name) =>
    Boolean(await IsmRecord.exists({ fileName: name, ...(record._id ? { _id: { $ne: record._id } } : {}) })),
  );
}

/**
 * La firma va atada al rol de quien firma (informe ISM 29-oct, falla 1):
 * solo el Capitán firma como Capitán y solo la Persona Designada en oficina.
 * Gerencia y Administración ven todo, pero no firman por otro rol.
 */
function canSignStage(role: string, stage: SignatureStage): boolean {
  if (stage === "capitan") return role === "capitan";
  if (stage === "oficina") return role === "designada";
  return true;
}

function stageOpen(record: IIsmRecord, stage: SignatureStage, officeOnly: boolean): boolean {
  if (stage === "tripulacion") return record.status === "borrador";
  if (stage === "capitan") return record.status === "borrador" || record.status === "por_capitan";
  return record.status === "por_oficina" || (officeOnly && record.status === "borrador");
}

/** Id de quien creó el registro (poblado o no). */
function creatorId(record: Pick<IIsmRecord, "createdBy">): string {
  const author = record.createdBy as unknown as { _id?: Types.ObjectId } | Types.ObjectId;
  return ("_id" in author && author._id ? author._id : author).toString();
}

/**
 * Quién edita. Registros guiados (R-14…): solo quien lo creó (la sesión del
 * barco o el tripulante) y solo en borrador, también cuando vuelve devuelto.
 * Capitán, Gerencia, Administración y Persona Designada revisan y devuelven
 * con motivo, pero no cambian respuestas ni contexto (auditoría 30-oct).
 */
function canEdit(record: IIsmRecord, role: string, officeOnly: boolean, uid: string): boolean {
  if (record.status === "archivado") return false;
  if (record.schemaVersion) return record.status === "borrador" && creatorId(record) === uid;
  if (isManager(role)) return true;
  if (record.status === "borrador") return officeOnly ? role === "designada" : true;
  if (record.status === "por_capitan") return role === "capitan";
  return role === "designada";
}

/** La tripulación solo ve, edita, firma y envía los registros que creó o firmó. */
function assertCanView(record: IIsmRecord, req: Request) {
  if (SEES_ALL.has(req.auth!.role)) return;
  const uid = req.auth!.sub;
  const involved = creatorId(record) === uid || record.signatures.some((s) => s.user.toString() === uid);
  if (!involved) throw forbidden("Este registro no está a tu cargo");
}

function pushEvent(record: IIsmRecord, req: Request, action: string, reason = "", section = "") {
  record.history.push({
    action,
    by: new Types.ObjectId(req.auth!.sub),
    byName: req.auth!.name,
    at: new Date(),
    reason,
    section,
  });
}

/** Esquema guiado con el que se llenó el registro (null en los formatos en papel). */
function schemaOf(record: Pick<IIsmRecord, "code" | "schemaVersion">) {
  return record.schemaVersion ? ismSchema(record.code, record.schemaVersion) : null;
}

/**
 * Quien hace el chequeo se elige de la lista de tripulantes (falla 3): el
 * nombre y el cargo salen de su ficha (falla 2), no se escriben a mano.
 */
async function applyCrewChoice(ctx: IIsmContext | null, incoming: Record<string, unknown>, req: Request) {
  if (!ctx || typeof incoming.crewId !== "string") return ctx;
  // "No soy yo": se vuelve a elegir de la lista.
  if (incoming.crewId === "") {
    return { ...ctx, filledBy: { ...ctx.filledBy, name: "", fromList: false, positionFixed: false } };
  }
  if (!Types.ObjectId.isValid(incoming.crewId)) throw badRequest("Elige quién hace el chequeo de la lista");
  const member = await User.findOne({ _id: incoming.crewId, active: true, role: { $in: CREW_LIST_ROLES } }).select(
    "name role position",
  );
  if (!member) throw badRequest("Esa persona no está en la lista de tripulantes");
  const fixed = Boolean(member.position);
  return {
    ...ctx,
    filledBy: {
      user: member._id,
      accountName: req.auth!.name,
      name: member.name,
      role: member.role,
      position: fixed
        ? member.position
        : typeof incoming.position === "string"
          ? incoming.position.slice(0, 20)
          : ctx.filledBy.user?.toString() === member._id.toString()
            ? ctx.filledBy.position
            : "",
      fromList: true,
      positionFixed: fixed,
    },
  };
}

/** Paso de firma del registro guiado según su estado (motor de firmas del esquema). */
function currentSigner(record: IIsmRecord): IsmSigner | null {
  const schema = schemaOf(record);
  return schema?.signers?.find((s) => s.status === record.status) ?? null;
}

function signerByStep(record: IIsmRecord, step: SignatureStage | null | undefined): IsmSigner | null {
  return schemaOf(record)?.signers?.find((s) => s.step === step) ?? null;
}

/** Los registros guiados con firmantes declarados solo se firman con «Firmar» y la clave. */
function assertNotStepSigned(record: IIsmRecord) {
  if (schemaOf(record)?.signers?.length) {
    throw conflict("Este registro se firma con «Firmar» y tu clave de 4 números. Actualiza la app.");
  }
}

type ClientSignature = Omit<IIsmSignature, "image"> & { valid: boolean };

/**
 * Lo que recibe la tablet: nunca las imágenes de las firmas (se piden aparte
 * por /signatures/:field/image) y, por firma, si sigue siendo válida.
 */
function toClient(record: { toObject?: () => unknown } & Partial<IIsmRecord>) {
  const raw = (typeof record.toObject === "function" ? record.toObject() : record) as IIsmRecord & {
    _id: Types.ObjectId;
  };
  const current = raw.data ? hashContent(raw) : "";
  const { idempotencyKey: _key, signatures, annulledSignatures, ...rest } = raw;
  const clientSignatures: ClientSignature[] = (signatures ?? []).map((sig) => {
    const { image: _image, ...plain } = sig;
    return { ...plain, valid: current ? signatureIsValid(plain, current) : true };
  });
  const annulled = (annulledSignatures ?? []).map(({ image: _image, ...plain }) => plain);
  return { ...rest, signatures: clientSignatures, annulledSignatures: annulled };
}

function validSignatures(record: IIsmRecord) {
  const current = hashContent(record);
  return record.signatures.filter((s) => signatureIsValid(s, current));
}

async function saveOrConflict(doc: { save: () => Promise<unknown> }) {
  try {
    await doc.save();
  } catch (err) {
    if (err instanceof MongooseError.VersionError) {
      throw conflict("El registro cambió en otra tablet. Recárgalo y vuelve a intentar.");
    }
    throw err;
  }
}

/** Lo que el frontend no necesita en los listados (firmas en imagen, datos, respuestas). */
const LIST_FIELDS = "-data -signatures.image -history -answers -idempotencyKey";

export async function catalog(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      forms: ismCatalog().map((f) => ({ ...f, guidedVersion: latestSchemaVersion(f.code) })),
      equipment: ismEquipment(),
      positions: CREW_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
      vessel: defaultVessel(),
    });
  } catch (err) {
    next(err);
  }
}

export async function formDefinition(req: Request, res: Response, next: NextFunction) {
  try {
    const def = ismDefinition(String(req.params.code));
    if (!def) throw notFound("Formulario no encontrado");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ form: def });
  } catch (err) {
    next(err);
  }
}

/** Esquema guiado (p. ej. R-14 v1), para la tablet. */
export async function schemaDefinition(req: Request, res: Response, next: NextFunction) {
  try {
    const version = req.params.version ? Number(req.params.version) : null;
    const schema = ismSchema(String(req.params.code), Number.isFinite(version) ? version : null);
    if (!schema) throw notFound("Este formato no tiene llenado guiado");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ schema });
  } catch (err) {
    next(err);
  }
}

async function findByKey(uid: string, key: string) {
  return IsmRecord.findOne({ createdBy: uid, idempotencyKey: key })
    .select("-signatures.image")
    .populate("createdBy", "name role position");
}

export async function createRecord(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, recordDate, equipmentFolder, position, idempotencyKey, context, test } = req.body as {
      code?: string;
      recordDate?: string;
      equipmentFolder?: string;
      position?: string;
      idempotencyKey?: string;
      context?: Record<string, unknown>;
      test?: boolean;
    };
    const def = code ? ismDefinition(code) : null;
    if (!def) throw badRequest("Formulario inválido");
    if (!recordDate) throw badRequest("Indica la fecha del registro");
    if (!isDateKey(recordDate)) throw badRequest("La fecha no es válida. Elige otra en el calendario.");
    if (def.officeOnly && !(isManager(req.auth!.role) || req.auth!.role === "designada")) {
      throw forbidden("Este registro lo llena la oficina");
    }

    // Reintento de la misma acción (señal intermitente, doble toque): mismo registro.
    const key =
      typeof idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey) ? idempotencyKey : null;
    if (key) {
      const existing = await findByKey(req.auth!.sub, key);
      if (existing) {
        res.status(200).json({ record: toClient(existing), duplicate: true });
        return;
      }
    }

    // Solo textos de referencia del formato; ninguna casilla viene marcada.
    const data: Record<string, string | boolean> = {};
    for (const f of def.fields) {
      if (typeof f.default === "string" && f.type === "text") data[f.name] = f.default;
    }

    let equipment: IIsmRecord["equipment"] = null;
    if (def.frequency === "por_equipo") {
      const eq = ismEquipment().find((e) => e.folder === equipmentFolder);
      if (!eq) throw badRequest("Elige el equipo");
      equipment = { folder: eq.folder, name: eq.name, category: eq.category };
      const map = def.equipmentFields!;
      data[map.name] = eq.name;
      data[map.brand] = eq.brand;
      data[map.model] = eq.model || eq.brand;
      data[map.serial] = eq.serial;
      data[map.owner] = eq.owner;
    }

    let pos = "";
    if (def.frequency.startsWith("por_cargo")) {
      if (!position || !CREW_POSITIONS.includes(position as never)) throw badRequest("Elige el cargo");
      pos = position;
    }

    // Registro guiado: contexto confirmado al iniciar, con la identidad de la sesión.
    const schema = ismSchema(def.code);
    let ctx: IIsmContext | null = null;
    if (schema) {
      const user = await User.findById(req.auth!.sub).select("position");
      ctx = mergeContext(
        {
          // Embarcación de los datos maestros; el esquema queda como respaldo.
          vessel: defaultVessel()?.name ?? schema.vessel,
          activityDate: recordDate,
          activityTime: "",
          place: "",
          filledBy: {
            user: new Types.ObjectId(req.auth!.sub),
            accountName: req.auth!.name,
            name: req.auth!.name,
            role: req.auth!.role,
            position: user?.position ?? "",
            fromList: false,
          },
          confirmedAt: null,
        },
        context ?? {},
      );
      ctx = await applyCrewChoice(ctx, context ?? {}, req);
    }

    const cruise = await Cruise.findOne({ status: "abordo" }).select("_id");
    const date = recordDateFromKey(recordDate);
    const now = new Date();
    const record = new IsmRecord({
      code: def.code,
      title: def.title,
      recordDate: date,
      fileName: buildFileName(def.code, date, now, pos || equipment?.folder),
      formEdition: schema?.templateEdition ?? "",
      // Registros de prueba: fuera de indicadores y avisos (solo quien administra los marca).
      test: test === true && (isManager(req.auth!.role) || req.auth!.role === "designada"),
      data: schema ? projectToData(schema, { data, answers: {}, context: ctx }) : data,
      position: pos,
      equipment,
      cruise: cruise?._id ?? null,
      createdBy: req.auth!.sub,
      schemaVersion: schema?.version ?? null,
      context: ctx,
      answers: {},
      flags: schema ? computeFlags(schema, {}) : null,
      idempotencyKey: key,
    });
    pushEvent(record, req, "creado");
    if (schema) await applyActivityDate(record);
    try {
      await record.save();
    } catch (err) {
      // Dos reintentos simultáneos con la misma clave: gana el primero.
      if (key && (err as { code?: number }).code === 11000) {
        const existing = await findByKey(req.auth!.sub, key);
        if (existing) {
          res.status(200).json({ record: toClient(existing), duplicate: true });
          return;
        }
      }
      throw err;
    }

    await logEvent(req.auth, {
      kind: "registro",
      title: `${def.code} creado`,
      detail: `${def.title}${equipment ? ` · ${equipment.name}` : ""}${pos ? ` · ${POSITION_LABELS[pos as never]}` : ""}`,
    });
    await record.populate("createdBy", "name role position");
    res.status(201).json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

export async function listRecords(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, status, from, to, position, equipment, mine, before, limit, q } = req.query as Record<
      string,
      string
    >;
    const filter: Record<string, unknown> = {};
    if (code) filter.code = code;
    if (status) filter.status = { $in: status.split(",") };
    if (position) filter.position = position;
    if (equipment) filter["equipment.folder"] = equipment;
    for (const [label, value] of [
      ["desde", from],
      ["hasta", to],
    ] as const) {
      if (value && !isDateKey(value)) throw badRequest(`La fecha «${label}» no es válida. Elige otra en el calendario.`);
    }
    if (before && Number.isNaN(new Date(before).getTime())) throw badRequest("La fecha no es válida");
    if (from || to) {
      filter.recordDate = {
        ...(from ? { $gte: new Date(`${from}T00:00:00-06:00`) } : {}),
        ...(to ? { $lte: new Date(`${to}T23:59:59-06:00`) } : {}),
      };
    }
    if (before) filter.updatedAt = { $lt: new Date(before) };
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [{ fileName: { $regex: safe, $options: "i" } }, { title: { $regex: safe, $options: "i" } }];
    }

    const uid = new Types.ObjectId(req.auth!.sub);
    if (mine === "1" || !SEES_ALL.has(req.auth!.role)) {
      filter.$and = [{ $or: [{ createdBy: uid }, { "signatures.user": uid }] }];
    }

    const pageSize = Math.min(Number(limit) || 30, 100);
    const records = await IsmRecord.find(filter)
      .select(LIST_FIELDS)
      .populate("createdBy", "name role position")
      .sort({ updatedAt: -1 })
      .limit(pageSize + 1);

    const hasMore = records.length > pageSize;
    res.json({ records: hasMore ? records.slice(0, pageSize) : records, hasMore });
  } catch (err) {
    next(err);
  }
}

export async function getRecord(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id)
      .select("-signatures.image -idempotencyKey")
      .populate("createdBy", "name role position");
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Campos del contexto que cambiaron (para el historial). */
function contextChanges(schema: IsmSchema, prev: IIsmContext | null, next: IIsmContext | null): string[] {
  if (!prev || !next) return [];
  const out: string[] = [];
  if (prev.activityDate !== next.activityDate) out.push(schema.context.activityDate.label);
  if (prev.activityTime !== next.activityTime) out.push(schema.context.activityTime.label);
  if (prev.place !== next.place) out.push(schema.context.place.label);
  if ((prev.filledBy?.user?.toString() ?? "") !== (next.filledBy?.user?.toString() ?? "") || prev.filledBy?.name !== next.filledBy?.name) {
    out.push("Quien hace el chequeo");
  }
  if (prev.filledBy?.position !== next.filledBy?.position) out.push("Cargo");
  for (const section of schema.sections) {
    if ((prev.sectionTimes?.[section.id] ?? "") !== (next.sectionTimes?.[section.id] ?? "")) {
      out.push(`Hora de ${section.title}`);
    }
  }
  return out;
}

/**
 * Guarda lo llenado. Solo quien tiene el registro en su etapa puede editar.
 * Si el contenido cambia después de una firma, esa firma queda invalidada.
 */
export async function saveData(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, answers, context } = req.body as {
      data?: unknown;
      answers?: unknown;
      context?: unknown;
    };
    if (!isObject(data) && !isObject(answers) && !isObject(context)) throw badRequest("Datos inválidos");

    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    const def = ismDefinition(record.code)!;
    if (!canEdit(record, req.auth!.role, def.officeOnly, req.auth!.sub)) {
      throw forbidden(
        record.schemaVersion && record.status === "borrador"
          ? "Solo quien hizo el registro lo corrige. Si hay que cambiar algo, devuélvelo con motivo."
          : `No puedes editar un registro ${STATUS_LABEL[record.status].toLowerCase()}`,
      );
    }
    const schema = schemaOf(record);
    if (schema && record.status !== "borrador") {
      throw forbidden("Las respuestas del chequeo solo cambian en borrador. Para corregir, devuélvelo con motivo.");
    }

    const before = hashContent(record);
    const managed = schema ? schemaManagedFields(schema) : new Set<string>();
    const allowed = new Map(def.fields.map((f) => [f.name, f.type]));
    const merged = { ...(record.data ?? {}) };
    /** Qué cambió, para el historial ("editó: Ronda 02, Hora de la actividad"). */
    const changedFields: string[] = [];
    let sheetFields = 0;
    for (const [name, value] of Object.entries(isObject(data) ? data : {})) {
      const type = allowed.get(name);
      if (!type || type === "signature" || managed.has(name)) continue;
      const prevValue = merged[name];
      if (type === "checkbox" || type === "radio") merged[name] = value === true;
      else if (typeof value === "string") merged[name] = value.slice(0, 5000);
      if (merged[name] !== prevValue && !(prevValue === undefined && (merged[name] === "" || merged[name] === false))) {
        sheetFields++;
      }
    }
    record.data = merged;
    if (sheetFields) changedFields.push(sheetFields === 1 ? "1 campo de la hoja" : `${sheetFields} campos de la hoja`);

    if (schema) {
      if (isObject(context)) {
        const prevCtx = record.context;
        record.context = await applyCrewChoice(mergeContext(record.context, context), context, req);
        record.markModified("context");
        changedFields.push(...contextChanges(schema, prevCtx, record.context));
      }
      if (isObject(answers)) {
        const prev = record.answers ?? {};
        const result = mergeAnswers(schema, prev, answers, req.auth!.sub);
        record.answers = result.answers;
        record.markModified("answers");
        const labels = new Map(schemaItems(schema).map(({ section, item }) => [item.id, `${section.title} ${item.n}`]));
        changedFields.push(...result.changedIds.map((id) => labels.get(id) ?? id));
        // Cada sección guarda su propia hora: la primera respuesta la fija con la hora
        // actual (se puede corregir en la tablet).
        if (record.context) {
          const times = { ...(record.context.sectionTimes ?? {}) };
          for (const section of schema.sections) {
            if (times[section.id]) continue;
            if (section.items.some((i) => i.id in answers && record.answers[i.id]?.value)) {
              times[section.id] = nowTimeGalapagos();
            }
          }
          record.context = { ...record.context, sectionTimes: times };
          record.markModified("context");
        }
      }
      // La fecha y hora de la actividad definen el mes del archivo y el nombre del PDF.
      await applyActivityDate(record);
      record.data = projectToData(schema, record);
      record.flags = computeFlags(schema, record.answers ?? {});
    }
    record.markModified("data");

    const after = hashContent(record);
    const invalidated: string[] = [];
    if (after !== before) {
      // Toda edición queda en el historial: quién y qué cambió.
      pushEvent(record, req, "editó", changedFields.length ? changedFields.join(", ").slice(0, 1000) : "Datos del registro");
      for (const sig of record.signatures) {
        if (sig.hashV === 2 && sig.dataHash === before) {
          invalidated.push(sig.field);
          pushEvent(record, req, `firma anulada: ${sig.label}`, "Los datos cambiaron después de firmar");
        }
      }
    }

    await saveOrConflict(record);
    const out = toClient(record);
    res.json({
      record: {
        _id: out._id,
        data: out.data,
        answers: out.answers,
        context: out.context,
        flags: out.flags,
        recordDate: out.recordDate,
        fileName: out.fileName,
        signatures: out.signatures,
        updatedAt: out.updatedAt,
      },
      invalidated,
    });
  } catch (err) {
    next(err);
  }
}

/** Imagen de una firma (PNG). Va aparte para que el registro pese poco. */
export async function signatureImage(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id).select("code createdBy signatures");
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    const sig = record.signatures.find((s) => s.field === req.params.field);
    if (!sig?.image) throw notFound("Esa firma no existe");
    const [meta, b64] = sig.image.split(",");
    res.setHeader("Content-Type", meta?.includes("png") ? "image/png" : "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(b64 ?? "", "base64"));
  } catch (err) {
    next(err);
  }
}

/** Firma con el dedo un recuadro del formulario. */
export async function sign(req: Request, res: Response, next: NextFunction) {
  try {
    const { field, image, signerName } = req.body as {
      field?: string;
      image?: string;
      signerName?: string;
    };
    if (!field || !image?.startsWith("data:image/png;base64,")) throw badRequest("Firma inválida");
    if (image.length > 400_000) throw badRequest("La firma es demasiado grande");

    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    const def = ismDefinition(record.code)!;
    const slot = def.fields.find((f) => f.name === field && f.type === "signature");
    if (!slot || !slot.stage) throw badRequest("Ese recuadro no es de firma");
    if (!canSignStage(req.auth!.role, slot.stage)) {
      throw forbidden(`Esta firma corresponde a: ${slot.label}`);
    }
    assertNotStepSigned(record);
    if (!stageOpen(record, slot.stage, def.officeOnly)) {
      throw conflict("Esta firma no está habilitada en la etapa actual del registro");
    }

    // Capitán y Persona Designada firman con el nombre de su propia cuenta.
    const name = (slot.stage === "tripulacion" ? signerName?.trim() || req.auth!.name : req.auth!.name).slice(0, 120);
    record.signatures = record.signatures.filter((s) => s.field !== field) as never;
    record.signatures.push({
      field,
      stage: slot.stage,
      label: slot.label ?? "",
      signerName: name,
      user: new Types.ObjectId(req.auth!.sub),
      userName: req.auth!.name,
      userRole: req.auth!.role,
      image,
      signedAt: new Date(),
      dataHash: hashContent(record),
      hashV: 2,
    });
    pushEvent(record, req, `firmó ${slot.label}`, name !== req.auth!.name ? `Firma de ${name}` : "");
    await saveOrConflict(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} · firma ${slot.label}`,
      detail: `${record.fileName} · ${name}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

export async function removeSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const def = ismDefinition(record.code)!;
    assertNotStepSigned(record);
    const sig = record.signatures.find((s) => s.field === req.params.field);
    if (!sig) throw notFound("Esa firma no existe");
    if (!stageOpen(record, sig.stage, def.officeOnly)) throw conflict("La firma ya no se puede quitar");
    if (!isManager(req.auth!.role) && sig.user.toString() !== req.auth!.sub) {
      throw forbidden("Solo quien capturó la firma puede quitarla");
    }
    record.signatures = record.signatures.filter((s) => s.field !== sig.field) as never;
    pushEvent(record, req, `quitó firma ${sig.label}`);
    await saveOrConflict(record);
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

/** Recuadros de firma de una etapa sin una firma válida. */
function missing(def: ReturnType<typeof ismDefinition>, record: IIsmRecord, stage: SignatureStage) {
  const signed = new Set(validSignatures(record).map((s) => s.field));
  return def!.fields.filter((f) => f.type === "signature" && f.stage === stage && !signed.has(f.name));
}

/** Firmas que quedaron invalidadas porque los datos cambiaron después. */
function invalidSignatures(record: IIsmRecord) {
  const current = hashContent(record);
  return record.signatures.filter((s) => !signatureIsValid(s, current));
}

/** Faltantes del llenado guiado: 422 con cada pregunta concreta. */
function rejectIfIncomplete(record: IIsmRecord, res: Response): boolean {
  const schema = schemaOf(record);
  if (!schema) return false;
  const miss = validateGuided(schema, record);
  if (!miss.length) return false;
  res.status(422).json({
    message: miss.length === 1 ? "Falta 1 dato por completar" : `Faltan ${miss.length} datos por completar`,
    missing: miss,
  });
  return true;
}

/** Envío explícito ("Listo para enviar"): nunca se envía a medias al guardar. */
export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("El registro ya fue enviado");
    assertCanView(record, req);
    assertNotStepSigned(record);
    const def = ismDefinition(record.code)!;
    if (!canEdit(record, req.auth!.role, def.officeOnly, req.auth!.sub)) throw forbidden();

    // Misma validación que la tablet: faltantes en su pregunta exacta.
    if (rejectIfIncomplete(record, res)) return;

    const invalid = invalidSignatures(record).filter((s) => s.stage === "tripulacion");
    if (invalid.length) {
      throw badRequest(
        `Los datos cambiaron después de firmar: vuelve a firmar ${invalid.map((s) => s.label).join(", ")}`,
      );
    }
    if (!def.officeOnly && def.stages.tripulacion > 0) {
      const crewSigned = validSignatures(record).some((s) => s.stage === "tripulacion");
      if (!crewSigned) throw badRequest("Falta la firma de quien llenó el registro");
    }

    record.submittedAt = new Date();
    if (def.officeOnly) {
      record.status = "por_oficina";
    } else if (def.stages.capitan > 0 && missing(def, record, "capitan").length) {
      record.status = "por_capitan";
    } else {
      record.status = "por_oficina";
      if (def.stages.capitan > 0) {
        // El Capitán ya firmó en el borrador: la aprobación es suya, no de quien envía.
        const captainSig = validSignatures(record)
          .filter((s) => s.stage === "capitan")
          .sort((a, b) => new Date(b.signedAt).getTime() - new Date(a.signedAt).getTime())[0]!;
        record.captainApprovedBy = captainSig.user;
        record.captainApprovedAt = captainSig.signedAt;
      }
    }
    record.returnInfo = null;
    pushEvent(record, req, "enviado");
    await saveOrConflict(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} enviado`,
      detail: `${record.fileName} · ${STATUS_LABEL[record.status]}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

/** Capitán aprueba → oficina. Oficina aprueba → archivado e inmutable. */
export async function approve(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    assertNotStepSigned(record);
    const def = ismDefinition(record.code)!;
    const role = req.auth!.role;

    if (record.status === "por_capitan" || record.status === "por_oficina") {
      if (rejectIfIncomplete(record, res)) return;
      const invalid = invalidSignatures(record);
      if (invalid.length) {
        throw badRequest(
          `La firma de ${invalid.map((s) => s.label).join(", ")} quedó invalidada porque los datos cambiaron después. ` +
            "Devuélvelo para que se vuelva a firmar.",
        );
      }
    }

    if (record.status === "por_capitan") {
      if (role !== "capitan") throw forbidden("Solo el Capitán, desde su cuenta, firma este paso");
      const pending = missing(def, record, "capitan");
      if (pending.length) throw badRequest(`Falta firmar: ${pending.map((p) => p.label).join(", ")}`);
      record.status = "por_oficina";
      record.captainApprovedBy = new Types.ObjectId(req.auth!.sub);
      record.captainApprovedAt = new Date();
      pushEvent(record, req, "aprobado por el Capitán");
    } else if (record.status === "por_oficina") {
      if (role !== "designada") {
        throw forbidden("Solo la Persona Designada, desde su cuenta, archiva el registro");
      }
      const pending = missing(def, record, "oficina").filter((f) => f.label === "Persona Designada");
      if (pending.length) throw badRequest("Falta la firma de la Persona Designada");
      record.status = "archivado";
      record.officeApprovedBy = new Types.ObjectId(req.auth!.sub);
      record.archivedAt = new Date();
      record.contentHash = hashRecord(record);
      pushEvent(record, req, "archivado");
    } else {
      throw conflict("El registro no está esperando aprobación");
    }

    await saveOrConflict(record);
    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} · ${record.status === "archivado" ? "archivado" : "aprobado por el Capitán"}`,
      detail: record.fileName,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

/**
 * Firma el paso actual de un registro guiado y lo pasa al siguiente
 * (informe R-14 del 29-oct, pantallas 2, 4 y 5):
 * - Quien hace el chequeo: se eligió de la lista; firma con el dedo y su
 *   clave en la tablet del barco (la sesión de la tablet nunca firma) → Capitán.
 * - Capitán: solo el rol Capitán, desde su cuenta y con su clave → Persona Designada.
 * - Persona Designada: solo ese rol, con su clave → Archivado (inmutable).
 * Por firma se guarda usuario, nombre y cargo del momento, rol, hora,
 * imagen y la huella de los datos firmados.
 */
export async function signStep(req: Request, res: Response, next: NextFunction) {
  try {
    const { image, pin, newPin, signer: signerId } = req.body as {
      image?: string;
      pin?: string;
      newPin?: string;
      signer?: string;
    };
    if (!image?.startsWith("data:image/png;base64,")) throw badRequest("Firma con el dedo en el recuadro");
    if (image.length > 400_000) throw badRequest("La firma es demasiado grande");

    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    const step = currentSigner(record);
    if (!step) throw conflict(record.status === "archivado" ? "El registro ya está archivado" : "Este registro no se firma por pasos");
    const role = req.auth!.role;

    // Quién firma este paso.
    let signerUser: Types.ObjectId;
    if (step.who === "lista") {
      // El paso del chequeo se firma en la sesión que creó el registro (nadie lo corrige por otro).
      if (creatorId(record) !== req.auth!.sub) {
        throw forbidden("Este chequeo se firma en la tablet con la que se hizo. Si hay que corregir algo, devuélvelo con motivo.");
      }
      if (rejectIfIncomplete(record, res)) return;
      const chosen = record.context?.filledBy;
      if (!chosen?.fromList || !chosen.user) throw badRequest("Elige quién hace el chequeo de la lista");
      if (signerId && signerId !== chosen.user.toString()) {
        throw forbidden("Firma quien hizo el chequeo. Si no eres tú, toca «No soy yo».");
      }
      signerUser = new Types.ObjectId(chosen.user.toString());
    } else {
      // Nadie firma por otro rol: ni Gerencia ni Administración.
      if (role !== step.who) {
        throw forbidden(
          step.who === "capitan"
            ? "Solo el Capitán, desde su cuenta, firma este paso"
            : "Solo la Persona Designada, desde su cuenta, firma este paso",
        );
      }
      const invalid = invalidSignatures(record);
      if (invalid.length) {
        throw badRequest(
          `Firma anulada: ${invalid.map((s) => s.label).join(", ")}. Los datos cambiaron después de firmar; devuélvelo para que se vuelva a firmar.`,
        );
      }
      signerUser = new Types.ObjectId(req.auth!.sub);
    }

    const person = await User.findOne({ _id: signerUser, active: true }).select("name role position");
    if (!person) throw forbidden("Esa persona ya no está activa en la lista de tripulantes");
    // La clave asegura que quien firma es quien dice ser (bloqueo en el servidor).
    await verifyPin(signerUser, pin, newPin);

    const now = new Date();
    const sessionUser = new Types.ObjectId(req.auth!.sub);
    record.signatures = record.signatures.filter((s) => s.field !== step.field) as never;
    record.signatures.push({
      field: step.field,
      stage: step.step,
      label: step.label,
      signerName: person.name,
      user: signerUser,
      userName: person.name,
      userRole: person.role,
      position: step.who === "lista" ? record.context?.filledBy?.position || person.position || "" : person.position || "",
      capturedBy: sessionUser.equals(signerUser) ? null : sessionUser,
      capturedByName: sessionUser.equals(signerUser) ? "" : req.auth!.name,
      method: "clave",
      image,
      signedAt: now,
      dataHash: hashContent(record),
      hashV: 2,
    });
    pushEvent(
      record,
      req,
      `firmó ${step.label}`,
      sessionUser.equals(signerUser) ? "Con su clave" : `Firma de ${person.name} con su clave, en la sesión de ${req.auth!.name}`,
    );

    const returned = record.returnInfo;
    record.returnInfo = null;
    record.status = step.next;
    if (step.step === "tripulacion") {
      record.submittedAt = now;
      pushEvent(record, req, "enviado al Capitán");
    } else if (step.step === "capitan") {
      record.captainApprovedBy = signerUser;
      record.captainApprovedAt = now;
    } else {
      record.officeApprovedBy = signerUser;
      record.archivedAt = now;
      record.contentHash = hashRecord(record);
      pushEvent(record, req, "archivado");
    }
    await saveOrConflict(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} · firma ${step.label}`,
      detail: `${record.fileName} · ${person.name} · ${STATUS_LABEL[record.status]}`,
    });

    if (!record.test) {
      const who = record.context?.filledBy;
      const when = record.context ? `${record.context.activityDate} ${record.context.activityTime}` : "";
      if (record.status === "por_capitan") {
        await notifyRole("capitan", {
          kind: "por_firmar_capitan",
          title: `${record.code} por firmar${returned ? " (corregido)" : ""}`,
          body: `${who?.name ?? ""}${who?.position ? ` · ${positionLabel(who.position)}` : ""} · ${when} · ${record.context?.place ?? ""}`,
          record: record._id,
        });
      } else if (record.status === "por_oficina") {
        await notifyRole("designada", {
          kind: "por_firmar_designada",
          title: `${record.code} firmado por el Capitán: te toca archivar`,
          body: record.fileName,
          record: record._id,
        });
      }
    }

    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

/**
 * Devolver con comentario obligatorio.
 * Registros guiados: el Capitán devuelve al tripulante (vuelve a Borrador) y
 * la Persona Designada al Capitán (vuelve a Por firmar · Capitán). Se anulan
 * las firmas desde el paso devuelto en adelante y quedan en el historial.
 * Formatos en papel: vuelve a borrador; las firmas de revisión se retiran.
 */
export async function giveBack(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason, section } = req.body as { reason?: string; section?: string };
    if (!reason?.trim()) throw badRequest("Escribe el comentario: es obligatorio");
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const step = currentSigner(record);
    if (step && (record.status === "por_capitan" || record.status === "por_oficina")) {
      await giveBackStep(record, step, req, reason, typeof section === "string" ? section : "");
      await record.populate("createdBy", "name role position");
      res.json({ record: toClient(record) });
      return;
    }
    if (typeof section !== "string" || !section.trim()) throw badRequest("Indica la sección afectada");
    const cleanReason = reason.trim().slice(0, 1000);
    const cleanSection = section.trim().slice(0, 120);
    const role = req.auth!.role;
    if (record.status === "por_capitan" && role !== "capitan") {
      throw forbidden("Solo el Capitán devuelve este registro");
    }
    if (record.status === "por_oficina" && role !== "designada") {
      throw forbidden("Solo la Persona Designada devuelve este registro");
    }
    if (record.status !== "por_capitan" && record.status !== "por_oficina") {
      throw conflict("Solo se devuelve un registro que está en revisión");
    }
    record.status = "borrador";
    record.signatures = record.signatures.filter((s) => s.stage === "tripulacion") as never;
    record.captainApprovedAt = null;
    record.captainApprovedBy = null;
    record.returnInfo = { reason: cleanReason, section: cleanSection, byName: req.auth!.name, at: new Date() };
    pushEvent(record, req, "devuelto", cleanReason, cleanSection);
    await saveOrConflict(record);
    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} devuelto`,
      detail: `${record.fileName} · ${cleanSection} · ${cleanReason}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

async function giveBackStep(
  record: IIsmRecord & { _id: Types.ObjectId; save: () => Promise<unknown> },
  step: IsmSigner,
  req: Request,
  reason: string,
  section: string,
) {
  if (req.auth!.role !== step.who) {
    throw forbidden(
      step.who === "capitan"
        ? "Solo el Capitán, desde su cuenta, devuelve este registro"
        : "Solo la Persona Designada, desde su cuenta, devuelve este registro",
    );
  }
  const target = signerByStep(record, step.returnsTo);
  if (!target) throw conflict("Este paso no se devuelve");
  const cleanReason = reason.trim().slice(0, 1000);
  const cleanSection = section.trim().slice(0, 120);
  const signers = schemaOf(record)?.signers ?? [];
  const from = signers.findIndex((s) => s.step === target.step);
  const annulSteps = new Set(signers.slice(from).map((s) => s.field));
  const now = new Date();
  const annulled = record.signatures.filter((s) => annulSteps.has(s.field));
  record.annulledSignatures = [
    ...(record.annulledSignatures ?? []),
    ...annulled.map((s) => ({
      ...(typeof (s as { toObject?: () => unknown }).toObject === "function"
        ? ((s as unknown as { toObject: () => IIsmSignature }).toObject())
        : s),
      annulledAt: now,
      annulReason: `Devuelto por ${req.auth!.name}: ${cleanReason}`,
    })),
  ];
  record.signatures = record.signatures.filter((s) => !annulSteps.has(s.field)) as never;
  record.status = target.status;
  // La firma del Capitán siempre queda anulada al devolver (a él o al tripulante).
  record.captainApprovedAt = null;
  record.captainApprovedBy = null;
  record.returnInfo = {
    reason: cleanReason,
    section: cleanSection,
    byName: req.auth!.name,
    at: now,
    toStage: target.step,
  };
  pushEvent(record, req, `devuelto a ${target.label}`, cleanReason, cleanSection);
  for (const s of annulled) pushEvent(record, req, `firma anulada: ${s.label} (${s.signerName})`, "Por la devolución");
  await saveOrConflict(record);
  await logEvent(req.auth, {
    kind: "registro",
    title: `${record.code} devuelto a ${target.label}`,
    detail: `${record.fileName} · ${cleanReason}`,
  });
  if (!record.test) {
    const to =
      target.step === "tripulacion"
        ? [record.context?.filledBy?.user, record.createdBy]
        : annulled.filter((s) => s.stage === "capitan").map((s) => s.user);
    await notifyUsers(to, {
      kind: "devuelto",
      title: `Te devolvieron el ${record.code}`,
      body: `${req.auth!.name}: ${cleanReason}`,
      record: record._id,
    });
  }
}

/** Descartar un borrador (nunca un registro enviado o archivado). */
export async function discard(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("Solo se descartan borradores");
    if (!isManager(req.auth!.role) && record.createdBy.toString() !== req.auth!.sub) {
      throw forbidden("Solo quien lo creó puede descartarlo");
    }
    await record.deleteOne();
    await logEvent(req.auth, { kind: "registro", title: `${record.code} descartado`, detail: record.fileName });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Marca o desmarca un registro como de prueba (Persona Designada o Gerencia).
 * No cambia el contenido ni las firmas: solo lo saca de indicadores y avisos.
 */
export async function setTest(req: Request, res: Response, next: NextFunction) {
  try {
    const role = req.auth!.role;
    if (!(role === "designada" || isManager(role))) throw forbidden("Solo la Persona Designada marca registros de prueba");
    const { test, reason } = req.body as { test?: unknown; reason?: string };
    if (typeof test !== "boolean") throw badRequest("Indica si es de prueba");
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (Boolean(record.test) === test) {
      res.json({ record: { _id: record._id, test: record.test } });
      return;
    }
    record.test = test;
    pushEvent(record, req, test ? "marcado como prueba" : "ya no es de prueba", (reason ?? "").trim().slice(0, 300));
    await saveOrConflict(record);
    res.json({ record: { _id: record._id, test: record.test } });
  } catch (err) {
    next(err);
  }
}

/** PDF oficial para imprimir o entregar al auditor. */
export async function pdf(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    const bytes = await renderRecordPdf(record);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${record.fileName}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
}

/** Resumen: bandejas por etapa y lo que falta llenar este mes. */
export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const uid = new Types.ObjectId(req.auth!.sub);
    const { start, end, y, m } = monthRangeGalapagos();
    // Los registros de prueba no cuentan en indicadores.
    const real = { test: { $ne: true } };
    const monthFilter = { recordDate: { $gte: start, $lt: end }, status: { $ne: "borrador" }, ...real };

    const [byStatus, mine, mineReturned, monthly, equipmentDone, positionsDone] = await Promise.all([
      IsmRecord.aggregate([{ $match: real }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      IsmRecord.countDocuments({ createdBy: uid, status: "borrador" }),
      IsmRecord.countDocuments({ createdBy: uid, status: "borrador", returnInfo: { $ne: null } }),
      IsmRecord.aggregate([
        { $match: { ...monthFilter, code: { $in: ["R-25_Alcohol", "R-25_Drogas", "R-28"] } } },
        { $group: { _id: "$code", n: { $sum: 1 } } },
      ]),
      IsmRecord.distinct("equipment.folder", { ...monthFilter, code: "R-16" }),
      IsmRecord.distinct("position", { ...monthFilter, code: "R-23" }),
    ]);

    const counts = Object.fromEntries(byStatus.map((s: { _id: string; n: number }) => [s._id, s.n]));
    const monthlyDone = new Set(monthly.map((x: { _id: string }) => x._id));

    res.json({
      month: { y, m },
      counts: {
        borrador: counts.borrador ?? 0,
        por_capitan: counts.por_capitan ?? 0,
        por_oficina: counts.por_oficina ?? 0,
        archivado: counts.archivado ?? 0,
        misBorradores: mine,
        misDevueltos: mineReturned,
      },
      checklist: [
        { code: "R-25_Alcohol", title: "Control mensual de alcohol", done: monthlyDone.has("R-25_Alcohol") },
        { code: "R-25_Drogas", title: "Control mensual de drogas", done: monthlyDone.has("R-25_Drogas") },
        { code: "R-28", title: "Chequeo contraincendios y salvamento", done: monthlyDone.has("R-28") },
        {
          code: "R-16",
          title: "Mantenimiento preventivo por equipo",
          done: equipmentDone.length >= ismEquipment().length,
          progress: { done: equipmentDone.length, total: ismEquipment().length },
          missing: ismEquipment()
            .filter((e) => !equipmentDone.includes(e.folder))
            .map((e) => e.name),
        },
        {
          code: "R-23",
          title: "Horas de descanso por cargo",
          done: positionsDone.length >= CREW_POSITIONS.length,
          progress: { done: positionsDone.length, total: CREW_POSITIONS.length },
          missing: CREW_POSITIONS.filter((p) => !positionsDone.includes(p)).map((p) => POSITION_LABELS[p]),
        },
      ],
    });
  } catch (err) {
    next(err);
  }
}
