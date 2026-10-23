import { NextFunction, Request, Response } from "express";
import { Cruise } from "../models/cruise.model";
import { buildCabinAccount } from "../services/account.service";
import { notFound } from "../errors/httpError";

/**
 * Cuenta pública de una cabina: el pasajero escanea el QR en la tablet
 * y abre su consumo en su celular, sin registrarse.
 */
export async function publicAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.params;
    const cruise = await Cruise.findOne({ "cabins.accountToken": token }).select(
      "name code status cabins",
    );
    if (!cruise) throw notFound("Cuenta no encontrada");

    const cabin = cruise.cabins.find((c) => c.accountToken === token);
    if (!cabin) throw notFound("Cuenta no encontrada");

    const account = await buildCabinAccount(cruise._id, cabin.number);
    res.json({
      cruiseName: cruise.code ? `Salida ${cruise.code}` : cruise.name,
      cabinNumber: cabin.number,
      guestName: cabin.guestName,
      account: {
        cabinNumber: account.cabinNumber,
        orders: account.orders.map((o) => ({
          id: o.id,
          createdAt: o.createdAt,
          total: o.total,
          items: o.items
            .filter((i) => i.chargeableQty > 0)
            .map((i) => ({
              name: i.name,
              qty: i.chargeableQty,
              unitPrice: i.unitPrice,
              courtesy: i.courtesy,
            })),
        })),
        subtotal: account.subtotal,
        courtesyTotal: account.courtesyTotal,
        total: account.total,
      },
    });
  } catch (err) {
    next(err);
  }
}
