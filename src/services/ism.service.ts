import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import { AnnotationFlags, PDFDocument, PDFPage, PDFSignature, StandardFonts, rgb } from "pdf-lib";
import { IIsmRecord } from "../models/ismRecord.model";
import { SignatureStage } from "../models/ismRecord.model";
import { IsmSchema, hashContent, ismSchema, schemaItems, signatureIsValid } from "./ismSchema.service";
import { POSITION_LABELS } from "../utils/roles";
import { appendGuidedAnnex } from "./ismAnnex.service";

/**
 * Definiciones de los registros ISM: se generan desde los PDF oficiales de
 * la compañía (tools/ism) y viven en assets/ism. El PDF final se arma
 * rellenando el mismo formato oficial, así el auditor recibe el documento
 * que ya conoce.
 */
export interface IsmFieldDef {
  name: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: "text" | "checkbox" | "radio" | "signature" | "photo";
  multiline?: boolean;
  fontSize?: number;
  default?: string | boolean;
  /** Dato conocido que se muestra como referencia (p. ej. caducidades del R-28); no es respuesta. */
  reference?: string;
  maxLength?: number;
  onValue?: string;
  stage?: SignatureStage;
  label?: string;
}

export interface IsmFormDef {
  code: string;
  title: string;
  group: string;
  frequency: string;
  officeOnly: boolean;
  stages: Record<SignatureStage, number>;
  pages: Array<{ width: number; height: number }>;
  fields: IsmFieldDef[];
  equipmentFields?: Record<"name" | "brand" | "model" | "serial" | "owner", string>;
}

export interface IsmCatalogItem {
  code: string;
  title: string;
  group: string;
  frequency: string;
  officeOnly: boolean;
  pages: number;
  fieldCount: number;
  stages: Record<SignatureStage, number>;
}

export interface IsmEquipment {
  category: string;
  folder: string;
  name: string;
  brand: string;
  model: string;
  serial: string;
  owner: string;
}

const ASSETS = path.join(process.cwd(), "assets", "ism");

let catalogCache: IsmCatalogItem[] | null = null;
let equipmentCache: IsmEquipment[] | null = null;
const defCache = new Map<string, IsmFormDef>();

export function ismCatalog(): IsmCatalogItem[] {
  if (!catalogCache) {
    catalogCache = JSON.parse(fs.readFileSync(path.join(ASSETS, "catalog.json"), "utf8"));
  }
  return catalogCache!;
}

export function ismEquipment(): IsmEquipment[] {
  if (!equipmentCache) {
    equipmentCache = JSON.parse(fs.readFileSync(path.join(ASSETS, "equipment.json"), "utf8"));
  }
  return equipmentCache!;
}

export interface IsmVessel {
  id: string;
  name: string;
  default?: boolean;
}

let vesselsCache: IsmVessel[] | null = null;

/** Embarcaciones (datos maestros en assets/ism/master.json, no en el código). */
export function ismVessels(): IsmVessel[] {
  if (!vesselsCache) {
    const file = path.join(ASSETS, "master.json");
    vesselsCache = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).vessels ?? []) : [];
  }
  return vesselsCache!;
}

export function defaultVessel(): IsmVessel | null {
  const list = ismVessels();
  return list.find((v) => v.default) ?? list[0] ?? null;
}

