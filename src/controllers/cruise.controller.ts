import { NextFunction, Request, Response } from "express";
import { Cruise, CRUISE_STATUSES, CruiseStatus } from "../models/cruise.model";
import { CruiseStock } from "../models/cruiseStock.model";
import { loadCruiseStock } from "../services/inventory.service";
import { badRequest, notFound } from "../errors/httpError";

const DEFAULT_CABIN_COUNT = 9;

export async function listCruises(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.query.status as CruiseStatus | undefined;
    const filter = status ? { status } : {};
    const cruises = await Cruise.find(filter).sort({ startDate: -1 }).limit(100);
    res.json({ cruises });
  } catch (err) {
    next(err);
  }
}

/** Crucero activo (abordo) o el próximo planificado: el que usa la operación del bar. */
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

export async function createCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, startDate, cabinCount, notes } = req.body as {
      name?: string;
      startDate?: string;
      cabinCount?: number;
      notes?: string;
    };
    if (!name || !startDate) throw badRequest("Nombre y fecha de inicio son obligatorios");

    const count = cabinCount ?? DEFAULT_CABIN_COUNT;
    const cruise = await Cruise.create({
      name,
      startDate: new Date(startDate),
      notes: notes ?? "",
      cabins: Array.from({ length: count }, (_, i) => ({ number: i + 1 })),
      createdBy: req.auth!.sub,
    });
    res.status(201).json({ cruise });
  } catch (err) {
    next(err);
  }
}

export async function getCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    const stock = await CruiseStock.find({ cruise: cruise._id }).populate(
      "product",
      "name category icon unit price",
    );
    res.json({ cruise, stock });
  } catch (err) {
    next(err);
  }
}

export async function updateCruise(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, status, notes, endDate } = req.body as {
      name?: string;
      status?: CruiseStatus;
      notes?: string;
      endDate?: string | null;
    };
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");

    if (name !== undefined) cruise.name = name;
    if (notes !== undefined) cruise.notes = notes;
    if (endDate !== undefined) cruise.endDate = endDate ? new Date(endDate) : null;
    if (status !== undefined) {
      if (!CRUISE_STATUSES.includes(status)) throw badRequest("Estado inválido");
      cruise.status = status;
      if (status === "cerrado" && !cruise.endDate) cruise.endDate = new Date();
    }

    await cruise.save();
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

/** Actualiza los datos del huésped de una cabina (nombre, país, correo, teléfono). */
export async function updateCabin(req: Request, res: Response, next: NextFunction) {
  try {
    const cabinNumber = Number(req.params.cabinNumber);
    const { guestName, guestCount, country, email, phone } = req.body as Record<string, unknown>;

    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");

    const cabin = cruise.cabins.find((c) => c.number === cabinNumber);
    if (!cabin) throw notFound("Cabina no encontrada");

    if (typeof guestName === "string") cabin.guestName = guestName;
    if (typeof guestCount === "number") cabin.guestCount = guestCount;
    if (typeof country === "string") cabin.country = country;
    if (typeof email === "string") cabin.email = email;
    if (typeof phone === "string") cabin.phone = phone;

    await cruise.save();
    res.json({ cabin });
  } catch (err) {
    next(err);
  }
}

/** Carga de inventario al crucero (inicial o reabastecimiento en puerto). */
export async function loadStock(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, fromWarehouse } = req.body as {
      items?: Array<{ productId: string; qty: number }>;
      fromWarehouse?: boolean;
    };
    if (!items?.length) throw badRequest("No hay ítems para cargar");

    const cruise = await Cruise.findById(req.params.id);
    if (!cruise) throw notFound("Crucero no encontrado");
    if (cruise.status === "cerrado") throw badRequest("El crucero ya está cerrado");

    await loadCruiseStock(String(req.params.id), req.auth!.sub, items, fromWarehouse ?? true);
    const stock = await CruiseStock.find({ cruise: cruise._id }).populate(
      "product",
      "name category icon unit price",
    );
    res.json({ stock });
  } catch (err) {
    next(err);
  }
}
