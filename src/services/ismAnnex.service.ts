import { PDFDocument, PDFEmbeddedPage, PDFFont, PDFPage, rgb } from "pdf-lib";
import { IIsmRecord } from "../models/ismRecord.model";
import { IsmSchema, hashContent, schemaItems, signatureIsValid } from "./ismSchema.service";
import { POSITION_LABELS } from "../utils/roles";

/**
 * Página anexa de los registros guiados. El formato oficial del R-14 no
 * tiene campo de observaciones, así que las novedades, los "no aplica" y la
 * identidad de quien llenó van en una página con el mismo encabezado y pie
 * del formato (se recortan del PDF oficial para conservar su estilo).
 */

const INK = rgb(0.06, 0.08, 0.1);
const MUTED = rgb(0.32, 0.36, 0.34);
const LINE = rgb(0.1, 0.1, 0.1);
const SHADE = rgb(0.93, 0.93, 0.93);

// Franja del encabezado y del pie en la hoja oficial (fracción de la altura, desde arriba).
const HEADER_BAND = { top: 0.02, bottom: 0.108 };
const FOOTER_BAND = { top: 0.951, bottom: 0.98 };

const MARGIN_X = 0.06;

export interface AnnexImage {
  bytes: Uint8Array;
  png: boolean;
}

