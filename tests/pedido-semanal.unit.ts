/**
 * Prueba pura del pedido semanal (sin base de datos):
 * npx ts-node --transpile-only tests/pedido-semanal.unit.ts
 */
import assert from "node:assert/strict";
import { isOverdue, latestCut, suggest, weekKey } from "../src/services/weeklyOrder.service";

// Corte: miércoles 15h00 Galápagos = 21h00 UTC.
const wed4 = new Date("2026-11-04T21:00:00Z");
assert.equal(latestCut(new Date("2026-11-04T21:00:00Z")).toISOString(), wed4.toISOString());
assert.equal(latestCut(new Date("2026-11-04T20:59:00Z")).toISOString(), "2026-10-28T21:00:00.000Z");
assert.equal(latestCut(new Date("2026-11-07T10:00:00Z")).toISOString(), wed4.toISOString());
// Miércoles 23h00 en Galápagos ya es jueves en UTC: sigue siendo el corte del miércoles.
assert.equal(latestCut(new Date("2026-11-05T05:00:00Z")).toISOString(), wed4.toISOString());
assert.equal(weekKey(wed4), "2026-11-04");

// Alerta a las 18h00 si el bar no revisó; nunca si ya lo envió.
const order = { status: "bar" as const, week: "2026-11-04" };
assert.equal(isOverdue(order, new Date("2026-11-04T23:59:00Z")), false);
assert.equal(isOverdue(order, new Date("2026-11-05T00:00:00Z")), true);
assert.equal(isOverdue({ ...order, status: "directora" as never }, new Date("2026-11-06T00:00:00Z")), false);

// Ejemplo de la guía: objetivo 18 tónicas, hay 6, vienen 4 → 8.
assert.deepEqual(
  suggest({ target: 18, containerSize: 355, onHand: 6 * 355, incoming: 4 * 355, consumption: 0, lowThreshold: 0 }),
  { suggested: 8, basis: "objetivo" },
);
// Objetivo cubierto: no se pide.
assert.deepEqual(suggest({ target: 10, containerSize: 1, onHand: 12, incoming: 0, consumption: 50, lowThreshold: 0 }), {
  suggested: 0,
  basis: "objetivo",
});
// Sin objetivo: por consumo; 1,2 botellas faltantes se redondean a 2.
assert.deepEqual(suggest({ target: 0, containerSize: 750, onHand: 300, incoming: 0, consumption: 1200, lowThreshold: 0 }), {
  suggested: 2,
  basis: "consumo",
});
// Sin datos y bajo el mínimo: "Revisa esta cantidad".
assert.deepEqual(suggest({ target: 0, containerSize: 1, onHand: 2, incoming: 0, consumption: 0, lowThreshold: 3 }), {
  suggested: null,
  basis: "revisar",
});
// Sin datos y con existencias: no entra en la propuesta.
assert.equal(suggest({ target: 0, containerSize: 1, onHand: 20, incoming: 0, consumption: 0, lowThreshold: 3 }), null);

console.log("pedido semanal: ok");
