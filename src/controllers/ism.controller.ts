import { NextFunction, Request, Response } from "express";
import { Error as MongooseError, Types } from "mongoose";
import { IIsmRecord, IsmRecord, IsmStatus, SignatureStage } from "../models/ismRecord.model";
import { Cruise } from "../models/cruise.model";
import {
  buildFileName,
  hashRecord,
  ismCatalog,
  ismDefinition,
  ismEquipment,
  monthRangeGalapagos,
  recordDateFromKey,
  renderRecordPdf,
} from "../services/ism.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { CREW_POSITIONS, POSITION_LABELS } from "../utils/roles";

/** Quién puede ver todos los registros (la tripulación ve los suyos). */
const SEES_ALL = new Set(["admin", "capitan", "designada"]);

const STATUS_LABEL: Record<IsmStatus, string> = {
  borrador: "Borrador",
  por_capitan: "Por firmar del Capitán",
  por_oficina: "Por firmar en oficina",
  archivado: "Archivado",
};

function canSignStage(role: string, stage: SignatureStage): boolean {
  if (role === "admin") return true;
  if (stage === "capitan") return role === "capitan";
  if (stage === "oficina") return role === "designada";
  return true;
}

function stageOpen(record: IIsmRecord, stage: SignatureStage, officeOnly: boolean): boolean {
  if (stage === "tripulacion") return record.status === "borrador";
  if (stage === "capitan") return record.status === "borrador" || record.status === "por_capitan";
  return record.status === "por_oficina" || (officeOnly && record.status === "borrador");
}

function canEdit(record: IIsmRecord, role: string, officeOnly: boolean): boolean {
  if (record.status === "archivado") return false;
  if (role === "admin") return true;
  if (record.status === "borrador") return officeOnly ? role === "designada" : true;
  if (record.status === "por_capitan") return role === "capitan";
  return role === "designada";
}

function assertCanView(record: IIsmRecord, req: Request) {
  if (SEES_ALL.has(req.auth!.role)) return;
  const uid = req.auth!.sub;
  const author = record.createdBy as unknown as { _id?: Types.ObjectId } | Types.ObjectId;
  const authorId = ("_id" in author && author._id ? author._id : author).toString();
  const involved = authorId === uid || record.signatures.some((s) => s.user.toString() === uid);
  if (!involved) throw forbidden("Este registro no está a tu cargo");
}

