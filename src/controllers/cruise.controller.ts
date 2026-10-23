import { NextFunction, Request, Response } from "express";
import {
  cabinDisplayName,
  Cruise,
  CRUISE_STATUSES,
  CruiseStatus,
  IPassenger,
} from "../models/cruise.model";
import { CycleSettings, DEFAULT_LEGS, ICycleLeg } from "../models/cycleSettings.model";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { addDaysKey, ecuadorDateTime } from "../utils/dates";

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
    if (!cruise) throw notFound("Salida no encontrada");
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
      const start = ecuadorDateTime(cursor, leg.departureTime);
      const endKey = addDaysKey(cursor, leg.durationDays);
      const dayStart = ecuadorDateTime(cursor, "00:00");
      const dayEnd = ecuadorDateTime(addDaysKey(cursor, 1), "00:00");

      const exists = await Cruise.findOne({
        leg: leg.code,
        startDate: { $gte: dayStart, $lt: dayEnd },
      }).select("_id");

      if (exists) {
        skipped += 1;
      } else {
        const sequence = (await Cruise.countDocuments({ leg: leg.code })) + 1;
        const code = `${leg.code}-${String(sequence).padStart(3, "0")}`;
        await Cruise.create({
          code,
          leg: leg.code,
          routeFrom: leg.routeFrom,
          routeTo: leg.routeTo,
          name: `${code} · ${leg.routeFrom} → ${leg.routeTo}`,
          startDate: start,
          endDate: ecuadorDateTime(endKey, leg.departureTime),
          cabins: Array.from({ length: settings.cabinCount }, (_, i) => ({ number: i + 1 })),
          createdBy: req.auth!.sub,
        });
        created.push(code);
      }

      cursor = endKey;
      legIndex += 1;
    }

    if (created.length) {
      await logEvent(req.auth, {
        kind: "salida",
        title: `${created.length} salida(s) generadas`,
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
    await logEvent(req.auth, { kind: "salida", title: `Salida creada · ${name}` });
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
    if (!cruise) throw notFound("Salida no encontrada");

    if (name !== undefined) cruise.name = name;
    if (notes !== undefined) cruise.notes = notes;
    if (status !== undefined && status !== cruise.status) {
      if (!CRUISE_STATUSES.includes(status)) throw badRequest("Estado inválido");
      if (cruise.status === "cerrado") throw conflict("Una salida cerrada no se reabre");
      if (status === "abordo") {
        const other = await Cruise.findOne({ status: "abordo", _id: { $ne: cruise._id } });
        if (other) throw conflict(`Cierra primero la salida ${other.code || other.name}`);
      }
      cruise.status = status;
      if (status === "cerrado") cruise.endDate = cruise.endDate ?? new Date();
      await logEvent(req.auth, {
        kind: "salida",
        title: `Salida ${cruise.code || cruise.name} · ${status === "abordo" ? "a bordo" : status}`,
        cruise: cruise._id,
      });
    }

    await cruise.save();
    res.json({ cruise });
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
    if (!cruise) throw notFound("Salida no encontrada");
    if (cruise.status === "cerrado") throw conflict("La salida está cerrada");
    const cabin = cruise.cabins.find((c) => c.number === cabinNumber);
    if (!cabin) throw notFound("Cabina no encontrada");

    const clean = passengers
      .filter((p) => p.name?.trim())
      .map((p) => ({
        name: p.name!.trim(),
        country: p.country?.trim() ?? "",
        nationality: p.nationality?.trim() ?? "",
        idNumber: p.idNumber?.trim() ?? "",
        email: p.email?.trim() ?? "",
        phone: p.phone?.trim() ?? "",
        isPayer: Boolean(p.isPayer),
      }));
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
