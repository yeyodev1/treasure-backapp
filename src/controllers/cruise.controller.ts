import { NextFunction, Request, Response } from "express";
import {
  cabinDisplayName,
  Cruise,
  CruiseStatus,
  IPassenger,
} from "../models/cruise.model";
import { CycleSettings, DEFAULT_LEGS, ICycleLeg } from "../models/cycleSettings.model";
import { Product } from "../models/product.model";
import { Order } from "../models/order.model";
import { Payment } from "../models/payment.model";
import { Account } from "../models/account.model";
import { Device } from "../models/device.model";
import { onboardAvailability } from "../services/inventory.service";
import { round2 } from "../utils/units";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, HttpError, notFound } from "../errors/httpError";
import { addDaysKey, ecuadorDateTime, TIMEZONE } from "../utils/dates";
import { EMAIL_ERROR, isValidOptionalEmail } from "../utils/email";

export async function listCruises(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.query.status as CruiseStatus | undefined;
    const filter = status ? { status } : {};
    const cruises = await Cruise.find(filter).sort({ startDate: 1 }).limit(200);
    res.json({ cruises });
  } catch (err) {
    next(err);
  }
}

/** Salida a bordo o, si no hay, la próxima planificada. */
export async function activeCruise(_req: Request, res: Response, next: NextFunction) {
  try {
    const cruise =
      (await Cruise.findOne({ status: "abordo" }).sort({ startDate: -1 })) ??
      (await Cruise.findOne({ status: "planificado" }).sort({ startDate: 1 }));
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

export async function getCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

async function getSettings() {
  return (
    (await CycleSettings.findOne({ key: "main" })) ??
    (await CycleSettings.create({ key: "main", legs: DEFAULT_LEGS, cabinCount: 9 }))
  );
}

export async function cycleSettings(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ settings: await getSettings() });
  } catch (err) {
    next(err);
  }
}

export async function updateCycleSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const { legs, cabinCount } = req.body as { legs?: ICycleLeg[]; cabinCount?: number };
    const settings = await getSettings();
    if (legs) {
      if (legs.length !== 3) throw badRequest("El ciclo tiene tres tramos: A, B y C");
      for (const leg of legs) {
        if (!leg.routeFrom || !leg.routeTo) throw badRequest("Cada tramo necesita origen y destino");
        if (!(leg.durationDays >= 1)) throw badRequest("La duración debe ser de al menos 1 día");
        if (!/^\d{2}:\d{2}$/.test(leg.departureTime)) throw badRequest("Hora de zarpe inválida");
      }
      settings.legs = legs;
    }
    if (cabinCount !== undefined) {
      if (!(cabinCount >= 1)) throw badRequest("Número de cabinas inválido");
      settings.cabinCount = cabinCount;
    }
    await settings.save();
    await logEvent(req.auth, { kind: "salida", title: "Ciclo de salidas actualizado" });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

/** Día de zarpe de cada tramo (guía V3): A y C zarpan sábado, B martes. */
const LEG_WEEKDAY: Record<string, number> = { A: 6, B: 2, C: 6 };
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** "7 nov" para mensajes (fecha de Galápagos). */
function dayLabel(date: string | Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    day: "numeric",
    month: "short",
    timeZone: typeof date === "string" ? "UTC" : TIMEZONE,
  })
    .format(typeof date === "string" ? new Date(`${date}T12:00:00Z`) : date)
    .replace(".", "");
}

function isDateKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/**
 * Código, ruta y fechas del próximo crucero de un tramo que zarpa ese día.
 * Lo usan el generador del ciclo y Nuevo crucero: una sola regla.
 */
async function planLeg(leg: ICycleLeg, dateKey: string) {
  const endKey = addDaysKey(dateKey, leg.durationDays);
  const sequence = (await Cruise.countDocuments({ leg: leg.code })) + 1;
  const code = `${leg.code}-${String(sequence).padStart(3, "0")}`;
  return {
    code,
    leg: leg.code,
    routeFrom: leg.routeFrom,
    routeTo: leg.routeTo,
    name: `${code} · ${leg.routeFrom} → ${leg.routeTo}`,
    startDate: ecuadorDateTime(dateKey, leg.departureTime),
    endDate: ecuadorDateTime(endKey, leg.departureTime),
    endKey,
  };
}