export function ismDefinition(code: string): IsmFormDef | null {
  if (!/^R-\d{2}(_[A-Za-z]+)?$/.test(code)) return null;
  if (!defCache.has(code)) {
    const file = path.join(ASSETS, "defs", `${code}.json`);
    if (!fs.existsSync(file)) return null;
    defCache.set(code, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return defCache.get(code)!;
}

// ---- Fechas en hora de Galápagos (UTC−6, sin horario de verano) ----

const GALAPAGOS_OFFSET_MS = 6 * 60 * 60 * 1000;

export function galapagosParts(date: Date = new Date()) {
  const local = new Date(date.getTime() - GALAPAGOS_OFFSET_MS);
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth() + 1,
    d: local.getUTCDate(),
    hh: local.getUTCHours(),
    mm: local.getUTCMinutes(),
  };
}

/**
 * Fecha del registro en Galápagos. Con hora ('HH:MM'), la hora real de la
 * actividad (informe 29-oct: antes todos quedaban a las 18:00 UTC); sin
 * hora, mediodía, para no cambiar de día por la zona.
 */
export function recordDateFromKey(key: string, time?: string | null): Date {
  const hhmm = time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "12:00";
  return new Date(`${key}T${hhmm}:00-06:00`);
}

/** 'YYYY-MM-DD' real del calendario (rechaza 2026-02-31 o textos). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function monthRangeGalapagos(date: Date = new Date()) {
  const { y, m } = galapagosParts(date);
  const start = new Date(Date.UTC(y, m - 1, 1, 6, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 6, 0, 0));
  return { start, end, y, m };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Nombre único y uniforme para todos (mejora 3 de su propio documento):
 * R-xx_AAAAMMDD_HHMM_<cargo o equipo>.pdf
 */
export function buildFileName(
  code: string,
  recordDate: Date,
  createdAt: Date,
  suffix?: string,
): string {
  const d = galapagosParts(recordDate);
  const t = galapagosParts(createdAt);
  const base = `${code}_${d.y}${pad(d.m)}${pad(d.d)}_${pad(t.hh)}${pad(t.mm)}`;
  const clean = suffix?.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base}${clean ? `_${clean}` : ""}.pdf`;
}

/**
 * Nombre del PDF de un registro guiado: R-14_AAAAMMDD_HHMM.pdf con la fecha y
 * hora de la actividad (no las de creación del borrador).
 */
export function activityFileName(code: string, dateKey: string, time: string): string {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time.replace(":", "") : "0000";
  return `${code}_${dateKey.replace(/-/g, "")}_${hhmm}.pdf`;
}

/** Si otro registro ya tiene el nombre, se agrega _2, _3… */
export async function uniqueFileName(
  base: string,
  taken: (name: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;
  const stem = base.replace(/\.pdf$/, "");
  for (let n = 2; n < 100; n++) {
    const name = `${stem}_${n}.pdf`;
    if (!(await taken(name))) return name;
  }
  return `${stem}_${Date.now()}.pdf`;
}

/** Fecha y hora para el PDF: "29/10/2026 21:28" (hora Galápagos). */
export function pdfStamp(date: Date): string {
  const t = galapagosParts(date);
  return `${pad(t.d)}/${pad(t.m)}/${t.y} ${pad(t.hh)}:${pad(t.mm)}`;
}

/** Huella del archivo: contenido (datos, respuestas, contexto) + firmas existentes. */
export function hashRecord(
  record: Pick<IIsmRecord, "code" | "data" | "signatures" | "recordDate" | "answers" | "context">,
) {
  const payload = JSON.stringify({
    code: record.code,
    recordDate: new Date(record.recordDate).toISOString(),
    data: Object.keys(record.data ?? {})
      .sort()
      .map((k) => [k, record.data[k]]),
    content: hashContent(record),
    signatures: (record.signatures ?? []).map((s) => [s.field, s.signerName, s.signedAt, s.image.length]),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ---- PDF oficial ----

/**
 * Texto de la casilla OBS: con una novedad, su resumen; con varias, cuántas
 * y "ver página anexa". Sin novedades pero con puntos que no aplican, se
 * remite al anexo igual.
 */
export function obsText(schema: IsmSchema, record: Pick<IIsmRecord, "answers">): string[] {
  const novedades = schemaItems(schema).filter(({ item }) => {
    const a = record.answers?.[item.id];
    return a?.value === "no" || Boolean(a?.problem);
  });
  const noAplica = schemaItems(schema).filter(({ item }) => record.answers?.[item.id]?.value === "na").length;
  if (novedades.length === 1) {
    const { section, item } = novedades[0]!;
    const a = record.answers[item.id]!;
    const summary = `${section.title} ${item.n}: ${a.descripcion || item.official}${a.accion ? ` (acción: ${a.accion})` : ""}`;
    // Si el resumen no cabe en la casilla, queda solo la remisión al anexo.
    return [`1 novedad: ${summary.replace(/\s+/g, " ")}. Ver página anexa`, "1 novedad: ver página anexa"];
  }
  if (novedades.length > 1) return [`${novedades.length} novedades: ver página anexa`];
  if (noAplica) return [`Sin novedades. ${noAplica === 1 ? "1 punto no aplica" : `${noAplica} puntos no aplican`}: ver página anexa`];
  return [];
}

/** Texto compatible con la fuente estándar del PDF (WinAnsi). */
function winAnsi(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

function rectOn(page: PDFPage, f: IsmFieldDef) {
  const { width, height } = page.getSize();
  return {
    x: f.x * width,
    y: height - (f.y + f.h) * height,
    w: f.w * width,
    h: f.h * height,
  };
}

async function imageBytes(src: string): Promise<{ bytes: Uint8Array; png: boolean } | null> {
  try {
    if (src.startsWith("data:")) {
      const [meta, b64] = src.split(",");
      return { bytes: Buffer.from(b64!, "base64"), png: meta!.includes("png") };
    }
    const { data, headers } = await axios.get<ArrayBuffer>(src, { responseType: "arraybuffer", timeout: 10000 });
    return { bytes: new Uint8Array(data), png: String(headers["content-type"]).includes("png") };
  } catch {
    return null;
  }
}

/**
 * Rellena el formato oficial con los datos y dibuja las firmas y fotos en
 * sus recuadros. Archivado: se aplana (no editable). Si aún no está
 * archivado, se marca como borrador.
 */
export async function renderRecordPdf(record: IIsmRecord): Promise<Uint8Array> {
  const def = ismDefinition(record.code);
  if (!def) throw new Error(`Formulario desconocido: ${record.code}`);

  const template = fs.readFileSync(path.join(ASSETS, "templates", `${record.code}.pdf`));
  const pdf = await PDFDocument.load(template);
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const currentHash = hashContent(record);

  for (const f of def.fields) {
    const value = record.data?.[f.name];
    try {
      if (f.type === "text") {
        const field = form.getTextField(f.name);
        const text = typeof value === "string" ? winAnsi(value) : "";
        if (f.maxLength) field.setMaxLength(Math.max(f.maxLength, text.length));
        field.setText(text);
      } else if (f.type === "checkbox") {
        const box = form.getCheckBox(f.name);
        if (value === true) box.check();
        else box.uncheck();
      }
    } catch {
      // Un campo que no se puede escribir no detiene el documento.
    }
  }

  // Los recuadros de firma del formato se reemplazan por la firma dibujada
  // (si no, los visores muestran su marca "SIGN").
  // Se ocultan y se sacan del formulario sin borrarlos: borrar sus objetos
  // (removeField o flatten) deja referencias rotas en el PDF archivado.
  for (const field of form.getFields()) {
    if (!(field instanceof PDFSignature)) continue;
    try {
      for (const widget of field.acroField.getWidgets()) {
        widget.setFlagTo(AnnotationFlags.Hidden, true);
        widget.setFlagTo(AnnotationFlags.Print, false);
      }
      form.acroForm.removeField(field.acroField);
    } catch {
      // Se deja como está.
    }
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    // Algunos formatos traen apariencias propias; se respetan.
  }

  // Firmas dibujadas con el dedo, en su recuadro.
  for (const sig of record.signatures ?? []) {
    // Una firma hecha antes de que cambiaran los datos ya no vale.
    if (!signatureIsValid(sig, currentHash)) continue;
    const f = def.fields.find((x) => x.name === sig.field);
    const page = f ? pages[f.page] : undefined;
    if (!f || !page) continue;
    const img = await imageBytes(sig.image);
    if (!img) continue;
    const embedded = img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
    const r = rectOn(page, f);
    const scale = Math.min((r.w - 4) / embedded.width, (r.h - 10) / embedded.height);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawImage(embedded, { x: r.x + (r.w - w) / 2, y: r.y + 8 + (r.h - 10 - h) / 2, width: w, height: h });
    // "[Nombre] · Timonel 1 · 29/10/2026 21:31" (nombre, cargo y hora del momento de firmar).
    // Cargo del momento; Capitán y Persona Designada sin cargo de a bordo llevan el de su casilla.
    const position = sig.position
      ? POSITION_LABELS[sig.position as keyof typeof POSITION_LABELS] ?? sig.position
      : sig.stage !== "tripulacion"
        ? sig.label
        : "";
    const stamp = winAnsi([sig.signerName, position, pdfStamp(new Date(sig.signedAt))].filter(Boolean).join(" · "));
    let size = 5.5;
    while (size > 4 && font.widthOfTextAtSize(stamp, size) > r.w - 4) size -= 0.25;
    page.drawText(stamp, { x: r.x + 2, y: r.y + 1.5, size, font, color: rgb(0.25, 0.3, 0.28) });
  }

  // Fotos de soporte (anexo del R-18).
  for (const f of def.fields.filter((x) => x.type === "photo")) {
    const url = record.data?.[f.name];
    const page = pages[f.page];
    if (typeof url !== "string" || !url || !page) continue;
    const img = await imageBytes(url);
    if (!img) continue;
    const embedded = img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
    const r = rectOn(page, f);
    const scale = Math.min(r.w / embedded.width, r.h / embedded.height);
    const w = embedded.width * scale;
    const h = embedded.height * scale;
    page.drawImage(embedded, { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, width: w, height: h });
  }

  // Registros guiados: casilla OBS con el resumen y página anexa con novedades,
  // "no aplica" y quien hizo el chequeo.
  const schema = record.schemaVersion ? ismSchema(record.code, record.schemaVersion) : null;
  if (schema?.obs && pages[schema.obs.page]) {
    const page = pages[schema.obs.page]!;
    const { width, height } = page.getSize();
    const box = {
      x: schema.obs.x * width,
      y: height - (schema.obs.y + schema.obs.h) * height,
      w: schema.obs.w * width,
      h: schema.obs.h * height,
    };
    const options = obsText(schema, record).map(winAnsi);
    for (const [i, text] of options.entries()) {
      let size = 8;
      while (size > 6 && font.widthOfTextAtSize(text, size) > box.w) size -= 0.25;
      if (font.widthOfTextAtSize(text, size) > box.w && i < options.length - 1) continue;
      page.drawText(text, { x: box.x, y: box.y + (box.h - size) / 2 + 1, size, font, color: rgb(0.06, 0.08, 0.1) });
      break;
    }
  }
  if (schema) {
    await appendGuidedAnnex(pdf, template, schema, record, {
      font,
      bold,
      safe: winAnsi,
      loadImage: imageBytes,
      stamp: pdfStamp,
    });
  }

  if (record.status === "archivado") {
    try {
      form.flatten();
    } catch {
      for (const field of form.getFields()) field.enableReadOnly();
    }
  } else {
    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      page.drawText("BORRADOR · REGISTRO AÚN NO ARCHIVADO", {
        x: width / 2 - 120,
        y: height - 14,
        size: 9,
        font,
        color: rgb(0.7, 0.3, 0.2),
      });
    }
  }

  pdf.setTitle(record.fileName);
  pdf.setProducer("Treasure of Galápagos · Registros ISM");
  return pdf.save();
}
