import assert from "assert";
import fs from "fs";
import path from "path";
import {
  FLOWS,
  fieldsToAnnul,
  missingLines,
  offlineSignedAt,
  pendingOrder,
  rowBelongsTo,
  statusAfterFill,
  statusForOrder,
} from "../services/ismFlow.service";
import { LAND_CODES, SENSITIVE_CODES, canCreateForm, canEditData, canViewRecord, ismArea } from "../services/ismAccess.service";
import { DEFAULT_RULES, countsFrom, dueState, equipmentDue, periodOf } from "../services/ismFrequency.service";
import { extendWeek, gapsOf, relevosOf, turnsOn } from "../services/ismRotation.service";
import { validateSigners } from "../services/ismSchema.service";
import { transitionProfile } from "../services/ismCrew.service";

/**
 * Autoverificación de la especificación ISM del 25-nov-2026 (sin base):
 *   npx ts-node --transpile-only src/scripts/check-ism-flow.ts
 */
const S = (...f: string[]) => new Set(f);
const SF = (n: number) => `Signature Field ${n}`;
let checks = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  checks++;
};

// --- Las firmas de cada flujo existen en la hoja oficial (salvo las virtuales) ---
for (const [code, flow] of Object.entries(FLOWS)) {
  const def = JSON.parse(fs.readFileSync(path.join(process.cwd(), "assets", "ism", "defs", `${code}.json`), "utf8"));
  const sigs = new Set(def.fields.filter((f: { type: string }) => f.type === "signature").map((f: { name: string }) => f.name));
  for (const step of flow.steps) for (const f of step.fields) ok(step.virtual || sigs.has(f), `${code}: ${f} no está en la hoja`);
  ok(flow.steps.every((s, i) => i === 0 || s.order >= flow.steps[i - 1]!.order), `${code}: pasos en orden`);
}

// --- Criterio 2: R-08/R-09, quien reporta no firma; pasa a Capitán, Capitán y PD ---
const r09 = FLOWS["R-09"]!;
ok(statusAfterFill(r09, {}, S()) === "por_capitan", "R-09 enviado va al Capitán");
ok(statusForOrder(r09, pendingOrder(r09, {}, S(SF(8)))) === "por_capitan", "R-09: falta la acción correctiva del Capitán");
ok(statusForOrder(r09, pendingOrder(r09, {}, S(SF(8), SF(11)))) === "por_oficina", "R-09: luego la PD");
// Criterio 4: con la última firma se archiva.
ok(statusForOrder(r09, pendingOrder(r09, {}, S(SF(8), SF(11), SF(10)))) === "archivado", "R-09: última firma archiva");

// R-05: tripulante familiarizado → Capitán → PD.
const r05 = FLOWS["R-05"]!;
ok(pendingOrder(r05, {}, S(), (s) => Boolean(s.atFill)) === 1, "R-05: falta el tripulante al llenar");
ok(statusAfterFill(r05, {}, S(SF(4))) === "por_capitan", "R-05: al Capitán");

// R-11: los tres gerentes a la vez, luego la PD.
const r11 = FLOWS["R-11"]!;
ok(statusAfterFill(r11, {}, S()) === "por_gerencia", "R-11: primero Gerencia");
ok(statusForOrder(r11, pendingOrder(r11, {}, S(SF(12), SF(17)))) === "por_gerencia", "R-11: falta Paula");
ok(statusForOrder(r11, pendingOrder(r11, {}, S(SF(12), SF(17), SF(18)))) === "por_oficina", "R-11: luego la PD");

// R-30: filas de los tripulantes (las que tienen nombre) → PD → José.
const r30 = FLOWS["R-30"]!;
const rows30 = { "Text Field 1093": "Marinero Juan Pérez", "Text Field 1098": "Mario Ruiz" };
ok(statusAfterFill(r30, rows30, S()) === "por_firmar", "R-30 publicado: firman los tripulantes");
ok(statusForOrder(r30, pendingOrder(r30, rows30, S(SF(40)))) === "por_firmar", "R-30: falta una fila con nombre");
ok(statusForOrder(r30, pendingOrder(r30, rows30, S(SF(40), SF(41)))) === "por_oficina", "R-30: luego la PD");
ok(statusForOrder(r30, pendingOrder(r30, rows30, S(SF(40), SF(41), SF(37)))) === "por_gerencia", "R-30: luego José");
ok(rowBelongsTo("Marinero Juan Pérez", "Juan Perez") && !rowBelongsTo("Mario Ruiz", "Juan Pérez"), "fila del R-30 por nombre");