/** Crucero programado o en curso que se cruza con ese rango (tocarse en el zarpe no cuenta). */
async function overlappingCruise(start: Date, end: Date) {
  return Cruise.findOne({
    status: { $in: ["planificado", "abordo"] },
    startDate: { $lt: end },
    $or: [{ endDate: { $gt: start } }, { endDate: null, startDate: { $gte: start } }],
  })
    .sort({ startDate: 1 })
    .select("code name status startDate endDate");
}

/** Vista previa y validación de Nuevo crucero (tipo + fecha de inicio). */
async function reviewNewCruise(legCode: unknown, startKey: unknown) {
  if (typeof legCode !== "string" || !legCode) throw badRequest("Elige el tipo de crucero: A, B o C");
  if (!isDateKey(startKey)) throw badRequest("Elige la fecha de inicio");
  const settings = await getSettings();
  const leg = settings.legs.find((l) => l.code === legCode);
  if (!leg) throw badRequest(`No existe el crucero tipo ${legCode}`);

  const plan = await planLeg(leg, startKey);
  const expected = LEG_WEEKDAY[leg.code];
  const actual = weekdayOf(startKey);
  const overlap = await overlappingCruise(plan.startDate, plan.endDate);
  return {
    leg,
    plan: {
      ...plan,
      label: leg.label,
      durationDays: leg.durationDays,
      departureTime: leg.departureTime,
      cabinCount: settings.cabinCount,
      weekday: {
        ok: expected === undefined || expected === actual,
        expected: expected === undefined ? "" : WEEKDAYS[expected]!,
        actual: WEEKDAYS[actual]!,
      },
      overlap: overlap
        ? {
            _id: overlap._id,
            code: overlap.code,
            name: overlap.name,
            status: overlap.status,
            startDate: overlap.startDate,
            endDate: overlap.endDate,
          }
        : null,
    },
    cabinCount: settings.cabinCount,
  };
}

function overlapMessage(overlap: { code: string; name: string; status: string; startDate: Date; endDate: Date | null }) {
  const state = overlap.status === "abordo" ? "en curso" : "programado";
  const dates = `${dayLabel(overlap.startDate)}${overlap.endDate ? ` → ${dayLabel(overlap.endDate)}` : ""}`;
  return `Se cruza con el crucero ${overlap.code || overlap.name} (${state}, ${dates}). Elige otra fecha de inicio.`;
}

/** GET /cruises/plan?leg=A&startDate=YYYY-MM-DD: fecha de fin, ruta, código y avisos. */
export async function previewNewCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { plan } = await reviewNewCruise(req.query.leg, req.query.startDate);
    res.json({ plan });
  } catch (err) {
    next(err);
  }
}

/**
 * Nuevo crucero: solo tipo y fecha de inicio; el resto sale de la
 * configuración del ciclo. No se cruza con otro programado o en curso; si el
 * día no es el de zarpe del tipo, se avisa y se crea solo si se confirma.
 */
export async function createNewCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { leg, startDate, acceptWeekday } = req.body as {
      leg?: string;
      startDate?: string;
      acceptWeekday?: boolean;
    };
    const { plan, cabinCount } = await reviewNewCruise(leg, startDate);
    if (plan.overlap) throw new HttpError(409, overlapMessage(plan.overlap), "solapa", { cruise: plan.overlap });
    if (!plan.weekday.ok && acceptWeekday !== true) {
      throw new HttpError(
        409,
        `El crucero ${plan.leg} zarpa en ${plan.weekday.expected} y el ${dayLabel(startDate!)} es ${plan.weekday.actual}.`,
        "dia_distinto",
        { expected: plan.weekday.expected, actual: plan.weekday.actual },
      );
    }

    const cruise = await Cruise.create({
      code: plan.code,
      leg: plan.leg,
      routeFrom: plan.routeFrom,
      routeTo: plan.routeTo,
      name: plan.name,
      startDate: plan.startDate,
      endDate: plan.endDate,
      cabins: Array.from({ length: cabinCount }, (_, i) => ({ number: i + 1 })),
      createdBy: req.auth!.sub,
    });
    await logEvent(req.auth, {
      kind: "salida",
      title: `Crucero creado · ${cruise.code}`,
      detail: `${plan.routeFrom} → ${plan.routeTo} · ${dayLabel(startDate!)} a ${dayLabel(plan.endKey)}${
        plan.weekday.ok ? "" : ` · zarpa ${plan.weekday.actual} (confirmado)`
      }`,
      cruise: cruise._id,
    });
    res.status(201).json({ cruise });
  } catch (err) {
    next(err);
  }
}

