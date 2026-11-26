import { Types } from "mongoose";
import { Product } from "../models/product.model";
import { Cruise } from "../models/cruise.model";
import { StockCount, CountKind } from "../models/stockCount.model";
import { StockMovement } from "../models/stockMovement.model";
import { goalsAt } from "./goals.service";
import { round2 } from "../utils/units";

/**
 * Bar-stock (especificación del 24-nov-2026): el stock del barco se cuenta a
 * ciegas al cierre de cada crucero, la directora recuenta a ciegas solo lo que
 * difiere y cada diferencia real queda como merma con producto, motivo,
 * crucero y persona. Gerencia solo ve las excepciones.
 */

/** Código correlativo de conteo (CT-001, CT-002…). */
export async function nextCountCode(): Promise<string> {
  const last = await StockCount.findOne().sort({ createdAt: -1 }).select("code");
  const n = last ? Number(last.code.replace(/\D/g, "")) + 1 : 1;
  return `CT-${String(n).padStart(3, "0")}`;
}

/** Frescos (menta, limón, azúcar…): se piden pero no llevan stock ni se cuentan. */
const FRESH_UNITS = new Set(["ramita", "rodaja", "cucharadita", "cucharada", "gota", "golpe", "porción"]);
export const isFresh = (p: { fresh?: boolean; stockUnit?: string }) => Boolean(p.fresh) || FRESH_UNITS.has(p.stockUnit ?? "");

/** Orden fijo del conteo: el bar se guarda así y la pantalla sigue ese orden. */
export const COUNT_GROUPS = ["licores", "vinos", "cervezas", "gaseosas", "insumos"] as const;
export type CountGroup = (typeof COUNT_GROUPS)[number];
export const GROUP_LABELS: Record<CountGroup, string> = {
  licores: "Licores",
  vinos: "Vinos",
  cervezas: "Cervezas",
  gaseosas: "Gaseosas y agua",
  insumos: "Insumos",
};
export function groupOf(p: { category?: string }): CountGroup {
  if (p.category === "licor") return "licores";
  if (p.category === "vino") return "vinos";
  if (p.category === "cerveza") return "cervezas";
  if (p.category === "gaseosa" || p.category === "agua") return "gaseosas";
  return "insumos";
}

/** Se cuenta en envases cerrados + el abierto en ¼, ½, ¾ (licores, vinos, jugos y jarabes en envase). */
export const countsOpen = (p: { stockUnit?: string; containerSize?: number }) =>
  p.stockUnit === "ml" && (p.containerSize ?? 1) > 1;

/** Lo que se cuenta a bordo: insumos físicos activos que no son frescos. */
export async function countableProducts() {
  const products = await Product.find({ kind: "fisico", active: true })
    .select("name category stockUnit containerSize containerLabel caseSize countOrder fresh onboardStock costPerUnit")
    .lean();
  return products
    .filter((p) => !isFresh(p))
    .sort(
      (a, b) =>
        COUNT_GROUPS.indexOf(groupOf(a)) - COUNT_GROUPS.indexOf(groupOf(b)) ||
        (a.countOrder ?? 0) - (b.countOrder ?? 0) ||
        a.name.localeCompare(b.name, "es"),
    );
}

/** Conteo a bordo que crea la app: el de cierre al finalizar un crucero, el inicial o el de Administración. */
export async function openCount(kind: CountKind, cruiseId: Types.ObjectId | null, userId: string, notes = "") {
  if (kind === "cierre" && cruiseId) {
    const existing = await StockCount.findOne({ kind: "cierre", cruise: cruiseId });
    if (existing) return existing;
  }
  const products = await countableProducts();
  return StockCount.create({
    code: await nextCountCode(),
    kind,
    location: "abordo",
    cruise: cruiseId,
    status: "borrador",
    cutAt: new Date(),
    lines: products.map((p) => ({
      product: p._id,
      name: p.name,
      stockUnit: p.stockUnit,
      digitalAtCut: p.onboardStock ?? 0,
      physical: null,
      reason: "",
    })),
    notes,
    createdBy: userId,
  });
}

