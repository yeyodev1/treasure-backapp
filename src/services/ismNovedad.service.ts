import { Types } from "mongoose";
import { IIsmRecord, IsmRecord } from "../models/ismRecord.model";
import { IsmNovedad, NovedadState } from "../models/ismNovedad.model";
import { ismSchema, schemaItems } from "./ismSchema.service";

type RecordLike = Pick<IIsmRecord, "code" | "schemaVersion" | "answers" | "status" | "fileName" | "test"> & {
  _id: Types.ObjectId;
};

/**
 * Lleva las respuestas "No" de un registro guiado a la colección de
 * novedades. Mientras el registro está en borrador, el seguimiento que se
 * llena en la tablet (responsable, plazo, estado) también se copia; después
 * la novedad se sigue aparte. Si en el borrador la respuesta deja de ser
 * "No", la novedad queda anulada (no se borra).
 */
export async function syncNovedades(record: RecordLike, actor?: { id: string; name: string }) {
  const schema = record.schemaVersion ? ismSchema(record.code, record.schemaVersion) : null;
  if (!schema) return;
  const draft = record.status === "borrador";
  const by = actor ? new Types.ObjectId(actor.id) : null;
  const byName = actor?.name ?? "";
  const seen = new Set<string>();
  for (const { section, item } of schemaItems(schema)) {
    const a = record.answers?.[item.id];
    if (a?.value !== "no") continue;
    seen.add(item.id);
    const estado: NovedadState = a.estado === "cerrada" ? "cerrada" : "abierta";
    const fromTablet = draft ? { responsable: a.responsable ?? "", plazo: a.plazo ?? "", estado } : {};
    await IsmNovedad.updateOne(
      { record: record._id, itemId: item.id },
      {
        $set: {
          code: record.code,
          fileName: record.fileName,
          itemLabel: `${section.title} ${item.n}`,
          official: item.official,
          descripcion: a.descripcion ?? "",
          accion: a.accion ?? "",
          test: Boolean(record.test),
          ...fromTablet,
          ...(draft && estado === "cerrada" ? { closedAt: new Date() } : {}),
        },
        $setOnInsert: {
          createdBy: by,
          ...(draft ? {} : { responsable: a.responsable ?? "", plazo: a.plazo ?? "", estado }),
          history: [{ action: "creada", by, byName, at: new Date(), detail: "Desde el chequeo" }],
        },
      },
      { upsert: true },
    );
  }
  if (draft) {
    await IsmNovedad.updateMany(
      { record: record._id, itemId: { $nin: [...seen] }, estado: { $ne: "anulada" } },
      {
        $set: { estado: "anulada" },
        $push: { history: { action: "anulada", by, byName, at: new Date(), detail: "La respuesta ya no es «No»" } },
      },
    );
  }
}

/**
 * Compatibilidad: registros con novedades guardadas antes de la colección
 * (solo en sus respuestas) se pasan a la colección la primera vez que se
 * listan.
 */
export async function backfillNovedades() {
  const withNovedad = await IsmRecord.find({ schemaVersion: { $ne: null }, "flags.novedades": { $gt: 0 } }).select(
    "_id code schemaVersion answers status fileName test",
  );
  if (!withNovedad.length) return 0;
  const synced = new Set((await IsmNovedad.distinct("record")).map((id: Types.ObjectId) => id.toString()));
  let n = 0;
  for (const r of withNovedad) {
    if (synced.has(r._id.toString())) continue;
    await syncNovedades(r);
    n++;
  }
  return n;
}
