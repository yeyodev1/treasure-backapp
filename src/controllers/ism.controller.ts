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
import { IsmCrew } from "../models/ismCrew.model";
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
  deviceTime,
  projectToData,
  schemaFileName,
  schemaItems,
  schemaManagedFields,
  signatureIsValid,
  validateGuided,
  IsmSchema,
  IsmSigner,
} from "../services/ismSchema.service";
import { logEvent } from "../services/audit.service";
import { freezeArchivedPdf, readArchivedPdf, tryFreezeArchivedPdf } from "../services/ismArchive.service";
import { syncNovedades } from "../services/ismNovedad.service";
import { CREW_LIST_ROLES, PIN_RESET_WINDOW_MS, crewProfile, positionLabel, transitionProfile, verifyPin } from "../services/ismCrew.service";
import { notifyRole, notifyUsers } from "../services/ismNotify.service";
import { nextCode } from "../services/codes.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { CREW_POSITIONS, POSITION_LABELS, ROLE_LABELS } from "../utils/roles";
import {
  AREA_LABELS,
  BAR_LINK_AREAS,
  IsmArea,
  ONBOARD_AREAS,
  canCreateForm,
  canEditData,
  canFillEquipment,
  canViewRecord,
  ismAccessOf,
  ismArea,
  viewFilter,
  AREA_POSITIONS,
} from "../services/ismAccess.service";
import { flowView, giveBackFlow, outgoingPending, signSlot, submitFlow } from "./ismFlow.controller";
import { flowOf } from "../services/ismFlow.service";
import { obligations } from "../services/ismObligations.service";

const STATUS_LABEL: Record<IsmStatus, string> = {
  borrador: "Borrador",
  por_capitan: "Por firmar · Capitán",
  por_oficina: "Por firmar · Persona Designada",
  por_gerencia: "Por firmar · Gerencia",
  por_firmar: "Por firmar",
  archivado: "Archivado",
};

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** 'YYYY-MM-DD' + 'HH:MM' → "30 oct 2026 · 16:19" (como en pantalla). */
export function screenStamp(dateKey?: string, time?: string): string {
  const [y, m, d] = (dateKey ?? "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}${time ? ` · ${time}` : ""}`;
}

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
  const schema = schemaOf(record);
  record.recordDate = recordDateFromKey(ctx.activityDate, ctx.activityTime);
  // Carpeta del mes calculada en el servidor (antes solo en la tablet).
  record.archivePath = archivePathFor(record.code, schema?.archiveFolder, ctx.activityDate);
  // Nombre según el patrón del esquema (por defecto R-14_AAAAMMDD_HHMM.pdf).
  const base = schema ? schemaFileName(schema, record.code, ctx.activityDate, ctx.activityTime) : activityFileName(record.code, ctx.activityDate, ctx.activityTime);
  // Mismo minuto que ya tenía (con o sin sufijo): conserva su nombre.
  const stem = base.replace(/\.pdf$/, "");
  if (record.fileName === base || new RegExp(`^${stem}_\\d+\\.pdf$`).test(record.fileName ?? "")) return;
  const taken = async (name: string) =>
    Boolean(await IsmRecord.exists({ fileName: name, ...(record._id ? { _id: { $ne: record._id } } : {}) }));
  // Regla de unicidad del esquema: "reject" no admite otro registro con el mismo nombre.
  if (schema?.uniqueness?.onConflict === "reject" && (await taken(base))) {
    throw conflict(`Ya hay un ${record.code} con esa fecha y hora (${base}). Ábrelo desde Mis tareas.`);
  }
  record.fileName = await uniqueFileName(base, taken);
}

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "ISM/Listado de registros/R-14 …/2026/10_octubre" (mes de la actividad). */
export function archivePathFor(code: string, folder: string | undefined, dateKey: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  const base = (folder || `ISM/${code}`).split("/").filter(Boolean);
  if (!y || !m) return base.join("/");
  return [...base, String(y), `${String(m).padStart(2, "0")}_${MONTH_NAMES[m - 1]}`].join("/");
}

