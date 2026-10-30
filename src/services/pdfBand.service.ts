import { PDFArray, PDFDocument, PDFName, PDFPage, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

/**
 * Franja de una hoja oficial (encabezado o pie) sin el resto de su texto
 * (auditoría 30-oct, punto 8). embedPages recorta lo que se ve, pero el
 * contenido completo de la hoja viaja oculto en el anexo: al copiar o
 * buscar texto aparecía la hoja oficial entera. Aquí se quitan del flujo de
 * contenido los bloques de texto (BT…ET) que caen fuera de la franja antes
 * de incrustarla.
 */

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 (convención de PDF: [a b c d e f]). */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

/**
 * Deja solo los bloques de texto cuyo origen (en coordenadas de la página)
 * cae entre yMin y yMax. Lo demás del contenido (líneas, imágenes) se
 * conserva: no es texto y el recorte de embedPages lo oculta.
 */
export function keepTextInBand(content: string, yMin: number, yMax: number): string {
  const drops: Array<[number, number]> = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [...IDENTITY];
  let operands: number[] = [];
  let inText = false;
  let textStart = 0;
  let tlm: Matrix = [...IDENTITY];
  let inside = true;
  let positioned = false;

  const mark = () => {
    const [x, y] = [tlm[4], tlm[5]];
    const pageY = x * ctm[1] + y * ctm[3] + ctm[5];
    positioned = true;
    if (pageY < yMin || pageY > yMax) inside = false;
  };

  const n = content.length;
  let i = 0;
  while (i < n) {
    const code = content.charCodeAt(i);
    const ch = content[i]!;
    if (WHITESPACE.has(code)) {
      i++;
      continue;
    }
    if (ch === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i++;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = content[i]!;
        if (c === "\\") i += 2;
        else {
          if (c === "(") depth++;
          else if (c === ")") depth--;
          i++;
        }
      }
      operands = [];
      continue;
    }
    if (ch === "<") {
      if (content[i + 1] === "<") {
        i += 2;
        continue;
      }
      const end = content.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      operands = [];
      continue;
    }
    if (ch === ">" || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      i++;
      continue;
    }
    if (ch === "/") {
      i++;
      while (i < n && !WHITESPACE.has(content.charCodeAt(i)) && !DELIMITERS.has(content[i]!)) i++;
      continue;
    }
    // Número u operador.
    const start = i;
    while (i < n && !WHITESPACE.has(content.charCodeAt(i)) && !DELIMITERS.has(content[i]!)) i++;
    const token = content.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push(Number(token));
      continue;
    }
    switch (token) {
      case "q":
        stack.push([...ctm]);
        break;
      case "Q":
        ctm = stack.pop() ?? [...IDENTITY];
        break;
      case "cm":
        if (operands.length >= 6) ctm = multiply(operands.slice(-6) as Matrix, ctm);
        break;
      case "BT":
        inText = true;
        textStart = start;
        tlm = [...IDENTITY];
        inside = true;
        positioned = false;
        break;
      case "Tm":
        if (inText && operands.length >= 6) {
          tlm = operands.slice(-6) as Matrix;
          mark();
        }
        break;
      case "Td":
      case "TD":
        if (inText && operands.length >= 2) {
          const [tx, ty] = operands.slice(-2) as [number, number];
          tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
          mark();
        }
        break;
      case "ET":
        if (inText && (!inside || !positioned)) drops.push([textStart, i]);
        inText = false;
        break;
      case "ID": {
        // Imagen en línea: sus bytes no son tokens; se salta hasta "EI".
        const end = content.slice(i).search(/\sEI(\s|$)/);
        i = end < 0 ? n : i + end + 3;
        break;
      }
      default:
        break;
    }
    operands = [];
  }

  if (!drops.length) return content;
  let out = "";
  let from = 0;
  for (const [a, b] of drops) {
    out += content.slice(from, a);
    from = b;
  }
  return out + content.slice(from);
}

function pageContent(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.get(PDFName.of("Contents"));
  if (!contents) return "";
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  let all = "";
  for (const ref of refs) {
    const stream = doc.context.lookup(ref as PDFRef);
    if (stream instanceof PDFRawStream) {
      all += Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") + "\n";
    }
  }
  return all;
}

/**
 * Carga la hoja oficial y devuelve su página con solo el texto de la franja
 * [yMin, yMax] (coordenadas PDF, desde abajo), lista para embedPage.
 */
export async function bandPage(templateBytes: Uint8Array, pageIndex: number, yMin: number, yMax: number) {
  const doc = await PDFDocument.load(templateBytes);
  const page = doc.getPage(pageIndex);
  const filtered = keepTextInBand(pageContent(doc, page), yMin, yMax);
  const stream = doc.context.flateStream(Buffer.from(filtered, "latin1"));
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  return page;
}
