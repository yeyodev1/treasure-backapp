import { Types } from "mongoose";
import { IsmRecord } from "../models/ismRecord.model";
import { IsmCrew } from "../models/ismCrew.model";
import { User } from "../models/user.model";
import { IsmRotationPost, IsmRotationTurn } from "../models/ismRotation.model";
import { notifyUsers } from "./ismNotify.service";
import { obligations } from "./ismObligations.service";
import { AREA_POSITIONS, IsmArea, ONBOARD_AREAS, canCreateForm, ismArea } from "./ismAccess.service";
import { addDays, closeDue, diffDays, frequencyRules } from "./ismFrequency.service";
import { onDutyUsers, relevosOf, turnsOn } from "./ismRotation.service";
import { todayKey } from "./ismSigners.service";
import { buildFileName, galapagosParts, ismDefinition, recordDateFromKey } from "./ism.service";

/**
 * Revisión periódica de Registros ISM (especificación ISM, 25-nov-2026,
 * secciones 6, 8 y 9). Corre al pedir los avisos, como mucho cada 10 minutos
 * por instancia; cada aviso lleva una clave para salir una sola vez:
 * - Bandeja del capitán: un aviso agrupado al día («tienes 8 por firmar»).
 * - Vencimientos: por vencer → quien llena (de turno); vence hoy → también el
 *   capitán; vencido → también la PD; 3 días vencido → Gerencia.
 * - Lo «cuando ocurre» con plazo (R-08, R-09, R-17, R-30): aviso si no se cierra.
 * - Calendario de rotación: «abordo / en tierra» del día y el R-07 de cada relevo.
 * Los registros de prueba no avisan.
 */
let lastRun = 0;

async function usersOfRole(role: string): Promise<Types.ObjectId[]> {
  return (await User.find({ role, active: true }).select("_id")).map((u) => u._id);
}

/** Quien está de turno en un área (calendario) o, sin calendario, quien figura abordo. */
async function onDutyInArea(area: IsmArea, today: string): Promise<Types.ObjectId[]> {
  if (area === "designada") return usersOfRole("designada");
  const positions = AREA_POSITIONS[area] ?? [];
  const duty = await onDutyUsers(positions, today);
  if (duty.length) return duty;
  const users = await User.find({ active: true, sharedDevice: { $ne: true }, role: { $in: ["tripulante", "capitan"] } }).select("role position");
  const inArea = users.filter((u) => ismArea(u.role, u.position) === area);
  const aboard = new Set((await IsmCrew.find({ user: { $in: inArea.map((u) => u._id) }, onboard: true }).select("user")).map((p) => String(p.user)));
  return inArea.filter((u) => aboard.has(String(u._id))).map((u) => u._id);
}

async function captainsOnDuty(today: string) {
  const duty = await onDutyUsers(["CAP"], today);
  return duty.length ? duty : usersOfRole("capitan");
}

export async function sweepIsm(now = new Date(), force = false) {
  if (!force && now.getTime() - lastRun < 10 * 60 * 1000) return;
  lastRun = now.getTime();
  const today = todayKey(now);
  for (const task of [captainInbox, dueNotices, closeDeadlines, rotationDay]) {
    try {
      await task(today, now);
    } catch (err) {
      console.error("[ism:revisión]", err);
    }
  }
}

/** Sección 6: un aviso agrupado al capitán de turno, desde las 07h30. */
async function captainInbox(today: string, now: Date) {
  const t = galapagosParts(now);
  if (t.hh * 60 + t.mm < 7 * 60 + 30) return;
  const n = await IsmRecord.countDocuments({ status: "por_capitan", test: { $ne: true } });
  if (!n) return;
  const minutes = Math.max(1, Math.round(n * 0.75));
  await notifyUsers(await captainsOnDuty(today), {
    kind: "bandeja_capitan",
    title: `Tienes ${n} por firmar`,
    body: `≈ ${minutes} ${minutes === 1 ? "minuto" : "minutos"} · revisa y firma uno por uno`,
    key: `bandeja:${today}`,
  });
}

const LEVEL_TEXT: Record<string, string> = {
  por_vencer: "por vencer",
  vence_hoy: "vence hoy",
  vencido: "vencido",
  vencido_3: "vencido hace 3 días o más",
};

