import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { IsmCrew } from "../models/ismCrew.model";
import { IsmRecord } from "../models/ismRecord.model";
import { ismArea } from "../services/ismAccess.service";
import { flowOf, pendingOrder, statusForOrder } from "../services/ismFlow.service";
import { hashContent, signatureIsValid } from "../services/ismSchema.service";
import { hashRecord } from "../services/ism.service";

/**
 * Datos para la especificación ISM del 25-nov-2026 (sección 12, «Antes de
 * activar»). NO se corre solo: vista previa por defecto, --apply guarda.
 * Idempotente. Lo que necesita a la PD (pruebas y borradores repetidos) solo
 * se lista, y se aplica con su bandera tras su revisión.
 *
 * 1. Área y «quién lo llena» de los registros de antes (los borradores pasan a ser del área).
 * 2. Estado según el orden de firmas de la hoja (p. ej. el R-09 del 8-nov que
 *    seguía en «Por firmar · Capitán» aunque el capitán firmó).
 * 3. Fichas genéricas «Jefe de Máquinas», «Timonel 1» y «Persona Designada
 *    (Oficina)» → inactivas (sus firmas quedan en el archivo).
 * 4. La Persona Designada figura en tierra.
 * 5. Pruebas: «PRUEBA IA» y los borradores del 29-oct → se listan; --mark-tests los marca.
 * 6. Borradores vacíos o repetidos → se listan; --discard-empty descarta los vacíos.
 *
 *   npx ts-node --transpile-only src/scripts/ism-spec-25nov.ts                     (vista previa)
 *   npx ts-node --transpile-only src/scripts/ism-spec-25nov.ts --apply
 *   npx ts-node --transpile-only src/scripts/ism-spec-25nov.ts --apply --mark-tests --discard-empty
 */

const GENERIC_NAMES = [/^jefe de m[aá]quinas$/i, /^timonel ?1$/i, /^persona designada \(oficina\)$/i];

async function main() {
  const apply = process.argv.includes("--apply");
  const markTests = process.argv.includes("--mark-tests");
  const discardEmpty = process.argv.includes("--discard-empty");
  await dbConnect();
  const log = (...a: unknown[]) => console.log("[ism-25nov]", ...a);
  log("base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"), apply ? "(GUARDA)" : "(vista previa)");

  // 1. Área y quién lo llena.
  const users = new Map((await User.find().select("name role position")).map((u) => [String(u._id), u]));
  const noArea = await IsmRecord.find({ $or: [{ area: { $in: [null, ""] } }, { area: { $exists: false } }] }).select("code createdBy filler fileName");
  log(`1. registros sin área: ${noArea.length}`);
  for (const r of noArea) {
    const u = users.get(String(r.createdBy));
    if (!u) continue;
    const set: Record<string, unknown> = { area: ismArea(u.role, u.position) };
    if (!r.filler) set.filler = { user: u._id, name: u.name, position: u.position ?? "" };
    if (apply) await IsmRecord.updateOne({ _id: r._id }, { $set: set });
  }

  // 2. Estado según el orden de firmas (solo formatos sin chequeo guiado y ya enviados).
  const open = await IsmRecord.find({ status: { $nin: ["borrador", "archivado"] }, schemaVersion: null });
  for (const r of open) {
    const flow = flowOf(r.code);
    if (!flow) continue;
    const current = hashContent(r);
    const signed = new Set(r.signatures.filter((s) => signatureIsValid(s, current)).map((s) => s.field));
    const next = statusForOrder(flow, pendingOrder(flow, r.data, signed));
    if (next === r.status) continue;
    log(`2. ${r.fileName}: ${r.status} → ${next}`);
    if (!apply) continue;
    const set: Record<string, unknown> = { status: next };
    if (next === "archivado") {
      set.archivedAt = new Date();
      set.contentHash = hashRecord(r);
    }
    // El PDF congelado se genera en la primera descarga (como con los archivados de antes).
    await IsmRecord.updateOne(
      { _id: r._id, status: r.status },
      { $set: set, $push: { history: { action: `estado corregido a ${next} (orden de firmas de la hoja)`, by: null, byName: "Sistema", at: new Date(), reason: "Especificación ISM 25-nov-2026", section: "" } } },
    );
  }

  // 3. Fichas genéricas.
  const generic = [...users.values()].filter((u) => GENERIC_NAMES.some((re) => re.test(u.name.trim())));
  for (const u of generic) {
    log(`3. ficha genérica → inactiva: ${u.name} (${u.role})`);
    if (apply) await User.updateOne({ _id: u._id }, { $set: { active: false } });
  }

  // 4. Persona Designada en tierra.
  const pds = [...users.values()].filter((u) => u.role === "designada");
  log(`4. Persona Designada en tierra: ${pds.map((u) => u.name).join(", ") || "—"}`);
  if (apply) await IsmCrew.updateMany({ user: { $in: pds.map((u) => u._id) } }, { $set: { onboard: false } });

  // 5. Pruebas (previa revisión de la PD).
  const tests = await IsmRecord.find({
    test: { $ne: true },
    $or: [
      { fileName: /PRUEBA IA/i },
      { title: /PRUEBA IA/i },
      { "context.place": /PRUEBA IA/i },
      { status: "borrador", createdAt: { $gte: new Date("2026-10-29T06:00:00Z"), $lt: new Date("2026-10-30T06:00:00Z") } },
    ],
  }).select("code fileName status createdAt");
  for (const r of tests) log(`5. prueba: ${r.fileName} (${r.status}, ${r.createdAt?.toISOString().slice(0, 10)})`);
  if (apply && markTests) {
    for (const r of tests) {
      await IsmRecord.updateOne(
        { _id: r._id },
        { $set: { test: true }, $push: { history: { action: "marcado como prueba", by: null, byName: "Sistema", at: new Date(), reason: "Limpieza 25-nov-2026, revisada por la PD", section: "" } } },
      );
    }
  }

  // 6. Borradores vacíos o repetidos (se listan; los vacíos se descartan con --discard-empty).
  const drafts = await IsmRecord.find({ status: "borrador", test: { $ne: true } }).select("code fileName data answers createdBy recordDate signatures");
  const seen = new Map<string, string>();
  for (const r of drafts) {
    const values = Object.values(r.data ?? {}).filter((v) => v !== "" && v !== false);
    const empty = values.length <= 3 && !Object.keys(r.answers ?? {}).length && !r.signatures.length;
    const key = `${r.code}|${String(r.createdBy)}|${r.recordDate?.toISOString().slice(0, 10)}`;
    if (empty) log(`6. borrador vacío: ${r.fileName}`);
    else if (seen.has(key)) log(`6. borrador repetido: ${r.fileName} (igual a ${seen.get(key)})`);
    seen.set(key, r.fileName);
    if (apply && discardEmpty && empty) await IsmRecord.deleteOne({ _id: r._id, status: "borrador" });
  }

  if (!apply) log("vista previa: agrega --apply para guardar");
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