/**
 * Genera salidas repitiendo A → B → C desde la fecha de inicio de A.
 * No duplica: si ya existe la salida de ese tramo en esa fecha, la salta.
 * Los viajes cerrados no se tocan.
 */
export async function generateCycle(req: Request, res: Response, next: NextFunction) {
  try {
    const { startDate, until } = req.body as { startDate?: string; until?: string };
    if (!startDate || !until || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw badRequest("Indica la fecha de inicio del tramo A y hasta cuándo generar");
    }
    if (until < startDate) throw badRequest("La fecha final debe ser posterior al inicio");

    const settings = await getSettings();
    const created: string[] = [];
    let skipped = 0;
    let cursor = startDate;
    let legIndex = 0;
    let guard = 0;

    while (cursor <= until && guard < 300) {
      guard += 1;
      const leg = settings.legs[legIndex % settings.legs.length]!;
      const plan = await planLeg(leg, cursor);
      const dayStart = ecuadorDateTime(cursor, "00:00");
      const dayEnd = ecuadorDateTime(addDaysKey(cursor, 1), "00:00");

      const exists = await Cruise.findOne({
        leg: leg.code,
        startDate: { $gte: dayStart, $lt: dayEnd },
      }).select("_id");

      if (exists) {
        skipped += 1;
      } else {
        await Cruise.create({
          code: plan.code,
          leg: plan.leg,
          routeFrom: plan.routeFrom,
          routeTo: plan.routeTo,
          name: plan.name,
          startDate: plan.startDate,
          endDate: plan.endDate,
          cabins: Array.from({ length: settings.cabinCount }, (_, i) => ({ number: i + 1 })),
          createdBy: req.auth!.sub,
        });
        created.push(plan.code);
      }

      cursor = plan.endKey;
      legIndex += 1;
    }

    if (created.length) {
      await logEvent(req.auth, {
        kind: "salida",
        title: `${created.length} crucero(s) generados`,
        detail: created.join(", "),
      });
    }
    res.status(201).json({ created, skipped });
  } catch (err) {
    next(err);
  }
}

export async function createCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, startDate, cabinCount, notes } = req.body as {
      name?: string;
      startDate?: string;
      cabinCount?: number;
      notes?: string;
    };
    if (!name || !startDate) throw badRequest("Nombre y fecha de inicio son obligatorios");

    const cruise = await Cruise.create({
      code: "",
      name,
      startDate: ecuadorDateTime(startDate, "10:00"),
      notes: notes ?? "",
      cabins: Array.from({ length: cabinCount ?? 9 }, (_, i) => ({ number: i + 1 })),
      createdBy: req.auth!.sub,
    });
    await logEvent(req.auth, { kind: "salida", title: `Crucero creado · ${name}` });
    res.status(201).json({ cruise });
  } catch (err) {
    next(err);
  }
}