// R-18: Cubierta pasa por el Capitán y lo despacha la PD; Hotelería va directo a Administración.
ok(statusAfterFill(FLOWS["R-18_Cubierta"]!, {}, S("Firma_Solicitante")) === "por_capitan", "R-18 Cubierta: al Capitán");
ok(statusForOrder(FLOWS["R-18_Cubierta"]!, pendingOrder(FLOWS["R-18_Cubierta"]!, {}, S("Firma_Solicitante", SF(29)))) === "por_oficina", "R-18 Cubierta: despacha la PD");
ok(statusForOrder(FLOWS["R-18_Cubierta"]!, pendingOrder(FLOWS["R-18_Cubierta"]!, {}, S("Firma_Solicitante", SF(29), SF(28)))) === "por_firmar", "R-18: recepción conforme");
ok(statusAfterFill(FLOWS["R-18_Hoteleria"]!, {}, S(SF(1))) === "por_oficina", "R-18 Hotelería: directo a Administración");

// R-10, R-14 (esquema), R-15, R-19, R-25: el Capitán los llena y no pasan por su bandeja.
for (const code of ["R-10", "R-15", "R-19", "R-25_Alcohol"]) {
  ok(FLOWS[code]!.steps.filter((s) => s.who === "capitan").every((s) => s.atFill), `${code}: la firma del Capitán va al llenar`);
}
// R-12 y R-27: sin revisión, se archivan al enviar.
ok(statusAfterFill(FLOWS["R-27"]!, {}, S(SF(18))) === "archivado", "R-27: archiva con la firma del evaluador");
ok(statusAfterFill(FLOWS["R-12"]!, { "Text Field 72": "01/12/2026" }, S("Firma_Responsable_01")) === "archivado", "R-12: archiva");

// Criterio 5: al devolver se anulan la firma de quien devuelve y las posteriores.
const annul = fieldsToAnnul(r05, 2);
ok(!annul.has(SF(4)) && annul.has(SF(5)) && annul.has(SF(6)), "devolver conserva las anteriores");

// R-16 y R-20: la hoja se firma llena.
ok(missingLines(FLOWS["R-16"]!, {}) === 13, "R-16: 13 líneas");
ok(missingLines(FLOWS["R-20"]!, {}) === 14, "R-20: 14 filas");

// Criterio 9: sin señal queda la hora real del teléfono (creíble).
const now = new Date("2026-11-26T15:00:00Z");
ok(offlineSignedAt(new Date("2026-11-26T09:00:00Z"), now).toISOString() === "2026-11-26T09:00:00.000Z", "hora del teléfono");
ok(offlineSignedAt(new Date("2026-10-01T09:00:00Z"), now) === now, "hora del teléfono no creíble → servidor");

// --- Accesos (criterios 1, 15, 17) ---
ok(!canCreateForm("cubierta", "R-04") && !canCreateForm("cubierta", "R-14") && !canCreateForm("cubierta", "R-26"), "Cubierta no ve R-04, R-14 ni R-26");
ok(canCreateForm("cubierta", "R-18_Cubierta") && !canCreateForm("cubierta", "R-18_Maquinas"), "R-18 por área");
ok(canCreateForm("puente", "R-14") && canCreateForm("hoteleria", "R-26") && canCreateForm("designada", "R-27"), "quién llena");
ok(!canCreateForm("gerencia", "R-11") && !canCreateForm("administracion", "R-18_Hoteleria"), "Gerencia y Administración no llenan");
ok(ismArea("tripulante", "TIM_01") === "cubierta" && ismArea("capitan", "") === "puente" && ismArea("designada", "") === "designada", "áreas");
const rec = (code: string, status: string, area: string) => ({ code, status, area, createdBy: "x" });
ok(canViewRecord("cubierta", "u", rec("R-28", "archivado", "cubierta")) && !canViewRecord("cubierta", "u", rec("R-13", "archivado", "maquinas")), "Archivo de Cubierta: solo lo suyo");
for (const code of SENSITIVE_CODES) ok(!canViewRecord("hoteleria", "u", rec(code, "archivado", "hoteleria")), `${code} archivado no lo ve un área`);
ok(canViewRecord("hoteleria", "u", rec("R-20", "borrador", "hoteleria")), "Hotelería ve su bitácora abierta del R-20");
ok(canViewRecord("puente", "u", rec("R-20", "archivado", "hoteleria")) && !canViewRecord("puente", "u", rec(LAND_CODES[0]!, "archivado", "designada")), "Puente: lo de abordo");
ok(canViewRecord("administracion", "u", rec("R-18_Hoteleria", "por_oficina", "hoteleria")) && !canViewRecord("administracion", "u", rec("R-09", "por_oficina", "cubierta")), "Administración: solo R-18 Hotelería");
ok(canViewRecord("maquinas", "u", rec("R-30", "por_firmar", "designada")), "cada área firma su fila del R-30");
// Criterio 7 y 17: el borrador es del área; Gerencia no edita.
ok(canEditData("cubierta", "tripulante", "otro", rec("R-28", "borrador", "cubierta")), "el reemplazo sigue el borrador del compañero");
ok(!canEditData("gerencia", "duena", "u", rec("R-28", "borrador", "cubierta")), "Gerencia no edita registros de abordo");
ok(!canEditData("cubierta", "tripulante", "u", rec("R-28", "archivado", "cubierta")), "archivado no se toca");

