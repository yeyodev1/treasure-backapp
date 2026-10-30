import crypto from "crypto";
import mongoose, { Types } from "mongoose";
import { IIsmArchivedPdf, IIsmRecord, IsmRecord } from "../models/ismRecord.model";
import { renderRecordPdf } from "./ism.service";

/**
 * PDF archivado congelado (auditoría 30-oct, punto 3). Al archivar se genera
 * el PDF una sola vez, se guarda en Mongo (GridFS, bucket "ismPdf") con su
 * sha256 y desde entonces se sirve siempre ese archivo: aunque cambie el
 * código, la plantilla o la fuente, el auditor recibe los mismos bytes.
 * Los registros archivados antes de este cambio se congelan en su primera
 * descarga.
 */
const BUCKET = "ismPdf";

function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Sin conexión a la base");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function upload(bytes: Uint8Array, fileName: string, recordId: Types.ObjectId, hash: string) {
  return new Promise<Types.ObjectId>((resolve, reject) => {
    const stream = bucket().openUploadStream(fileName, {
      metadata: { record: recordId, sha256: hash, contentType: "application/pdf" },
    });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id as Types.ObjectId));
    stream.end(Buffer.from(bytes));
  });
}

async function download(fileId: Types.ObjectId): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    bucket()
      .openDownloadStream(fileId)
      .on("data", (c: Buffer) => chunks.push(c))
      .once("error", reject)
      .once("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Genera y guarda el PDF del registro archivado si aún no lo tiene. Si dos
 * descargas llegan a la vez, gana la primera y el otro archivo se borra.
 */
export async function freezeArchivedPdf(
  record: IIsmRecord & { _id: Types.ObjectId },
): Promise<IIsmArchivedPdf> {
  if (record.status !== "archivado") throw new Error("Solo se congela un registro archivado");
  if (record.archivedPdf?.fileId) return record.archivedPdf;
  const bytes = await renderRecordPdf(record);
  const hash = sha256(bytes);
  const fileId = await upload(bytes, record.fileName, record._id, hash);
  const frozen: IIsmArchivedPdf = { fileId, sha256: hash, size: bytes.length, generatedAt: new Date() };
  const res = await IsmRecord.updateOne(
    { _id: record._id, status: "archivado", archivedPdf: null },
    { $set: { archivedPdf: frozen } },
  );
  if (res.modifiedCount === 1) {
    record.archivedPdf = frozen;
    return frozen;
  }
  // Otra descarga lo congeló primero: se usa ese y se borra el nuestro.
  await bucket().delete(fileId).catch(() => undefined);
  const winner = await IsmRecord.findById(record._id).select("archivedPdf");
  if (!winner?.archivedPdf?.fileId) throw new Error("No se pudo congelar el PDF archivado");
  record.archivedPdf = winner.archivedPdf;
  return winner.archivedPdf;
}

/** Bytes del PDF congelado; si no coinciden con su sha256, no se sirven. */
export async function readArchivedPdf(frozen: IIsmArchivedPdf): Promise<Buffer> {
  const bytes = await download(new Types.ObjectId(frozen.fileId.toString()));
  if (sha256(bytes) !== frozen.sha256) {
    throw new Error("El PDF archivado no coincide con su huella sha256");
  }
  return bytes;
}

/** Congela sin detener la operación (al archivar): si falla, se hace en la primera descarga. */
export async function tryFreezeArchivedPdf(record: IIsmRecord & { _id: Types.ObjectId }) {
  try {
    await freezeArchivedPdf(record);
  } catch (err) {
    console.error("[ism] No se pudo congelar el PDF al archivar; se hará en la primera descarga", err);
  }
}
