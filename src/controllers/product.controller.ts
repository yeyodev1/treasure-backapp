import { NextFunction, Request, Response } from "express";
import { Product, PRODUCT_CATEGORIES, ProductCategory } from "../models/product.model";
import { cocktailPriceFromRecipe } from "../services/inventory.service";
import { badRequest, notFound } from "../errors/httpError";

export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const onlyActive = req.query.all !== "1";
    const filter = onlyActive ? { active: true } : {};
    const products = await Product.find(filter)
      .populate("recipe.product", "name price unit")
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
  price?: number;
  unit?: string;
  warehouseStock?: number;
  isCocktail?: boolean;
  recipe?: Array<{ product: string; qty: number }>;
  active?: boolean;
}

async function resolvePrice(body: ProductBody): Promise<number> {
  // Cócteles con receta: el precio se calcula automáticamente según los ingredientes.
  if (body.isCocktail && body.recipe?.length) {
    const ids = body.recipe.map((r) => r.product);
    const ingredients = await Product.find({ _id: { $in: ids } }).select("price");
    const priceMap = new Map(ingredients.map((p) => [p._id.toString(), p.price]));
    return cocktailPriceFromRecipe(
      body.recipe.map((r) => ({
        product: { price: priceMap.get(r.product) ?? 0 },
        qty: r.qty,
      })),
    );
  }
  if (body.price === undefined || body.price < 0) throw badRequest("Precio inválido");
  return body.price;
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ProductBody;
    if (!body.name) throw badRequest("El nombre es obligatorio");
    if (!body.category || !PRODUCT_CATEGORIES.includes(body.category)) {
      throw badRequest("Categoría inválida");
    }

    const price = await resolvePrice(body);
    const product = await Product.create({
      name: body.name,
      category: body.category,
      icon: body.icon ?? "glass",
      price,
      unit: body.unit ?? "unidad",
      warehouseStock: body.warehouseStock ?? 0,
      isCocktail: body.isCocktail ?? false,
      recipe: body.recipe ?? [],
      isCustom: false,
      createdBy: req.auth!.sub,
    });
    res.status(201).json({ product });
  } catch (err) {
    next(err);
  }
}

/** Cóctel creado sobre la marcha desde la tablet del bar (botón "crear cóctel"). */
export async function createCustomCocktail(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as { name?: string; recipe?: Array<{ product: string; qty: number }> };
    if (!body.name) throw badRequest("El cóctel necesita un nombre");
    if (!body.recipe?.length) throw badRequest("El cóctel necesita al menos un ingrediente");

    const price = await resolvePrice({ isCocktail: true, recipe: body.recipe });
    const product = await Product.create({
      name: body.name,
      category: "coctel",
      icon: "cocktail",
      price,
      unit: "vaso",
      isCocktail: true,
      recipe: body.recipe,
      isCustom: true,
      createdBy: req.auth!.sub,
    });
    const populated = await product.populate("recipe.product", "name price unit");
    res.status(201).json({ product: populated });
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as ProductBody;
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Producto no encontrado");

    if (body.name !== undefined) product.name = body.name;
    if (body.category !== undefined) {
      if (!PRODUCT_CATEGORIES.includes(body.category)) throw badRequest("Categoría inválida");
      product.category = body.category;
    }
    if (body.icon !== undefined) product.icon = body.icon;
    if (body.unit !== undefined) product.unit = body.unit;
    if (body.warehouseStock !== undefined) product.warehouseStock = body.warehouseStock;
    if (body.recipe !== undefined) product.recipe = body.recipe as never;
    if (body.active !== undefined) product.active = body.active;

    if (body.isCocktail !== undefined) product.isCocktail = body.isCocktail;
    // Si llega precio explícito manda el menú; el cálculo automático por
    // ingredientes solo aplica cuando no se indica precio (cócteles creados en bar).
    if (body.price !== undefined) {
      if (body.price < 0) throw badRequest("Precio inválido");
      product.price = body.price;
    } else if (body.recipe !== undefined && product.isCocktail && product.recipe.length) {
      product.price = await resolvePrice({
        isCocktail: true,
        recipe: product.recipe.map((r) => ({ product: r.product.toString(), qty: r.qty })),
      });
    }

    await product.save();
    res.json({ product });
  } catch (err) {
    next(err);
  }
}
