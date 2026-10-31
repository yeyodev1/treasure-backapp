import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Order } from "../models/order.model";
import { Payment, PAYMENT_METHODS, PaymentMethod } from "../models/payment.model";
import { Cruise } from "../models/cruise.model";
import { User } from "../models/user.model";
import { Account } from "../models/account.model";
import { buildCabinAccount } from "../services/account.service";
import { contificoStatus, issueInvoice } from "../services/contifico.service";
import { logEvent } from "../services/audit.service";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { parseRangeEdge } from "../utils/dates";
import { isValidOptionalEmail } from "../utils/email";
import { sendAccountSummary } from "../services/accountEmail.service";


/** Cobra Dirección de crucero (guía auditada 27-oct-2026) o Gerencia. */
async function assertCanCollect(userId: string, role: string) {
  if (role === "duena") return;
  if (role === "direccion") {
    const user = await User.findById(userId).select("active");
    if (user?.active) return;
  }
  throw forbidden("Los cobros los registra Dirección de crucero o Gerencia");
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Monto pedido: vacío = saldo completo. */
function parseAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "string" ? Number(raw.replace(",", ".")) : Number(raw);
  if (!Number.isFinite(value) || round2(value) <= 0) {
    throw badRequest("Introduce una cantidad mayor que cero.");
  }
  return round2(value);
}

/**
 * Pagos parciales vigentes sobre los consumos abiertos de la cabina.
 * `parts`: undefined = todos; false = solo los que se facturan al completar
 * la cuenta (no las partes por porcentaje, que tienen su propia factura).
 */
async function partialPaidOf(cruiseId: string, cabinNumber: number, parts?: false) {
  const rows = await Payment.find({
    cruise: cruiseId,
    cabinNumber,
    status: "vigente",
    settled: false,
    ...(parts === false ? { part: { $ne: true } } : {}),
  }).select("total");
  return round2(rows.reduce((s, p) => s + p.total, 0));
}

/** Una forma de pago del cobro. Sin monto = lo que falta. */
interface PayLine {
  method?: PaymentMethod;
  amount?: number | string;
  reference?: string;
  cashConfirmed?: boolean;
}

interface CollectBody {
  cruiseId?: string;
  cabinNumber?: number;
  /** Cabinas que se cobran juntas a un solo pagador (una factura). */
  cabins?: number[];
  /** Solo estos consumos (lo de una persona de la cabina). */
  orderIds?: string[];
  /** Porcentaje de la cuenta que paga esta persona (con su propia factura). */
  percent?: number;
  /** Varias formas de pago en un mismo cobro. */
  lines?: PayLine[];
  // Forma anterior (un solo método): sigue funcionando.
  method?: PaymentMethod;
  amount?: number | string;
  reference?: string;
  cashConfirmed?: boolean;
  expectedDue?: number;
  billing?: { name?: string; idNumber?: string; email?: string; country?: string; passengerId?: string };
}

type CollectMode = "cuenta" | "consumos" | "porcentaje" | "grupo";

function cleanLines(body: CollectBody) {
  const raw: PayLine[] = Array.isArray(body.lines) && body.lines.length
    ? body.lines
    : [{ method: body.method, amount: body.amount, reference: body.reference, cashConfirmed: body.cashConfirmed }];
  if (raw.length > 6) throw badRequest("Máximo 6 formas de pago en un cobro");
  const lines = raw.map((l) => {
    if (!l.method) throw badRequest("Crucero, cabina y método de pago son obligatorios");
    if (!PAYMENT_METHODS.includes(l.method)) throw badRequest("Método de pago inválido");
    if (l.method === "efectivo" && !l.cashConfirmed) {
      throw badRequest("Con efectivo, confirma que el dinero ingresó a caja");
    }
    if (l.method === "transferencia" && !l.reference?.trim()) {
      throw badRequest("Indica la referencia de la transferencia");
    }
    return {
      method: l.method,
      amount: parseAmount(l.amount),
      reference: l.reference?.trim() ?? "",
      cashConfirmed: Boolean(l.cashConfirmed),
    };
  });
  const open = lines.filter((l) => l.amount === null);
  if (open.length > 1 || (open.length === 1 && lines[lines.length - 1]!.amount !== null)) {
    throw badRequest("Solo la última forma de pago puede ir sin monto (cubre lo que falta)");
  }
  return lines;
}