type CountDoc = InstanceType<typeof StockCount>;
type ProductLite = { _id: Types.ObjectId; name: string; category: string; stockUnit: string; containerSize: number; costPerUnit: number };

async function productsOf(count: CountDoc) {
  const products = (await Product.find({ _id: { $in: count.lines.map((l) => l.product) } })
    .select("name category stockUnit containerSize costPerUnit")
    .lean()) as unknown as ProductLite[];
  return new Map(products.map((p) => [p._id.toString(), p]));
}

/** Diferencia permitida: ± ¼ de botella en lo que se cuenta abierto; 0 en unidades. */
function toleranceOf(p: ProductLite | undefined, openTolerance: number) {
  return p && countsOpen(p) ? openTolerance * (p.containerSize || 1) : 0;
}

/**
 * Tras el conteo del bartender: lo que cae dentro de tolerancia queda listo;
 * lo demás pasa a la directora. Devuelve cuántos productos debe recontar.
 */
export async function evaluateBartender(count: CountDoc) {
  const goals = await goalsAt(count.cutAt);
  const products = await productsOf(count);
  let toRecount = 0;
  for (const line of count.lines) {
    if (line.physical === null) continue;
    const diff = round2(line.physical - Math.max(0, line.digitalAtCut));
    const tol = toleranceOf(products.get(line.product.toString()), goals.openTolerance ?? 0.25);
    if (Math.abs(diff) <= tol + 1e-9) line.result = diff ? "tolerancia" : "ok";
    else {
      line.result = "";
      toRecount += 1;
    }
  }
  return toRecount;
}

/**
 * Regla de un producto recontado (pura, con su autocomprobación): dentro de
 * tolerancia o con sobrante es error de conteo; si falta, es merma. Una
 * botella completa de licor faltante siempre va a Gerencia.
 */
export function judgeRecount(input: { expected: number; recount: number; tolerance: number; unitCost: number; category: string; containerSize: number }) {
  const shortage = round2(Math.max(0, input.expected) - input.recount);
  if (shortage <= input.tolerance + 1e-9) return { result: "corregido" as const, value: 0, fullBottle: false };
  return {
    result: "merma" as const,
    value: round2(shortage * input.unitCost),
    fullBottle: input.category === "licor" && shortage >= (input.containerSize || 1) - 1e-9,
  };
}

/**
 * Recuento de la directora: si coincide con el sistema era error de conteo
 * (se corrige); si no, es una diferencia real y, si falta, es merma con motivo.
 * Devuelve por qué pasa a Gerencia (vacío = la cierra la directora).
 */
export async function evaluateRecount(count: CountDoc) {
  const goals = await goalsAt(count.cutAt);
  const products = await productsOf(count);
  let total = 0;
  const reasons: string[] = [];
  for (const line of count.lines) {
    if (line.result === "ok" || line.result === "tolerancia" || line.recount === null) continue;
    const p = products.get(line.product.toString());
    line.unitCost = p?.costPerUnit ?? 0;
    const judged = judgeRecount({
      expected: line.digitalAtCut,
      recount: line.recount,
      tolerance: toleranceOf(p, goals.openTolerance ?? 0.25),
      unitCost: line.unitCost,
      category: p?.category ?? "",
      containerSize: p?.containerSize || 1,
    });
    line.result = judged.result;
    line.value = judged.value;
    line.fullBottle = judged.fullBottle;
    total += line.value;
    if (line.fullBottle) reasons.push(`Botella completa faltante: ${line.name}`);
  }
  count.wasteTotal = round2(total);
  const limit = goals.wasteLimit ?? 25;
  if (count.wasteTotal > limit) reasons.unshift(`Merma $${count.wasteTotal.toFixed(2)} sobre el límite $${limit}`);
  reasons.push(...(await repetitions(count, goals.repeatCruises ?? 3)));
  return reasons;
}

