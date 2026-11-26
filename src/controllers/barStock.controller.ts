import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { Cruise } from "../models/cruise.model";
import { Order } from "../models/order.model";
import { User } from "../models/user.model";
import { StockCount, WASTE_MOTIVES, WasteMotive } from "../models/stockCount.model";
import { StockMovement } from "../models/stockMovement.model";
import {
  applyVerified,
  countsOpen,
  evaluateBartender,
  evaluateRecount,
  GROUP_LABELS,
  groupOf,
  isFresh,
  openCount,
  startGate,
} from "../services/barStock.service";
import { logEvent } from "../services/audit.service";
import { purchaseResponsible } from "../services/weeklyOrder.service";
import { AppSetting } from "../models/appSetting.model";
import { badRequest, conflict, forbidden, notFound } from "../errors/httpError";
import { round2 } from "../utils/units";

/**
 * Bar-stock (especificación del 24-nov-2026): roturas y salidas durante el
 * crucero, conteo de cierre a ciegas, recuento de la directora y decisión de
 * Gerencia. Ver services/barStock.service.ts.
 */

const isLead = (role: string) => role === "direccion" || role === "duena";

/* ───────────── Rotura, salida y devolución a tierra ───────────── */

const EXIT_KINDS = ["cocina", "tripulacion", "brindis"] as const;

export async function createMovement(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, productId, qty, photo, note, exitKind, authorizedById, key } = req.body as {
      type?: string;
      productId?: string;
      qty?: number;
      photo?: string;
      note?: string;
      exitKind?: string;
      authorizedById?: string;
      key?: string;
    };
    if (type !== "rotura" && type !== "salida" && type !== "devolucion_tierra") throw badRequest("Tipo inválido");
    if (!key) throw badRequest("Falta la clave del registro");
    // Reintento sin señal: la misma clave no registra dos veces.
    if (await StockMovement.exists({ transferId: key })) {
      res.json({ ok: true, duplicated: true });
      return;
    }
    if (typeof qty !== "number" || !(qty > 0) || qty > 500) throw badRequest("Indica la cantidad");
    const product = Types.ObjectId.isValid(productId ?? "") ? await Product.findById(productId) : null;
    if (!product || product.kind !== "fisico" || isFresh(product)) throw badRequest("Elige una botella o producto del bar");
    if (!countsOpen(product) && !Number.isInteger(qty)) throw badRequest(`${product.name} se registra en unidades enteras`);
    if (type === "rotura" && !photo) throw badRequest("La rotura necesita la foto");
    let authorizedByName = "";
    if (type === "salida") {
      if (!EXIT_KINDS.includes(exitKind as (typeof EXIT_KINDS)[number])) throw badRequest("Elige si es cocina, tripulación o brindis");
      const who = Types.ObjectId.isValid(authorizedById ?? "") ? await User.findById(authorizedById).select("name role") : null;
      if (!who || !isLead(who.role)) throw badRequest("Elige quién autorizó la salida (directora o Gerencia)");
      authorizedByName = who.name;
    }

    const cruise = await Cruise.findOne({ status: "abordo" }).select("_id code");
    const base = round2(qty * (product.containerSize || 1));
    await Product.updateOne({ _id: product._id }, { $inc: { onboardStock: -base } });
    await StockMovement.create({
      type,
      product: product._id,
      location: "abordo",
      qty: -base,
      cruise: cruise?._id ?? null,
      reason: String(note ?? "").trim().slice(0, 200),
      unitCost: product.costPerUnit ?? 0,
      transferId: key,
      photo: type === "rotura" ? String(photo) : "",
      exitKind: type === "salida" ? exitKind : "",
      authorizedByName,
      user: req.auth!.sub,
    });
    const label = type === "rotura" ? "Rotura" : type === "salida" ? `Salida a ${exitKind === "tripulacion" ? "tripulación" : exitKind}` : "Devolución a tierra";
    await logEvent(req.auth, {
      kind: "inventario",
      title: `${label} · ${product.name}`,
      detail: `${qty} ${product.containerLabel || "unidad"}${authorizedByName ? ` · autorizó ${authorizedByName}` : ""}${note ? ` · ${note}` : ""}`,
      amount: round2(base * (product.costPerUnit ?? 0)) || null,
      cruise: cruise?._id ?? null,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** Cortesías, roturas y salidas de un crucero (o del en curso), una por una. */
export async function listMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const asked = String(req.query.cruiseId ?? "");
    const cruise = Types.ObjectId.isValid(asked)
      ? await Cruise.findById(asked).select("code startDate")
      : await Cruise.findOne({ status: "abordo" }).select("code startDate");
    if (!cruise) {
      res.json({ cruise: null, items: [], total: 0 });
      return;
    }
    const [moves, orders] = await Promise.all([
      StockMovement.find({ cruise: cruise._id, type: { $in: ["rotura", "salida", "devolucion_tierra"] } })
        .populate("product", "name containerSize containerLabel")
        .populate("user", "name")
        .sort({ createdAt: -1 })
        .lean(),
      Order.find({ cruise: cruise._id, status: { $in: ["entregada", "pendiente"] }, "items.courtesy": true })
        .populate("createdBy", "name")
        .lean(),
    ]);
    const items = [
      ...moves.map((m) => {
        const p = m.product as unknown as { name: string; containerSize: number; containerLabel: string } | null;
        const qty = round2(-m.qty / (p?.containerSize || 1));
        return {
          id: m._id.toString(),
          at: m.createdAt,
          kind: m.type,
          exitKind: m.exitKind ?? "",
          product: p?.name ?? "",
          qty,
          unit: p?.containerLabel || "unidad",
          by: (m.user as unknown as { name?: string } | null)?.name ?? "",
          authorizedBy: m.authorizedByName ?? "",
          note: m.reason,
          photo: m.photo ?? "",
          value: round2(-m.qty * (m.unitCost ?? 0)),
        };
      }),
      ...orders.flatMap((o) =>
        o.items
          .filter((i) => i.courtesy && i.qty - (i.cancelledQty ?? 0) - (i.annulledQty ?? 0) > 0)
          .map((i) => {
            const units = i.qty - (i.cancelledQty ?? 0) - (i.annulledQty ?? 0);
            return {
              id: `${o._id.toString()}-${i.product.toString()}`,
              at: o.createdAt,
              kind: "cortesia",
              exitKind: i.courtesyKind ?? "casa",
              product: i.name,
              qty: units,
              unit: "",
              by: (o.createdBy as unknown as { name?: string } | null)?.name ?? "",
              authorizedBy: "",
              note: `Cabina ${o.cabinNumber}`,
              photo: "",
              value: round2(units * i.unitPrice),
            };
          }),
      ),
    ].sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime());
    res.json({ cruise: { id: cruise._id.toString(), code: cruise.code }, items, total: round2(items.reduce((s, i) => s + i.value, 0)) });
  } catch (err) {
    next(err);
  }
}

