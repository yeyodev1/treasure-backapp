import { Cruise } from "../models/cruise.model";
import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { AgencyInvoice } from "../models/agencyInvoice.model";
import { agencyEmail, agencySummary } from "../services/agency.service";
import { logEvent } from "../services/audit.service";
import { mailerConfigured, sendMail } from "../services/mailer.service";
import { badRequest, conflict, notFound } from "../errors/httpError";
import { EMAIL_ERROR, isValidOptionalEmail } from "../utils/email";
import { commercialDateKey } from "../utils/dates";
import { round2 } from "../utils/units";

/**
 * Factura mensual a la agencia (solo Gerencia, 4-nov-2026). Ver
 * services/agency.service.ts y models/agencyInvoice.model.ts.
 */
export async function listAgencyBilling(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await agencySummary());
  } catch (err) {
    next(err);
  }
}

/**
 * Registra la factura del mes con los cruceros elegidos (cada uno por lo que
 * tiene pendiente) y, con correo, le envía a la agencia el detalle por crucero.
 * Si el correo falla la factura queda registrada y se puede reenviar.
 */
export async function createAgencyInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as { cruiseIds?: unknown; to?: unknown; invoiceNumber?: unknown; note?: unknown; month?: unknown };
    const ids = Array.isArray(body.cruiseIds) ? [...new Set(body.cruiseIds.map(String))] : [];
    if (!ids.length) throw badRequest("Elige los cruceros que facturas");
    let to = String(body.to ?? "").trim();
    if (!isValidOptionalEmail(to)) throw badRequest(EMAIL_ERROR);
    if (to && !mailerConfigured()) throw badRequest("El envío de correos no está configurado");
    const month = String(body.month ?? "") || commercialDateKey().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("Mes inválido");

    const summary = await agencySummary();
    const picked = ids.map((id) => {
      const row = summary.cruises.find((c) => c.id === id);
      if (!row || row.pending <= 0) {
        throw conflict(`${row ? `El crucero ${row.code || row.name}` : "Un crucero elegido"} ya no tiene cortesías por facturar. Recarga la página.`);
      }
      return row;
    });
    const amount = round2(picked.reduce((s, r) => s + r.pending, 0));
    // Solo cruceros finalizados de una misma agencia (especificación del Resumen, bloque 7).
    if (picked.some((r) => r.status !== "cerrado")) throw badRequest("Solo se facturan cruceros finalizados");
    const cruiseDocs = await Cruise.find({ _id: { $in: picked.map((r) => r.id) } }).select("code agency").lean();
    const agencies = new Set(cruiseDocs.map((c) => (c.agency?.name ?? "").trim().toLowerCase()));
    if (agencies.size > 1) throw badRequest("Junta solo cruceros de la misma agencia");
    const agency = cruiseDocs[0]?.agency ?? { name: "", ruc: "", email: "" };
    if (!agency.name) throw badRequest("Pon la agencia del crucero (en Cruceros) antes de facturar");
    if (!to) to = agency.email ?? "";
    // Mientras Contífico no emite estas facturas, se anota el número de la emitida a mano.
    if (!String(body.invoiceNumber ?? "").trim()) throw badRequest("Escribe el número de la factura emitida en Contífico");

    const invoice = await AgencyInvoice.create({
      month,
      amount,
      items: picked.map((r) => ({ cruise: new Types.ObjectId(r.id), code: r.code || r.name, count: r.count, amount: r.pending })),
      invoiceNumber: String(body.invoiceNumber ?? "").trim().slice(0, 60),
      agency: { name: agency.name, ruc: agency.ruc ?? "", email: agency.email ?? "" },
      note: String(body.note ?? "").trim().slice(0, 300),
      by: new Types.ObjectId(req.auth!.sub),
      byName: req.auth!.name,
    });

    let email: { status: "enviado" | "error"; to: string; error: string } | null = null;
    if (to) {
      try {
        const mail = agencyEmail(
          month,
          picked.map((r) => ({ label: r.code || r.name, amount: r.pending, items: r.items })),
          amount,
        );
        await sendMail({ to, ...mail });
        invoice.sentTo = to;
        invoice.sentAt = new Date();
        await invoice.save();
        email = { status: "enviado", to, error: "" };
      } catch (err) {
        email = { status: "error", to, error: err instanceof Error ? err.message : String(err) };
      }
    }

    await logEvent(req.auth, {
      kind: "cuenta",
      title: `Factura a la agencia · ${month}`,
      detail: `${picked.map((r) => r.code || r.name).join(", ")}${email ? ` · ${email.status === "enviado" ? `enviada a ${to}` : `correo no enviado: ${email.error}`}` : ""}`,
      amount,
    });
    res.status(201).json({ ...(await agencySummary()), invoiceId: invoice._id.toString(), email });
  } catch (err) {
    next(err);
  }
}

/** Una factura mal registrada no se borra: se anula con motivo y sus cruceros vuelven a pendiente. */
export async function voidAgencyInvoice(req: Request, res: Response, next: NextFunction) {
  try {
    const id = String(req.params.id);
    const reason = String((req.body as { reason?: string })?.reason ?? "").trim();
    if (!Types.ObjectId.isValid(id)) throw notFound("Factura no encontrada");
    if (!reason) throw badRequest("Escribe el motivo de la anulación");

    const invoice = await AgencyInvoice.findById(id);
    if (!invoice) throw notFound("Factura no encontrada");
    if (invoice.status === "anulada") throw conflict("Esa factura ya está anulada");
    invoice.status = "anulada";
    invoice.voided = { by: new Types.ObjectId(req.auth!.sub), byName: req.auth!.name, at: new Date(), reason: reason.slice(0, 300) };
    await invoice.save();
    await logEvent(req.auth, { kind: "cuenta", title: `Factura a la agencia anulada · ${invoice.month}`, detail: reason, amount: invoice.amount });
    res.json(await agencySummary());
  } catch (err) {
    next(err);
  }
}
