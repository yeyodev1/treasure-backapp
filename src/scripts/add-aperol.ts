/**
 * Alta temporal del Aperol (pedido del bar, 19-nov-2026: "no está el aperol, necesitamos cobrar").
 * Crea Aperol (botella), Aperol (trago) y Aperol Spritz con precios estimados, y carga stock a
 * bordo para que el bar pueda registrar el consumo (sin stock la venta se bloquea).
 * Si en Contífico existe un producto "Aperol", lo vincula; si no, factura con el genérico (CAUTOR).
 * Si un producto ya existe, no lo toca. Sin --apply solo muestra lo que haría.
 *
 *   vercel env run -e production -- npx ts-node --transpile-only src/scripts/add-aperol.ts [--apply] [--botellas=2]
 */
import mongoose from "mongoose";
import { Product } from "../models/product.model";
import { User } from "../models/user.model";
import { contificoProducts } from "../services/contifico.service";
import { moveStock } from "../services/inventory.service";

// shortcut: precios estimados (Paula aún no los confirma); se corrigen en Catálogo.
// Trago = PVP de APEROL en Contífico ($9,13 sin IVA → $10,50 con IVA).
const BOTTLE_PRICE = 55.0;
const SHOT_PRICE = 10.5;
const SPRITZ_PRICE = 14.5;
// Igual que catalog-v3.
const BOTTLE_ML = 750;
const SHOT_ML = 60;
const SPRITZ = { aperol: 90, espumante: 90, soda: 30 };
const ESPUMANTE = "Calvet Celebration Brut (botella)";
const SODA = "Soda (agua carbonatada)";
const NARANJA = "Naranja (rodaja)";

const apply = process.argv.includes("--apply");
const bottles = Number(process.argv.find((a) => a.startsWith("--botellas="))?.split("=")[1] ?? 2);

async function main() {
  if (!Number.isFinite(bottles) || bottles < 0) throw new Error("--botellas debe ser un número ≥ 0");
  await mongoose.connect(process.env.MONGODB_URI!);
  const owner = await User.findOne({ role: "duena", active: true }).sort({ createdAt: 1 });
  if (!owner) throw new Error("No hay usuario Gerencia para registrar el alta");
  const at = new Date();
  const history = (price: number) => [{ price, changedBy: owner._id, at }];

  const remote = await contificoProducts(true).catch((e) => {
    console.log(`Contífico no respondió (${e?.message}); se factura con el genérico.`);
    return [];
  });
  const match = (re: RegExp) => remote.find((p) => p.estado === "A" && re.test(p.nombre));
  const aperolC = match(/aperol(?!.*spritz)/i);
  const spritzC = match(/aperol.*spritz|spritz/i);
  const cautor = remote.find((p) => p.codigo === "CAUTOR" && p.estado === "A");
  console.log(`Contífico: Aperol=${aperolC ? `${aperolC.nombre} (${aperolC.id}, pvp sin IVA ${aperolC.pvp ?? "—"})` : "no"},Spritz=${spritzC ? spritzC.nombre : "no"}, CAUTOR=${cautor ? "sí" : "no"}`);
  if (!aperolC && !cautor) console.log("OJO: sin producto en Contífico ni CAUTOR, la factura de estos ítems fallará.");

  const [espumante, soda, naranja] = await Promise.all(
    [ESPUMANTE, SODA, NARANJA].map((name) => Product.findOne({ name, active: true }).select("_id name")),
  );
  for (const [n, p] of [[ESPUMANTE, espumante], [SODA, soda], [NARANJA, naranja]] as const)
    console.log(`Insumo ${n}: ${p ? "ok" : "NO existe (se omite de la receta)"}`);

  let bottle = await Product.findOne({ name: "Aperol (botella)" });
  const plan = [
    `Aperol (botella) $${BOTTLE_PRICE} ${bottle ? "(ya existe)" : ""}`,
    `Aperol (trago) $${SHOT_PRICE}`,
    `Aperol Spritz $${SPRITZ_PRICE}`,
    `Stock a bordo: +${bottles} botella(s) (${bottles * BOTTLE_ML} ml), ajuste temporal`,
  ];
  console.log(`${apply ? "Aplicando" : "Simulación (usa --apply)"}:\n  ${plan.join("\n  ")}`);
  if (!apply) return mongoose.disconnect();

  if (!bottle) {
    bottle = await Product.create({
      name: "Aperol (botella)",
      category: "licor",
      icon: "bottle",
      kind: "fisico",
      sellable: true,
      stockUnit: "ml",
      containerSize: BOTTLE_ML,
      containerLabel: "botella",
      servingSize: SHOT_ML,
      servingPrice: SHOT_PRICE,
      recipe: [],
      active: true,
      price: BOTTLE_PRICE,
      warehouseStock: 0,
      onboardStock: 0,
      contificoId: aperolC?.id ?? "",
      createdBy: owner._id,
      priceHistory: history(BOTTLE_PRICE),
    });
    console.log(`Creado: ${bottle.name}`);
  }

  const recipeProduct = async (name: string, price: number, category: string, icon: string, recipe: Array<{ product: unknown; qty: number }>, contificoId = "") => {
    if (await Product.findOne({ name })) return console.log(`Ya existe: ${name}`);
    await Product.create({
      name,
      category,
      icon,
      kind: "receta",
      sellable: true,
      recipe,
      stockUnit: "unidad",
      containerSize: 1,
      containerLabel: "unidad",
      warehouseStock: 0,
      onboardStock: 0,
      active: true,
      price,
      contificoId,
      createdBy: owner._id,
      priceHistory: history(price),
    });
    console.log(`Creado: ${name} $${price}`);
  };

  await recipeProduct("Aperol (trago)", SHOT_PRICE, "licor", "shot", [{ product: bottle._id, qty: SHOT_ML }], aperolC?.id);
  await recipeProduct(
    "Aperol Spritz",
    SPRITZ_PRICE,
    "coctel",
    "cocktail",
    [
      { product: bottle._id, qty: SPRITZ.aperol },
      ...(espumante ? [{ product: espumante._id, qty: SPRITZ.espumante }] : []),
      ...(soda ? [{ product: soda._id, qty: SPRITZ.soda }] : []),
      ...(naranja ? [{ product: naranja._id, qty: 1 }] : []),
    ],
    spritzC?.id,
  );

  if (bottles > 0) {
    const session = await mongoose.startSession();
    await session.withTransaction(() =>
      moveStock({
        session,
        guard: false,
        type: "ajuste",
        location: "abordo",
        deltas: new Map([[String(bottle!._id), bottles * BOTTLE_ML]]),
        userId: String(owner._id),
        reason: "Alta temporal de Aperol para poder vender y facturar (19-nov-2026); corregir con el conteo",
      }),
    );
    await session.endSession();
    console.log(`Stock a bordo: +${bottles * BOTTLE_ML} ml de Aperol`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
