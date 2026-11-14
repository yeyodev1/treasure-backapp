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
import { chargesChanged, continuesToOf } from "../services/account.service";
import { badRequest, conflict, HttpError, notFound } from "../errors/httpError";
import { addDaysKey, commercialDateKey, ecuadorDateTime, TIMEZONE } from "../utils/dates";
import { EMAIL_ERROR, isValidOptionalEmail } from "../utils/email";
import { Types } from "mongoose";
import { User } from "../models/user.model";
import { CommissionPayment } from "../models/commissionPayment.model";

/** Bartender del crucero: un usuario activo con rol bartender, o null para quitarlo. */
async function resolveBartender(id: unknown) {
  if (id === null || id === "") return { bartender: null, bartenderName: "" };
  const user = typeof id === "string" && Types.ObjectId.isValid(id)
    ? await User.findOne({ _id: id, role: "bartender", active: true }).select("name")
    : null;
  if (!user) throw badRequest("Elige un bartender activo");
  return { bartender: user._id, bartenderName: user.name };
}

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

/** Ciclo viejo (A sábado→martes, C sábado→sábado) que pasa al de 13-nov-2026; lo que Gerencia ya cambió no se toca. */
const OLD_LEGS: Record<string, { label: string; durationDays: number }> = {
  A: { label: "Sábado a martes", durationDays: 3 },
  C: { label: "Sábado a sábado", durationDays: 7 },
};

