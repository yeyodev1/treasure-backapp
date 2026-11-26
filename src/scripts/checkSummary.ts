// Autocomprobación del calendario del barco con los cruceros de noviembre 2026 (especificación, criterios de aceptación).
// Uso: npx ts-node --transpile-only src/scripts/checkSummary.ts  (no toca la base)
import assert from "node:assert";
import { Types } from "mongoose";
import { dayStates } from "../services/summary.service";
import { isTestOrTeamEmail } from "../services/emailRules.service";
import { judgeRecount } from "../services/barStock.service";

const cruise = (code: string, start: string, end: string, status: string) => ({
  _id: new Types.ObjectId(),
  code,
  leg: code[0]!,
  name: code,
  routeFrom: "",
  routeTo: "",
  startDate: new Date(`${start}T16:00:00Z`),
  endDate: new Date(`${end}T16:00:00Z`),
  status,
  bartender: null,
  bartenderName: "",
  cabins: [],
});
const cruises = [cruise("B-005", "2026-11-10", "2026-11-14", "cerrado"), cruise("C-003", "2026-11-14", "2026-11-20", "cerrado"), cruise("A-001", "2026-11-20", "2026-11-24", "abordo")];
const days = dayStates("2026-11-01", "2026-11-30", cruises as never, new Set());
const n = (s: string) => days.filter((d) => d.state === s).length;
const today = new Date().toISOString().slice(0, 10);
if (today === "2026-11-24") {
  assert.equal(n("navegando"), 14, "14 días operados");
  assert.equal(n("para"), 10, "10 de para (1–9 y 24 nov)");
  assert.equal(n("por_venir"), 6, "6 por venir");
}
assert.equal(days.find((d) => d.day === "2026-11-14")!.code, "C-003", "el día de cambio cuenta para el crucero que zarpa");
// C-003 guardado hasta el 21 (dato real): el 20 igual es de A-001, que zarpa ese día.
const overlap = [cruise("C-003", "2026-11-14", "2026-11-21", "cerrado"), cruise("A-001", "2026-11-20", "2026-11-24", "cerrado")];
const d20 = dayStates("2026-11-20", "2026-11-20", overlap as never, new Set())[0]!;
assert.equal(d20.code, "A-001", "el día 20 lleva la etiqueta de A-001");
assert.ok(d20.departs, "A-001 zarpa el 20");
const oct = dayStates("2026-10-01", "2026-10-31", cruises as never, new Set());
assert.ok(oct.every((d) => d.state === "sin_registro"), "antes del primer mes con operación: sin registro");
// Correos de noviembre: los 10 inválidos se detectan y los reales pasan.
const team = { emails: new Set(["admin@treasure.ec"]), names: [["gabriel", "criollo"], ["paula", "teran"]] };
for (const bad of ["hola@hola.com", "hhyh@hu.com", "hhh@gmail.com", "simon@gmail.com", "criollogabriel41@gmail.com", "admin@treasure.ec"]) {
  assert.ok(isTestOrTeamEmail(bad, team), `debió rechazar ${bad}`);
}
for (const good of ["afgaviria7@gmail.com", "lex@doddstr.com.au", "ana@outlook.com", "marktattersall94@gmail.com", "schmollsarah@web.de", "facturaspaulateran@gmail.com"]) {
  assert.ok(!isTestOrTeamEmail(good, team), `debió aceptar ${good}`);
}
// Bar-stock, criterios 2-5: Club esperado 20, la directora cuenta 18 → merma de 2; cuenta 20 → se corrige.
const club = { expected: 20, tolerance: 0, unitCost: 2.5, category: "cerveza", containerSize: 1 };
assert.deepEqual(judgeRecount({ ...club, recount: 18 }), { result: "merma", value: 5, fullBottle: false });
assert.equal(judgeRecount({ ...club, recount: 20 }).result, "corregido");
assert.equal(judgeRecount({ ...club, recount: 22 }).result, "corregido", "sobrante no es merma");
// Botella abierta: ±¼ de 750 ml es tolerancia; una botella completa de licor faltante va a Gerencia.
const jw = { expected: 3000, tolerance: 187.5, unitCost: 0.04, category: "licor", containerSize: 750 };
assert.equal(judgeRecount({ ...jw, recount: 2850 }).result, "corregido");
assert.deepEqual(judgeRecount({ ...jw, recount: 2250 }), { result: "merma", value: 30, fullBottle: true });
// Esperado negativo cuenta como 0 (nunca negativo).
assert.equal(judgeRecount({ ...club, expected: -21, recount: 0 }).result, "corregido");
console.log("ok", { navegando: n("navegando"), para: n("para"), porVenir: n("por_venir") });

// Propuesta vieja (fórmula de antes del 26-nov, sin tocar) → se recalcula una sola vez.
import { isOldProposal } from "../controllers/weeklyOrder.controller";
{
  const h = (detail: string) => [{ action: "Propuesta preparada", detail }] as never;
  const base = { status: "bar", revision: 0, lines: [{ editedAt: null }] } as never as Parameters<typeof isOldProposal>[0];
  const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  assert(isOldProposal({ ...base, history: h("38 producto(s) con existencias del corte") }), "vieja sin tocar → recalcula");
  assert(!isOldProposal({ ...base, history: h("6 producto(s) · consumo por pasajero de los últimos 4 cruceros") }), "nueva → no");
  assert(!isOldProposal({ ...base, history: [...(h("x") as never[]), {}] as never }), "ya recalculada → no");
  assert(!isOldProposal({ ...base, lines: [{ editedAt: new Date() }] as never, history: h("x") }), "editada por el bar → no");
  console.log("propuesta vieja ok");
}
