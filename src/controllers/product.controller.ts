import { NextFunction, Request, Response } from "express";
import { isOwner } from "../utils/roles";
import { Types } from "mongoose";
import { IProduct, Product, PRODUCT_CATEGORIES, ProductCategory, WINE_STYLES, WineStyle } from "../models/product.model";
import { suggestedPrice } from "../services/inventory.service";
import { logEvent } from "../services/audit.service";
import { contificoProducts } from "../services/contifico.service";
import { badRequest, forbidden, notFound } from "../errors/httpError";
import { PRODUCT_KINDS, ProductKind, STOCK_UNITS, StockUnit } from "../utils/units";

const RECIPE_POPULATE = "name kind stockUnit containerSize containerLabel servingSize servingPrice";

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.all !== "1") filter.active = true;
    if (typeof req.query.kind === "string") filter.kind = req.query.kind;
    const products = await Product.find(filter)
      .populate("recipe.product", RECIPE_POPULATE)
      .populate("priceHistory.changedBy", "name")
      .sort({ category: 1, name: 1 });
    res.json({ products });
  } catch (err) {
    next(err);
  }
}

interface ProductBody {
  name?: string;
  category?: ProductCategory;
  icon?: string;
  kind?: ProductKind;
  price?: number;
  sellable?: boolean;
  stockUnit?: StockUnit;
  containerSize?: number;
  containerLabel?: string;
  lowStockThreshold?: number;
  servingSize?: number;
  servingPrice?: number;
  recipe?: Array<{ product: string; qty: number }>;
  active?: boolean;
  contificoId?: string;
  wineStyle?: WineStyle | "";
}

function applyWineStyle(product: IProduct, style: WineStyle | "" | undefined) {
  if (style === undefined) return;
  if (style !== "" && !WINE_STYLES.includes(style)) throw badRequest("Tipo de vino inválido");
  product.wineStyle = product.category === "vino" ? style : "";
}

async function validateRecipe(recipe: Array<{ product: string; qty: number }>) {
  if (!recipe.length) throw badRequest("La receta necesita al menos un ingrediente");
  const ids = recipe.map((r) => r.product);
  if (ids.some((id) => !Types.ObjectId.isValid(id))) throw badRequest("Ingrediente inválido");
  const ingredients = await Product.find({ _id: { $in: ids } }).select("kind name");
  if (ingredients.length !== new Set(ids).size) throw badRequest("Hay ingredientes que no existen");
  const notPhysical = ingredients.find((p) => p.kind !== "fisico");
  if (notPhysical) throw badRequest(`${notPhysical.name} no es un insumo físico`);
  if (recipe.some((r) => !(r.qty > 0))) throw badRequest("Cada ingrediente necesita su medida");
}

/** Solo Gerencia (rol duena, nunca por nombre o correo) cambia precios; queda historial con autor. */
function applyPrice(product: IProduct, price: number, req: Request) {
  if (!isOwner(req.auth!.role)) throw forbidden("Solo Gerencia cambia precios");
  if (!(price >= 0)) throw badRequest("Precio inválido");
  if (product.price !== price) {
    product.priceHistory.push({ price, changedBy: req.auth!.sub as never, at: new Date() });
    product.price = price;
  }
}

function applyPhysicalFields(product: IProduct, body: ProductBody) {
  if (body.stockUnit !== undefined) {
    if (!STOCK_UNITS.includes(body.stockUnit)) throw badRequest("Unidad inválida");
    product.stockUnit = body.stockUnit;
  }
  if (body.containerSize !== undefined) {
    if (!(body.containerSize > 0)) throw badRequest("El tamaño del envase debe ser mayor a 0");
    product.containerSize = body.containerSize;
  }
  if (body.containerLabel !== undefined) product.containerLabel = body.containerLabel;
  if (body.sellable !== undefined) product.sellable = body.sellable;
  if (body.lowStockThreshold !== undefined) product.lowStockThreshold = body.lowStockThreshold;
  if (body.servingSize !== undefined) product.servingSize = body.servingSize;
  if (body.servingPrice !== undefined) product.servingPrice = body.servingPrice;
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ProductBody;
    if (!body.name?.trim()) throw badRequest("El nombre es obligatorio");
    if (!body.kind || !PRODUCT_KINDS.includes(body.kind)) throw badRequest("Tipo inválido");
    if (!body.category || !PRODUCT_CATEGORIES.includes(body.category)) {
      throw badRequest("Categoría inválida");
    }
    if (body.kind === "receta") await validateRecipe(body.recipe ?? []);

    const product = new Product({
      name: body.name.trim(),
      category: body.category,
      icon: body.icon ?? "glass",
      kind: body.kind,
      price: 0,
      sellable: body.kind === "fisico" ? body.sellable ?? true : true,
      recipe: body.kind === "receta" ? body.recipe : [],
      createdBy: req.auth!.sub,
    });
    if (body.kind === "fisico") applyPhysicalFields(product, body);
    applyWineStyle(product, body.wineStyle);
    if (body.price !== undefined && body.price > 0) applyPrice(product, body.price, req);
    await product.save();

    await logEvent(req.auth, {
      kind: "catalogo",
      title: `Producto creado · ${product.name}`,
      detail: product.kind,
      amount: product.price || null,
    });

    res.status(201).json({ product: await product.populate("recipe.product", RECIPE_POPULATE) });
  } catch (err) {
    next(err);
  }
}

