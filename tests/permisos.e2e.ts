/**
 * Permisos por rol (checklist 29-oct punto 07 e informe ISM falla 1):
 *
 *   npx ts-node-dev --transpile-only tests/permisos.e2e.ts
 *
 * Métricas solo para Gerencia y firmas atadas al rol de quien firma.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AddressInfo } from "net";
import bcrypt from "bcryptjs";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK   " : "FALLA"} ${label}${detail !== "" ? ` → ${JSON.stringify(detail)}` : ""}`);
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main() {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = repl.getUri("treasure");
  process.env.CONTIFICO_API_KEY = "";
  process.env.CONTIFICO_API_TOKEN = "";

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const people: Record<string, [string, string]> = {
    duena: ["duena", "Gerencia"],
    adm: ["admin", "Administración"],
    dir: ["direccion", "Dirección"],
    bar: ["bartender", "Bar"],
    bod: ["bodega", "Bodega"],
    cap: ["capitan", "Capitán"],
    tri: ["tripulante", "Timonel"],
    des: ["designada", "Persona Designada"],
  };
  for (const [key, [role, name]] of Object.entries(people)) {
    await User.create({ email: `${key}@t`, role, name, passwordHash: hash, active: true, position: role === "capitan" ? "CAP" : "TIM_01" });
  }

  const server = createApp().app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const tokens: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  }
  for (const key of Object.keys(people)) {
    const r = await api(key, "POST", "/auth/login", { email: `${key}@t`, password: "x" });
    tokens[key] = r.data.token;
  }

  // 07 · Métricas solo Gerencia
  for (const path of ["/reports/sales", "/reports/by-cruise", "/reports/owner"]) {
    check(`Gerencia ve ${path}`, (await api("duena", "GET", path)).status === 200);
    for (const who of ["adm", "dir", "bar", "bod"]) {
      const r = await api(who, "GET", path);
      check(`${people[who][1]} no ve ${path}`, r.status === 403, r.status);
    }
  }

  // ISM falla 1 · firma atada al rol
  const form = await api("tri", "GET", "/ism/forms/R-14");
  const fields = (form.data.form?.fields ?? form.data.fields ?? []) as Array<{ name: string; type: string; stage?: string }>;
  const capSlot = fields.find((f) => f.type === "signature" && f.stage === "capitan");
  check("R-14 tiene recuadro de firma del Capitán", Boolean(capSlot));
  const created = await api("tri", "POST", "/ism/records", {
    code: "R-14",
    recordDate: "2026-10-30",
    position: "TIM_01",
    idempotencyKey: "perm-1",
  });
  const recId = created.data.record?.id ?? created.data.record?._id;
  check("Tripulante crea el R-14", created.status < 300 && Boolean(recId), created.status);
  if (capSlot && recId) {
    for (const who of ["duena", "adm", "tri", "des"]) {
      const r = await api(who, "POST", `/ism/records/${recId}/signatures`, { field: capSlot.name, image: PNG });
      check(`${people[who][1]} no firma como Capitán`, r.status === 403, r.status);
    }
    const ok = await api("cap", "POST", `/ism/records/${recId}/signatures`, {
      field: capSlot.name,
      image: PNG,
      signerName: "Otro nombre",
    });
    const sig = (ok.data.record?.signatures ?? []).find((s: any) => s.field === capSlot.name);
    check("El Capitán firma desde su cuenta", ok.status === 200, ok.status);
    check("La firma del Capitán lleva el nombre de su cuenta", sig?.signerName === "Capitán", sig?.signerName);
  }

  server.close();
  await mongoose.disconnect();
  await repl.stop();
  console.log(failures ? `\n${failures} falla(s)` : "\nTodo OK");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
