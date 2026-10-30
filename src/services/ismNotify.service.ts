import { Types } from "mongoose";
import { IsmNotice, NoticeKind } from "../models/ismNotice.model";
import { IsmRecord } from "../models/ismRecord.model";
import { User } from "../models/user.model";

/**
 * Avisos de Registros ISM. Cada aviso se entrega por los canales activos;
 * hoy solo dentro de la app. Para correo o Teams basta agregar un canal a
 * CHANNELS (recibe el mismo aviso ya armado). Un aviso nunca rompe la acción
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

type Channel = (to: Types.ObjectId[], notice: NoticeInput) => Promise<void>;

const inApp: Channel = async (to, notice) => {
  const record = notice.record ? new Types.ObjectId(String(notice.record)) : null;
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
    } catch (err) {
      // Clave repetida: el aviso ya estaba.
      if ((err as { code?: number }).code !== 11000) console.error("[aviso]", err);
    }
  }
};

const CHANNELS: Channel[] = [inApp];

/** Avisa a usuarios concretos (sin repetir) por todos los canales. */
export async function notifyUsers(users: Array<Types.ObjectId | string | null | undefined>, notice: NoticeInput) {
  try {
    const ids = [...new Set(users.filter(Boolean).map(String))].map((id) => new Types.ObjectId(id));
    if (!ids.length) return;
    for (const channel of CHANNELS) await channel(ids, notice);
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
