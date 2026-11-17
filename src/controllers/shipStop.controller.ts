import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { SHIP_STOP_KINDS, ShipStop, ShipStopKind } from "../models/shipStop.model";
import { badRequest, notFound } from "../errors/httpError";
import { localDateTime } from "../utils/dates";

const DAY_MS = 24 * 3600_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Paras y diques; con `?year=AAAA` solo los que tocan ese año. */
export async function listShipStops(req: Request, res: Response, next: NextFunction) {
  try {
    const year = Number(req.query.year);
    const filter = Number.isInteger(year) && year > 2000
      ? { from: { $lte: localDateTime(`${year}-12-31`, "23:59") }, to: { $gte: localDateTime(`${year}-01-01`) } }
      : {};
    const stops = await ShipStop.find(filter).sort({ from: 1 }).limit(500).lean();
    res.json({
      stops: stops.map((s) => ({
        id: s._id.toString(),
        kind: s.kind,
        from: s.from,
        to: s.to,
        note: s.note,
        createdByName: s.createdByName,
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function createShipStop(req: Request, res: Response, next: NextFunction) {
  try {
    const { kind, from, to, note } = req.body as { kind?: string; from?: string; to?: string; note?: string };
    if (!SHIP_STOP_KINDS.includes(kind as ShipStopKind)) throw badRequest("Elige si es para o dique");
    if (!DAY_KEY.test(String(from)) || !DAY_KEY.test(String(to))) throw badRequest("Elige las fechas desde y hasta");
    // Mediodía en Galápagos: la fecha no cambia de día por la zona horaria.
    const start = localDateTime(from!, "12:00");
    const end = localDateTime(to!, "12:00");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest("Fecha inválida");
    if (start > end) throw badRequest("La fecha «hasta» no puede ser antes de «desde»");
    if (end.getTime() - start.getTime() > 366 * DAY_MS) throw badRequest("Máximo un año por registro");
    const text = String(note ?? "").trim();
    if (text.length > 200) throw badRequest("La nota es muy larga (máximo 200 letras)");

    const stop = await ShipStop.create({
      kind,
      from: start,
      to: end,
      note: text,
      createdBy: new Types.ObjectId(req.auth!.sub),
      createdByName: req.auth!.name,
    });
    res.status(201).json({ id: stop._id.toString() });
  } catch (err) {
    next(err);
  }
}

export async function deleteShipStop(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id)) throw notFound("Registro no encontrado");
    const deleted = await ShipStop.findByIdAndDelete(id);
    if (!deleted) throw notFound("Registro no encontrado");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