/** El mismo producto o la misma persona con merma en N cruceros seguidos (contando este). */
async function repetitions(count: CountDoc, times: number) {
  if (times < 2) return [];
  const previous = await StockCount.find({ kind: "cierre", status: "aprobado", _id: { $ne: count._id } })
    .sort({ cutAt: -1 })
    .limit(times - 1)
    .select("lines.product lines.result lines.name submittedBy")
    .lean();
  if (previous.length < times - 1) return [];
  const out: string[] = [];
  for (const line of count.lines) {
    if (line.result !== "merma") continue;
    const id = line.product.toString();
    if (previous.every((c) => c.lines.some((l) => l.product.toString() === id && l.result === "merma"))) {
      out.push(`${line.name} con merma en ${times} cruceros seguidos`);
    }
  }
  const person = count.submittedBy?.toString();
  if (
    person &&
    count.lines.some((l) => l.result === "merma") &&
    previous.every((c) => c.submittedBy?.toString() === person && c.lines.some((l) => l.result === "merma"))
  ) {
    out.push(`${count.submittedByName || "El mismo bartender"} con merma en ${times} cruceros seguidos`);
  }
  return out;
}

/**
 * Conteo verificado: pasa a ser la referencia. Cada producto queda en lo
 * contado (el recuento de la directora si lo hubo) sobre el stock actual, así
 * se conservan los movimientos posteriores al corte. Las faltas reales son
 * merma con su motivo; lo demás, ajuste.
 */
export async function applyVerified(count: CountDoc, userId: string) {
  for (const line of count.lines) {
    const final = line.recount ?? line.physical;
    if (final === null) continue;
    const delta = round2(final - line.digitalAtCut);
    if (!delta) continue;
    await Product.updateOne({ _id: line.product }, { $inc: { onboardStock: delta } });
    await StockMovement.create({
      type: line.result === "merma" ? "merma" : "ajuste",
      product: line.product,
      location: "abordo",
      qty: delta,
      cruise: count.cruise,
      count: count._id,
      reason: `${count.code} · ${line.result === "merma" ? `merma (${line.motive || "sin motivo"})` : line.result === "corregido" ? "error de conteo corregido" : "conteo verificado"}`,
      unitCost: line.unitCost ?? 0,
      user: userId,
    });
  }
  count.status = "aprobado";
}

/**
 * ¿Se puede iniciar este crucero? Solo con el conteo de cierre del anterior
 * verificado. Con el conteo del bartender enviado y la directora pasada de su
 * plazo, sí (lo pendiente queda en Gerencia). Gerencia puede autorizarlo.
 */
export async function startGate(cruise: { _id: Types.ObjectId; startDate: Date; startAuthorization?: { status: string } | null }) {
  const previous = await Cruise.findOne({ status: "cerrado", startDate: { $lt: cruise.startDate } })
    .sort({ startDate: -1 })
    .select("code closedAt")
    .lean();
  if (!previous) return { ok: true, blocker: "", pending: false, previous: null as null | { code: string } };
  const counts = await StockCount.find({
    location: "abordo",
    $or: [{ kind: "cierre", cruise: previous._id }, { kind: { $in: ["inicial", "cierre"] }, cutAt: { $gte: previous.closedAt ?? new Date(0) } }],
  })
    .sort({ cutAt: -1 })
    .lean();
  if (counts.some((c) => c.status === "aprobado")) return { ok: true, blocker: "", pending: false, previous };
  const sent = counts.find((c) => c.status === "enviado" || c.status === "gerencia");
  const goals = await goalsAt();
  if (sent?.submittedAt && Date.now() - new Date(sent.submittedAt).getTime() >= (goals.verifyMaxHours ?? 1) * 3_600_000) {
    return { ok: true, blocker: "", pending: true, previous };
  }
  if (cruise.startAuthorization?.status === "autorizada") return { ok: true, blocker: "", pending: false, previous };
  return {
    ok: false,
    pending: false,
    previous,
    blocker: sent
      ? `${previous.code}: la directora aún verifica el conteo de cierre`
      : `${previous.code} no tiene conteo de cierre verificado`,
  };
}