/**
 * Cobra una cuenta aprobada (checklist 29-oct, P05 y pedido del cliente,
 * 31-oct-2026). Un cobro puede:
 *
 * - tener varias formas de pago (`lines`: $10 efectivo + el resto tarjeta),
 *   con una sola factura y un cobro de Contífico por cada forma;
 * - cubrir la cuenta completa o solo una parte (`amount` menor que el saldo:
 *   pago parcial que se factura con el pago que completa la cuenta);
 * - cubrir solo algunos consumos (`orderIds`): lo de una persona, con su
 *   propia factura; la cuenta sigue aprobada para el resto;
 * - cubrir un porcentaje (`percent`): la parte de una persona, con su propia
 *   factura (consumos prorrateados); descuenta del saldo;
 * - cubrir varias cabinas a un mismo pagador (`cabins`): una sola factura.
 *
 * Anti doble clic: cada cuenta se toma de forma atómica (aprobada → cobrada)
 * y se libera si queda saldo o algo falla; `expectedDue` rechaza un segundo
 * clic con el saldo cambiado. Al completar la cuenta se envía el resumen.
 */
export async function collectCabin(req: Request, res: Response, next: NextFunction) {
  try {
    await assertCanCollect(req.auth!.sub, req.auth!.role);
    const body = req.body as CollectBody;
    const { cruiseId, billing, expectedDue } = body;
    const cabinList = Array.isArray(body.cabins) && body.cabins.length
      ? [...new Set(body.cabins.map(Number))]
      : body.cabinNumber
        ? [Number(body.cabinNumber)]
        : [];
    if (!cruiseId || !cabinList.length || cabinList.some((n) => !Number.isInteger(n) || n < 1)) {
      throw badRequest("Crucero, cabina y método de pago son obligatorios");
    }
    const lines = cleanLines(body);
    const orderIds = Array.isArray(body.orderIds) ? [...new Set(body.orderIds.map(String))] : null;
    const percent = body.percent === undefined || body.percent === null ? null : Number(body.percent);
    const mode: CollectMode = cabinList.length > 1 ? "grupo" : orderIds ? "consumos" : percent !== null ? "porcentaje" : "cuenta";
    if ([cabinList.length > 1, Boolean(orderIds), percent !== null].filter(Boolean).length > 1) {
      throw badRequest("Elige una sola forma de dividir: por consumos, por porcentaje o cabinas juntas");
    }
    if (mode === "porcentaje" && !(percent! > 0 && percent! <= 100)) {
      throw badRequest("El porcentaje va de 1 a 100");
    }
    if (mode === "consumos" && !orderIds!.length) throw badRequest("Elige los consumos que paga esta persona");

    const summaries = await Promise.all(cabinList.map((n) => buildCabinAccount(cruiseId, n)));
    for (const s of summaries) {
      if (!s.orders.length) {
        throw badRequest(cabinList.length > 1 ? `La cabina ${s.cabinNumber} no tiene consumos por cobrar` : "La cabina no tiene consumos abiertos");
      }
      if (!s.readyToCollect) {
        throw conflict(
          cabinList.length > 1
            ? `La cuenta de la cabina ${s.cabinNumber} debe estar aprobada antes de cobrar`
            : "La cuenta debe estar aprobada en su versión vigente antes de cobrar",
        );
      }
    }

    const cruise = await Cruise.findById(cruiseId);
    const firstCabin = cruise?.cabins.find((c) => c.number === cabinList[0]);
    const chosen = billing?.passengerId ? firstCabin?.passengers.find((p) => String(p._id) === billing.passengerId) : undefined;
    const payer = chosen ?? firstCabin?.passengers.find((p) => p.isPayer) ?? firstCabin?.passengers[0];

    const typedEmail = billing?.email?.trim() ?? "";
    if (typedEmail && !isValidOptionalEmail(typedEmail)) {
      throw badRequest("Revisa el correo. Ejemplo: nombre@dominio.com.");
    }
    const finalBilling = {
      name: billing?.name?.trim() || payer?.name || "",
      idNumber: billing?.idNumber?.trim() || payer?.idNumber || "",
      // Un correo guardado inválido no bloquea el cobro: se factura sin correo.
      email: typedEmail || (payer?.email && isValidOptionalEmail(payer.email) ? payer.email : ""),
      country: billing?.country?.trim() || payer?.country || "",
    };
    if (!finalBilling.name || !finalBilling.idNumber) {
      throw badRequest("Falta el nombre o la identificación del pagador para facturar");
    }

    // Doble clic o dos tablets: solo una petición toma cada cuenta aprobada.
    const claimed: Array<InstanceType<typeof Account>> = [];
    const releaseAll = () =>
      Promise.all(
        claimed.map((a) => Account.updateOne({ _id: a._id, status: "cobrada" }, { $set: { status: "aprobada" } })),
      );
    for (const s of summaries) {
      const got = await Account.findOneAndUpdate(
        { cruise: cruiseId, cabinNumber: s.cabinNumber, status: "aprobada", approvedVersion: s.version },
        { $set: { status: "cobrada" } },
        { new: true },
      );
      if (!got) {
        await releaseAll();
        throw conflict(
          cabinList.length > 1
            ? `La cuenta de la cabina ${s.cabinNumber} ya se está cobrando o ya fue pagada`
            : "Esta cuenta ya se está cobrando o ya fue pagada",
        );
      }
      claimed.push(got);
    }

    const headId = new Types.ObjectId();
    let docs: Array<InstanceType<typeof Payment>> = [];
    let accountSettled = false;
    let scopeOrderIds: string[] = [];
    let linesTotal = 0;
    let subsetTotal = 0;
    try {
      // Saldos leídos con las cuentas tomadas: nadie más cobra al mismo tiempo.
      const paidBefore = await Promise.all(cabinList.map((n) => partialPaidOf(cruiseId, n)));
      const abonosBefore = await Promise.all(cabinList.map((n) => partialPaidOf(cruiseId, n, false)));
      const dues = summaries.map((s, i) => round2(s.total - paidBefore[i]!));
      const due = round2(dues.reduce((a, b) => a + b, 0));
      if (dues.some((d) => d <= 0)) {
        throw conflict(
          "Los pagos parciales ya cubren la cuenta: reversa el último pago parcial y vuelve a cobrar el saldo",
        );
      }
      if (expectedDue !== undefined && expectedDue !== null && round2(Number(expectedDue)) !== due) {
        throw conflict(`El saldo cambió: ahora es $${due.toFixed(2)}. Revisa la cuenta antes de cobrar.`);
      }

      // Lo que debe cubrir este cobro.
      let target = due;
      const summary = summaries[0]!;
      if (mode === "grupo" && paidBefore.some((p) => p > 0)) {
        const i = paidBefore.findIndex((p) => p > 0);
        throw conflict(`La cabina ${cabinList[i]} tiene pagos parciales: cóbrala sola`);
      }
      if (mode === "consumos") {
        if (paidBefore[0]! > 0) throw conflict("La cuenta tiene pagos parciales: cobra el saldo completo");
        const open = new Map(summary.orders.map((o) => [o.id, o]));
        const missing = orderIds!.find((id) => !open.has(id));
        if (missing) throw conflict("Hay consumos elegidos que ya no están por cobrar: actualiza la cuenta");
        subsetTotal = round2(orderIds!.reduce((s, id) => s + open.get(id)!.total, 0));
        if (subsetTotal <= 0) throw badRequest("Los consumos elegidos no tienen importe (son cortesías)");
        target = subsetTotal;
      }
      if (mode === "porcentaje") {
        if (abonosBefore[0]! > 0) throw conflict("La cuenta tiene pagos parciales sin dividir: cobra el saldo completo");
        const share = round2((summary.total * percent!) / 100);
        target = share >= due - 0.01 ? due : share;
      }

      // Montos de cada forma de pago; la última sin monto cubre lo que falta.
      const fixed = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));
      const amounts = lines.map((l) => l.amount ?? round2(target - fixed));
      if (amounts.some((a) => a <= 0)) throw badRequest("Introduce una cantidad mayor que cero.");
      linesTotal = round2(amounts.reduce((a, b) => a + b, 0));
      if (linesTotal > target) {
        throw badRequest(
          mode === "cuenta"
            ? `El monto no puede ser mayor que el saldo ($${target.toFixed(2)}).`
            : `Las formas de pago suman más que lo que se cobra ($${target.toFixed(2)}).`,
        );
      }
      if (linesTotal < target && mode !== "cuenta") {
        throw badRequest(`Las formas de pago deben sumar $${target.toFixed(2)}.`);
      }

      // Qué queda cubierto.
      const isPart = mode === "porcentaje" && linesTotal < due;
      const isAbono = mode === "cuenta" && linesTotal < due;
      accountSettled =
        mode === "grupo" ||
        (mode === "cuenta" && !isAbono) ||
        (mode === "porcentaje" && !isPart) ||
        // Lo que queda sin elegir son solo cortesías ($0): la cuenta se completa.
        (mode === "consumos" && summary.orders.every((o) => orderIds!.includes(o.id) || o.total <= 0));
      scopeOrderIds =
        mode === "consumos"
          ? accountSettled
            ? summary.orders.map((o) => o.id)
            : orderIds!
          : summaries.flatMap((s) => s.orders.map((o) => o.id));
      const scopeAmount = mode === "consumos" ? subsetTotal : round2(summaries.reduce((a, s) => a + s.total, 0));
      // Factura: lo cobrado ahora más los parciales sin factura propia que completa.
      const rolledIn = accountSettled && mode !== "consumos" ? round2(abonosBefore.reduce((a, b) => a + b, 0)) : 0;
      const invoiceTotal = round2(linesTotal + rolledIn);
      const share = mode === "consumos" || mode === "grupo" ? 1 : Math.min(1, invoiceTotal / scopeAmount);
      const invoiced = !isAbono;
      const settled = !isAbono && !isPart;

      // Reparto de las formas de pago entre las cabinas (cabinas juntas).
      const chunks: Array<{ cabin: number; line: (typeof lines)[number]; amount: number }> = [];
      const remaining = mode === "grupo" ? [...dues] : [linesTotal];
      let c = 0;
      lines.forEach((line, i) => {
        let left = amounts[i]!;
        while (left > 0.0049) {
          while (c < remaining.length - 1 && remaining[c]! <= 0.0049) c++;
          const take = c === remaining.length - 1 ? left : Math.min(left, remaining[c]!);
          chunks.push({ cabin: cabinList[mode === "grupo" ? c : 0]!, line, amount: round2(take) });
          remaining[c] = round2(remaining[c]! - take);
          left = round2(left - take);
        }
      });

      const createdAt = Date.now();
      docs = (await Payment.insertMany(
        chunks.map((chunk, i) => {
          const head = i === chunks.length - 1;
          const cabinSummary = summaries[cabinList.indexOf(chunk.cabin)]!;
          return {
            _id: head ? headId : new Types.ObjectId(),
            cruise: cruiseId,
            cabinNumber: chunk.cabin,
            orders: head ? scopeOrderIds : [],
            accountVersion: cabinSummary.version,
            subtotal: head && settled && mode === "cuenta" ? cabinSummary.subtotal : chunk.amount,
            courtesyTotal: head && settled && mode === "cuenta" ? cabinSummary.courtesyTotal : 0,
            total: chunk.amount,
            accountTotal: mode === "grupo" ? scopeAmount : cabinSummary.total,
            settled,
            settledBy: settled ? headId : null,
            group: headId,
            part: isPart,
            share: head ? share : 1,
            invoiceTotal: head && invoiced ? invoiceTotal : null,
            cabins: head && mode === "grupo" ? cabinList : [],
            method: chunk.line.method,
            reference: chunk.line.reference,
            cashConfirmed: chunk.line.cashConfirmed,
            billing: finalBilling,
            invoiceStatus: head && invoiced ? "pendiente" : "parcial",
            collectedBy: req.auth!.sub,
            // Orden estable: la cabeza es la última.
            createdAt: new Date(createdAt + i),
          };
        }),
      )) as unknown as typeof docs;
    } catch (err) {
      await releaseAll();
      throw err;
    }

    const head = docs.find((d) => d._id.equals(headId))!;
    const isPart = head.part;
    if (head.settled) {
      // Los consumos cubiertos quedan pagados con este cobro.
      await Order.updateMany({ _id: { $in: scopeOrderIds } }, { $set: { payment: headId } });
    }
    if (accountSettled) {
      // Pagos parciales y partes anteriores quedan dentro de esta liquidación.
      await Payment.updateMany(
        { cruise: cruiseId, cabinNumber: { $in: cabinList }, status: "vigente", settled: false },
        { $set: { settled: true, settledBy: headId } },
      );
    } else {
      // Queda saldo: la cuenta sigue aprobada para lo que falta.
      for (const a of claimed) {
        const set: Record<string, unknown> = { status: "aprobada" };
        if (mode === "consumos") set.approvedTotal = round2((a.approvedTotal ?? 0) - subsetTotal);
        await Account.updateOne({ _id: a._id, status: "cobrada" }, { $set: set });
      }
    }

    // Si el pagador no tenía identificación o correo, se guardan para la próxima.
    if (cruise && firstCabin && payer) {
      payer.idNumber = payer.idNumber || finalBilling.idNumber;
      payer.email = payer.email || finalBilling.email;
      payer.country = payer.country || finalBilling.country;
      await cruise.save();
    }

    const methodsText = docs
      .reduce<Array<{ method: string; total: number }>>((acc, d) => {
        const same = acc.find((x) => x.method === d.method);
        if (same) same.total = round2(same.total + d.total);
        else acc.push({ method: d.method, total: d.total });
        return acc;
      }, [])
      .map((x) => (docs.length > 1 ? `${x.method} $${x.total.toFixed(2)}` : x.method))
      .join(" + ");
    const dueAfter = accountSettled ? 0 : round2((await buildCabinAccount(cruiseId, cabinList[0]!)).due);
    const what =
      mode === "grupo"
        ? `Cabinas ${cabinList.join(", ")} juntas · ${finalBilling.name}`
        : mode === "consumos"
          ? `Consumos de ${finalBilling.name} · $${linesTotal.toFixed(2)}`
          : mode === "porcentaje"
            ? `${percent}% · ${finalBilling.name} · $${linesTotal.toFixed(2)}`
            : "";
    for (const a of claimed) {
      const action = accountSettled ? "cobrada" : "pago_parcial";
      const reason = accountSettled
        ? [methodsText, what].filter(Boolean).join(" · ")
        : `${what ? `${what} · ` : ""}${methodsText}${what ? "" : ` · $${linesTotal.toFixed(2)}`} · saldo $${dueAfter.toFixed(2)}`;
      await Account.updateOne(
        { _id: a._id },
        {
          $push: {
            history: { action, version: a.version, reason, by: new Types.ObjectId(req.auth!.sub), at: new Date() },
          },
        },
      );
    }

    const invoicedHead = head.invoiceStatus === "pendiente" ? ((await issueInvoice(headId)) ?? head) : head;

    await logEvent(req.auth, {
      kind: "cobro",
      title: `${accountSettled ? "Cobro" : isPart || mode === "consumos" ? "Cobro de una parte" : "Pago parcial"} · ${
        cabinList.length > 1 ? `cabinas ${cabinList.join(", ")}` : `cabina ${cabinList[0]}`
      }`,
      detail: accountSettled
        ? `${methodsText} · ${finalBilling.name}`
        : `${methodsText} · ${finalBilling.name} · saldo $${dueAfter.toFixed(2)}`,
      amount: linesTotal,
      cruise: cruiseId,
      cabinNumber: cabinList[0],
    });

    // Resumen al pagador: nunca rompe el cobro.
    let email = null;
    if (accountSettled) {
      try {
        email = await sendAccountSummary(headId, req.auth);
      } catch (err) {
        console.error("[cobro] resumen por correo", err);
      }
    }

    res.status(201).json({
      payment: invoicedHead,
      payments: docs.map((d) => (d._id.equals(headId) ? invoicedHead : d)),
      settled: accountSettled,
      due: dueAfter,
      email,
    });
  } catch (err) {
    next(err);
  }
}

