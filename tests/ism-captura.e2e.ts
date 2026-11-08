/**
 * Captura mínima (TREASURE ISM 2.0, 8-nov-2026): pedir suministros (R-18) y
 * reportar una novedad (R-09) desde «¿Qué necesitas hacer?».
 *
 *   npx ts-node --transpile-only tests/ism-captura.e2e.ts
 *
 * El número de orden lo pone el sistema una sola vez (un reintento no gasta
 * otro), y al enviar se avisa a quien le toca el siguiente paso.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AddressInfo } from "net";
import bcrypt from "bcryptjs";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK   " : "FALLA"} ${label}${detail !== "" ? ` → ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = repl.getUri("treasure");
  process.env.CONTIFICO_API_KEY = "";
  process.env.CONTIFICO_API_TOKEN = "";
  process.env.RESEND_API_KEY = "";

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const people: Record<string, [string, string, string]> = {
    cap: ["capitan", "Capitán Uno", "CAP"],
    tri: ["tripulante", "Timonel Uno", "TIM_01"],
    des: ["designada", "Persona Designada", ""],
    adm: ["admin", "Administración", ""],
    dir: ["direccion", "Directora", "DIR"],
  };
  for (const [key, [role, name, position]] of Object.entries(people)) {
    await User.create({ email: `${key}@t`, role, name, passwordHash: hash, active: true, position });
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
    const text = await r.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.length };
    }
    return { status: r.status, data };
  }
  for (const key of Object.keys(people)) {
    tokens[key] = (await api(key, "POST", "/auth/login", { email: `${key}@t`, password: "x" })).data.token;
  }
  const notices = async (who: string) => ((await api(who, "GET", "/ism/notices")).data.notices ?? []) as any[];

  // ---- R-18 Hotelería: número automático, firma de la directora → Administración ----
  const a = await api("dir", "POST", "/ism/records", { code: "R-18_Hoteleria", recordDate: "2026-11-08", idempotencyKey: "pedido-hot-1" });
  check("R-18 creado", a.status === 201, a.data.message);
  const recA = a.data.record;
  check("Número de orden puesto por el sistema", recA?.data?.["Text Field 3"] === "OR-2026-001", recA?.data?.["Text Field 3"]);
  const again = await api("dir", "POST", "/ism/records", { code: "R-18_Hoteleria", recordDate: "2026-11-08", idempotencyKey: "pedido-hot-1" });
  check("Reintento: mismo registro y mismo número", again.data.duplicate === true && again.data.record?._id === recA._id);

  const saved = await api("dir", "PATCH", `/ism/records/${recA._id}`, {
    data: { "Text Field 4": "2", "Text Field 33": "almohadas", "Text Field 35": "Directora", "Text Field 2": "08/11/2026" },
  });
  check("Líneas guardadas", saved.status === 200 && saved.data.record.data["Text Field 33"] === "almohadas", saved.data.message);
  const signed = await api("dir", "POST", `/ism/records/${recA._id}/signatures`, { field: "Signature Field 1", image: "data:image/png;base64,iVBORw0KGgo=" });
  check("Firma de la solicitante", signed.status === 200, signed.data.message);
  const sentA = await api("dir", "POST", `/ism/records/${recA._id}/submit`);
  check("Enviado a Administración", sentA.data.record?.status === "por_oficina", [sentA.status, sentA.data.message]);
  check("Aviso a Administración", (await notices("adm")).some((n) => n.kind === "por_recibir" && n.record === recA._id));

  const b = await api("dir", "POST", "/ism/records", { code: "R-18_Hoteleria", recordDate: "2026-11-08", idempotencyKey: "pedido-hot-2" });
  check("El siguiente pedido lleva el número que sigue", b.data.record?.data?.["Text Field 3"] === "OR-2026-002", b.data.record?.data?.["Text Field 3"]);

  // ---- R-18 Cubierta: sin firma de tripulación → Capitán (firma como solicitante) ----
  const c = await api("tri", "POST", "/ism/records", { code: "R-18_Cubierta", recordDate: "2026-11-08", idempotencyKey: "pedido-cub-1" });
  check("R-18 Cubierta con número", c.data.record?.data?.["Text Field 112"] === "OR-2026-003", c.data.record?.data?.["Text Field 112"]);
  await api("tri", "PATCH", `/ism/records/${c.data.record._id}`, { data: { "Text Field 113": "3", "Text Field 93": "escobas" } });
  const sentC = await api("tri", "POST", `/ism/records/${c.data.record._id}/submit`);
  check("R-18 Cubierta enviado al Capitán", sentC.data.record?.status === "por_capitan", [sentC.status, sentC.data.message]);
  check("Aviso al Capitán", (await notices("cap")).some((n) => n.kind === "por_firmar_capitan" && n.record === c.data.record._id));

  // ---- R-09: el relato basta para enviarlo; el Capitán clasifica e investiga ----
  const n = await api("dir", "POST", "/ism/records", { code: "R-09", recordDate: "2026-11-08", idempotencyKey: "novedad-1" });
  check("R-09 sin número de orden", n.status === 201 && !Object.values(n.data.record.data).some((v) => String(v).startsWith("OR-")));
  await api("dir", "PATCH", `/ism/records/${n.data.record._id}`, {
    data: { Nombre_Reporta: "Directora", Fecha_Reporte: "08/11/2026", "Text Field 68": "Observé líquido en el pasillo." },
  });
  const sentN = await api("dir", "POST", `/ism/records/${n.data.record._id}/submit`);
  check("R-09 enviado al Capitán sin clasificar", sentN.data.record?.status === "por_capitan", [sentN.status, sentN.data.message]);
  check("Aviso al Capitán por la novedad", (await notices("cap")).some((x) => x.record === n.data.record._id));

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