/** Cóctel fuera de carta armado en el bar: precio sugerido por sus medidas. */
export async function createCustomCocktail(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as { name?: string; recipe?: Array<{ product: string; qty: number }> };
    if (!body.name?.trim()) throw badRequest("El cóctel necesita un nombre");
    await validateRecipe(body.recipe ?? []);

    const price = await suggestedPrice(body.recipe!);
    const product = await Product.create({
      name: body.name.trim(),
      category: "coctel",
      icon: "cocktail",
      kind: "receta",
      price,
      sellable: true,
      recipe: body.recipe,
      isCustom: true,
      createdBy: req.auth!.sub,
      priceHistory: [{ price, changedBy: req.auth!.sub, at: new Date() }],
    });

    await logEvent(req.auth, {
      kind: "catalogo",
      title: `Cóctel creado en bar · ${product.name}`,
      detail: "Precio sugerido por sus medidas",
      amount: price,
    });

    res.status(201).json({ product: await product.populate("recipe.product", RECIPE_POPULATE) });
  } catch (err) {
    next(err);
  }
}

/**
 * Quitar de la carta un cóctel creado en el bar (pedido del cliente,
 * 31-oct-2026: "cuando creo un cóctel no puedo eliminarlo"). Solo los
 * creados en el bar; se desactiva para conservar el historial de lo vendido.
 */
export async function removeCustomCocktail(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Cóctel no encontrado");
    if (!product.isCustom) throw forbidden("Solo se eliminan los cócteles creados en el bar");
    if (product.active) {
      product.active = false;
      await product.save();
      await logEvent(req.auth, {
        kind: "catalogo",
        title: `Cóctel eliminado del bar · ${product.name}`,
        detail: "Se quita de la carta; lo vendido queda en el historial",
      });
    }
    res.json({ product });
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ProductBody;
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Producto no encontrado");

    const changes: string[] = [];
    if (body.name !== undefined && body.name.trim() && body.name !== product.name) {
      product.name = body.name.trim();
      changes.push("nombre");
    }
    if (body.category !== undefined) {
      if (!PRODUCT_CATEGORIES.includes(body.category)) throw badRequest("Categoría inválida");
      product.category = body.category;
    }
    if (body.icon !== undefined) product.icon = body.icon;
    if (body.wineStyle !== undefined && body.wineStyle !== product.wineStyle) {
      applyWineStyle(product, body.wineStyle);
      changes.push(`tipo de vino ${body.wineStyle || "sin tipo"}`);
    }
    if (product.category !== "vino") product.wineStyle = "";
    if (body.kind !== undefined && body.kind !== product.kind) {
      if (!PRODUCT_KINDS.includes(body.kind)) throw badRequest("Tipo inválido");
      product.kind = body.kind;
      changes.push(`tipo ${body.kind}`);
    }
    if (product.kind === "fisico") applyPhysicalFields(product, body);
    if (product.kind === "receta" && body.recipe !== undefined) {
      await validateRecipe(body.recipe);
      product.recipe = body.recipe as never;
      changes.push("receta");
    }
    if (product.kind !== "receta") product.recipe = [] as never;
    if (body.price !== undefined && body.price !== product.price) {
      const before = product.price;
      applyPrice(product, body.price, req);
      changes.push(`precio ${before} → ${body.price}`);
    }
    if (body.active !== undefined && body.active !== product.active) {
      product.active = body.active;
      changes.push(body.active ? "activado" : "desactivado");
    }
    if (body.contificoId !== undefined && body.contificoId !== product.contificoId) {
      if (!isOwner(req.auth!.role)) throw forbidden("Solo Gerencia vincula con Contífico");
      if (body.contificoId) {
        const match = (await contificoProducts()).find((p) => p.id === body.contificoId);
        if (!match) throw badRequest("Ese producto no existe en Contífico");
        product.contificoId = match.id;
        product.contificoCode = match.codigo;
        changes.push(`Contífico ${match.codigo}`);
      } else {
        product.contificoId = "";
        product.contificoCode = "";
        changes.push("sin Contífico");
      }
    }

    await product.save();
    if (changes.length) {
      await logEvent(req.auth, {
        kind: "catalogo",
        title: `Producto editado · ${product.name}`,
        detail: changes.join(", "),
      });
    }

    res.json({ product: await product.populate("recipe.product", RECIPE_POPULATE) });
  } catch (err) {
    next(err);
  }
}