/** Quién recibe en tierra: la Persona Designada, o Administración en el R-18 Hotelería (5-nov). */
const officeRoleOf = (def: { officeRole?: string }) => def.officeRole ?? "designada";

/**
 * Número de orden (O/R) del R-18: lo pone el sistema al crear (TREASURE ISM 2.0,
 * AUTO-18-03 «reserva número una vez»), nadie lo busca ni lo escribe.
 */
const ORDER_FIELD: Record<string, string> = {
  "R-18_Cubierta": "Text Field 112",
  "R-18_Maquinas": "Text Field 112",
  "R-18_Hoteleria": "Text Field 3",
};

/** R-07 enviado a quien recibe el cargo: es suyo leerlo, firmarlo y enviarlo al Capitán. */
const isReceiver = (record: IIsmRecord, uid: string) => record.handoff?.to?.toString() === uid;

/** Id de quien creó el registro (poblado o no). */
function creatorId(record: Pick<IIsmRecord, "createdBy">): string {
  const author = record.createdBy as unknown as { _id?: Types.ObjectId } | Types.ObjectId;
  return ("_id" in author && author._id ? author._id : author).toString();
}

/**
 * Quién edita (especificación ISM, 25-nov-2026, reglas 8 y 13): en borrador,
 * el área que lo llena (cualquiera de ella sigue el borrador del compañero);
 * en revisión, quien firma ese paso completa su parte. Gerencia no edita.
 * Registros guiados (R-14): solo en borrador; quien revisa devuelve con motivo.
 */
function canEdit(record: IIsmRecord, area: IsmArea, role: string, uid: string, officeRole = "designada"): boolean {
  if (record.schemaVersion && record.status !== "borrador") return false;
  return canEditData(area, role, uid, record, officeRole);
}

/**
 * Qué ve cada cuenta (sección 5): Gerencia y la PD todo, el Puente lo de
 * abordo, cada área lo suyo, Administración solo el R-18 de Hotelería.
 */
