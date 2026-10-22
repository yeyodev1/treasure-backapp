import { Types } from "mongoose";
import { Order } from "../models/order.model";

export interface AccountSummary {
  cabinNumber: number;
  orders: Array<{
    id: string;
    createdAt: Date;
    items: Array<{ name: string; qty: number; unitPrice: number; courtesy: boolean }>;
    total: number;
  }>;
  subtotal: number;
  courtesyTotal: number;
  total: number;
}

/** Cuenta acumulada de una cabina: todos los pedidos abiertos del crucero. */
export async function buildCabinAccount(
  cruiseId: Types.ObjectId | string,
  cabinNumber: number,
): Promise<AccountSummary> {
  const orders = await Order.find({
    cruise: cruiseId,
    cabinNumber,
    status: "abierta",
  }).sort({ createdAt: 1 });

  let subtotal = 0;
  let courtesyTotal = 0;

  const mapped = orders.map((order) => {
    let orderTotal = 0;
    for (const item of order.items) {
      const line = item.qty * item.unitPrice;
      if (item.courtesy) courtesyTotal += line;
      else orderTotal += line;
    }
    subtotal += orderTotal;
    return {
      id: order._id.toString(),
      createdAt: order.createdAt as Date,
      items: order.items.map((i) => ({
        name: i.name,
        qty: i.qty,
        unitPrice: i.unitPrice,
        courtesy: i.courtesy,
      })),
      total: orderTotal,
    };
  });

  return {
    cabinNumber,
    orders: mapped,
    subtotal,
    courtesyTotal,
    total: subtotal,
  };
}
