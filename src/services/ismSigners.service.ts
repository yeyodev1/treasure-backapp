import { Types } from "mongoose";
import { User } from "../models/user.model";
import { IsmCrew } from "../models/ismCrew.model";
import { IIsmRecord, IsmRecord } from "../models/ismRecord.model";
import { FlowStep, FormFlow, flowOf, rowBelongsTo, stepOfField } from "./ismFlow.service";
import { IsmArea, ismArea } from "./ismAccess.service";
import { hasRotation, onDutyUsers } from "./ismRotation.service";
import { hashContent, signatureIsValid } from "./ismSchema.service";
import { galapagosParts } from "./ism.service";
import { positionLabel } from "./ismCrew.service";

/**
 * Quién puede firmar cada casilla (especificación ISM, 25-nov-2026, reglas
 * 1–3 y 9): una persona real con clave y firma registrada (sin eso no
 * aparece), con el rol o el cargo del paso; lo que firma un cargo va a quien
 * esté de turno según el calendario de rotación.
 */
const ROLE_OF: Record<string, string[]> = {
  persona: ["tripulante", "capitan", "designada"],
  capitan: ["capitan"],
  designada: ["designada"],
  admin: ["admin"],
  gerencia: ["duena"],
};

export function todayKey(date = new Date()): string {
  const t = galapagosParts(date);
  return `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
}

export interface Signer {
  id: string;
  name: string;
  position: string;
  positionLabel: string;
  /** Aún sin clave: solo firma desde su propia cuenta (transición). */
  noPin: boolean;
  /** Aún sin firma registrada: la dibuja al firmar y queda registrada (transición). */
  drawSignature: boolean;
}

const fillerId = (r: Pick<IIsmRecord, "filler" | "createdBy">) =>
  String(r.filler?.user ?? (r.createdBy as unknown as { _id?: unknown })?._id ?? r.createdBy);

export async function eligibleSigners(
  record: Pick<IIsmRecord, "code" | "data" | "area" | "filler" | "createdBy">,
  step: FlowStep,
  field: string,
  flow: FormFlow,
  /** Quien tiene la sesión abierta (en la transición firma sin clave si aún no tiene). */
  selfId?: string,
): Promise<Signer[]> {
  const roles = ROLE_OF[step.who];
  if (!roles) return [];
  const query: Record<string, unknown> = { active: true, sharedDevice: { $ne: true }, role: { $in: roles } };
  if (step.positions) query.position = { $in: step.positions };
  if (step.self) query._id = fillerId(record);
  let users = await User.find(query).select("name role position").sort({ name: 1 });
  // El cargo de turno: si el calendario tiene ese cargo, solo quien está de turno hoy.
  const dutyPositions = step.who === "capitan" ? ["CAP"] : step.positions;
  if (dutyPositions && (await hasRotation(dutyPositions))) {
    const onDuty = new Set((await onDutyUsers(dutyPositions, todayKey())).map(String));
    users = users.filter((u) => onDuty.has(String(u._id)));
  }
  if (step.rowOwner) {
    const rowText = record.data?.[flow.rowNames?.[field] ?? ""];
    users = users.filter((u) => rowBelongsTo(rowText, u.name));
  }
  if (step.requester && record.area) users = users.filter((u) => ismArea(u.role, u.position) === record.area);
  const profiles = await IsmCrew.find({
    user: { $in: users.map((u) => u._id) },
    ...(step.manager ? { managerTitle: step.manager } : {}),
  }).select("user pinHash signatureImage");
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  // shortcut: transición (pedido de Diego, 26-nov) mientras Gerencia carga a las personas reales:
  // sin firma registrada se dibuja al firmar (queda registrada) y quien aún no tiene clave firma
  // solo desde su propia cuenta, como antes. Se apaga solo cuando todos tienen clave y firma.
  return users
    .filter((u) => (step.manager ? byUser.has(String(u._id)) : true))
    .filter((u) => Boolean(byUser.get(String(u._id))?.pinHash) || String(u._id) === selfId)
    .map((u) => {
      const p = byUser.get(String(u._id));
      return {
        id: String(u._id),
        name: u.name,
        position: u.position ?? "",
        positionLabel: positionLabel(u.position),
        noPin: !p?.pinHash,
        drawSignature: !p?.signatureImage,
      };
    });
}

/** Usuarios a avisar cuando un paso espera a un rol (el de turno si hay calendario). */
export async function stepRecipients(step: FlowStep, record: Pick<IIsmRecord, "area" | "filler" | "createdBy">): Promise<Types.ObjectId[]> {
  if (step.who === "capitan" && (await hasRotation(["CAP"]))) return onDutyUsers(["CAP"], todayKey());
  if (step.who === "persona" || step.who === "externo") {
    return step.requester || step.self ? [new Types.ObjectId(fillerId(record))] : [];
  }
  const roles = ROLE_OF[step.who] ?? [];
  const users = await User.find({ active: true, role: { $in: roles } }).select("_id");
  if (step.who !== "gerencia" || !step.manager) return users.map((u) => u._id);
  const titled = await IsmCrew.find({ user: { $in: users.map((u) => u._id) }, managerTitle: step.manager }).select("user");
  return titled.length ? titled.map((p) => p.user) : users.map((u) => u._id);
}

/**
 * Firmas pendientes de una persona (regla 10: el relevo R-07 no se cierra
 * hasta que quien se baja las firme): su bandeja si es Capitán, su R-23 o
 * su informe R-29 sin firmar y su fila de un R-30 abierto.
 */
export async function pendingFor(userId: string): Promise<Array<{ _id: string; code: string; fileName: string; why: string }>> {
  const user = await User.findById(userId).select("name role");
  if (!user) return [];
  const real = { test: { $ne: true } };
  const out: Array<{ _id: string; code: string; fileName: string; why: string }> = [];
  if (user.role === "capitan") {
    const inbox = await IsmRecord.find({ ...real, status: "por_capitan" }).select("code fileName").limit(50);
    out.push(...inbox.map((r) => ({ _id: String(r._id), code: r.code, fileName: r.fileName, why: "Por firmar como Capitán" })));
  }
  const own = await IsmRecord.find({ ...real, status: "borrador", code: { $in: ["R-23", "R-29"] }, "filler.user": user._id }).select(
    "code fileName data answers context recordDate signatures",
  );
  for (const r of own) {
    const flow = flowOf(r.code)!;
    const field = flow.steps.find((s) => s.self)!.fields[0]!;
    const current = hashContent(r);
    if (!r.signatures.some((s) => s.field === field && signatureIsValid(s, current))) {
      out.push({ _id: String(r._id), code: r.code, fileName: r.fileName, why: "Falta su firma" });
    }
  }
  const r30 = await IsmRecord.find({ ...real, status: "por_firmar", code: "R-30" }).select("code fileName data signatures");
  for (const r of r30) {
    const flow = flowOf("R-30")!;
    const signed = new Set(r.signatures.map((s) => s.field));
    const mine = Object.entries(flow.rowNames ?? {}).some(([sig, nameField]) => {
      const text = r.data?.[nameField];
      return typeof text === "string" && text.trim() && rowBelongsTo(text, user.name) && !signed.has(sig);
    });
    if (mine) out.push({ _id: String(r._id), code: r.code, fileName: r.fileName, why: "Falta su fila de la toma de conocimiento" });
  }
  return out;
}

/** Área de la cuenta de un registro creado antes de la especificación (sin `area`): la de quien lo creó. */
export async function areaOfCreator(createdBy: unknown): Promise<IsmArea | ""> {
  const u = await User.findById(String((createdBy as { _id?: unknown })?._id ?? createdBy)).select("role position");
  return u ? ismArea(u.role, u.position) : "";
}

export { stepOfField };
