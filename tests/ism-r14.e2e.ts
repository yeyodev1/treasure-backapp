/**
 * Prueba de aceptación del R-14 (informe ISM y mejoras, 29-oct-2026):
 *
 *   npx ts-node-dev --transpile-only tests/ism-r14.e2e.ts
 *
 * Fecha y nombre del archivo con la hora de la actividad, fecha inválida
 * con aviso, marca de novedad, casilla OBS, registros de prueba.
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

  const mongoose = (await import("mongoose")).default;
  const { createApp } = await import("../src/app");
  const { User } = await import("../src/models/user.model");
  const { ismSchema } = await import("../src/services/ismSchema.service");
  const { obsText } = await import("../src/services/ism.service");
  await mongoose.connect(process.env.MONGODB_URI!);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const hash = await bcrypt.hash("x", 4);
  const people: Record<string, [string, string, string]> = {
    duena: ["duena", "Gerencia", ""],
    cap: ["capitan", "Capitán Uno", "CAP"],
    tri: ["tripulante", "Timonel Uno", "TIM_01"],
    tri2: ["tripulante", "Maquinista", "MAQ"],
    des: ["designada", "Persona Designada", ""],
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
    return { status: r.status, data, headers: r.headers };
  }
  for (const key of Object.keys(people)) {
    const r = await api(key, "POST", "/auth/login", { email: `${key}@t`, password: "x" });
    tokens[key] = r.data.token;
  }

  const schema = ismSchema("R-14")!;
  const allYes = (except: Record<string, unknown> = {}) =>
    Object.fromEntries(
      schema.sections.flatMap((s) => s.items).map((i) => [i.id, except[i.id] ?? { value: "si" }]),
    );

  async function newR14(who: string, key: string, time = "21:26", extra: Record<string, unknown> = {}) {
    const r = await api(who, "POST", "/ism/records", {
      code: "R-14",
      recordDate: "2026-10-29",
      idempotencyKey: key,
      context: { activityDate: "2026-10-29", activityTime: time, place: "Puerto Ayora", position: "TIM_01", confirmed: true },
      ...extra,
    });
    return r;
  }

  // ---- Fecha y nombre del archivo (bloque 3) ----
  const bad = await api("tri", "POST", "/ism/records", { code: "R-14", recordDate: "2026-02-31", idempotencyKey: "bad-date-1" });
  check("Fecha inválida al crear → aviso 400, no error 500", bad.status === 400, [bad.status, bad.data.message]);
  const badList = await api("des", "GET", "/ism/records?from=2026-13-01");
  check("Fecha inválida en el archivo → aviso 400", badList.status === 400, [badList.status, badList.data.message]);

  const a = await newR14("tri", "r14-file-a");
  const recA = a.data.record;
  check("Nombre con la hora de la actividad", recA?.fileName === "R-14_20261029_2126.pdf", recA?.fileName);
  check(
    "Fecha del registro = fecha y hora real de la actividad",
    new Date(recA?.recordDate).toISOString() === "2026-10-30T03:26:00.000Z",
    recA?.recordDate,
  );
  check("Guarda la edición del formato", recA?.formEdition === schema.templateEdition, recA?.formEdition);
  const b = await newR14("tri2", "r14-file-b");
  check("Mismo minuto → sufijo _2", b.data.record?.fileName === "R-14_20261029_2126_2.pdf", b.data.record?.fileName);
  const moved = await api("tri", "PATCH", `/ism/records/${recA._id}`, { context: { activityTime: "21:40" } });
  check("Cambiar la hora renombra el archivo", moved.data.record?.fileName === "R-14_20261029_2140.pdf", moved.data.record?.fileName);

  // ---- Marca de novedad, hora por sección y seguimiento ----
  const answers = allYes({
    "ronda.balsas": {
      value: "no",
      descripcion: "Las balsas salvavidas de la cubierta 02 no están aseguradas",
      accion: "Se trincaron de nuevo",
      responsable: "Contramaestre",
      plazo: "2026-10-30",
      estado: "cerrada",
    },
    "fondeado.radar": { value: "na", motivo: "El barco no está fondeado" },
    "zarpe.cartas": { value: "si", problem: true, descripcion: "x", accion: "y" },
  });
  const saved = await api("tri", "PATCH", `/ism/records/${recA._id}`, { answers });
  const flags = saved.data.record?.flags;
  check("Marca de novedad Sí con al menos un No", flags?.hasNovedad === true && flags?.novedades === 1, flags);
  check("«Hay un problema» ya no se acepta", saved.data.record?.answers?.["zarpe.cartas"]?.problem === false);
  check(
    "Novedad con responsable, plazo y estado",
    saved.data.record?.answers?.["ronda.balsas"]?.estado === "cerrada" &&
      saved.data.record?.answers?.["ronda.balsas"]?.plazo === "2026-10-30",
  );
  const times = saved.data.record?.context?.sectionTimes ?? {};
  check("Cada sección guarda su propia hora", ["ronda", "zarpe", "arribo", "fondeado"].every((s) => /^\d\d:\d\d$/.test(times[s])), times);

  // ---- OBS y PDF ----
  const { IsmRecord } = await import("../src/models/ismRecord.model");
  const docA = await IsmRecord.findById(recA._id);
  const obs = obsText(schema, docA!);
  check("OBS con el resumen de la novedad", obs[0]?.startsWith("1 novedad: Ronda de seguridad de cubierta 02"), obs);
  const pdf = await fetch(`${base}/ism/records/${recA._id}/pdf`, { headers: { Authorization: `Bearer ${tokens.tri}` } });
  // SAVE_PDF=<carpeta> guarda el PDF para revisarlo a ojo.
  if (process.env.SAVE_PDF) {
    const fs = await import("fs");
    fs.writeFileSync(`${process.env.SAVE_PDF}/borrador.pdf`, Buffer.from(await pdf.clone().arrayBuffer()));
  }
  check("El PDF se genera", pdf.status === 200 && (pdf.headers.get("content-type") ?? "").includes("pdf"), pdf.status);
  check(
    "El PDF se descarga con el nombre del registro",
    (pdf.headers.get("content-disposition") ?? "").includes("R-14_20261029_2140.pdf"),
    pdf.headers.get("content-disposition"),
  );

  // ---- Registros de prueba ----
  const before = (await api("des", "GET", "/ism/summary")).data.counts?.borrador;
  const t = await newR14("des", "r14-test-1", "08:00", { test: true });
  check("La Persona Designada crea un registro de prueba", t.data.record?.test === true, t.data.record?.test);
  const after = (await api("des", "GET", "/ism/summary")).data.counts?.borrador;
  check("Los registros de prueba no cuentan en indicadores", before === after, [before, after]);
  const tt = await newR14("tri", "r14-test-2", "08:05", { test: true });
  check("Un tripulante no marca registros de prueba", tt.data.record?.test === false, tt.data.record?.test);
  const mark = await api("tri", "POST", `/ism/records/${b.data.record._id}/test`, { test: true });
  check("Solo la Persona Designada marca como prueba", mark.status === 403, mark.status);

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