// --- Frecuencias (criterios 13 y 14) ---
const today = "2026-11-26";
const r25 = DEFAULT_RULES["R-25"]!;
const p25 = periodOf(r25, today)!;
ok(p25.due === "2026-11-30" && p25.warnFrom === "2026-11-20", "R-25 mensual, avisa el día 20");
ok(dueState(p25.due, p25.warnFrom, today, false) === "por_vencer", "por vencer");
ok(dueState("2026-11-26", "2026-11-20", today, false) === "vence_hoy", "vence hoy");
ok(dueState("2026-11-25", "2026-11-20", today, false) === "vencido", "vencido");
ok(dueState("2026-11-22", "2026-11-20", today, false) === "vencido_3", "3 días vencido → Gerencia");
ok(dueState("2026-11-22", "2026-11-20", today, true) === "hecho", "hecho");
const p18 = periodOf(DEFAULT_RULES["R-18"]!, today)!;
ok(p18.due === "2026-11-25" && p18.start === "2026-11-23", "R-18 vence el miércoles de la semana");
ok(periodOf(DEFAULT_RULES["R-09"]!, today) === null, "lo «cuando ocurre» nunca sale como atrasado");
ok(!countsFrom("2026-11-30", "2026-12-01"), "sin atrasos hacia atrás");
ok(equipmentDue("2026-11-10", "M") === "2026-12-10" && equipmentDue("2026-11-10", "S") === "2026-11-17", "R-16 por frecuencia del equipo");
ok(equipmentDue("2026-01-31", "M") === "2026-02-28", "fin de mes");
ok(equipmentDue(null, "M") === null, "R-16 sin trabajos no es atraso");

// --- Calendario de rotación (sección 9) ---
const turns = [
  { _id: "a", post: "coc", user: "vera", from: "2026-11-02", to: "2026-11-29" },
  { _id: "b", post: "coc", user: "rios", from: "2026-11-30", to: "2026-12-20" },
  { _id: "c", post: "aux", user: "paz", from: "2026-11-02", to: "2026-11-29" },
  { _id: "d", post: "aux", user: null, from: "2026-11-30", to: "2026-12-13" },
];
ok(turnsOn(turns, "2026-11-26").map((t) => t.user).join() === "vera,paz", "de turno hoy");
ok(gapsOf(turns.filter((t) => t.post === "aux"), "2026-11-25", "2026-12-15").length === 1, "sin reemplazo en rojo");
const rel = relevosOf(turns);
ok(rel.length === 1 && rel[0]!.day === "2026-11-30" && rel[0]!.out.user === "vera", "relevo → R-07");
const ext = extendWeek(turns[0]!, turns[1]!);
ok(ext.turn.to === "2026-12-06" && ext.next!.from === "2026-12-07", "extender una semana");

// --- R-14 v2: el Capitán llena y firma (su firma va a «quien chequea» y «capitán»), luego la PD ---
const r14 = JSON.parse(fs.readFileSync(path.join(process.cwd(), "assets", "ism", "schemas", "R-14.v2.json"), "utf8"));
ok(validateSigners(r14.signers).length === 0, "R-14 v2: firmas válidas");
ok(r14.sections.length === 1 && r14.sections[0].id === "zarpe", "R-14 v2: solo la sección previa al zarpe");
ok(r14.signers[0].who === "capitan" && r14.signers[0].print === "anexo", "R-14 v2: la firma del Capitán llena las dos casillas");

// --- Transición (26-nov): los guardas cortan antes de tocar la base ---
(async () => {
  const codeOf = (p: Promise<unknown>) => p.then(() => "", (e: { code?: string }) => e.code ?? "?");
  const me = { id: "a", name: "Ana", noPin: true, drawSignature: true };
  ok((await codeOf(transitionProfile(me, "a", "", "", ""))) === "firma_falta", "transición: sin firma registrada hay que dibujarla");
  ok((await codeOf(transitionProfile({ ...me, drawSignature: false }, "b", "", "", ""))) === "sin_clave", "transición: sin clave no firma en la sesión de otro");
  console.log(`check-ism-flow: ${checks} comprobaciones OK`);
})();