export interface AnnexOptions {
  font: PDFFont;
  bold: PDFFont;
  /** Texto apto para la fuente estándar (WinAnsi). */
  safe: (text: string) => string;
  loadImage: (url: string) => Promise<AnnexImage | null>;
  stamp: (date: Date) => string;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Palabras más largas que la columna se cortan.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

export async function appendGuidedAnnex(
  pdf: PDFDocument,
  templateBytes: Uint8Array,
  schema: IsmSchema,
  record: IIsmRecord,
  opts: AnnexOptions,
): Promise<number> {
  const { font, bold, safe } = opts;
  const source = await PDFDocument.load(templateBytes);
  const sourcePage = source.getPage(0);
  const { width: W, height: H } = sourcePage.getSize();

  const [header, footer] = await pdf.embedPages(
    [sourcePage, sourcePage],
    [
      { left: 0, right: W, top: H * (1 - HEADER_BAND.top), bottom: H * (1 - HEADER_BAND.bottom) },
      { left: 0, right: W, top: H * (1 - FOOTER_BAND.top), bottom: H * (1 - FOOTER_BAND.bottom) },
    ],
  );

  const left = W * MARGIN_X;
  const right = W * (1 - MARGIN_X);
  const contentW = right - left;
  const bottomLimit = H * (1 - FOOTER_BAND.top) + 14;

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const drawBand = (p: PDFPage, band: PDFEmbeddedPage, frac: { top: number; bottom: number }) => {
    p.drawPage(band, { x: 0, y: H * (1 - frac.bottom), width: W, height: H * (frac.bottom - frac.top) });
  };

  const ctx = record.context;
  const fmtDate = (key?: string) => {
    const [yy, mm, dd] = (key ?? "").split("-");
    return yy && mm && dd ? `${dd}/${mm}/${yy}` : "-";
  };

  function newPage() {
    page = pdf.addPage([W, H]);
    pages.push(page);
    drawBand(page, header, HEADER_BAND);
    drawBand(page, footer, FOOTER_BAND);
    y = H * (1 - HEADER_BAND.bottom) - 22;
    const title = safe(`${schema.officialTitle.toUpperCase()}`);
    const size = 11.5;
    page.drawText(title, {
      x: Math.max(left, (W - bold.widthOfTextAtSize(title, size)) / 2),
      y,
      size,
      font: bold,
      color: INK,
    });
    y -= 16;
    const sub = safe("ANEXO: QUIEN HIZO EL CHEQUEO, NOVEDADES Y PUNTOS QUE NO APLICAN");
    page.drawText(sub, { x: (W - bold.widthOfTextAtSize(sub, 9)) / 2, y, size: 9, font: bold, color: MUTED });
    y -= 14;

    // Fila de contexto, como la fila Fecha / Hora / Lugar del formato.
    const cells: Array<[string, string, number]> = [
      ["Embarcación:", ctx?.vessel || schema.vessel, 0.4],
      ["Fecha:", fmtDate(ctx?.activityDate), 0.2],
      ["Hora:", ctx?.activityTime || "-", 0.14],
      ["Lugar:", ctx?.place || "-", 0.26],
    ];
    const rowH = 18;
    let x = left;
    for (const [label, value, frac] of cells) {
      const w = contentW * frac;
      page.drawRectangle({ x, y: y - rowH, width: w, height: rowH, borderColor: LINE, borderWidth: 0.8 });
      page.drawText(safe(label), { x: x + 4, y: y - 12.5, size: 9, font: bold, color: INK });
      const lw = bold.widthOfTextAtSize(safe(label), 9);
      const text = safe(value);
      let vs = 9;
      while (vs > 6 && font.widthOfTextAtSize(text, vs) > w - lw - 12) vs -= 0.5;
      page.drawText(text, { x: x + lw + 8, y: y - 12.5, size: vs, font, color: INK });
      x += w;
    }
    y -= rowH + 4;

    // Cada sección guarda su propia hora (la ronda, el zarpe, el arribo y el fondeo).
    const times = schema.sections
      .filter((sec) => ctx?.sectionTimes?.[sec.id])
      .map((sec) => `${sec.title} ${ctx!.sectionTimes![sec.id]}`);
    if (times.length) {
      for (const line of wrap(safe(`Hora de cada sección: ${times.join(" · ")}`), font, 8, contentW)) {
        page.drawText(line, { x: left, y: y - 9, size: 8, font, color: MUTED });
        y -= 11;
      }
    }
    y -= 10;
  }

  function ensure(height: number) {
    if (y - height < bottomLimit) newPage();
  }

  function sectionTitle(text: string) {
    ensure(40);
    page.drawRectangle({ x: left, y: y - 16, width: contentW, height: 16, color: SHADE, borderColor: LINE, borderWidth: 0.8 });
    page.drawText(safe(text), { x: left + 5, y: y - 11.5, size: 9.5, font: bold, color: INK });
    y -= 16;
  }

  /** Tabla con columnas de ancho fijo; las filas crecen con el texto y nunca se cortan. */
  function table(columns: Array<{ title: string; frac: number }>, rows: string[][]) {
    const size = 8.5;
    const lead = 10.5;
    const widths = columns.map((c) => contentW * c.frac);
    const drawHead = () => {
      let x = left;
      columns.forEach((c, i) => {
        page.drawRectangle({ x, y: y - 14, width: widths[i]!, height: 14, borderColor: LINE, borderWidth: 0.6 });
        page.drawText(safe(c.title), { x: x + 4, y: y - 10, size: 8, font: bold, color: INK });
        x += widths[i]!;
      });
      y -= 14;
    };
    drawHead();
    for (const row of rows) {
      const wrapped = row.map((cell, i) => wrap(safe(cell), font, size, widths[i]! - 8));
      const lines = Math.max(...wrapped.map((l) => l.length));
      let start = 0;
      // Una fila muy larga se reparte entre páginas sin perder texto.
      while (start < lines) {
        const room = Math.floor((y - bottomLimit - 6) / lead);
        if (room < 2) {
          newPage();
          drawHead();
          continue;
        }
        const take = Math.min(room, lines - start);
        const h = take * lead + 6;
        let x = left;
        wrapped.forEach((cellLines, i) => {
          page.drawRectangle({ x, y: y - h, width: widths[i]!, height: h, borderColor: LINE, borderWidth: 0.6 });
          cellLines.slice(start, start + take).forEach((line, li) => {
            page.drawText(line, { x: x + 4, y: y - 9.5 - li * lead, size, font, color: INK });
          });
          x += widths[i]!;
        });
        y -= h;
        start += take;
        if (start < lines) {
          newPage();
          drawHead();
        }
      }
    }
    y -= 12;
  }

  function paragraph(text: string, size = 8.5, f: PDFFont = font, color = INK) {
    for (const line of wrap(safe(text), f, size, contentW)) {
      ensure(12);
      page.drawText(line, { x: left, y: y - size, size, font: f, color });
      y -= size + 3;
    }
  }

  newPage();

  // Quien hizo el chequeo: la hoja oficial no tiene casilla para su firma
  // (decisión 3 del piloto), así que firma aquí con nombre, cargo y hora.
  sectionTitle("QUIEN HIZO EL CHEQUEO");
  y -= 6;
  const fb = ctx?.filledBy;
  const label = (code?: string) => (code ? (POSITION_LABELS[code as keyof typeof POSITION_LABELS] ?? code) : "");
  const step = schema.signers?.find((s) => s.print === "anexo");
  const current = hashContent(record);
  const crewSig = step
    ? record.signatures?.find((s) => s.field === step.field && signatureIsValid(s, current))
    : undefined;
  const boxW = Math.min(220, contentW * 0.45);
  const boxH = 64;
  ensure(boxH + 30);
  page.drawRectangle({ x: left, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.6 });
  const img = crewSig ? await opts.loadImage(crewSig.image) : null;
  if (img) {
    try {
      const embedded = img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
      const scale = Math.min((boxW - 10) / embedded.width, (boxH - 10) / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, { x: left + (boxW - w) / 2, y: y - boxH + (boxH - h) / 2, width: w, height: h });
    } catch {
      // Sin imagen: quedan nombre, cargo y hora.
    }
  } else {
    page.drawText(safe("Pendiente de firma"), { x: left + 8, y: y - boxH / 2 - 3, size: 8.5, font, color: MUTED });
  }
  const who = crewSig
    ? [crewSig.signerName, label(crewSig.position) || label(fb?.position), opts.stamp(new Date(crewSig.signedAt))]
    : [fb?.name || "-", label(fb?.position)];
  const textX = left + boxW + 12;
  page.drawText(safe(who.filter(Boolean).join(" · ")), { x: textX, y: y - 16, size: 9.5, font: bold, color: INK });
  page.drawText(safe("Firma con el dedo, confirmada con su clave de 4 números."), {
    x: textX,
    y: y - 30,
    size: 8,
    font,
    color: MUTED,
  });
  if (crewSig?.capturedByName) {
    page.drawText(safe(`Tablet con la sesión de: ${crewSig.capturedByName}`), { x: textX, y: y - 42, size: 8, font, color: MUTED });
  }
  y -= boxH + 12;
  // Claves restablecidas en las 24 h previas a una firma (auditoría 30-oct, punto 2).
  for (const sig of (record.signatures ?? []).filter((s) => s.pinResetAt && signatureIsValid(s, current))) {
    paragraph(
      `${sig.label} (${sig.signerName}): clave restablecida el ${opts.stamp(new Date(sig.pinResetAt!))}${sig.pinResetByName ? ` por ${sig.pinResetByName}` : ""}, en las 24 h previas a la firma.`,
      8.5,
      bold,
    );
  }
  const answeredAt = Object.values(record.answers ?? {})
    .map((a) => (a?.at ? new Date(a.at).getTime() : 0))
    .filter(Boolean);
  const lines = [
    answeredAt.length
      ? `Captura de respuestas: ${opts.stamp(new Date(Math.min(...answeredAt)))} a ${opts.stamp(new Date(Math.max(...answeredAt)))}`
      : "Captura de respuestas: -",
    `Enviado al Capitán: ${record.submittedAt ? opts.stamp(new Date(record.submittedAt)) : "aún no enviado"}`,
    `Esquema de preguntas: ${schema.code} v${schema.version} · Formato ${record.formEdition || schema.templateEdition}`,
  ];
  for (const l of lines) paragraph(l);
  y -= 6;
  paragraph(schema.notice, 8.5, bold);
  y -= 12;


  const novedades: string[][] = [];
  const noAplica: string[][] = [];
  const evidence: Array<{ label: string; url: string }> = [];
  for (const { section, item } of schemaItems(schema)) {
    const a = record.answers?.[item.id];
    if (!a?.value) continue;
    const ref = `${section.title} · ${item.n}`;
    if (a.value === "no" || a.problem) {
      const estado = a.estado === "cerrada" ? "Cerrada" : "Abierta";
      const plazo = a.plazo ? fmtDate(a.plazo) : "";
      novedades.push([
        ref,
        item.official,
        `${a.value === "no" ? "" : "(SI, con novedad) "}${a.descripcion || "-"}`,
        a.accion || "-",
        [a.responsable ? `Responsable: ${a.responsable}` : "", plazo ? `Plazo: ${plazo}` : "", `Estado: ${estado}`]
          .filter(Boolean)
          .join("\n"),
      ]);
      (a.evidencia ?? []).forEach((url, i) => evidence.push({ label: `${ref} · foto ${i + 1}`, url }));
    } else if (a.value === "na") {
      noAplica.push([ref, item.official, a.motivo || "-"]);
    }
  }

  sectionTitle(`NOVEDADES (${novedades.length})`);
  if (novedades.length) {
    table(
      [
        { title: "Ítem", frac: 0.13 },
        { title: "Punto revisado", frac: 0.25 },
        { title: "Qué se encontró", frac: 0.22 },
        { title: "Acción tomada", frac: 0.21 },
        { title: "Seguimiento", frac: 0.19 },
      ],
      novedades,
    );
  } else {
    y -= 4;
    paragraph("Sin novedades registradas en este chequeo.");
    y -= 8;
  }

  sectionTitle(`PUNTOS QUE NO APLICAN (${noAplica.length})`);
  if (noAplica.length) {
    table(
      [
        { title: "Ítem", frac: 0.18 },
        { title: "Punto", frac: 0.42 },
        { title: "Motivo", frac: 0.4 },
      ],
      noAplica,
    );
  } else {
    y -= 4;
    paragraph("Todos los puntos tienen respuesta SI o NO.");
    y -= 8;
  }

  if (evidence.length) {
    sectionTitle(`EVIDENCIA FOTOGRÁFICA (${evidence.length})`);
    y -= 6;
    const boxW = (contentW - 16) / 3;
    const boxH = boxW * 0.72;
    let col = 0;
    for (const ev of evidence) {
      if (col === 0) ensure(boxH + 22);
      const x = left + col * (boxW + 8);
      const img = await opts.loadImage(ev.url);
      page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.5 });
      if (img) {
        try {
          const embedded = img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
          const scale = Math.min((boxW - 4) / embedded.width, (boxH - 4) / embedded.height);
          const w = embedded.width * scale;
          const h = embedded.height * scale;
          page.drawImage(embedded, { x: x + (boxW - w) / 2, y: y - boxH + (boxH - h) / 2, width: w, height: h });
        } catch {
          page.drawText("Imagen no disponible", { x: x + 6, y: y - boxH / 2, size: 8, font, color: MUTED });
        }
      } else {
        page.drawText("Imagen no disponible", { x: x + 6, y: y - boxH / 2, size: 8, font, color: MUTED });
      }
      page.drawText(safe(ev.label).slice(0, 60), { x, y: y - boxH - 10, size: 7, font, color: MUTED });
      col++;
      if (col === 3) {
        col = 0;
        y -= boxH + 18;
      }
    }
    if (col) y -= boxH + 18;
    y -= 4;
  }

  return pages.length;
}
