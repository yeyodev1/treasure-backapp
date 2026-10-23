import { Types } from "mongoose";
import { AuditEvent, AuditKind } from "../models/auditEvent.model";
import { AuthPayload } from "../middlewares/auth.middleware";

interface LogInput {
  kind: AuditKind;
  title: string;
  detail?: string;
  amount?: number | null;
  cruise?: Types.ObjectId | string | null;
  cabinNumber?: number | null;
}

/**
 * Deja constancia de una acción con su actor. Nunca rompe la operación:
 * si la bitácora falla, se reporta en consola y la acción sigue.
 */
export async function logEvent(auth: AuthPayload | null | undefined, input: LogInput) {
  try {
    await AuditEvent.create({
      kind: input.kind,
      title: input.title,
      detail: input.detail ?? "",
      amount: input.amount ?? null,
      by: auth?.sub ?? null,
      byName: auth?.name ?? "",
      cruise: input.cruise ?? null,
      cabinNumber: input.cabinNumber ?? null,
    });
  } catch (err) {
    console.error("[audit] no se pudo registrar el evento", err);
  }
}