/* ───────────── Conteo de cierre a ciegas ───────────── */

type CountDoc = InstanceType<typeof StockCount>;

/**
 * Cada quien ve solo lo suyo: el bartender no ve el esperado mientras cuenta;
 * la directora ve solo los productos con diferencia, sin el número del
 * bartender ni el del sistema; Gerencia ve todo.
 */
async function view(count: CountDoc, role: string) {
  const products = await Product.find({ _id: { $in: count.lines.map((l) => l.product) } })
    .select("name category stockUnit containerSize containerLabel caseSize countOrder")
    .lean();
  const info = new Map(products.map((p) => [p._id.toString(), p]));
  const owner = role === "duena";
  const stage = count.status;
  const lines = count.lines
    .filter((l) => owner || stage === "borrador" || stage === "aprobado" || stage === "gerencia" || !["ok", "tolerancia"].includes(l.result))
    .map((l) => {
      const p = info.get(l.product.toString());
      const size = p?.containerSize || 1;
      const showResult = owner || stage === "aprobado" || stage === "gerencia" || (stage === "enviado" && l.recount !== null && l.result !== "");
      return {
        product: l.product.toString(),
        name: l.name,
        group: groupOf(p ?? {}),
        containerLabel: p?.containerLabel || "unidad",
        containerSize: size,
        caseSize: p?.caseSize ?? 0,
        countsOpen: p ? countsOpen(p) : false,
        // A ciegas: el bartender solo ve lo que él contó; la directora, solo su recuento.
        physical: role === "bartender" || owner || stage === "borrador" ? (l.physical === null ? null : round2(l.physical / size)) : undefined,
        recount: l.recount === null ? null : round2(l.recount / size),
        expected: owner || stage === "aprobado" ? round2(Math.max(0, l.digitalAtCut) / size) : undefined,
        result: showResult ? l.result : "",
        motive: l.motive,
        value: showResult ? l.value : 0,
        fullBottle: l.fullBottle,
      };
    });
  const cruise = count.cruise ? await Cruise.findById(count.cruise).select("code").lean() : null;
  return {
    id: count._id.toString(),
    code: count.code,
    kind: count.kind,
    status: count.status,
    cruise: cruise?.code ?? "",
    cutAt: count.cutAt,
    groups: GROUP_LABELS,
    lines,
    pending: count.lines.filter((l) => l.physical === null).length,
    toRecount: count.lines.filter((l) => l.physical !== null && !["ok", "tolerancia"].includes(l.result) && l.recount === null).length,
    wasteTotal: count.wasteTotal,
    toManagement: count.toManagement,
    submittedByName: count.submittedByName,
    submittedAt: count.submittedAt,
    verifiedByName: count.verifiedByName,
    verifiedAt: count.verifiedAt,
    decision: count.decision,
  };
}

