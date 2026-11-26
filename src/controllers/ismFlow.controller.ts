import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { IIsmRecord, IIsmSignature, IsmRecord } from "../models/ismRecord.model";
import { User } from "../models/user.model";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { logEvent } from "../services/audit.service";
import { hashContent, signatureIsValid } from "../services/ismSchema.service";
import { hashRecord, ismDefinition, ismEquipment } from "../services/ism.service";
import { tryFreezeArchivedPdf } from "../services/ismArchive.service";
import { verifyPin } from "../services/ismCrew.service";
import { notifyUsers } from "../services/ismNotify.service";
import {
  FlowStep,
  FormFlow,
  fieldsToAnnul,
  flowOf,
  missingLines,
  offlineSignedAt,
  pendingOrder,
  stageOf,
  statusForOrder,
  stepOfField,
  stepsAt,
} from "../services/ismFlow.service";
import { IsmArea, ONBOARD_AREAS, canEditData, canViewRecord, ismAccessOf } from "../services/ismAccess.service";
import { eligibleSigners, pendingFor, stepRecipients } from "../services/ismSigners.service";
import { toClient } from "./ism.controller";

/**
 * Firmas en el orden de la hoja (especificación ISM, 25-nov-2026, reglas
 * 1–7 y sección 4). Se entra por cuenta de área y se firma como persona:
 * siempre se elige quién firma y se pone su clave; su firma registrada se
 * estampa en la casilla. Cuando firma uno, el registro pasa al siguiente y
 * con la última firma se archiva solo. Los externos firman con «Firma de
 * externo» (nombre, cédula y firma con el dedo) en el teléfono de quien llena.
 */

type Doc = IIsmRecord & {
  _id: Types.ObjectId;
  save: () => Promise<unknown>;
  markModified: (p: string) => void;
  populate: (path: string, select?: string) => Promise<unknown>;
};
type Session = { area: IsmArea; role: string; uid: string; name: string };

async function sessionOf(req: Request): Promise<Session> {
  const { area } = await ismAccessOf(req.auth!);
  return { area, role: req.auth!.role, uid: req.auth!.sub, name: req.auth!.name };
}

const officeRoleOf = (code: string) => ismDefinition(code)?.officeRole ?? "designada";

/** Firmas válidas (los datos no cambiaron después de firmar). */
export function signedFields(record: IIsmRecord): Set<string> {
  const current = hashContent(record);
  return new Set(record.signatures.filter((s) => signatureIsValid(s, current)).map((s) => s.field));
}

const isReceiver = (r: IIsmRecord, uid: string) => r.handoff?.to?.toString() === uid;

/** ¿Esta cuenta puede firmar (o devolver) en este paso ahora? */
export function canActOnStep(s: Session, record: IIsmRecord, step: FlowStep): boolean {
  if (record.status === "borrador") {
    if (!step.atFill) return false;
    // R-07 enviado: quien recibe el cargo firma como entrante.
    if (record.handoff) return isReceiver(record, s.uid) && step.order === 2;
    return canEditData(s.area, s.role, s.uid, record, officeRoleOf(record.code));
  }
  switch (step.who) {
    case "capitan":
      return s.role === "capitan";
    case "designada":
      return s.role === "designada";
    case "admin":
      return s.role === "admin";
    case "gerencia":
      return s.role === "duena";
    default:
      // Fila del R-30 desde cualquier área de abordo; recepción del R-18, el área que pidió.
      if (step.requester) return s.area === record.area;
      return ONBOARD_AREAS.includes(s.area) || s.area === "designada";
  }
}

function pushEvent(record: IIsmRecord, req: Request, action: string, reason = "", section = "") {
  record.history.push({ action, by: new Types.ObjectId(req.auth!.sub), byName: req.auth!.name, at: new Date(), reason, section });
}

const labelsOf = (steps: FlowStep[]) => steps.map((s) => s.label).join(", ");

