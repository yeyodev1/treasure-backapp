/**
 * Prueba de aceptación del R-14 (informe ISM y mejoras, 29-oct-2026):
 *
 *   npx ts-node-dev --transpile-only tests/ism-r14.e2e.ts
 *
 * Fecha y nombre del archivo con la hora de la actividad, fecha inválida
 * con aviso, marca de novedad, casilla OBS, registros de prueba; lista de
 * tripulantes y clave de 4 números (temporal, errada y bloqueo); firma por
 * pasos sin firmar por otro rol (también por la API); devolución con
 * comentario que anula firmas; archivado inmutable; avisos dentro de la app.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AddressInfo } from "net";
import bcrypt from "bcryptjs";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK   " : "FALLA"} ${label}${detail !== "" ? ` → ${JSON.stringify(detail)}` : ""}`);
}

/** Texto de un PDF por página con pdftotext (si no está instalado, esas pruebas se saltan). */
async function pdfPages(bytes: ArrayBuffer): Promise<string[] | null> {
  const { execFileSync } = await import("child_process");
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const file = path.join(os.tmpdir(), `ism-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, Buffer.from(bytes));
  try {
    return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).split("\f");
  } catch {
    console.log("SALTO pdftotext no disponible: no se revisa el texto del PDF");
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
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
    adm: ["admin", "Administración", ""],
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

  // ---- Lista de tripulantes y claves (bloque 2) ----
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==";
  const noAdd = await api("tri", "POST", "/ism/crew", { name: "Juan Pérez", position: "TIM_01" });
  check("Un tripulante no edita la lista de tripulantes", noAdd.status === 403, noAdd.status);
  const juan = (await api("des", "POST", "/ism/crew", { name: "Juan Pérez", position: "TIM_01", onboard: true })).data.member;
  const pedro = (await api("des", "POST", "/ism/crew", { name: "Pedro Gómez", position: "MAQ" })).data.member;
  check("La Persona Designada da de alta tripulantes", Boolean(juan?.id && pedro?.id), juan);
  const list = await api("tri", "GET", "/ism/crew?onboard=1");
  check("La tablet ve la lista con nombre y cargo", list.data.crew?.some((c: any) => c.name === "Juan Pérez" && c.positionLabel === "Timonel 1"));
  const duenaPin = await api("duena", "POST", `/ism/crew/${juan.id}/temporary-pin`);
  check("Gerencia ya no da claves temporales (solo la Persona Designada)", duenaPin.status === 403, duenaPin.status);
  // ---- Tablet compartida (punto 4): no es una persona; solo se marca a mano ----
  const tablet = await User.create({ email: "tablet.barco@t", role: "tripulante", name: "Tablet Barco", passwordHash: hash, active: true, position: "" });
  const before4 = await api("tri", "GET", "/ism/crew?onboard=1");
  check("Una cuenta llamada «Tablet Barco» no se marca sola", before4.data.crew?.some((c: any) => c.id === tablet._id.toString() && c.sharedDevice === false));
  const noMark = await api("tri", "PATCH", `/ism/crew/${tablet._id}`, { sharedDevice: true });
  check("Un tripulante no marca la tablet compartida", noMark.status === 403, noMark.status);
  const marked = await api("des", "PATCH", `/ism/crew/${tablet._id}`, { sharedDevice: true });
  check("La Persona Designada marca la tablet compartida", marked.data.member?.sharedDevice === true, marked.data.member);
  const after4 = await api("tri", "GET", "/ism/crew?onboard=1");
  check("La tablet compartida no sale en «¿Quién hace el chequeo?»", !after4.data.crew?.some((c: any) => c.id === tablet._id.toString()));
  const manage4 = await api("des", "GET", "/ism/crew?all=1");
  check("En Tripulantes se ve marcada para poder desmarcarla", manage4.data.crew?.some((c: any) => c.id === tablet._id.toString() && c.sharedDevice));
  const pickTablet = await api("tri", "PATCH", `/ism/records/${recA._id}`, { context: { crewId: tablet._id.toString() } });
  check("No se puede elegir la tablet como quien hace el chequeo", pickTablet.status === 400, pickTablet.status);

  const tempJuan = (await api("des", "POST", `/ism/crew/${juan.id}/temporary-pin`)).data.pin as string;
  const tempPedro = (await api("des", "POST", `/ism/crew/${pedro.id}/temporary-pin`)).data.pin as string;
  check("Clave temporal de 4 números", /^\d{4}$/.test(tempJuan), tempJuan);
  const { IsmCrew } = await import("../src/models/ismCrew.model");
  const prof = await IsmCrew.findOne({ user: juan.id });
  check("La clave se guarda cifrada", Boolean(prof?.pinHash.startsWith("$2")) && !prof?.pinHash.includes(tempJuan));

  async function fullR14(key: string, crewId: string, time: string) {
    const r = (await newR14("tri", key, time)).data.record;
    await api("tri", "PATCH", `/ism/records/${r._id}`, { context: { crewId }, answers });
    return r._id as string;
  }

  const r1 = await fullR14("r14-flow-1", juan.id, "06:10");
  const ctxR1 = (await api("tri", "GET", `/ism/records/${r1}`)).data.record.context;
  check("El cargo sale de la ficha del tripulante elegido", ctxR1?.filledBy?.position === "TIM_01" && ctxR1?.filledBy?.name === "Juan Pérez", ctxR1?.filledBy);
  const legacy = await api("tri", "POST", `/ism/records/${r1}/submit`);
  check("No se envía sin firmar con clave", legacy.status === 409, legacy.status);
  const otherSigner = await api("tri", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: tempPedro, signer: pedro.id });
  check("Nadie firma por quien hizo el chequeo", otherSigner.status === 403, otherSigner.status);
  const s1 = await api("tri", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: tempJuan, signer: juan.id });
  check("Clave temporal: pide crear la propia", s1.status === 428 && s1.data.code === "clave_temporal", [s1.status, s1.data.code]);
  const weak = await api("tri", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: tempJuan, newPin: "1234", signer: juan.id });
  check("No acepta claves fáciles", weak.status === 400, weak.status);
  const s1b = await api("tri", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: tempJuan, newPin: "5826", signer: juan.id });
  check("Quien hizo el chequeo firma y envía al Capitán", s1b.data.record?.status === "por_capitan", [s1b.status, s1b.data.message]);
  const crewSig = s1b.data.record?.signatures?.find((s: any) => s.stage === "tripulacion");
  check(
    "La firma guarda usuario, nombre, cargo, rol, hora y huella",
    crewSig?.user === juan.id && crewSig?.signerName === "Juan Pérez" && crewSig?.position === "TIM_01" && crewSig?.userRole === "tripulante" && Boolean(crewSig?.dataHash) && Boolean(crewSig?.signedAt),
    crewSig,
  );
  check(
    "La firma guarda la clave restablecida en las 24 h previas y por quién",
    Boolean(crewSig?.pinResetAt) && crewSig?.pinResetByName === "Persona Designada",
    [crewSig?.pinResetAt, crewSig?.pinResetByName],
  );
  check("La sesión de la tablet no es quien firma", crewSig?.capturedByName === "Timonel Uno" && crewSig?.user !== recA.createdBy?._id, crewSig?.capturedByName);
  const reuse = await api("tri", "POST", `/ism/records/${await fullR14("r14-flow-x", juan.id, "06:20")}/sign-step`, { image: PNG, pin: tempJuan, signer: juan.id });
  check("La clave temporal es de un solo uso", reuse.status === 403, reuse.status);
  const capNotice = await api("cap", "GET", "/ism/notices");
  check("Aviso al Capitán cuando le llega un R-14", capNotice.data.notices?.some((n: any) => n.kind === "por_firmar_capitan" && n.record === r1), capNotice.data.unread);

  // Bloqueo tras 5 intentos fallidos
  const r2 = await fullR14("r14-flow-2", pedro.id, "06:30");
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await api("tri", "POST", `/ism/records/${r2}/sign-step`, { image: PNG, pin: "0000", signer: pedro.id })).status);
  }
  check("Clave errada: avisa y cuenta intentos", statuses.slice(0, 4).every((s) => s === 403), statuses);
  check("Al quinto intento se bloquea", statuses[4] === 423, statuses);
  const locked = await api("tri", "POST", `/ism/records/${r2}/sign-step`, { image: PNG, pin: tempPedro, newPin: "4826", signer: pedro.id });
  check("Bloqueada en el servidor aunque la clave sea correcta", locked.status === 423, locked.status);
  const desNotices = await api("des", "GET", "/ism/notices");
  check("Aviso a la Persona Designada por la clave bloqueada", desNotices.data.notices?.some((n: any) => n.kind === "clave_bloqueada"));

  // Capitán y Persona Designada: su cuenta + su clave
  const tempCap = (await api("des", "POST", `/ism/crew/${(await User.findOne({ email: "cap@t" }))!._id}/temporary-pin`)).data.pin;
  const tempDes = (await api("des", "POST", `/ism/crew/${(await User.findOne({ email: "des@t" }))!._id}/temporary-pin`)).data.pin;
  check("El Capitán cambia su clave temporal", (await api("cap", "POST", "/ism/crew/me/pin", { current: tempCap, next: "7391" })).status === 200);
  check("La Persona Designada cambia su clave temporal", (await api("des", "POST", "/ism/crew/me/pin", { current: tempDes, next: "2468" })).status === 200);

  for (const who of ["duena", "des", "tri"]) {
    const r = await api(who, "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "7391" });
    check(`${people[who][1]} no firma como Capitán (API)`, r.status === 403, r.status);
  }
  const legacyCap = await api("cap", "POST", `/ism/records/${r1}/signatures`, { field: "Firma_Capitan", image: PNG });
  check("Sin clave no hay firma del Capitán (ruta antigua cerrada)", legacyCap.status === 409, legacyCap.status);
  const noComment = await api("cap", "POST", `/ism/records/${r1}/return`, { reason: " " });
  check("Devolver exige comentario", noComment.status === 400, noComment.status);
  const back = await api("cap", "POST", `/ism/records/${r1}/return`, { reason: "La acción de la balsa no está clara" });
  check("El Capitán devuelve al tripulante", back.data.record?.status === "borrador" && back.data.record?.returnInfo?.toStage === "tripulacion", back.data.record?.status);
  check(
    "La firma anterior queda anulada en el historial",
    back.data.record?.signatures?.length === 0 &&
      back.data.record?.annulledSignatures?.some((s: any) => s.field === "Firma_Chequeo") &&
      back.data.record?.history?.some((h: any) => h.action.startsWith("firma anulada")),
  );
  const triNotices = await api("tri", "GET", "/ism/notices");
  check("Aviso a quien hizo el chequeo cuando se lo devuelven", triNotices.data.notices?.some((n: any) => n.kind === "devuelto" && n.record === r1));
  // ---- Seguridad (auditoría 30-oct, punto 1): devuelto, solo lo corrige quien lo creó ----
  for (const who of ["cap", "duena", "adm", "des"]) {
    const r = await api(who, "PATCH", `/ism/records/${r1}`, { context: { activityTime: "23:59" }, answers: { "ronda.drizas": { value: "no", descripcion: "x", accion: "y" } } });
    check(`${people[who][1]} no cambia respuestas ni hora de un R-14 devuelto`, r.status === 403, r.status);
  }
  const capCrewSign = await api("cap", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "5826", signer: juan.id });
  check("El Capitán no firma el paso del chequeo de otro", capCrewSign.status === 403, capCrewSign.status);
  const untouched = (await api("des", "GET", `/ism/records/${r1}`)).data.record;
  check("La hora de la ronda sigue igual", untouched?.context?.activityTime === "06:10" && untouched?.answers?.["ronda.drizas"]?.value === "si", untouched?.context?.activityTime);
  await api("tri", "PATCH", `/ism/records/${r1}`, { answers: { "ronda.balsas": { ...answers["ronda.balsas"] as object, accion: "Se trincaron y se avisó al contramaestre" } } });
  const edited = (await api("des", "GET", `/ism/records/${r1}`)).data.record;
  const editEvent = [...(edited?.history ?? [])].reverse().find((h: any) => h.action === "editó");
  check(
    "La corrección queda en el historial con quién y qué campos",
    editEvent?.byName === "Timonel Uno" && String(editEvent?.reason).includes("Ronda de seguridad de cubierta 02"),
    editEvent,
  );
  const again = await api("tri", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "5826", signer: juan.id });
  check("Corrige, firma de nuevo y vuelve al Capitán", again.data.record?.status === "por_capitan", [again.status, again.data.message]);
  const wrongCap = await api("cap", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "1111" });
  check("El Capitán con clave errada no firma", wrongCap.status === 403, wrongCap.status);
  const capSign = await api("cap", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "7391" });
  check("El Capitán firma con su cuenta y su clave", capSign.data.record?.status === "por_oficina", [capSign.status, capSign.data.message]);
  for (const who of ["duena", "cap", "tri"]) {
    const r = await api(who, "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "2468" });
    check(`${people[who][1]} no firma como Persona Designada (API)`, r.status === 403, r.status);
  }
  const back2 = await api("des", "POST", `/ism/records/${r1}/return`, { reason: "Falta revisar la hora del zarpe" });
  check(
    "La Persona Designada devuelve al Capitán y anula su firma",
    back2.data.record?.status === "por_capitan" &&
      !back2.data.record?.signatures?.some((s: any) => s.stage === "capitan") &&
      back2.data.record?.signatures?.some((s: any) => s.stage === "tripulacion"),
    back2.data.record?.status,
  );
  await api("cap", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "7391" });
  const arch = await api("des", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "2468" });
  check("La Persona Designada firma y archiva", arch.data.record?.status === "archivado", [arch.status, arch.data.message]);
  const edit = await api("tri", "PATCH", `/ism/records/${r1}`, { answers: { "ronda.drizas": { value: "no", descripcion: "x", accion: "y" } } });
  const reSign = await api("des", "POST", `/ism/records/${r1}/sign-step`, { image: PNG, pin: "2468" });
  const reBack = await api("des", "POST", `/ism/records/${r1}/return`, { reason: "x", section: "Firmas" });
  const del = await api("tri", "DELETE", `/ism/records/${r1}`);
  check("Archivado: ya no se edita, firma, devuelve ni borra", [edit.status, reSign.status, reBack.status, del.status].every((s) => s >= 400), [edit.status, reSign.status, reBack.status, del.status]);
  const archPdf = await fetch(`${base}/ism/records/${r1}/pdf`, { headers: { Authorization: `Bearer ${tokens.des}` } });
  check(
    "El PDF archivado sale con el nombre de la fecha y hora de la actividad",
    (archPdf.headers.get("content-disposition") ?? "").includes("R-14_20261029_0610.pdf"),
    archPdf.headers.get("content-disposition"),
  );
  const archBytes = await archPdf.arrayBuffer();
  if (process.env.SAVE_PDF) {
    const fs = await import("fs");
    fs.writeFileSync(`${process.env.SAVE_PDF}/archivado.pdf`, Buffer.from(archBytes));
  }
  // ---- PDF archivado congelado e historial de solo agregar (punto 3) ----
  const crypto = await import("crypto");
  const sha = (b: ArrayBuffer | Buffer) => crypto.createHash("sha256").update(Buffer.from(b as ArrayBuffer)).digest("hex");
  const archDoc = await IsmRecord.findById(r1);
  check("Al archivar se guarda el PDF con su sha256", Boolean(archDoc?.archivedPdf?.fileId) && archDoc?.archivedPdf?.sha256 === sha(archBytes), archDoc?.archivedPdf?.sha256);
  check("La descarga trae la huella sha256", archPdf.headers.get("x-content-sha256") === archDoc?.archivedPdf?.sha256);
  // Aunque algo cambie después (código, plantilla o un dato tocado en la base), se sirve el mismo archivo.
  await IsmRecord.collection.updateOne({ _id: archDoc!._id }, { $set: { "context.place": "Otro lugar" } });
  const again2 = await fetch(`${base}/ism/records/${r1}/pdf`, { headers: { Authorization: `Bearer ${tokens.cap}` } });
  check("El PDF archivado es siempre el mismo archivo", sha(await again2.arrayBuffer()) === sha(archBytes));
  // Registro archivado antes del cambio: se congela en la primera descarga.
  const { default: mg } = await import("mongoose");
  await IsmRecord.collection.updateOne({ _id: archDoc!._id }, { $set: { archivedPdf: null } });
  const legacyPdf = await fetch(`${base}/ism/records/${r1}/pdf`, { headers: { Authorization: `Bearer ${tokens.des}` } });
  const legacyBytes = await legacyPdf.arrayBuffer();
  const legacyDoc = await IsmRecord.findById(r1);
  const legacyAgain = await fetch(`${base}/ism/records/${r1}/pdf`, { headers: { Authorization: `Bearer ${tokens.des}` } });
  check(
    "Archivado de antes: se congela en la primera descarga",
    Boolean(legacyDoc?.archivedPdf?.sha256) && legacyDoc?.archivedPdf?.sha256 === sha(legacyBytes) && sha(await legacyAgain.arrayBuffer()) === sha(legacyBytes),
  );
  check("Los archivos quedan en Mongo (GridFS)", (await mg.connection.db!.collection("ismPdf.files").countDocuments()) === 2);
  // Historial: solo agregar.
  const hDoc = await IsmRecord.findById(r1);
  const hLen = hDoc!.history.length;
  hDoc!.history[0]!.reason = "cambiado";
  const editHist = await hDoc!.save().then(() => "guardó", (e: Error) => e.message);
  const removeHist = await IsmRecord.findById(r1).then((d) => {
    d!.history.splice(1, 1);
    return d!.save().then(() => "guardó", (e: Error) => e.message);
  });
  const setHist = await IsmRecord.updateOne({ _id: r1 }, { $set: { "history.0.reason": "x" } }).then(() => "guardó", (e: Error) => e.message);
  const pullHist = await IsmRecord.updateOne({ _id: r1 }, { $pull: { history: { action: "creado" } } }).then(() => "guardó", (e: Error) => e.message);
  const unsetHist = await IsmRecord.updateOne({ _id: r1 }, { $unset: { history: 1 } }).then(() => "guardó", (e: Error) => e.message);
  check("No se modifica ni borra una entrada del historial", [editHist, removeHist, setHist, pullHist, unsetHist].every((m) => m.includes("solo admite agregar")), [editHist, removeHist, setHist, pullHist, unsetHist]);
  const pushHist = await IsmRecord.updateOne({ _id: r1 }, { $push: { history: { action: "nota", by: null, byName: "x", at: new Date(), reason: "", section: "" } } });
  const appended = await IsmRecord.findById(r1).then((d) => {
    d!.history.push({ action: "nota 2", by: null, byName: "x", at: new Date(), reason: "", section: "" });
    return d!.save().then(() => "guardó", (e: Error) => e.message);
  });
  const hAfter = await IsmRecord.findById(r1);
  check("Agregar eventos sí se puede ($push)", pushHist.modifiedCount === 1 && appended === "guardó" && hAfter!.history.length === hLen + 2 && hAfter!.history[0]!.reason !== "cambiado", [appended, hAfter!.history.length, hLen]);

  const archText = await pdfPages(archBytes);
  if (archText) {
    const annex = archText.slice(1).join("\n");
    check("El anexo dice que la clave se restableció antes de firmar", /clave restablecida el \d\d\/\d\d\/\d{4} \d\d:\d\d por Persona Designada/.test(annex), annex.match(/.*clave restablecida.*/)?.[0]);
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