/** Reenvía el resumen de la cuenta pagada al pagador (Dirección o Gerencia). */
export async function resendSummary(req: Request, res: Response, next: NextFunction) {
  try {
    await assertCanCollect(req.auth!.sub, req.auth!.role);
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.status !== "vigente") throw badRequest("El cobro fue reversado");
    if (payment.settled === false) {
      throw badRequest("El resumen se envía cuando la cuenta queda pagada");
    }
    if (payment.settledBy && !payment.settledBy.equals(payment._id)) {
      throw badRequest("El resumen va con el pago que completó la cuenta");
    }
    const result = await sendAccountSummary(payment._id, req.auth, true);
    if (result.status === "omitido") throw conflict("El resumen se está enviando");
    res.json({ email: result, payment: await Payment.findById(payment._id) });
  } catch (err) {
    next(err);
  }
}

/**
 * Reverso autorizado (solo administración): un cobro con pago o factura no
 * se cancela, se reversa con motivo.
 *
 * - Pago parcial (cuenta con saldo): sale del saldo; la aprobación sigue.
 * - Pago que liquidó la cuenta: la cuenta vuelve a abrirse y sus pagos
 *   parciales vuelven a contar como parciales sobre el saldo.
 * - Un parcial de una cuenta ya liquidada se reversa después del pago que
 *   la liquidó (la factura de la liquidación lo incluye).
 */