export async function updateCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, status, notes } = req.body as {
      name?: string;
      status?: CruiseStatus;
      notes?: string;
    };
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (status !== undefined && status !== cruise.status) {
      throw badRequest("Usa Iniciar crucero o Finalizar operación del crucero para cambiar el estado");
    }

    if (name !== undefined) cruise.name = name;
    if (notes !== undefined) cruise.notes = notes;
    await cruise.save();
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Problemas que impiden iniciar (bloquean) y avisos que no bloquean. */
async function startReview(cruise: InstanceType<typeof Cruise>) {
  const blockers: string[] = [];
  const occupied = cruise.cabins.filter((c) => c.passengers.length);
  if (!occupied.length) blockers.push("No hay pasajeros registrados en ninguna cabina");

  const seen = new Map<string, number>();
  for (const cabin of occupied) {
    if (!cabin.passengers.some((p) => p.isPayer)) blockers.push(`Cabina ${cabin.number}: falta el pagador`);
    if (cabin.passengers.length > cabin.capacity) {
      blockers.push(`Cabina ${cabin.number}: ${cabin.passengers.length} pasajeros y capacidad ${cabin.capacity}`);
    }
    for (const p of cabin.passengers) {
      const key = p.idNumber ? `id:${p.idNumber.replace(/\s|-/g, "").toLowerCase()}` : `n:${normalizeName(p.name)}`;
      const other = seen.get(key);
      if (other !== undefined) blockers.push(`${p.name} aparece en las cabinas ${other} y ${cabin.number}`);
      else seen.set(key, cabin.number);
    }
  }

  const other = await Cruise.findOne({ status: "abordo", _id: { $ne: cruise._id } }).select("code name");
  if (other) blockers.push(`El crucero ${other.code || other.name} sigue en curso: finaliza su operación primero`);

  // Avisos de stock: no bloquean el crucero, el bar ve "no disponible" por producto.
  const availability = await onboardAvailability();
  const sellable = await Product.find({ active: true, sellable: true, kind: { $ne: "servicio" } }).select("name");
  const unavailable = sellable
    .filter((p) => availability[p._id.toString()]?.available === false)
    .map((p) => `${p.name} (falta ${availability[p._id.toString()]!.missing})`);
  const low = await Product.find({
    kind: "fisico",
    active: true,
    lowStockThreshold: { $gt: 0 },
    $expr: { $lte: ["$onboardStock", "$lowStockThreshold"] },
  }).select("name onboardStock stockUnit");

  return {
    blockers,
    warnings: {
      unavailable,
      low: low.map((p) => `${p.name}: ${p.onboardStock} ${p.stockUnit} a bordo`),
    },
    occupancy: {
      cabins: cruise.cabins.length,
      occupied: occupied.length,
      passengers: occupied.reduce((s, c) => s + c.passengers.length, 0),
      empty: cruise.cabins.filter((c) => !c.passengers.length).map((c) => c.number),
    },
  };
}

/** Resumen previo a Iniciar crucero: ruta, fechas, ocupación, bloqueos y avisos. */
export async function startCheck(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    res.json({ cruise, ...(await startReview(cruise)) });
  } catch (err) {
    next(err);
  }
}

/**
 * Iniciar crucero: Programada pasa a En curso una sola vez (update
 * condicional + índice único de salida en curso). No crea compras ni toca stock.
 */
export async function startCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "abordo") {
      res.json({ cruise, duplicated: true });
      return;
    }
    if (cruise.status !== "planificado") throw conflict("Un crucero finalizado no se reinicia");
    const review = await startReview(cruise);
    if (review.blockers.length) throw badRequest(review.blockers.join(" · "));

    let started;
    try {
      started = await Cruise.findOneAndUpdate(
        { _id: cruise._id, status: "planificado" },
        { $set: { status: "abordo", startedAt: new Date(), startedBy: req.auth!.sub } },
        { new: true },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict("Ya hay otro crucero en curso");
      throw err;
    }
    if (!started) {
      const fresh = await Cruise.findById(cruise._id);
      res.json({ cruise: fresh, duplicated: true });
      return;
    }

    await logEvent(req.auth, {
      kind: "salida",
      title: `Crucero iniciado · ${started.code || started.name}`,
      detail: `${review.occupancy.passengers} pasajeros en ${review.occupancy.occupied} cabinas`,
      cruise: started._id,
    });
    res.json({ cruise: started, warnings: review.warnings });
  } catch (err) {
    next(err);
  }
}

const SILENT_DEVICE_MS = 10 * 60 * 1000;

