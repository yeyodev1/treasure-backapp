// Solo lectura contra prod: aviso del 28, correo por crucero y pedido semanal con lo vendido.
import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import "../src/models/user.model";
import { agencySummary, agencyEmail } from "../src/services/agency.service";
import { buildLines } from "../src/services/weeklyOrder.service";
(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const s = await agencySummary(new Date("2026-11-28T18:00:00Z"));
  console.log(JSON.stringify({ reminder: s.reminder, totals: s.totals, cruises: s.cruises.map((c) => [c.code, c.month, c.total, c.pending, c.state, c.items.length]) }));
  assert.ok(s.reminder, "el 28 hay aviso si hay pendiente");
  assert.equal((await agencySummary(new Date("2026-11-27T18:00:00Z"))).reminder, null, "el 27 no hay aviso");
  const mail = agencyEmail("2026-11", s.cruises.map((c) => ({ label: c.code, amount: c.pending, items: c.items })), s.totals.pending);
  console.log(mail.subject); console.log(mail.text);
  const lines = await buildLines(new Date("2026-11-04T21:00:00Z"));
  console.log("pedido PS-002 con la regla nueva:", lines.length, "líneas", lines.slice(0, 5).map((l) => `${l.name} consumo ${l.consumption} sug ${l.suggested}`));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
