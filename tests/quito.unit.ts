// La bodega de Quito solo cuenta botellas (vino, licor, insumo en botella); lo demás va en Galápagos.
import assert from "node:assert/strict";
import { belongsInQuito } from "../src/services/inventory.service";

const p = (category: string, containerLabel: string, stockUnit: string, quitoStock = 0) =>
  ({ category, containerLabel, stockUnit, quitoStock }) as Parameters<typeof belongsInQuito>[0];
assert.ok(belongsInQuito(p("vino", "botella", "ml")));
assert.ok(belongsInQuito(p("licor", "botella", "ml")));
assert.ok(belongsInQuito(p("insumo", "botella", "ml")), "Campari");
assert.ok(!belongsInQuito(p("agua", "botella", "ml")), "Agua Güitig");
assert.ok(!belongsInQuito(p("cerveza", "botella", "unidad")), "Club");
assert.ok(!belongsInQuito(p("gaseosa", "lata", "ml")), "Coca Cola");
assert.ok(!belongsInQuito(p("insumo", "litro", "ml")), "Jugo de lima");
assert.ok(belongsInQuito(p("cerveza", "botella", "unidad", 6)), "si ya hay stock en Quito, se cuenta");
console.log("quito: ok");
