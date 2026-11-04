// "Ver como": Gerencia toma los permisos del rol que mira; nadie más puede, y /auth no cambia.
import assert from "node:assert/strict";
import { asViewedRole } from "../src/middlewares/auth.middleware";

const duena = { sub: "1", name: "Paula", role: "duena" as const };
const bar = { sub: "2", name: "Bar", role: "bartender" as const };

assert.equal(asViewedRole(duena, "bartender", "/cruises/x/finish").role, "bartender");
assert.equal(asViewedRole(duena, "admin", "/purchases/x/receive").role, "admin");
assert.equal(asViewedRole(duena, undefined, "/cruises").role, "duena");
assert.equal(asViewedRole(duena, "", "/cruises").role, "duena");
assert.equal(asViewedRole(duena, "inventado", "/cruises").role, "duena");
assert.equal(asViewedRole(duena, "bartender", "/auth/refresh").role, "duena", "la renovación no baja el token");
assert.equal(asViewedRole(bar, "duena", "/cruises").role, "bartender", "nadie sube permisos");
assert.equal(asViewedRole(bar, "direccion", "/cruises").role, "bartender");
assert.equal(asViewedRole(duena, "bartender", "/x").sub, "1", "la persona sigue siendo la real");
console.log("ver como: ok");
