import { NextFunction, Request, Response } from "express";
import { Cruise } from "../models/cruise.model";
import { buildCabinAccount } from "../services/account.service";
import { notFound } from "../errors/httpError";

/**
 * Cuenta pública de una cabina: el pasajero escanea el QR en la tablet
 * y abre este detalle en su propio celular, sin registrarse.
 */
export async function publicAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.params;
    const cruise = await Cruise.findOne({ "cabins.accountToken": token }).select(
      "name status cabins",
    );
    if (!cruise) throw notFound("Cuenta no encontrada");

    const cabin = cruise.cabins.find((c) => c.accountToken === token);
    if (!cabin) throw notFound("Cuenta no encontrada");

    const account = await buildCabinAccount(cruise._id, cabin.number);
    res.json({
      cruiseName: cruise.name,
      cabinNumber: cabin.number,
      guestName: cabin.guestName,
      account,
    });
  } catch (err) {
    next(err);
  }
}
