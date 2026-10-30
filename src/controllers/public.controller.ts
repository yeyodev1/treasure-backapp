import { NextFunction, Request, Response } from "express";
import { Cruise } from "../models/cruise.model";
import { buildCabinAccount } from "../services/account.service";
import { englishItemName } from "../services/proforma.service";
import { notFound } from "../errors/httpError";

/**
 * Cuenta pública de una cabina: el pasajero escanea el QR en la tablet
 * y abre su consumo en su celular, sin registrarse. En inglés, como la
 * prefactura: total, pagos y saldo.
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
    // Pagado y abierto juntos: el pasajero ve total, pagos y saldo (checklist 29-oct, 22).
    const orders = [...account.paidOrders, ...account.orders].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    res.json({
      cruiseName: cruise.code ? `Cruise ${cruise.code}` : cruise.name,
      cabinNumber: cabin.number,
      guestName: cabin.guestName,
      account: {
        cabinNumber: account.cabinNumber,
        orders: orders.map((o) => ({
          id: o.id,
          createdAt: o.createdAt,
          total: o.total,
          items: o.items
            .filter((i) => i.chargeableQty > 0)
            .map((i) => ({
              name: englishItemName(i.name),
              qty: i.chargeableQty,
              unitPrice: i.unitPrice,
              courtesy: i.courtesy,
            })),
        })),
        // Solo fecha, medio e importe: sin referencias ni datos de facturación.
        payments: account.payments.map((p) => ({
          createdAt: p.createdAt,
          method: p.method,
          total: p.total,
        })),
        subtotal: account.consumed,
        courtesyTotal: account.courtesyAll,
        total: account.consumed,
        paid: account.paid,
        due: account.due,
      },
    });
  } catch (err) {
    next(err);
  }
}