async function getSettings() {
  const settings =
    (await CycleSettings.findOne({ key: "main" })) ??
    (await CycleSettings.create({ key: "main", legs: DEFAULT_LEGS, cabinCount: 9 }));
  let changed = false;
  for (const leg of settings.legs) {
    const old = OLD_LEGS[leg.code];
    const now = DEFAULT_LEGS.find((l) => l.code === leg.code);
    if (old && now && leg.label === old.label && leg.durationDays === old.durationDays) {
      leg.label = now.label;
      leg.durationDays = now.durationDays;
      changed = true;
    }
  }
  if (changed) {
    settings.markModified("legs");
    await settings.save();
  }
  return settings;
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

/** Día de zarpe de cada tramo (13-nov-2026): A viernes, B martes, C sábado. */
const LEG_WEEKDAY: Record<string, number> = { A: 5, B: 2, C: 6 };
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

/** Siguiente tipo del ciclo A → B → C → A. */
function nextLegCode(legs: ICycleLeg[], code: string): string {
  const i = legs.findIndex((l) => l.code === code);
  return legs[(i + 1) % legs.length]?.code ?? legs[0]!.code;
}

/** Próximas fechas de zarpe de un tipo desde un día (su día de la semana). */
function legDates(leg: ICycleLeg, fromKey: string, count: number): string[] {
  const expected = LEG_WEEKDAY[leg.code];
  let key = fromKey;
  if (expected !== undefined) {
    while (weekdayOf(key) !== expected) key = addDaysKey(key, 1);
  }
  return Array.from({ length: count }, (_, i) => addDaysKey(key, i * (expected === undefined ? 1 : 7)));
}

/**
 * GET /cruises/plan/options (pedido del cliente, 31-oct-2026): para Nuevo
 * crucero, las próximas fechas válidas de cada tipo (solo su día de zarpe),
 * cuáles están ocupadas y por qué crucero, y una sugerencia: el que sigue
 * en el ciclo al último programado o en curso, en su primera fecha libre.
 */
export async function newCruiseOptions(_req: Request, res: Response, next: NextFunction) {
  try {
    const settings = await getSettings();
    const today = commercialDateKey();
    const active = await Cruise.find({ status: { $in: ["planificado", "abordo"] } })
      .select("code leg name status startDate endDate")
      .sort({ startDate: 1 });

    const busy = (start: Date, end: Date) =>
      active.find((c) => c.startDate < end && (c.endDate ? c.endDate > start : c.startDate >= start)) ?? null;

    const legs = settings.legs.map((leg) => {
      const expected = LEG_WEEKDAY[leg.code];
      const dates = legDates(leg, today, 10).map((date) => {
        const endKey = addDaysKey(date, leg.durationDays);
        const conflict = busy(ecuadorDateTime(date, leg.departureTime), ecuadorDateTime(endKey, leg.departureTime));
        return {
          date,
          endDate: endKey,
          free: !conflict,
          conflict: conflict
            ? { _id: conflict._id, code: conflict.code, name: conflict.name, status: conflict.status, startDate: conflict.startDate, endDate: conflict.endDate }
            : null,
        };
      });
      return {
        code: leg.code,
        label: leg.label,
        routeFrom: leg.routeFrom,
        routeTo: leg.routeTo,
        durationDays: leg.durationDays,
        departureTime: leg.departureTime,
        weekday: expected === undefined ? "" : WEEKDAYS[expected]!,
        dates,
      };
    });

    // Sugerencia: continúa el ciclo desde el último crucero programado o en curso.
    const last = [...active].sort((a, b) => (b.endDate ?? b.startDate).getTime() - (a.endDate ?? a.startDate).getTime())[0];
    const lastAny = last ?? (await Cruise.findOne({ leg: { $ne: "" } }).sort({ startDate: -1 }).select("leg endDate startDate"));
    const legCode = lastAny?.leg ? nextLegCode(settings.legs, lastAny.leg) : settings.legs[0]!.code;
    const fromKey = last?.endDate ? [commercialDateKey(last.endDate), today].sort().pop()! : today;
    const suggestedLeg = settings.legs.find((l) => l.code === legCode)!;
    let suggestion: { leg: string; startDate: string } | null = null;
    for (const date of legDates(suggestedLeg, fromKey, 12)) {
      const end = addDaysKey(date, suggestedLeg.durationDays);
      if (!busy(ecuadorDateTime(date, suggestedLeg.departureTime), ecuadorDateTime(end, suggestedLeg.departureTime))) {
        suggestion = { leg: legCode, startDate: date };
        break;
      }
    }

    res.json({ legs, suggestion, cabinCount: settings.cabinCount });
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
    const { leg, startDate, bartender } = req.body as { leg?: string; startDate?: string; bartender?: string };
    const { plan, cabinCount } = await reviewNewCruise(leg, startDate);
    const crew = bartender ? await resolveBartender(bartender) : {};
    // Pedido del cliente (31-oct-2026): los cruceros solo inician y terminan
    // viernes, sábado o martes; cada tipo zarpa en su día, sin excepciones.
    if (!plan.weekday.ok) {
      throw new HttpError(
        400,
        `El crucero ${plan.leg} zarpa los ${plan.weekday.expected.endsWith("s") ? plan.weekday.expected : `${plan.weekday.expected}s`} y el ${dayLabel(startDate!)} es ${plan.weekday.actual}.`,
        "dia_distinto",
        { expected: plan.weekday.expected, actual: plan.weekday.actual },
      );
    }
    if (plan.overlap) throw new HttpError(409, overlapMessage(plan.overlap), "solapa", { cruise: plan.overlap });

    const cruise = await Cruise.create({
      code: plan.code,
      leg: plan.leg,
      routeFrom: plan.routeFrom,
      routeTo: plan.routeTo,
      name: plan.name,
      startDate: plan.startDate,
      endDate: plan.endDate,
      cabins: Array.from({ length: cabinCount }, (_, i) => ({ number: i + 1 })),
      ...crew,
      createdBy: req.auth!.sub,
    });
    await logEvent(req.auth, {
      kind: "salida",
      title: `Crucero creado · ${cruise.code}`,
      detail: `${plan.routeFrom} → ${plan.routeTo} · ${dayLabel(startDate!)} a ${dayLabel(plan.endKey)}`,
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
    const { name, status, notes, bartender } = req.body as {
      name?: string;
      status?: CruiseStatus;
      notes?: string;
      bartender?: string | null;
    };
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (status !== undefined && status !== cruise.status) {
      throw badRequest("Usa Iniciar crucero o Finalizar operación del crucero para cambiar el estado");
    }

    if (name !== undefined) cruise.name = name;
    if (notes !== undefined) cruise.notes = notes;
    if (bartender !== undefined && String(bartender ?? "") !== String(cruise.bartender ?? "")) {
      // La comisión ya pagada queda a nombre de quien la cobró.
      if (await CommissionPayment.exists({ status: "vigente", "items.cruise": cruise._id })) {
        throw conflict("La comisión de este crucero ya se pagó: anula ese pago para cambiar el bartender");
      }
      Object.assign(cruise, await resolveBartender(bartender));
    }
    await cruise.save();
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Identidad de un pasajero para no repetirlo en la salida (identificación o nombre). */
const keyOf = (p: { name: string; idNumber: string }) =>
  p.idNumber ? `id:${p.idNumber.replace(/\s|-/g, "").toLowerCase()}` : `n:${normalizeName(p.name)}`;

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
  // Crucero unido: la cabina que sigue en otro crucero no se cobra aquí.
  const continuesTo = await continuesToOf(cruise._id);

  const cabins = cruise.cabins.map((cabin) => {
    const charges = orders.filter((o) => o.cabinNumber === cabin.number);
    const consumed = round2(charges.reduce((s, o) => s + o.total, 0));
    const paid = round2(
      payments.filter((p) => p.cabinNumber === cabin.number).reduce((s, p) => s + p.total, 0),
    );
    const status = accounts.find((a) => a.cabinNumber === cabin.number)?.status ?? "abierta";
    const next = continuesTo.get(cabin.number) ?? null;
    return {
      number: cabin.number,
      guestName: cabin.guestName,
      passengers: cabin.passengers.length,
      consumed,
      paid,
      due: next ? 0 : round2(consumed - paid),
      accountStatus: next ? "continua" : charges.length ? status : "sin_consumos",
      continuesTo: next,
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

    // Cabina unida que recibe gente distinta a la de origen: ya no es la misma cuenta (12-nov-2026).
    let unlinked = "";
    if (cabin.continuesFrom && clean.length) {
      const origin = await Cruise.findById(cabin.continuesFrom.cruise).select("code name cabins.number cabins.passengers");
      const from = origin?.cabins.find((c) => c.number === cabin.continuesFrom!.cabinNumber);
      const before = new Set((from?.passengers ?? []).map(keyOf));
      if (!clean.some((p) => before.has(keyOf(p)))) {
        unlinked = origin?.code || origin?.name || "el crucero anterior";
        cabin.continuesFrom = null;
      }
    }
    cabin.passengers = clean as never;
    cabin.guestName = cabinDisplayName(cabin);
    await cruise.save();
    if (unlinked) {
      await chargesChanged(cruise._id, cabinNumber, req.auth!.sub, `Pasajeros nuevos: ya no suma lo de ${unlinked}`);
    }

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

type ContinuationLink = { to?: number; fromCruise?: string | null; fromCabin?: number };

/**
 * Crucero unido (pedido del cliente, 6-nov-2026): las cabinas de este crucero
 * siguen de cabinas de un crucero anterior. Todo el barco, solo algunas, o
 * con cambio de cabina. La cuenta es una sola y se cobra al final.
 * `fromCruise: null` deshace la unión. Una cabina vacía recibe los pasajeros
 * de la de origen.
 */
export async function updateContinuations(req: Request, res: Response, next: NextFunction) {
  try {
    const { links } = req.body as { links?: ContinuationLink[] };
    if (!Array.isArray(links) || !links.length) throw badRequest("Indica las cabinas a unir");

    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "cerrado") throw conflict("El crucero está finalizado: ya no se une");
    const name = cruise.code || cruise.name;

    const targets = links.map((link) => {
      const cabin = cruise.cabins.find((c) => c.number === Number(link.to));
      if (!cabin) throw badRequest(`La cabina ${link.to} no existe en ${name}`);
      return { link, cabin, before: cabin.continuesFrom ? `${cabin.continuesFrom.cruise}:${cabin.continuesFrom.cabinNumber}` : "" };
    });
    // Primero se sueltan todas: así un cambio de cabina entre dos (3 ↔ 5) no choca consigo mismo.
    for (const t of targets) t.cabin.continuesFrom = null;

    const origins = new Map<string, InstanceType<typeof Cruise>>();
    const lines: string[] = [];
    const changed: number[] = [];
    for (const { link, cabin, before } of targets) {
      if (link.fromCruise) {
        if (!Types.ObjectId.isValid(link.fromCruise)) throw badRequest("Crucero de origen inválido");
        if (cruise._id.equals(link.fromCruise)) throw badRequest("Una cabina no continúa de su mismo crucero");
        const origin = origins.get(link.fromCruise) ?? (await Cruise.findById(link.fromCruise));
        if (!origin) throw notFound("Crucero de origen no encontrado");
        origins.set(link.fromCruise, origin);
        const originName = origin.code || origin.name;
        if (origin.startDate >= cruise.startDate) throw badRequest(`${originName} no es anterior a ${name}`);
        const fromCabin = origin.cabins.find((c) => c.number === Number(link.fromCabin));
        if (!fromCabin) throw badRequest(`La cabina ${link.fromCabin} no existe en ${originName}`);
        // Cabina vacía en origen: no hay nadie que continúe; unirla arrastraría consumos de prueba (12-nov-2026).
        if (!fromCabin.passengers.length) {
          lines.push(`cabina ${cabin.number}: ${originName} cabina ${fromCabin.number} no tenía pasajeros, no se une`);
          if (before) changed.push(cabin.number);
          continue;
        }

        const sameHere = cruise.cabins.find(
          (c) => c.continuesFrom?.cruise.equals(origin._id) && c.continuesFrom.cabinNumber === fromCabin.number,
        );
        const elsewhere = await Cruise.findOne({
          _id: { $ne: cruise._id },
          cabins: { $elemMatch: { "continuesFrom.cruise": origin._id, "continuesFrom.cabinNumber": fromCabin.number } },
        }).select("code name");
        if (sameHere || elsewhere) {
          const where = sameHere ? `la cabina ${sameHere.number} de ${name}` : elsewhere!.code || elsewhere!.name;
          throw badRequest(`La cabina ${fromCabin.number} de ${originName} ya sigue en ${where}`);
        }

        cabin.continuesFrom = { cruise: origin._id, cabinNumber: fromCabin.number };
        if (!cabin.passengers.length && fromCabin.passengers.length) {
          cabin.passengers = fromCabin.passengers.map((p) => ({
            name: p.name,
            country: p.country,
            nationality: p.nationality,
            idNumber: p.idNumber,
            email: p.email,
            phone: p.phone,
            isPayer: p.isPayer,
          })) as never;
          cabin.capacity = Math.max(cabin.capacity, fromCabin.capacity, cabin.passengers.length);
          cabin.guestName = cabinDisplayName(cabin);
        }
        lines.push(`cabina ${cabin.number} ← ${originName} cabina ${fromCabin.number}`);
      } else if (before) {
        lines.push(`cabina ${cabin.number}: ya no continúa`);
      }
      const after = cabin.continuesFrom ? `${cabin.continuesFrom.cruise}:${cabin.continuesFrom.cabinNumber}` : "";
      if (after !== before) changed.push(cabin.number);
    }

    // Los pasajeros traídos no pueden quedar repetidos en dos cabinas de la salida.
    const seen = new Map<string, number>();
    for (const cabin of cruise.cabins) {
      for (const p of cabin.passengers) {
        const other = seen.get(keyOf(p));
        if (other !== undefined) throw badRequest(`${p.name} quedaría en las cabinas ${other} y ${cabin.number}: corrige los pasajeros primero`);
        seen.set(keyOf(p), cabin.number);
      }
    }

    await cruise.save();
    // La cuenta cambió de contenido: si estaba revisada o aprobada, vuelve a revisarse.
    for (const n of changed) await chargesChanged(cruise._id, n, req.auth!.sub, "Crucero unido: cambió lo que suma la cuenta");

    if (lines.length) {
      await logEvent(req.auth, {
        kind: "salida",
        title: `Crucero unido · ${name}`,
        detail: lines.join(" · "),
        cruise: cruise._id,
      });
    }
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}