async function assertCanView(record: IIsmRecord, req: Request): Promise<IsmArea> {
  const { area } = await ismAccessOf(req.auth!);
  if (!canViewRecord(area, req.auth!.sub, record)) throw forbidden("Este registro no es de tu área");
  return area;
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
  const member = await User.findOne({
    _id: incoming.crewId,
    active: true,
    role: { $in: CREW_LIST_ROLES },
    // La tablet compartida no es una persona: no hace chequeos.
    sharedDevice: { $ne: true },
  }).select(
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

/** "el Capitán", "la Persona Designada" o el nombre del rol (motor de firmas con rol libre). */
function roleName(role: string): string {
  if (role === "capitan") return "el Capitán";
  if (role === "designada") return "la Persona Designada";
  return ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role;
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
export function toClient(record: { toObject?: () => unknown } & Partial<IIsmRecord>) {
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
  // Registros de antes: la carpeta del mes se calcula al vuelo.
  const archivePath =
    rest.archivePath ||
    (rest.schemaVersion && rest.context?.activityDate
      ? archivePathFor(rest.code, schemaOf(rest)?.archiveFolder, rest.context.activityDate)
      : undefined);
  return { ...rest, ...(archivePath ? { archivePath } : {}), signatures: clientSignatures, annulledSignatures: annulled };
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

export async function catalog(req: Request, res: Response, next: NextFunction) {
  try {
    const { area } = await ismAccessOf(req.auth!);
    const role = req.auth!.role;
    res.json({
      forms: ismCatalog().map((f) => {
        const guidedVersion = latestSchemaVersion(f.code);
        // Tarjeta de Mis tareas del formato guiado (sale del esquema, no del código).
        const card = guidedVersion ? ismSchema(f.code, guidedVersion)?.card : undefined;
        // Todos los formatos van (títulos de la bandeja y el archivo); `canCreate` dice cuáles llena esta cuenta.
        return { ...f, guidedVersion, canCreate: canCreateForm(area, f.code), ...(card ? { card } : {}) };
      }),
      // Archivo: cada cuenta ve el suyo (sección 5); el servidor filtra qué registros.
      archive: area !== "otros",
      equipment: ismEquipment().filter((e) => canFillEquipment(area, e)),
      positions: CREW_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
      // Cargos por los que esta cuenta abre un R-07 o R-22 (null = cualquiera).
      // El Capitán evalúa (R-22) a cualquier cargo; cada área, los suyos.
      fillPositions: ONBOARD_AREAS.includes(area) && area !== "puente" ? (AREA_POSITIONS[area] ?? null) : null,
      vessel: defaultVessel(),
      // Qué ve cada cuenta (especificación ISM, 25-nov-2026, sección 5).
      access: {
        area,
        areaLabel: AREA_LABELS[area],
        crew: role === "duena" ? "gerencia" : role === "capitan" ? "capitan" : role === "designada" ? "designada" : "propia",
        frequencies: role === "duena" ? "edita" : role === "designada" ? "ve" : null,
        rotation: role === "duena",
        barLink: BAR_LINK_AREAS.includes(area),
        markTest: role === "duena" || role === "designada",
      },
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

/**
 * Quién llena (regla 1): una persona del área de la cuenta, elegida al
 * empezar. Sin elegir, la persona de la sesión.
 */
async function fillerOf(id: unknown, area: IsmArea, req: Request) {
  const pick = typeof id === "string" && Types.ObjectId.isValid(id) ? id : req.auth!.sub;
  const user = await User.findOne({ _id: pick, active: true, sharedDevice: { $ne: true } }).select("name role position");
  if (!user) throw badRequest("Elige quién lo llena");
  if (pick !== req.auth!.sub && ismArea(user.role, user.position) !== area) throw badRequest("Esa persona es de otra área");
  return { user: user._id, name: user.name, position: user.position ?? "" };
}

async function findByKey(uid: string, key: string) {
  return IsmRecord.findOne({ createdBy: uid, idempotencyKey: key })
    .select("-signatures.image")
    .populate("createdBy", "name role position");
}

export async function createRecord(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, recordDate, equipmentFolder, position, idempotencyKey, context, test, filler } = req.body as {
      code?: string;
      recordDate?: string;
      equipmentFolder?: string;
      position?: string;
      idempotencyKey?: string;
      context?: Record<string, unknown>;
      test?: boolean;
      /** Quién lo llena (especificación ISM, regla 1): se elige al empezar. */
      filler?: string;
    };
    const def = code ? ismDefinition(code) : null;
    if (!def) throw badRequest("Formulario inválido");
    if (!recordDate) throw badRequest("Indica la fecha del registro");
    if (!isDateKey(recordDate)) throw badRequest("La fecha no es válida. Elige otra en el calendario.");
    const access = await ismAccessOf(req.auth!);
    if (!canCreateForm(access.area, def.code)) {
      throw forbidden(`El ${def.code.replace("_", " · ")} no lo llena tu área. Pídelo a quien le corresponde.`);
    }
    const person = await fillerOf(filler, access.area, req);

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
      if (!canFillEquipment(access.area, eq)) throw forbidden(`${eq.name} lo llena otra área`);
      // R-16 es una bitácora (sección 7): una hoja abierta por equipo que se va llenando.
      const open = await IsmRecord.findOne({ code: "R-16", "equipment.folder": eq.folder, status: { $ne: "archivado" }, test: { $ne: true } })
        .select("-signatures.image")
        .populate("createdBy", "name role position");
      if (open && !test) {
        res.status(200).json({ record: toClient(open), duplicate: true });
        return;
      }
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
      // R-23 es por persona: el cargo es el de quien lo llena (sección 4).
      const wanted = def.code === "R-23" ? person.position || position : position;
      if (!wanted || !CREW_POSITIONS.includes(wanted as never)) throw badRequest("Elige el cargo");
      const allowed = AREA_POSITIONS[access.area];
      if (def.code !== "R-23" && allowed && !allowed.includes(wanted) && access.area !== "puente") {
        throw forbidden("Ese cargo es de otra área");
      }
      pos = wanted;
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
            // R-14 v2 (especificación ISM, 25-nov-2026): lo llena el propio Capitán, no se elige de la lista.
            fromList: schema.signers?.[0]?.who !== "lista",
            positionFixed: schema.signers?.[0]?.who !== "lista" && Boolean(user?.position),
          },
          confirmedAt: null,
        },
        context ?? {},
      );
      ctx = await applyCrewChoice(ctx, context ?? {}, req);
    }

    const isTest = test === true && (req.auth!.role === "duena" || req.auth!.role === "designada");
    const orderField = ORDER_FIELD[def.code];
    if (orderField && !isTest) data[orderField] = await nextCode(`OR-${recordDate.slice(0, 4)}`);

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
      test: isTest,
      data: schema ? projectToData(schema, { data, answers: {}, context: ctx }) : data,
      position: pos,
      equipment,
      cruise: cruise?._id ?? null,
      createdBy: req.auth!.sub,
      area: access.area,
      filler: person,
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
    const { code, status, from, to, position, equipment, mine, before, limit, q, inbox } = req.query as Record<
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

    // Cada cuenta ve lo de su área (especificación ISM, 25-nov-2026, sección 5).
    const { area } = await ismAccessOf(req.auth!);
    const and: unknown[] = [viewFilter(area, req.auth!.sub)];
    // «Míos» = los borradores de mi área (el reemplazo de turno los sigue).
    if (mine === "1") and.push(ONBOARD_AREAS.includes(area) || area === "designada" ? { area } : { createdBy: new Types.ObjectId(req.auth!.sub) });
    // Por firmar de esta cuenta (bandeja del capitán, de la PD, de Administración, de Gerencia…).
    if (inbox === "1") and.push(awaitingFilter(area, req.auth!.role));
    // Las pruebas no aparecen en Por firmar ni en el Archivo (regla 12).
    if (inbox === "1" || (status && !status.split(",").includes("borrador"))) and.push({ test: { $ne: true } });
    filter.$and = and;

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
    const area = await assertCanView(record, req);
    const session = { area, role: req.auth!.role, uid: req.auth!.sub };
    res.json({
      record: {
        ...toClient(record),
        // Orden de firmas de la hoja y qué puede firmar esta cuenta (sección 4).
        flow: flowView(record, session),
        canEdit: canEdit(record, area, req.auth!.role, req.auth!.sub, officeRoleOf(ismDefinition(record.code) ?? {})),
        outgoingPending: await outgoingPending(record),
      },
    });
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
    const area = await assertCanView(record, req);
    const def = ismDefinition(record.code)!;
    if (!canEdit(record, area, req.auth!.role, req.auth!.sub, officeRoleOf(def))) {
      throw forbidden(
        record.schemaVersion && record.status === "borrador"
          ? "Lo corrige el área que lo llena. Si hay que cambiar algo, devuélvelo con motivo."
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
        if (sig.hashV !== 2 || sig.dataHash !== before) continue;
        // Quien revisa completa su parte (análisis de causa, medida correctiva, despacho):
        // las firmas anteriores siguen valiendo. En borrador, cambiar datos anula la firma.
        if (record.status !== "borrador") {
          sig.dataHash = after;
          continue;
        }
        invalidated.push(sig.field);
        pushEvent(record, req, `firma anulada: ${sig.label}`, "Los datos cambiaron después de firmar");
      }
    }

    await saveOrConflict(record);
    // Las respuestas "No" se siguen como novedades (colección propia).
    if (schema && isObject(answers)) await syncNovedades(record, { id: req.auth!.sub, name: req.auth!.name });
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
    const record = await IsmRecord.findById(req.params.id).select("code status area createdBy handoff signatures");
    if (!record) throw notFound("Registro no encontrado");
    await assertCanView(record, req);
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

/**
 * Firma una casilla (especificación ISM, 25-nov-2026): se elige la persona y
 * pone su clave, o «Firma de externo». Antes se firmaba con el dedo y un
 * nombre escrito a mano; la cuenta del área sola ya no firma.
 */
export async function sign(req: Request, res: Response, next: NextFunction) {
  return signSlot(req, res, next);
}

/** Quitar una firma de llenado mientras el registro está en borrador (p. ej. firmó la persona equivocada). */
export async function removeSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const area = await assertCanView(record, req);
    assertNotStepSigned(record);
    const sig = record.signatures.find((s) => s.field === req.params.field);
    if (!sig) throw notFound("Esa firma no existe");
    const step = flowOf(record.code)?.steps.find((s) => s.fields.includes(sig.field));
    if (record.status !== "borrador" || !step?.atFill) throw conflict("La firma ya no se puede quitar: devuélvelo con comentario");
    if (!canEdit(record, area, req.auth!.role, req.auth!.sub)) throw forbidden("Solo el área que lo llena quita una firma");
    record.signatures = record.signatures.filter((s) => s.field !== sig.field) as never;
    pushEvent(record, req, `quitó firma ${sig.label}`, sig.signerName);
    await saveOrConflict(record);
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
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

/**
 * R-07 (5-nov): el saliente llena, firma y lo envía a quien recibe el cargo.
 * No se ven entre ellos: desde aquí sale de su lista; quien recibe lo lee,
 * firma con su clave y el relevo pasa al Capitán.
 */
export async function handoffRecord(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("El registro ya fue enviado");
    const area = await assertCanView(record, req);
    const def = ismDefinition(record.code)!;
    if (!def.handoff) throw badRequest("Este registro no se envía a otra persona");
    if (record.handoff) throw conflict(`Ya se envió a ${record.handoff.toName}`);
    if (!canEdit(record, area, req.auth!.role, req.auth!.sub)) throw forbidden();
    const own = validSignatures(record).some((s) => s.field === def.handoff!.from);
    if (!own) throw badRequest("Firma primero como saliente");
    const { to } = req.body as { to?: string };
    const person = Types.ObjectId.isValid(String(to))
      ? await User.findOne({ _id: to, active: true, role: { $in: CREW_LIST_ROLES }, sharedDevice: { $ne: true } }).select("name")
      : null;
    if (!person) throw badRequest("Elige a quien recibe el cargo");
    const outgoing = validSignatures(record).find((s) => s.field === def.handoff!.from)!;
    if (person._id.equals(outgoing.user)) throw badRequest("Quien recibe el cargo es otra persona");
    record.handoff = { to: person._id, toName: person.name, by: new Types.ObjectId(req.auth!.sub), at: new Date() };
    pushEvent(record, req, `enviado a ${person.name} para que reciba el cargo`);
    await saveOrConflict(record);
    if (!record.test) {
      await notifyUsers([person._id], {
        kind: "entrega_cargo",
        title: `${record.code}: ${outgoing.signerName} te entrega el cargo`,
        body: "Léelo y firma como entrante con tu clave.",
        record: record._id,
      });
    }
    await logEvent(req.auth, { kind: "registro", title: `${record.code} enviado a quien recibe`, detail: `${record.fileName} · ${person.name}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Envío explícito ("Listo para enviar"): nunca se envía a medias al guardar. */
export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("El registro ya fue enviado");
    const area = await assertCanView(record, req);
    assertNotStepSigned(record);
    if (!canEdit(record, area, req.auth!.role, req.auth!.sub) && !isReceiver(record, req.auth!.sub)) throw forbidden();
    if (!flowOf(record.code)) throw conflict("Este registro se envía desde su chequeo guiado");
    await submitFlow(record, req);
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

/** Antes el Capitán y la PD «aprobaban» aparte; ahora firmar su casilla pasa el registro al siguiente. */
export async function approve(_req: Request, _res: Response, next: NextFunction) {
  next(conflict("Ahora se firma la casilla con tu clave y el registro pasa solo al siguiente. Actualiza la app."));
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
    const { pin, newPin, signer: signerId, deviceAt, image } = req.body as {
      image?: string;
      pin?: string;
      newPin?: string;
      signer?: string;
      deviceAt?: string;
    };

    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const area = await assertCanView(record, req);
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
      if (role !== step.who) throw forbidden(`Solo ${roleName(step.who)}, desde su cuenta, firma este paso`);
      // R-14 v2 (especificación ISM, 25-nov-2026): el Capitán llena y firma en borrador.
      if (record.status === "borrador") {
        if (!canEdit(record, area, role, req.auth!.sub)) throw forbidden("Lo firma el Puente, que lo llenó");
        if (rejectIfIncomplete(record, res)) return;
      }
      const invalid = invalidSignatures(record);
      if (invalid.length) {
        throw badRequest(
          `Firma anulada: ${invalid.map((s) => s.label).join(", ")}. Los datos cambiaron después de firmar; devuélvelo para que se vuelva a firmar.`,
        );
      }
      signerUser = new Types.ObjectId(req.auth!.sub);
    }

    const person = await User.findOne({ _id: signerUser, active: true }).select("name role position sharedDevice");
    if (!person) throw forbidden("Esa persona ya no está activa en la lista de tripulantes");
    if (person.sharedDevice) throw forbidden("La tablet compartida no firma: elige a la persona que hizo el chequeo");
    const sessionUser = new Types.ObjectId(req.auth!.sub);
    // Se firma con la clave (regla 3) y la firma registrada (regla 2); en la transición, quien aún
    // no las tiene firma desde su cuenta sin clave y dibuja su firma, que queda registrada.
    const current = await crewProfile(signerUser);
    const profile = await transitionProfile(
      { id: String(signerUser), name: person.name, noPin: !current.pinHash, drawSignature: !current.signatureImage },
      req.auth!.sub,
      pin,
      newPin,
      image,
    );
    const signatureImage = profile.signatureImage!;

    const now = new Date();
    // Clave restablecida poco antes de firmar: queda en la firma (y en el anexo).
    const resetAt = profile.pinResetAt ? new Date(profile.pinResetAt) : null;
    const recentReset = resetAt && now.getTime() - resetAt.getTime() <= PIN_RESET_WINDOW_MS ? resetAt : null;
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
      ...(recentReset ? { pinResetAt: recentReset, pinResetByName: profile.pinResetByName || "" } : {}),
      ...(deviceTime(deviceAt) ? { deviceAt: deviceTime(deviceAt) } : {}),
      image: signatureImage,
      signedAt: now,
      dataHash: hashContent(record),
      hashV: 2,
    });
    pushEvent(
      record,
      req,
      `firmó ${step.label}`,
      `${sessionUser.equals(signerUser) ? "Con su clave" : `Firma de ${person.name} con su clave, en la sesión de ${req.auth!.name}`} y su firma registrada`,
    );

    const returned = record.returnInfo;
    const fromDraft = record.status === "borrador";
    record.returnInfo = null;
    record.status = step.next;
    if (fromDraft) {
      record.submittedAt = now;
      pushEvent(record, req, step.step === "tripulacion" ? "enviado al Capitán" : "enviado");
    }
    if (step.step === "tripulacion") {
      // (fin del paso de quien hizo el chequeo)
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
    if (fromDraft) await syncNovedades(record, { id: req.auth!.sub, name: req.auth!.name });
    // El PDF se genera una vez y queda congelado con su sha256.
    if (record.status === "archivado") await tryFreezeArchivedPdf(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} · firma ${step.label}`,
      detail: `${record.fileName} · ${person.name} · ${STATUS_LABEL[record.status]}`,
    });

    if (!record.test) {
      const who = record.context?.filledBy;
      // Misma forma de fecha que la app: "30 oct 2026 · 16:19".
      const when = record.context ? screenStamp(record.context.activityDate, record.context.activityTime) : "";
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
    await assertCanView(record, req);
    if (!flowOf(record.code)) throw conflict("Este registro no se devuelve desde aquí");
    // Regla 5: vuelve a quien lo llenó, con las firmas anteriores; se anulan la de quien devuelve y las posteriores.
    await giveBackFlow(record, req, reason, typeof section === "string" ? section : "");
    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} devuelto`,
      detail: `${record.fileName} · ${reason.trim().slice(0, 300)}`,
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
  if (req.auth!.role !== step.who) throw forbidden(`Solo ${roleName(step.who)}, desde su cuenta, devuelve este registro`);
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
    // El borrador es del área (regla 8): lo descarta su área (o la PD en la limpieza, sección 12).
    const area = await assertCanView(record, req);
    if (!canEdit(record, area, req.auth!.role, req.auth!.sub) && req.auth!.role !== "designada") {
      throw forbidden("Solo el área que lo llena puede descartarlo");
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
    if (!(role === "designada" || role === "duena")) throw forbidden("Solo la Persona Designada o Gerencia marcan registros de prueba");
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
    await assertCanView(record, req);
    // Archivado: siempre el mismo archivo congelado (se genera en la primera descarga si es de antes).
    if (record.status === "archivado") {
      const frozen = await freezeArchivedPdf(record);
      const bytes = await readArchivedPdf(frozen);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${record.fileName}"`);
      res.setHeader("X-Content-SHA256", frozen.sha256);
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Content-SHA256");
      res.send(bytes);
      return;
    }
    const bytes = await renderRecordPdf(record);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${record.fileName}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    next(err);
  }
}

/**
 * Lo que espera la firma de esta cuenta (especificación ISM, 25-nov-2026,
 * sección 5, «Mis tareas»): la bandeja del Capitán, lo de la PD (con las R-18
 * de Cubierta y Máquinas por despachar), el R-18 de Hotelería de
 * Administración, lo de José, Jorge o Paula en Gerencia, y en las áreas su
 * fila del R-30 y la recepción conforme de su R-18.
 */
export function awaitingFilter(area: IsmArea, role: string): Record<string, unknown> {
  if (role === "capitan") return { status: "por_capitan" };
  if (role === "designada") return { status: "por_oficina", code: { $ne: "R-18_Hoteleria" } };
  if (role === "admin") return { status: "por_oficina", code: "R-18_Hoteleria" };
  if (role === "duena") return { status: "por_gerencia" };
  if (ONBOARD_AREAS.includes(area)) return { status: "por_firmar", $or: [{ code: "R-30" }, { area }] };
  return { _id: null };
}

/** Resumen de Mis tareas: bandejas, borradores del área y obligatorios según las frecuencias de Gerencia. */
export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const { area } = await ismAccessOf(req.auth!);
    const role = req.auth!.role;
    const { y, m } = monthRangeGalapagos();
    // Las pruebas no cuentan en Por firmar, Obligatorios ni Archivo (regla 12).
    const real = { test: { $ne: true } };
    const scope = { $and: [viewFilter(area, req.auth!.sub), real] };
    const mine = ONBOARD_AREAS.includes(area) || area === "designada" ? { area } : { createdBy: new Types.ObjectId(req.auth!.sub) };
    const [byStatus, drafts, returned, toSign, checklist] = await Promise.all([
      IsmRecord.aggregate([{ $match: scope }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      IsmRecord.countDocuments({ status: "borrador", ...mine }),
      IsmRecord.countDocuments({ status: "borrador", returnInfo: { $ne: null }, ...mine }),
      IsmRecord.countDocuments({ $and: [awaitingFilter(area, role), viewFilter(area, req.auth!.sub), real] }),
      obligations(area),
    ]);
    const counts = Object.fromEntries(byStatus.map((s: { _id: string; n: number }) => [s._id, s.n]));
    res.json({
      month: { y, m },
      counts: {
        borrador: counts.borrador ?? 0,
        por_capitan: counts.por_capitan ?? 0,
        por_oficina: counts.por_oficina ?? 0,
        por_gerencia: counts.por_gerencia ?? 0,
        por_firmar: counts.por_firmar ?? 0,
        archivado: counts.archivado ?? 0,
        misBorradores: drafts,
        misDevueltos: returned,
        porFirmar: toSign,
      },
      checklist,
    });
  } catch (err) {
    next(err);
  }
}