/** Archiva: el PDF se congela y, en el R-16, se abre una hoja nueva del mismo equipo (sección 7). */
function markArchived(record: Doc, req: Request, by: Types.ObjectId | null) {
  record.status = "archivado";
  record.officeApprovedBy = by;
  record.archivedAt = new Date();
  record.contentHash = hashRecord(record);
  pushEvent(record, req, "archivado");
}

async function afterArchive(record: Doc, req: Request) {
  await tryFreezeArchivedPdf(record);
  if (record.code === "R-16" && record.equipment) {
    const eq = ismEquipment().find((e) => e.folder === record.equipment!.folder);
    const def = ismDefinition("R-16")!;
    const data: Record<string, string | boolean> = {};
    if (eq && def.equipmentFields) {
      data[def.equipmentFields.name] = eq.name;
      data[def.equipmentFields.brand] = eq.brand;
      data[def.equipmentFields.model] = eq.model || eq.brand;
      data[def.equipmentFields.serial] = eq.serial;
      data[def.equipmentFields.owner] = eq.owner;
    }
    try {
      await IsmRecord.create({
        code: "R-16",
        title: record.title,
        recordDate: new Date(),
        fileName: record.fileName.replace(/\.pdf$/, "_hoja_nueva.pdf"),
        data,
        equipment: record.equipment,
        area: record.area,
        filler: null,
        createdBy: record.createdBy,
        sourceKey: `r16:${record._id}`,
        history: [{ action: "hoja nueva (la anterior se llenó y se archivó)", by: null, byName: "Sistema", at: new Date(), reason: "", section: "" }],
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) console.error("[ism] hoja nueva del R-16", err);
    }
  }
  void req;
}

/** Aviso al siguiente: el capitán recibe al momento solo R-07, R-08 y R-09 (sección 6); lo demás va en su aviso agrupado. */
async function notifyNext(record: Doc, flow: FormFlow) {
  if (record.test || record.status === "archivado" || record.status === "borrador") return;
  const order = pendingOrder(flow, record.data, signedFields(record));
  if (order === null) return;
  const steps = stepsAt(flow, order);
  const base = record.code.split("_")[0]!;
  if (steps[0]!.who === "capitan" && !["R-07", "R-08", "R-09"].includes(base)) return;
  const to = (await Promise.all(steps.map((s) => stepRecipients(s, record)))).flat();
  await notifyUsers(to, {
    kind: steps[0]!.who === "capitan" ? "por_firmar_capitan" : steps[0]!.who === "designada" ? "por_firmar_designada" : "por_firmar",
    title: `${record.code.replace("_", " · ")}: ${steps[0]!.who === "capitan" ? "urgente, " : ""}falta ${labelsOf(steps)}`,
    body: record.fileName,
    record: record._id,
  });
}

/** Pasa al estado del siguiente paso pendiente (o archiva). */
function advance(record: Doc, flow: FormFlow, req: Request, lastSigner: Types.ObjectId | null) {
  const order = pendingOrder(flow, record.data, signedFields(record));
  const status = statusForOrder(flow, order);
  if (record.status === status) return false;
  if (record.status === "por_capitan") {
    record.captainApprovedBy = lastSigner;
    record.captainApprovedAt = new Date();
  }
  if (status === "archivado") markArchived(record, req, lastSigner);
  else {
    record.status = status;
    pushEvent(record, req, `pasa a: ${labelsOf(stepsAt(flow, order!))}`);
  }
  return true;
}

/**
 * Sale del borrador: firmas de llenado completas, bitácora llena y, en el
 * R-07, sin firmas pendientes de quien se baja.
 */
export async function leaveDraft(record: Doc, flow: FormFlow, req: Request) {
  const signed = signedFields(record);
  const fill = pendingOrder(flow, record.data, signed, (s) => Boolean(s.atFill));
  if (fill !== null) throw badRequest(`Falta firmar: ${labelsOf(stepsAt(flow, fill).filter((s) => s.atFill))}`);
  const current = hashContent(record);
  const invalid = record.signatures.filter((s) => !signatureIsValid(s, current) && stepOfField(flow, s.field)?.atFill);
  if (invalid.length) throw badRequest(`Los datos cambiaron después de firmar: vuelvan a firmar ${invalid.map((s) => s.label).join(", ")}`);
  const lines = missingLines(flow, record.data);
  if (lines) throw badRequest(`La hoja se firma cuando está llena: faltan ${lines} ${lines === 1 ? "línea" : "líneas"}`);
  if (record.code === "R-07") {
    const outgoing = record.signatures.find((s) => s.field === flow.steps[0]!.fields[0]);
    const pending = outgoing ? await pendingFor(String(outgoing.user)) : [];
    if (pending.length) {
      throw new HttpError(
        409,
        `El relevo no se cierra: ${outgoing!.signerName} tiene ${pending.length} ${pending.length === 1 ? "firma pendiente" : "firmas pendientes"} (${pending
          .map((p) => p.code)
          .join(", ")}). Que las firme antes de bajar.`,
        "relevo_pendientes",
        { pending },
      );
    }
  }
  record.submittedAt = new Date();
  record.returnInfo = null;
  pushEvent(record, req, "enviado");
  // Sin firmas de revisión (R-12, R-27) se archiva al enviar.
  const order = pendingOrder(flow, record.data, signed);
  if (order === null) markArchived(record, req, null);
  else {
    record.status = statusForOrder(flow, order);
    pushEvent(record, req, `pasa a: ${labelsOf(stepsAt(flow, order))}`);
  }
}

const EXTERNAL_ID = /^[A-Za-z0-9-]{5,20}$/;

/** Firma una casilla: persona + clave (su firma registrada) o firma de externo. */
export async function signSlot(req: Request, res: Response, next: NextFunction) {
  try {
    const { field, signer, pin, newPin, external, deviceAt } = req.body as {
      field?: string;
      signer?: string;
      pin?: string;
      newPin?: string;
      external?: { name?: string; idNumber?: string; image?: string };
      deviceAt?: string;
    };
    const record = (await IsmRecord.findById(req.params.id)) as Doc | null;
    if (!record) throw notFound("Registro no encontrado");
    const s = await sessionOf(req);
    if (!canViewRecord(s.area, s.uid, record)) throw forbidden("Este registro no es de tu área");
    const flow = flowOf(record.code);
    if (!flow || record.schemaVersion) throw conflict("Este registro se firma desde su chequeo guiado");
    if (record.status === "archivado") throw conflict("El registro ya está archivado: no se toca");
    const step = field ? stepOfField(flow, field) : null;
    if (!step || !field) throw badRequest("Esa casilla no es de firma");

    const signed = signedFields(record);
    if (signed.has(field)) throw conflict("Esa casilla ya está firmada");
    const order =
      record.status === "borrador"
        ? pendingOrder(flow, record.data, signed, (x) => Boolean(x.atFill))
        : pendingOrder(flow, record.data, signed);
    if (order !== step.order) {
      const waiting = order === null ? [] : stepsAt(flow, order);
      throw conflict(
        record.status === "borrador" && !step.atFill
          ? `«${step.label}» firma después de enviar el registro`
          : `Aún no le toca a «${step.label}». Primero: ${labelsOf(waiting)}`,
      );
    }
    if (record.code === "R-07" && step.order === 2 && !record.handoff) {
      throw conflict("Envíalo a quien recibe el cargo: firma desde su cuenta");
    }
    if (!canActOnStep(s, record, step)) throw forbidden(`Esta firma (${step.label}) no se pone desde tu cuenta`);
    if (record.status === "borrador" && flow.fullBefore && !step.rows) {
      const lines = missingLines(flow, record.data);
      if (lines) throw badRequest(`La hoja se firma cuando está llena: faltan ${lines} ${lines === 1 ? "línea" : "líneas"}`);
    }

    const now = new Date();
    const when = offlineSignedAt(deviceAt ? new Date(deviceAt) : null, now);
    const offline = when !== now;
    let sig: IIsmSignature;
    if (step.who === "externo") {
      const name = (external?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
      const idNumber = (external?.idNumber ?? "").trim();
      const image = external?.image ?? "";
      if (name.length < 5 || !name.includes(" ")) throw badRequest("Escribe el nombre y apellido de quien firma");
      if (!EXTERNAL_ID.test(idNumber)) throw badRequest("Escribe la cédula (o pasaporte) de quien firma");
      if (!image.startsWith("data:image/png;base64,") || image.length > 400_000) throw badRequest("Que firme con el dedo en el recuadro");
      sig = {
        field,
        stage: stageOf(step.who),
        label: step.label,
        signerName: name,
        user: new Types.ObjectId(s.uid),
        userName: s.name,
        userRole: s.role,
        capturedBy: new Types.ObjectId(s.uid),
        capturedByName: s.name,
        method: "externo",
        external: true,
        idNumber,
        image,
        signedAt: when,
        dataHash: "",
        hashV: 2,
      };
    } else {
      const people = await eligibleSigners(record, step, field, flow);
      const person = people.find((p) => p.id === signer);
      if (!person) {
        throw forbidden(people.length ? "Elige a quien firma de la lista" : `Nadie con clave y firma registrada puede firmar como ${step.label}`);
      }
      const profile = await verifyPin(person.id, pin, newPin);
      const user = await User.findById(person.id).select("role position");
      sig = {
        field,
        stage: stageOf(step.who),
        label: step.label,
        signerName: person.name,
        user: new Types.ObjectId(person.id),
        userName: person.name,
        userRole: user?.role ?? "",
        position: user?.position ?? "",
        capturedBy: person.id === s.uid ? null : new Types.ObjectId(s.uid),
        capturedByName: person.id === s.uid ? "" : s.name,
        method: "clave",
        image: profile.signatureImage!,
        signedAt: when,
        dataHash: "",
        hashV: 2,
      };
    }
    if (offline) {
      sig.deviceAt = when;
      sig.syncedAt = now;
    }
    sig.dataHash = hashContent(record);
    record.signatures.push(sig);
    pushEvent(
      record,
      req,
      `firmó ${step.label}`,
      `${sig.signerName}${sig.external ? ` (externo, cédula ${sig.idNumber})` : " con su clave"}${sig.capturedBy ? ` en la cuenta de ${s.name}` : ""}${offline ? " · sin señal, hora del teléfono" : ""}`,
    );

    let moved = false;
    if (record.status === "borrador") {
      const fillDone = pendingOrder(flow, record.data, signedFields(record), (x) => Boolean(x.atFill)) === null;
      const rowsOpen = flow.steps.some((x) => x.atFill && x.rows);
      // Con la última firma de llenado sale solo (salvo hojas con filas, que se envían a mano).
      if (fillDone && !rowsOpen) {
        await leaveDraft(record, flow, req);
        moved = true;
      }
    } else {
      moved = advance(record, flow, req, sig.external ? null : sig.user);
    }
    await record.save();
    // (el estado cambió al firmar: TypeScript lo da por descartado tras el chequeo de arriba)
    if ((record.status as string) === "archivado") await afterArchive(record, req);
    else if (moved) await notifyNext(record, flow);
    await logEvent(req.auth, { kind: "registro", title: `${record.code} · firma ${step.label}`, detail: `${record.fileName} · ${sig.signerName}` });
    await record.populate("createdBy", "name role position");
    res.json({ record: toClient(record) });
  } catch (err) {
    next(err);
  }
}

/** Personas que pueden firmar una casilla ahora (con clave y firma registrada). */
export async function signersFor(req: Request, res: Response, next: NextFunction) {
  try {
    const record = await IsmRecord.findById(req.params.id).select("code status data area filler createdBy handoff schemaVersion");
    if (!record) throw notFound("Registro no encontrado");
    const s = await sessionOf(req);
    if (!canViewRecord(s.area, s.uid, record)) throw forbidden("Este registro no es de tu área");
    const flow = flowOf(record.code);
    const step = flow ? stepOfField(flow, String(req.params.field)) : null;
    if (!flow || !step) throw notFound("Esa casilla no es de firma");
    const people = step.who === "externo" ? [] : await eligibleSigners(record, step, String(req.params.field), flow);
    res.json({ step: { label: step.label, who: step.who, external: step.who === "externo" }, people });
  } catch (err) {
    next(err);
  }
}

/** Enviar (fin del llenado): pasa al primer paso de revisión o se archiva. */
export async function submitFlow(record: Doc, req: Request) {
  const flow = flowOf(record.code)!;
  await leaveDraft(record, flow, req);
  await record.save();
  if (record.status === "archivado") await afterArchive(record, req);
  else await notifyNext(record, flow);
}

/**
 * Devolver con comentario (regla 5): vuelve a quien lo llenó, conserva las
 * firmas anteriores a quien devuelve y anula la suya y las posteriores.
 */
export async function giveBackFlow(record: Doc, req: Request, reason: string, section: string) {
  const flow = flowOf(record.code)!;
  if (record.status === "borrador" || record.status === "archivado") throw conflict("Solo se devuelve un registro que espera firma");
  const order = pendingOrder(flow, record.data, signedFields(record));
  if (order === null) throw conflict("El registro ya tiene todas sus firmas");
  const s = await sessionOf(req);
  if (!stepsAt(flow, order).some((st) => canActOnStep(s, record, st))) throw forbidden("Lo devuelve quien debe firmarlo ahora");
  const annul = fieldsToAnnul(flow, order);
  const now = new Date();
  const cleanReason = reason.trim().slice(0, 1000);
  const annulled = record.signatures.filter((x) => annul.has(x.field));
  record.annulledSignatures = [
    ...(record.annulledSignatures ?? []),
    ...annulled.map((x) => ({
      ...((x as unknown as { toObject?: () => IIsmSignature }).toObject?.() ?? x),
      annulledAt: now,
      annulReason: `Devuelto por ${req.auth!.name}: ${cleanReason}`,
    })),
  ];
  record.signatures = record.signatures.filter((x) => !annul.has(x.field)) as never;
  record.status = "borrador";
  record.captainApprovedAt = null;
  record.captainApprovedBy = null;
  record.returnInfo = { reason: cleanReason, section: section.trim().slice(0, 120), byName: req.auth!.name, at: now };
  pushEvent(record, req, "devuelto", cleanReason, section);
  for (const x of annulled) pushEvent(record, req, `firma anulada: ${x.label} (${x.signerName})`, "Por la devolución");
  await record.save();
  if (!record.test) {
    await notifyUsers([record.filler?.user, record.createdBy], {
      kind: "devuelto",
      title: `Te devolvieron el ${record.code}`,
      body: `${req.auth!.name}: ${cleanReason}`,
      record: record._id,
    });
  }
}

/** R-07: firmas pendientes de quien se baja (se muestran en el relevo). */
export async function outgoingPending(record: IIsmRecord) {
  if (record.code !== "R-07" || record.status !== "borrador") return [];
  const outgoing = record.signatures.find((x) => x.field === flowOf("R-07")!.steps[0]!.fields[0]);
  const who = outgoing?.user ?? record.filler?.user;
  return who ? pendingFor(String(who)) : [];
}

/** Lo que la app necesita para mostrar el orden de firmas de un registro. */
export function flowView(record: IIsmRecord, s: { area: IsmArea; role: string; uid: string }) {
  const flow = flowOf(record.code);
  if (!flow || record.schemaVersion) return null;
  const signed = signedFields(record);
  const pending =
    record.status === "archivado"
      ? null
      : record.status === "borrador"
        ? pendingOrder(flow, record.data, signed, (x) => Boolean(x.atFill))
        : pendingOrder(flow, record.data, signed);
  const session = { ...s, name: "" };
  return {
    pendingOrder: pending,
    steps: flow.steps.map((st) => ({
      order: st.order,
      who: st.who,
      label: st.label,
      fields: st.fields,
      atFill: Boolean(st.atFill),
      rows: Boolean(st.rows),
      virtual: Boolean(st.virtual),
      done: st.fields.some((f) => signed.has(f)) && (!st.rows ? st.fields.every((f) => signed.has(f)) : true),
      canSign: pending === st.order && canActOnStep(session, record, st),
    })),
    rowNames: flow.rowNames ?? {},
    sendsWithRows: flow.steps.some((st) => st.atFill && st.rows),
  };
}