/** Resumen de cierre: cuentas por cabina, envíos pendientes y equipos. */
async function finishReview(cruise: InstanceType<typeof Cruise>) {
  const [orders, payments, accounts, devices, held] = await Promise.all([
    Order.find({ cruise: cruise._id, status: { $in: ["entregada", "pendiente"] } }).select(
      "cabinNumber total payment",
    ),
    Payment.find({ cruise: cruise._id, status: "vigente" }).select("cabinNumber total"),
    Account.find({ cruise: cruise._id }).select("cabinNumber status"),
    Device.find({ $or: [{ cruise: cruise._id }, { pending: { $gt: 0 } }] }),
    Order.countDocuments({ cruise: cruise._id, status: "retenida" }),
  ]);

  const cabins = cruise.cabins.map((cabin) => {
    const charges = orders.filter((o) => o.cabinNumber === cabin.number);
    const consumed = round2(charges.reduce((s, o) => s + o.total, 0));
    const paid = round2(
      payments.filter((p) => p.cabinNumber === cabin.number).reduce((s, p) => s + p.total, 0),
    );
    const status = accounts.find((a) => a.cabinNumber === cabin.number)?.status ?? "abierta";
    return {
      number: cabin.number,
      guestName: cabin.guestName,
      passengers: cabin.passengers.length,
      consumed,
      paid,
      due: round2(consumed - paid),
      accountStatus: charges.length ? status : "sin_consumos",
    };
  });

  const now = Date.now();
  const deviceRows = devices.map((d) => ({
    deviceId: d.deviceId,
    label: (d.label || "").replace(/^Tablet bar/, "Tableta del bar") || d.userName || "Tableta del bar",
    userName: d.userName,
    pending: d.pending,
    lastSyncAt: d.lastSyncAt,
    lastSeenAt: d.lastSeenAt,
    silent: now - d.lastSeenAt.getTime() > SILENT_DEVICE_MS,
  }));
  const issues: string[] = [];
  for (const d of deviceRows) {
    if (d.pending > 0) issues.push(`${d.label}: ${d.pending} envío(s) sin confirmar`);
    else if (d.silent && d.lastSeenAt.getTime() > now - 24 * 3600 * 1000) {
      issues.push(`${d.label} no responde desde ${d.lastSeenAt.toISOString()}`);
    }
  }

  const totals = cabins.reduce(
    (t, c) => ({ consumed: t.consumed + c.consumed, paid: t.paid + c.paid, due: t.due + c.due }),
    { consumed: 0, paid: 0, due: 0 },
  );
  const finance =
    totals.due <= 0.005 && totals.consumed > 0
      ? "liquidada"
      : cabins.some((c) => c.accountStatus === "abierta" || c.accountStatus === "en_revision")
        ? "por_revisar"
        : "por_cobrar";

  return {
    cabins,
    devices: deviceRows,
    issues,
    held,
    finance,
    totals: { consumed: round2(totals.consumed), paid: round2(totals.paid), due: round2(totals.due) },
  };
}

export async function finishCheck(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    res.json({ cruise, ...(await finishReview(cruise)) });
  } catch (err) {
    next(err);
  }
}

/**
 * Finalizar crucero: En curso pasa a Finalizada y se bloquean nuevos
 * consumos (los tardíos quedan retenidos para revisión). Si hay equipos con
 * envíos pendientes o sin responder, el cierre excepcional exige motivo.
 * Las cuentas pendientes conservan su saldo: finalizar no las marca pagadas.
 */