export async function reversePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) throw badRequest("El motivo del reverso es obligatorio");

    const current = await Payment.findById(req.params.id).select("settled settledBy status group part");
    if (!current || current.status !== "vigente") throw conflict("El cobro no existe o ya fue reversado");
    // Un cobro con varias formas de pago (o varias cabinas) se reversa entero.
    const headId = current.group ?? current._id;
    const groupDocs = current.group
      ? await Payment.find({ group: current.group, status: "vigente" })
      : [current];
    const liquidator = current.settled !== false && (!current.settledBy || current.settledBy.equals(headId));
    if (current.settled !== false && !liquidator) {
      throw conflict("Este pago es parte de una cuenta ya pagada: reversa primero el pago que la completó");
    }

    const now = new Date();
    const reversal = {
      status: "reversado",
      reversedBy: req.auth!.sub,
      reversedAt: now,
      reverseReason: reason.trim(),
    };
    const ids = groupDocs.map((d) => d._id);
    const done = await Payment.updateMany({ _id: { $in: ids }, status: "vigente" }, { $set: reversal });
    if (!done.modifiedCount) throw conflict("El cobro no existe o ya fue reversado");
    const payment = (await Payment.findById(headId))!;

    if (payment.invoiceStatus === "emitida") {
      payment.invoiceError = "Factura emitida: registrar nota de crédito en Contífico";
      await payment.save();
    }

    const cabins = [...new Set([...groupDocs.map((d) => d.cabinNumber), ...(payment.cabins ?? [])])];
    const total = round2(groupDocs.reduce((s, d) => s + d.total, 0));
    for (const cabinNumber of cabins) {
      const account = await Account.findOne({ cruise: payment.cruise, cabinNumber });
      if (liquidator) {
        if (account) {
          account.status = "abierta";
          account.version += 1;
          account.approvedVersion = null;
          account.approvedTotal = null;
        }
      }
      if (account) {
        account.history.push({
          action: "reversada",
          version: account.version,
          reason: liquidator ? reason.trim() : `Pago parcial $${total.toFixed(2)} · ${reason.trim()}`,
          by: new Types.ObjectId(req.auth!.sub),
          at: now,
        });
        await account.save();
      }
    }
    if (liquidator) {
      await Order.updateMany({ payment: headId }, { $set: { payment: null } });
      // Parciales y partes que este cobro completó vuelven a contar sobre el saldo.
      await Payment.updateMany(
        { settledBy: headId, _id: { $nin: ids }, status: "vigente" },
        { $set: { settled: false, settledBy: null } },
      );
    }

    await logEvent(req.auth, {
      kind: "cobro",
      title: `${liquidator ? "Cobro" : "Pago parcial"} reversado · ${
        cabins.length > 1 ? `cabinas ${cabins.join(", ")}` : `cabina ${payment.cabinNumber}`
      }`,
      detail: reason.trim(),
      amount: total,
      cruise: payment.cruise,
      cabinNumber: payment.cabinNumber,
    });

    res.json({ payment: await Payment.findById(req.params.id) });
  } catch (err) {
    next(err);
  }
}