/** Sección 8: avisos de vencimiento escalonados. */
async function dueNotices(today: string) {
  const list = await obligations("gerencia", { today, all: true });
  for (const o of list) {
    if (!LEVEL_TEXT[o.state]) continue;
    const areas = [...ONBOARD_AREAS, "designada" as IsmArea].filter((a) => canCreateForm(a, o.code));
    const to: Types.ObjectId[] = [];
    for (const a of areas) to.push(...(await onDutyInArea(a, today)));
    if (o.state !== "por_vencer") to.push(...(await captainsOnDuty(today)));
    if (o.state === "vencido" || o.state === "vencido_3") to.push(...(await usersOfRole("designada")));
    if (o.state === "vencido_3") to.push(...(await usersOfRole("duena")));
    const detail = o.missing?.length ? `Falta: ${o.missing.slice(0, 6).join(", ")}` : o.items?.length ? `Equipos: ${o.items.slice(0, 6).map((i) => i.name).join(", ")}` : o.rule;
    await notifyUsers(to, {
      kind: "vencimiento",
      title: `${o.code.replace("_", " · ")} ${LEVEL_TEXT[o.state]}${o.due ? ` (${o.due.split("-").reverse().join("/")})` : ""}`,
      body: detail,
      key: `venc:${o.code}:${o.periodKey}:${o.state}`,
    });
  }
}

/** «Cuando ocurre» con plazo: nunca sale como atrasado, pero avisa si no se cierra (sección 8). */
async function closeDeadlines(today: string) {
  const rules = await frequencyRules();
  for (const r of rules.filter((x) => x.rule.kind === "cuando_ocurre" && x.rule.closeDays)) {
    const open = await IsmRecord.find({
      code: { $regex: `^${r.code}(_|$)` },
      status: { $nin: ["borrador", "archivado"] },
      test: { $ne: true },
    }).select("code fileName createdAt");
    for (const rec of open) {
      const due = closeDue(todayKey(rec.createdAt ?? new Date()), r.rule.closeDays);
      if (!due || today <= due) continue;
      const late = diffDays(today, due);
      const to = [...(await captainsOnDuty(today)), ...(await usersOfRole("designada")), ...(late >= 3 ? await usersOfRole("duena") : [])];
      await notifyUsers(to, {
        kind: "vencimiento",
        title: `${rec.code} sin cerrar: el plazo de ${r.rule.closeDays} días venció`,
        body: rec.fileName,
        record: rec._id,
        key: `cierre:${rec._id}:${late >= 3 ? 3 : 1}`,
      });
    }
  }
}

/** Sección 9: abordo / en tierra del día y el R-07 de cada relevo (lo crea el calendario). */
async function rotationDay(today: string) {
  const posts = await IsmRotationPost.find({ active: true });
  if (!posts.length) return;
  const turns = await IsmRotationTurn.find({ post: { $in: posts.map((p) => p._id) }, to: { $gte: addDays(today, -1) }, from: { $lte: addDays(today, 30) } });
  // Abordo según el calendario, una vez al día (el capitán lo corrige ese mismo día y se respeta).
  const people = [...new Set(turns.filter((t) => t.user).map((t) => String(t.user)))];
  const aboard = new Set(turnsOn(turns, today).filter((t) => t.user).map((t) => String(t.user)));
  for (const id of people) {
    await IsmCrew.updateOne(
      { user: id, onboardSyncedOn: { $ne: today } },
      { $set: { onboard: aboard.has(id), onboardSyncedOn: today } },
      { upsert: false },
    );
  }
  // R-07 de los relevos de hoy y mañana, con cargo, saliente y entrante ya puestos.
  const def = ismDefinition("R-07");
  if (!def) return;
  for (const r of relevosOf(turns).filter((x) => x.day >= today && x.day <= addDays(today, 1))) {
    const post = posts.find((p) => String(p._id) === String(r.in.post));
    if (!post?.position) continue;
    const [outUser, inUser] = await Promise.all([
      User.findById(r.out.user).select("name role position"),
      User.findById(r.in.user).select("name role position"),
    ]);
    if (!outUser || !inUser) continue;
    const area = ismArea(outUser.role, post.position);
    const date = recordDateFromKey(r.day);
    try {
      await IsmRecord.create({
        code: "R-07",
        title: def.title,
        recordDate: date,
        fileName: buildFileName("R-07", date, new Date(), post.position),
        // Cargo, saliente y entrante de la hoja (guía del R-07).
        data: { "Text Field 19": r.day.split("-").reverse().join("/"), "Text Field 63": post.label, Apellido: outUser.name, "Text Field 66": inUser.name },
        position: post.position,
        area,
        filler: { user: outUser._id, name: outUser.name, position: post.position },
        createdBy: outUser._id,
        sourceKey: `relevo:${r.out._id}:${r.in._id}`,
        history: [{ action: `creado por el calendario de rotación: ${outUser.name} entrega a ${inUser.name}`, by: null, byName: "Sistema", at: new Date(), reason: "", section: "" }],
      });
      await notifyUsers([outUser._id], {
        kind: "entrega_cargo",
        title: `Relevo ${r.day.split("-").reverse().join("/")}: llena tu entrega de cargo (R-07)`,
        body: `Entregas ${post.label} a ${inUser.name}. Antes de bajar firma lo que tengas pendiente.`,
        key: `relevo:${r.out._id}:${r.in._id}`,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
}
