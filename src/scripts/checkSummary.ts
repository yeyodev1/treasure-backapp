// Autocomprobación del calendario del barco con los cruceros de noviembre 2026 (especificación, criterios de aceptación).
// Uso: npx ts-node --transpile-only src/scripts/checkSummary.ts  (no toca la base)
import assert from "node:assert";
import { Types } from "mongoose";
import { dayStates } from "../services/summary.service";
import { isTestOrTeamEmail } from "../services/emailRules.service";

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
console.log("ok", { navegando: n("navegando"), para: n("para"), porVenir: n("por_venir") });