export async function listPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const { cruiseId, from, to, before, limit, invoice } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (cruiseId) filter.cruise = cruiseId;
    // Facturas pendientes: pagos vigentes cuya factura no se emitió.
    if (invoice === "pendiente") {
      filter.status = "vigente";
      filter.invoiceStatus = { $in: ["pendiente", "error"] };
    }
    // 'YYYY-MM-DD' = día completo en hora de Galápagos.
    const start = parseRangeEdge(from, "start");
    const end = parseRangeEdge(to, "end");
    if (start || end || before) {
      filter.createdAt = {
        ...(start ? { $gte: start } : {}),
        ...(end ? { $lte: end } : {}),
        ...(before ? { $lt: new Date(before) } : {}),
      };
    }

    const pageSize = Math.min(Number(limit) || 40, 300);
    const payments = await Payment.find(filter)
      .populate("collectedBy", "name role")
      .populate("reversedBy", "name")
      .populate("cruise", "name code")
      .sort({ createdAt: -1 })
      .limit(pageSize + 1);

    const hasMore = payments.length > pageSize;
    res.json({ payments: hasMore ? payments.slice(0, pageSize) : payments, hasMore });
  } catch (err) {
    next(err);
  }
}

/** Reintenta la emisión de una factura pendiente o con error en Contífico. */
export async function retryInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw notFound("Pago no encontrado");
    if (payment.status === "reversado") throw badRequest("El cobro fue reversado");
    if (payment.invoiceStatus === "parcial") {
      throw badRequest("Los pagos parciales se facturan con el pago que completa la cuenta");
    }
    if (payment.invoiceStatus === "emitida") throw badRequest("La factura ya fue emitida");
    if (payment.invoiceStatus === "emitiendo") throw conflict("La factura se está emitiendo");

    const invoiced = await issueInvoice(payment._id);
    if (invoiced?.invoiceStatus === "emitida") {
      await logEvent(req.auth, {
        kind: "cobro",
        title: `Factura emitida · cabina ${invoiced.cabinNumber}`,
        detail: invoiced.invoiceNumber,
        amount: invoiced.total,
        cruise: invoiced.cruise,
        cabinNumber: invoiced.cabinNumber,
      });
    }

    res.json({ payment: invoiced });
  } catch (err) {
    next(err);
  }
}

/** Estado de Contífico y su catálogo, para vincular productos. */
export async function contificoInfo(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await contificoStatus());
  } catch (err) {
    next(err);
  }
}
