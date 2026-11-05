import { Types } from "mongoose";
import { IsmNotice, NoticeKind } from "../models/ismNotice.model";
import { IsmRecord } from "../models/ismRecord.model";
import { User } from "../models/user.model";
import { mailerConfigured, sendMail } from "./mailer.service";

/**
 * Avisos de Registros ISM. Cada aviso se entrega por los canales activos:
 * dentro de la app y por correo a quien tiene uno. Para Teams basta agregar
 * un canal a CHANNELS (recibe el mismo aviso ya armado). Un aviso nunca rompe la acción
 * que lo origina.
 */
export interface NoticeInput {
  kind: NoticeKind;
  title: string;
  body?: string;
  record?: Types.ObjectId | string | null;
  /** Clave para no repetir el mismo aviso a la misma persona. */
  key?: string;
}

/** Cada canal recibe a quienes les llega el aviso y devuelve a quienes se lo entregó. */
type Channel = (to: Types.ObjectId[], notice: NoticeInput) => Promise<Types.ObjectId[]>;

const inApp: Channel = async (to, notice) => {
  const record = notice.record ? new Types.ObjectId(String(notice.record)) : null;
  const delivered: Types.ObjectId[] = [];
  for (const user of to) {
    try {
      await IsmNotice.create({
        to: user,
        kind: notice.kind,
        title: notice.title,
        body: notice.body ?? "",
        record,
        link: record ? `/registro/${record}` : "",
        key: notice.key ?? null,
      });
      delivered.push(user);
    } catch (err) {
      // Clave repetida: el aviso ya estaba.
      if ((err as { code?: number }).code !== 11000) console.error("[aviso]", err);
    }
  }
  return delivered;
};

const REGISTROS_URL = "https://registros.teseturis.app";
const NO_EMAIL_DOMAIN = "@sin-cuenta.treasure.ec";
const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Correo a quien tiene uno real. Sin correo, el aviso queda solo dentro de la app. */
const email: Channel = async (to, notice) => {
  if (!mailerConfigured() || !to.length) return to;
  const users = await User.find({ _id: { $in: to }, active: true }).select("email");
  const link = `${REGISTROS_URL}${notice.record ? `/registro/${notice.record}` : ""}`;
  const html = `<p><strong>${escapeHtml(notice.title)}</strong></p>${notice.body ? `<p>${escapeHtml(notice.body)}</p>` : ""}<p><a href="${link}">Abrir Registros ISM</a></p>`;
  for (const u of users) {
    if (!u.email || u.email.endsWith(NO_EMAIL_DOMAIN)) continue;
    try {
      await sendMail({ to: u.email, subject: `Registros ISM · ${notice.title}`, html, text: `${notice.title}\n${notice.body ?? ""}\n${link}` });
    } catch (err) {
      console.error("[aviso:correo]", err);
    }
  }
  return to;
};

const CHANNELS: Channel[] = [inApp, email];

/** Avisa a usuarios concretos (sin repetir) por todos los canales. */
export async function notifyUsers(users: Array<Types.ObjectId | string | null | undefined>, notice: NoticeInput) {
  try {
    const ids = [...new Set(users.filter(Boolean).map(String))].map((id) => new Types.ObjectId(id));
    if (!ids.length) return;
    // En cadena: el correo sale solo por los avisos nuevos (un aviso repetido no se vuelve a enviar).
    let to = ids;
    for (const channel of CHANNELS) to = await channel(to, notice);
  } catch (err) {
    console.error("[aviso]", err);
  }
}

/** Avisa a todas las cuentas activas de un rol (Capitán, Persona Designada). */
export async function notifyRole(role: "capitan" | "designada", notice: NoticeInput) {
  try {
    const users = await User.find({ role, active: true }).select("_id");
    await notifyUsers(
      users.map((u) => u._id),
      notice,
    );
  } catch (err) {
    console.error("[aviso]", err);
  }
}

const HOUR = 60 * 60 * 1000;
let lastSweep = 0;

/**
 * Alertas de espera a la Persona Designada: un R-14 con más de 48 h
 * esperando al Capitán o más de 7 días en su bandeja. Se revisa al pedir los
 * avisos (como mucho cada 10 minutos por instancia) y cada alerta sale una
 * sola vez por envío. Los registros de prueba no avisan.
 */
export async function sweepOverdue(now = new Date(), force = false) {
  if (!force && now.getTime() - lastSweep < 10 * 60 * 1000) return;
  lastSweep = now.getTime();
  try {
    const [captain, office] = await Promise.all([
      IsmRecord.find({
        status: "por_capitan",
        test: { $ne: true },
        submittedAt: { $lte: new Date(now.getTime() - 48 * HOUR) },
      }).select("code fileName submittedAt"),
      IsmRecord.find({
        status: "por_oficina",
        test: { $ne: true },
        captainApprovedAt: { $lte: new Date(now.getTime() - 7 * 24 * HOUR) },
      }).select("code fileName captainApprovedAt"),
    ]);
    for (const r of captain) {
      await notifyRole("designada", {
        kind: "espera_capitan",
        title: `${r.code} lleva más de 48 h esperando al Capitán`,
        body: r.fileName,
        record: r._id,
        key: `espera_capitan:${r._id}:${r.submittedAt?.getTime()}`,
      });
    }
    for (const r of office) {
      await notifyRole("designada", {
        kind: "espera_designada",
        title: `${r.code} lleva más de 7 días en tu bandeja`,
        body: r.fileName,
        record: r._id,
        key: `espera_designada:${r._id}:${r.captainApprovedAt?.getTime()}`,
      });
    }
  } catch (err) {
    console.error("[aviso]", err);
  }
}