function pushEvent(record: IIsmRecord, req: Request, action: string, reason = "") {
  record.history.push({
    action,
    by: new Types.ObjectId(req.auth!.sub),
    byName: req.auth!.name,
    at: new Date(),
    reason,
  });
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

/** Lo que el frontend no necesita en los listados (firmas en imagen, datos). */
const LIST_FIELDS = "-data -signatures.image -history";

export async function catalog(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      forms: ismCatalog(),
      equipment: ismEquipment(),
      positions: CREW_POSITIONS.map((p) => ({ value: p, label: POSITION_LABELS[p] })),
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

export async function createRecord(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, recordDate, equipmentFolder, position } = req.body as {
      code?: string;
      recordDate?: string;
      equipmentFolder?: string;
      position?: string;
    };
    const def = code ? ismDefinition(code) : null;
    if (!def) throw badRequest("Formulario inválido");
    if (!recordDate || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
      throw badRequest("Indica la fecha del registro");
    }
    if (def.officeOnly && !["admin", "designada"].includes(req.auth!.role)) {
      throw forbidden("Este registro lo llena la oficina");
    }

    const data: Record<string, string | boolean> = {};
    for (const f of def.fields) {
      if (f.default !== undefined && (f.type === "text" || f.type === "checkbox")) data[f.name] = f.default;
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

    const cruise = await Cruise.findOne({ status: "abordo" }).select("_id");
    const date = recordDateFromKey(recordDate);
    const now = new Date();
    const record = new IsmRecord({
      code: def.code,
      title: def.title,
      recordDate: date,
      fileName: buildFileName(def.code, date, now, pos || equipment?.folder),
      data,
      position: pos,
      equipment,
      cruise: cruise?._id ?? null,
      createdBy: req.auth!.sub,
    });
    pushEvent(record, req, "creado");
    await record.save();

    await logEvent(req.auth, {
      kind: "registro",
      title: `${def.code} creado`,
      detail: `${def.title}${equipment ? ` · ${equipment.name}` : ""}${pos ? ` · ${POSITION_LABELS[pos as never]}` : ""}`,
    });
    res.status(201).json({ record });
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
    const record = await IsmRecord.findById(req.params.id).populate("createdBy", "name role position");
    if (!record) throw notFound("Registro no encontrado");
    assertCanView(record, req);
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

/** Guarda lo llenado. Solo quien tiene el registro en su etapa puede editar. */
export async function saveData(req: Request, res: Response, next: NextFunction) {
  try {
    const { data } = req.body as { data?: Record<string, unknown> };
    if (!data || typeof data !== "object") throw badRequest("Datos inválidos");

    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const def = ismDefinition(record.code)!;
    if (!canEdit(record, req.auth!.role, def.officeOnly)) {
      throw forbidden(`No puedes editar un registro ${STATUS_LABEL[record.status].toLowerCase()}`);
    }

    const allowed = new Map(def.fields.map((f) => [f.name, f.type]));
    const merged = { ...(record.data ?? {}) };
    for (const [name, value] of Object.entries(data)) {
      const type = allowed.get(name);
      if (!type || type === "signature") continue;
      if (type === "checkbox" || type === "radio") merged[name] = value === true;
      else if (typeof value === "string") merged[name] = value.slice(0, 5000);
    }
    record.data = merged;
    record.markModified("data");
    await saveOrConflict(record);
    res.json({ record: { _id: record._id, data: record.data, updatedAt: record.updatedAt } });
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
    const def = ismDefinition(record.code)!;
    const slot = def.fields.find((f) => f.name === field && f.type === "signature");
    if (!slot || !slot.stage) throw badRequest("Ese recuadro no es de firma");
    if (!canSignStage(req.auth!.role, slot.stage)) {
      throw forbidden(`Esta firma corresponde a: ${slot.label}`);
    }
    if (!stageOpen(record, slot.stage, def.officeOnly)) {
      throw conflict("Esta firma no está habilitada en la etapa actual del registro");
    }

    const name = (signerName?.trim() || req.auth!.name).slice(0, 120);
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
      dataHash: hashRecord(record),
    });
    pushEvent(record, req, `firmó ${slot.label}`, name !== req.auth!.name ? `Firma de ${name}` : "");
    await saveOrConflict(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} · firma ${slot.label}`,
      detail: `${record.fileName} · ${name}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

export async function removeSignature(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const def = ismDefinition(record.code)!;
    const sig = record.signatures.find((s) => s.field === req.params.field);
    if (!sig) throw notFound("Esa firma no existe");
    if (!stageOpen(record, sig.stage, def.officeOnly)) throw conflict("La firma ya no se puede quitar");
    if (req.auth!.role !== "admin" && sig.user.toString() !== req.auth!.sub) {
      throw forbidden("Solo quien capturó la firma puede quitarla");
    }
    record.signatures = record.signatures.filter((s) => s.field !== sig.field) as never;
    pushEvent(record, req, `quitó firma ${sig.label}`);
    await saveOrConflict(record);
    await record.populate("createdBy", "name role position");
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

function missing(def: ReturnType<typeof ismDefinition>, record: IIsmRecord, stage: SignatureStage) {
  const signed = new Set(record.signatures.map((s) => s.field));
  return def!.fields.filter((f) => f.type === "signature" && f.stage === stage && !signed.has(f.name));
}

/** Envío explícito ("Listo para enviar"): nunca se envía a medias al guardar. */
export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("El registro ya fue enviado");
    const def = ismDefinition(record.code)!;
    if (!canEdit(record, req.auth!.role, def.officeOnly)) throw forbidden();

    if (!def.officeOnly && def.stages.tripulacion > 0) {
      const crewSigned = record.signatures.some((s) => s.stage === "tripulacion");
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
        record.captainApprovedBy = new Types.ObjectId(req.auth!.sub);
        record.captainApprovedAt = new Date();
      }
    }
    pushEvent(record, req, "enviado");
    await saveOrConflict(record);

    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} enviado`,
      detail: `${record.fileName} · ${STATUS_LABEL[record.status]}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

/** Capitán aprueba → oficina. Oficina aprueba → archivado e inmutable. */
export async function approve(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const def = ismDefinition(record.code)!;
    const role = req.auth!.role;

    if (record.status === "por_capitan") {
      if (!(role === "capitan" || role === "admin")) throw forbidden("Lo aprueba el Capitán");
      const pending = missing(def, record, "capitan");
      if (pending.length) throw badRequest(`Falta firmar: ${pending.map((p) => p.label).join(", ")}`);
      record.status = "por_oficina";
      record.captainApprovedBy = new Types.ObjectId(req.auth!.sub);
      record.captainApprovedAt = new Date();
      pushEvent(record, req, "aprobado por el Capitán");
    } else if (record.status === "por_oficina") {
      if (!(role === "designada" || role === "admin")) {
        throw forbidden("Lo recibe y archiva la Persona Designada");
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
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

/** Devolver con motivo: vuelve a borrador; las firmas de etapas posteriores se retiran. */
export async function giveBack(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo es obligatorio");
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    const role = req.auth!.role;
    if (record.status === "por_capitan" && !(role === "capitan" || role === "admin")) throw forbidden();
    if (record.status === "por_oficina" && !(role === "designada" || role === "admin")) throw forbidden();
    if (record.status !== "por_capitan" && record.status !== "por_oficina") {
      throw conflict("Solo se devuelve un registro que está en revisión");
    }
    record.status = "borrador";
    record.signatures = record.signatures.filter((s) => s.stage === "tripulacion") as never;
    record.captainApprovedAt = null;
    record.captainApprovedBy = null;
    pushEvent(record, req, "devuelto", reason.trim());
    await saveOrConflict(record);
    await logEvent(req.auth, {
      kind: "registro",
      title: `${record.code} devuelto`,
      detail: `${record.fileName} · ${reason.trim()}`,
    });
    await record.populate("createdBy", "name role position");
    res.json({ record });
  } catch (err) {
    next(err);
  }
}

/** Descartar un borrador (nunca un registro enviado o archivado). */
export async function discard(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id);
    if (!record) throw notFound("Registro no encontrado");
    if (record.status !== "borrador") throw conflict("Solo se descartan borradores");
    if (req.auth!.role !== "admin" && record.createdBy.toString() !== req.auth!.sub) {
      throw forbidden("Solo quien lo creó puede descartarlo");
    }
    await record.deleteOne();
    await logEvent(req.auth, { kind: "registro", title: `${record.code} descartado`, detail: record.fileName });
    res.json({ ok: true });
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
    const monthFilter = { recordDate: { $gte: start, $lt: end }, status: { $ne: "borrador" } };

    const [byStatus, mine, monthly, equipmentDone, positionsDone] = await Promise.all([
      IsmRecord.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      IsmRecord.countDocuments({ createdBy: uid, status: "borrador" }),
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