async function loadCount(id: string) {
  const count = Types.ObjectId.isValid(id) ? await StockCount.findById(id) : null;
  if (!count || !["cierre", "inicial", "admin"].includes(count.kind)) throw notFound("Conteo no encontrado");
  return count;
}

/** El conteo abierto del barco (cierre o inicial) y el último verificado. */
export async function currentCount(req: Request, res: Response, next: NextFunction) {
  try {
    const open = await StockCount.findOne({ kind: { $in: ["cierre", "inicial"] }, status: { $in: ["borrador", "enviado", "gerencia"] } }).sort({ createdAt: -1 });
    const last = await StockCount.findOne({ kind: { $in: ["cierre", "inicial"] }, status: "aprobado" }).sort({ verifiedAt: -1, updatedAt: -1 });
    res.json({
      count: open ? await view(open, req.auth!.role) : null,
      last: last ? { id: last._id.toString(), code: last.code, verifiedAt: last.verifiedAt ?? last.updatedAt, verifiedByName: last.verifiedByName, wasteTotal: last.wasteTotal } : null,
    });
  } catch (err) {
    next(err);
  }
}

export async function getCount(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ count: await view(await loadCount(String(req.params.id)), req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** Conteo inicial (arranque): bartender y directora cuentan juntos y reemplaza el stock actual. */
export async function startInitialCount(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isLead(req.auth!.role)) throw forbidden("El conteo inicial lo abre la directora o Gerencia");
    if (await StockCount.exists({ kind: { $in: ["cierre", "inicial"] }, status: { $in: ["borrador", "enviado", "gerencia"] } })) {
      throw conflict("Ya hay un conteo abierto: termínalo primero");
    }
    const cruise = await Cruise.findOne({ status: "abordo" }).select("_id");
    const count = await openCount("inicial", cruise?._id ?? null, req.auth!.sub, "Conteo inicial verificado (arranque de Bar-stock)");
    await logEvent(req.auth, { kind: "conteo", title: `Conteo inicial ${count.code} abierto`, detail: `${count.lines.length} productos` });
    res.status(201).json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** Guarda lo contado (en envases: botellas cerradas + abierta, o cajas × unidades + sueltas). */
export async function saveCountLines(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await loadCount(String(req.params.id));
    if (count.status !== "borrador") throw conflict("Este conteo ya se envió");
    const lines = Array.isArray(req.body?.lines) ? (req.body.lines as Array<{ productId?: string; physical?: number | null }>) : [];
    const products = await Product.find({ _id: { $in: count.lines.map((l) => l.product) } }).select("containerSize").lean();
    const size = new Map(products.map((p) => [p._id.toString(), p.containerSize || 1]));
    for (const input of lines) {
      const line = count.lines.find((l) => l.product.toString() === input.productId);
      if (!line) continue;
      if (input.physical === null) line.physical = null;
      else if (typeof input.physical === "number" && input.physical >= 0 && input.physical < 100_000) {
        line.physical = round2(input.physical * (size.get(line.product.toString()) ?? 1));
      }
    }
    await count.save();
    res.json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** El bartender envía: lo que cuadra queda listo; lo que difiere pasa a la directora. */
export async function sendCount(req: Request, res: Response, next: NextFunction) {
  try {
    const count = await loadCount(String(req.params.id));
    if (count.status !== "borrador") throw conflict("Este conteo ya se envió");
    const missing = count.lines.filter((l) => l.physical === null);
    if (missing.length) throw badRequest(`Faltan ${missing.length} producto(s) por contar (${missing.slice(0, 3).map((l) => l.name).join(", ")}…)`);
    count.submittedBy = new Types.ObjectId(req.auth!.sub);
    count.submittedByName = req.auth!.name;
    count.submittedAt = new Date();

    // El inicial se cuenta entre bartender y directora juntos: queda verificado al enviarlo.
    const toRecount = count.kind === "inicial" ? 0 : await evaluateBartender(count);
    if (!toRecount) {
      if (count.kind === "inicial") for (const l of count.lines) l.result = "ok";
      count.verifiedBy = new Types.ObjectId(req.auth!.sub);
      count.verifiedByName = count.kind === "inicial" ? req.auth!.name : "Dentro de tolerancia";
      count.verifiedAt = new Date();
      await applyVerified(count, req.auth!.sub);
    } else {
      count.status = "enviado";
    }
    await count.save();
    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} ${toRecount ? "enviado a la directora" : "verificado"}`,
      detail: toRecount ? `${toRecount} producto(s) con diferencia por recontar` : "todo dentro de tolerancia",
      cruise: count.cruise,
    });
    res.json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** La directora recuenta a ciegas solo lo que difiere y, si es merma, elige el motivo. */
export async function recountLines(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isLead(req.auth!.role)) throw forbidden("El recuento lo hace la directora");
    const count = await loadCount(String(req.params.id));
    if (count.status !== "enviado") throw conflict("Este conteo no está esperando el recuento");
    const lines = Array.isArray(req.body?.lines)
      ? (req.body.lines as Array<{ productId?: string; recount?: number | null; motive?: string }>)
      : [];
    const products = await Product.find({ _id: { $in: count.lines.map((l) => l.product) } }).select("containerSize").lean();
    const size = new Map(products.map((p) => [p._id.toString(), p.containerSize || 1]));
    for (const input of lines) {
      const line = count.lines.find((l) => l.product.toString() === input.productId);
      if (!line || ["ok", "tolerancia"].includes(line.result)) continue;
      if (typeof input.recount === "number" && input.recount >= 0) {
        const next = round2(input.recount * (size.get(line.product.toString()) ?? 1));
        if (next !== line.recount) line.result = "";
        line.recount = next;
      }
      if (input.motive !== undefined) {
        if (input.motive && !WASTE_MOTIVES.includes(input.motive as WasteMotive)) throw badRequest("Motivo inválido");
        line.motive = (input.motive || "") as "" | WasteMotive;
      }
    }
    // Comparar: con todo recontado se calcula el resultado de cada producto.
    if (count.lines.every((l) => ["ok", "tolerancia"].includes(l.result) || l.recount !== null)) {
      count.toManagement = await evaluateRecount(count);
    }
    await count.save();
    res.json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** Cerrar el conteo: la directora lo cierra si la merma es menor; si no, pasa a Gerencia. */
export async function closeCount(req: Request, res: Response, next: NextFunction) {
  try {
    if (!isLead(req.auth!.role)) throw forbidden("El conteo lo cierra la directora");
    const count = await loadCount(String(req.params.id));
    if (count.status !== "enviado") throw conflict("Este conteo no está esperando a la directora");
    const pending = count.lines.filter((l) => !["ok", "tolerancia"].includes(l.result) && l.recount === null);
    if (pending.length) throw badRequest(`Falta recontar ${pending.length} producto(s)`);
    count.toManagement = await evaluateRecount(count);
    const noMotive = count.lines.find((l) => l.result === "merma" && !l.motive);
    if (noMotive) throw badRequest(`Elige el motivo de la merma de ${noMotive.name}`);
    count.verifiedBy = new Types.ObjectId(req.auth!.sub);
    count.verifiedByName = req.auth!.name;
    count.verifiedAt = new Date();
    if (count.toManagement.length) count.status = "gerencia";
    else await applyVerified(count, req.auth!.sub);
    await count.save();
    await logEvent(req.auth, {
      kind: "conteo",
      title: `Conteo ${count.code} ${count.status === "gerencia" ? "pasa a Gerencia" : "verificado"}`,
      detail: `Merma $${count.wasteTotal.toFixed(2)}${count.toManagement.length ? ` · ${count.toManagement.join(" · ")}` : ""}`,
      amount: count.wasteTotal || null,
      cruise: count.cruise,
    });
    res.json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/** Gerencia aprueba la merma o la rechaza con comentario (vuelve a la directora). */
export async function decideCount(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.auth!.role !== "duena") throw forbidden("Solo Gerencia decide la merma sobre el límite");
    const { approved, comment } = req.body as { approved?: boolean; comment?: string };
    const count = await loadCount(String(req.params.id));
    if (count.status !== "gerencia") throw conflict("Este conteo no espera a Gerencia");
    if (!approved && !comment?.trim()) throw badRequest("Escribe el comentario para la directora");
    count.decision = { approved: Boolean(approved), comment: String(comment ?? "").trim(), byName: req.auth!.name, at: new Date() };
    if (approved) await applyVerified(count, req.auth!.sub);
    else {
      // Vuelve a la directora: recuenta de nuevo lo que era merma.
      count.status = "enviado";
      for (const l of count.lines) if (l.result === "merma") l.recount = null;
    }
    await count.save();
    await logEvent(req.auth, {
      kind: "conteo",
      title: `Merma de ${count.code} ${approved ? "aprobada" : "rechazada"} por Gerencia`,
      detail: String(comment ?? "").trim(),
      amount: count.wasteTotal || null,
      cruise: count.cruise,
    });
    res.json({ count: await view(count, req.auth!.role) });
  } catch (err) {
    next(err);
  }
}

/* ───────────── Iniciar el siguiente crucero ───────────── */

/** La directora pide autorización para iniciar sin conteo; Gerencia autoriza o no. */
export async function startAuthorization(req: Request, res: Response, next: NextFunction) {
  try {
    const { action, reason } = req.body as { action?: string; reason?: string };
    const cruise = await Cruise.findById(req.params.id);
    if (!cruise || cruise.status !== "planificado") throw notFound("Crucero programado no encontrado");
    if (action === "pedir") {
      if (!isLead(req.auth!.role)) throw forbidden("La pide la directora");
      cruise.startAuthorization = { status: "pedida", requestedByName: req.auth!.name, byName: "", at: new Date(), reason: String(reason ?? "").trim() };
    } else if (action === "autorizar" || action === "negar") {
      if (req.auth!.role !== "duena") throw forbidden("Solo Gerencia autoriza un inicio sin conteo");
      cruise.startAuthorization = {
        status: action === "autorizar" ? "autorizada" : "negada",
        requestedByName: cruise.startAuthorization?.requestedByName ?? "",
        byName: req.auth!.name,
        at: new Date(),
        reason: String(reason ?? "").trim(),
      };
    } else throw badRequest("Acción inválida");
    await cruise.save();
    await logEvent(req.auth, {
      kind: "salida",
      title: `Inicio sin conteo ${action === "pedir" ? "pedido" : action === "autorizar" ? "autorizado" : "no autorizado"} · ${cruise.code}`,
      detail: String(reason ?? "").trim(),
      cruise: cruise._id,
    });
    res.json({ cruise, gate: await startGate(cruise) });
  } catch (err) {
    next(err);
  }
}

/** Si cambió el bartender, el que entra firma que recibe el bar. */
export async function signBarReceipt(req: Request, res: Response, next: NextFunction) {
  try {
    const cruise = await Cruise.findOne({ status: "abordo" });
    if (!cruise) throw notFound("No hay crucero en curso");
    if (cruise.barReceipt) {
      res.json({ cruise });
      return;
    }
    cruise.barReceipt = { byName: req.auth!.name, at: new Date() };
    await cruise.save();
    await logEvent(req.auth, { kind: "salida", title: `Bar recibido · ${cruise.code}`, detail: req.auth!.name, cruise: cruise._id });
    res.json({ cruise });
  } catch (err) {
    next(err);
  }
}

/* ───────────── Configuración: responsable de compras ───────────── */

/** Quién compra esta semana (por defecto Administración) y a quién se puede asignar. */
export async function getSettings(_req: Request, res: Response, next: NextFunction) {
  try {
    const [responsible, candidates] = await Promise.all([
      purchaseResponsible(),
      User.find({ role: { $in: ["admin", "bartender", "direccion"] }, active: true }).select("name role").sort({ name: 1 }).lean(),
    ]);
    res.json({ purchaseResponsible: responsible, candidates: candidates.map((u) => ({ id: u._id.toString(), name: u.name, role: u.role })) });
  } catch (err) {
    next(err);
  }
}

/** Gerencia cambia el responsable de compras: fijo o hasta una fecha (para una semana). */
export async function saveSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, until } = req.body as { userId?: string | null; until?: string | null };
    if (userId && !(await User.exists({ _id: userId, active: true }))) throw badRequest("Elige una persona activa");
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw badRequest("Fecha inválida");
    await AppSetting.updateOne(
      { key: "purchaseResponsible" },
      { $set: { value: { userId: userId || null, until: until ? `${until}T23:59:59-06:00` : null }, updatedByName: req.auth!.name } },
      { upsert: true },
    );
    await logEvent(req.auth, { kind: "equipo", title: "Responsable de compras", detail: userId ? `${(await User.findById(userId).select("name"))?.name}${until ? ` hasta el ${until}` : " (fijo)"}` : "Administración (por defecto)" });
    res.json({ purchaseResponsible: await purchaseResponsible() });
  } catch (err) {
    next(err);
  }
}