export async function finishCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = (req.body?.reason as string | undefined)?.trim() ?? "";
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "cerrado") {
      res.json({ cruise, duplicated: true });
      return;
    }
    if (cruise.status !== "abordo") throw conflict("Solo se finaliza un crucero en curso");
    const review = await finishReview(cruise);
    if (review.issues.length && !reason) {
      throw badRequest(`Cierre excepcional: indica el motivo (${review.issues.join(" · ")})`);
    }

    const closed = await Cruise.findOneAndUpdate(
      { _id: cruise._id, status: "abordo" },
      {
        $set: {
          status: "cerrado",
          closedAt: new Date(),
          closedBy: req.auth!.sub,
          closeReason: reason,
        },
      },
      { new: true },
    );
    if (!closed) {
      res.json({ cruise: await Cruise.findById(cruise._id), duplicated: true });
      return;
    }

    await logEvent(req.auth, {
      kind: "salida",
      title: `Operación del crucero finalizada · ${closed.code || closed.name}`,
      detail: `Consumos ${review.totals.consumed} · cobrado ${review.totals.paid} · por cobrar ${review.totals.due}${
        reason ? ` · cierre excepcional: ${reason}` : ""
      }`,
      cruise: closed._id,
    });
    res.json({ cruise: closed, summary: review });
  } catch (err) {
    next(err);
  }
}

/** Pasajeros de una cabina: nombre, país, nacionalidad, pagador y contacto. */
export async function updatePassengers(req: Request, res: Response, next: NextFunction) {
  try {
    const cabinNumber = Number(req.params.cabinNumber);
    const { passengers } = req.body as { passengers?: Partial<IPassenger>[] };
    if (!Array.isArray(passengers)) throw badRequest("Lista de pasajeros inválida");

    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "cerrado") throw conflict("El crucero está finalizado: los pasajeros ya no se editan");
    const cabin = cruise.cabins.find((c) => c.number === cabinNumber);
    if (!cabin) throw notFound("Cabina no encontrada");

    // Correo vacío o válido; si no, no se guarda nada y se dice cuál revisar.
    const badEmail = passengers.find((p) => p.name?.trim() && !isValidOptionalEmail(p.email));
    if (badEmail) throw badRequest(`${badEmail.name!.trim()}: ${EMAIL_ERROR}`);

    const clean = passengers
      .filter((p) => p.name?.trim())
      .map((p) => ({
        name: p.name!.trim(),
        country: p.country?.trim() ?? "",
        nationality: p.nationality?.trim() ?? "",
        idNumber: p.idNumber?.trim() ?? "",
        email: typeof p.email === "string" ? p.email.trim() : "",
        phone: p.phone?.trim() ?? "",
        isPayer: Boolean(p.isPayer),
      }));
    const { capacity } = req.body as { capacity?: number };
    if (capacity !== undefined) {
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 6) throw badRequest("Capacidad inválida");
      cabin.capacity = capacity;
    }
    if (clean.length > cabin.capacity) {
      throw badRequest(`La cabina ${cabinNumber} admite ${cabin.capacity} pasajero(s)`);
    }
    // Sin duplicados dentro de la salida (misma identificación o mismo nombre).
    const keyOf = (p: { name: string; idNumber: string }) =>
      p.idNumber ? `id:${p.idNumber.replace(/\s|-/g, "").toLowerCase()}` : `n:${normalizeName(p.name)}`;
    const keys = new Set<string>();
    for (const p of clean) {
      const k = keyOf(p);
      if (keys.has(k)) throw badRequest(`${p.name} está repetido en la cabina`);
      keys.add(k);
    }
    for (const other of cruise.cabins) {
      if (other.number === cabinNumber) continue;
      const dup = other.passengers.find((p) => keys.has(keyOf(p)));
      if (dup) throw badRequest(`${dup.name} ya está registrado en la cabina ${other.number}`);
    }

    // Siempre hay exactamente un pagador si hay pasajeros.
    if (clean.length && !clean.some((p) => p.isPayer)) clean[0]!.isPayer = true;
    let payerSeen = false;
    for (const p of clean) {
      if (p.isPayer && payerSeen) p.isPayer = false;
      if (p.isPayer) payerSeen = true;
    }

    cabin.passengers = clean as never;
    cabin.guestName = cabinDisplayName(cabin);
    await cruise.save();

    await logEvent(req.auth, {
      kind: "salida",
      title: `Pasajeros · cabina ${cabinNumber}`,
      detail: `${cruise.code || cruise.name}: ${clean.length} pasajero(s)`,
      cruise: cruise._id,
      cabinNumber,
    });
    res.json({ cabin });
  } catch (err) {
    next(err);
  }
}
