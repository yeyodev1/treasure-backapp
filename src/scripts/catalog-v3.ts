import { Types } from "mongoose";
import { Product, ProductCategory } from "../models/product.model";
import { StockUnit } from "../utils/units";

/**
 * Catálogo v3 (23-oct-2026): carta de Menu_Treasure.pdf + medidas de
 * Treasure_Detalle_Ingredientes_y_Medidas_por_Copa.xlsx.
 *
 * - Físicos: botellas, latas e insumos con stock en unidad base (ml…).
 * - Recetas: tragos (60 ml), copas (150 ml) y cócteles con sus medidas.
 * - Servicios: descorche.
 *
 * Sincroniza por nombre: si el producto ya existe se actualiza en su lugar
 * (conserva su _id y su precio vigente); si no, se crea.
 */

interface PhysicalDef {
  name: string;
  legacy?: string[];
  category: ProductCategory;
  icon: string;
  stockUnit: StockUnit;
  containerSize: number;
  containerLabel: string;
  sellable: boolean;
  price: number;
  servingSize?: number;
  servingPrice?: number;
}

interface RecipeDef {
  name: string;
  legacy?: string[];
  category: ProductCategory;
  icon: string;
  price: number;
  recipe: Array<[string, number]>;
}

const SHOT_ML = 60;
const GLASS_ML = 150;
const BOTTLE_ML = 750;

/** Destilados de la carta: [nombre, precio trago, precio botella]. */
const SPIRITS: Array<[string, number, number]> = [
  ["Johnnie Walker Azul", 40.0, 460.0],
  ["Johnnie Walker Verde 15 años", 18.0, 250.0],
  ["Johnnie Walker Negro 12 años", 14.0, 135.0],
  ["Buchanan's 12 años", 13.0, 110.0],
  ["Jack Daniel's", 12.0, 100.0],
  ["Evan Williams", 10.5, 90.5],
  ["Johnnie Walker Rojo", 9.0, 65.0],
  ["Havana Club 7 años", 15.0, 75.0],
  ["Bacardi", 10.0, 70.0],
  ["San Miguel", 8.0, 50.0],
  ["Absolut", 11.5, 65.0],
  ["SKY", 10.0, 50.0],
  ["Smirnoff", 8.5, 45.0],
  ["Bombay Sapphire", 12.5, 95.0],
  ["Hendrick's", 12.0, 85.0],
  ["Tanqueray", 10.0, 65.0],
  ["Don Julio Reposado", 15.0, 240.5],
  ["Don Julio Blanco", 13.5, 215.5],
  ["Jose Cuervo", 10.5, 85.0],
  ["El Charro", 8.0, 65.0],
];

/** Digestivos y aperitivos: se venden por trago; la botella es insumo. */
const DIGESTIFS: Array<[string, number]> = [
  ["Cointreau", 10.5],
  ["Cognac Hennessy", 13.75],
  ["Cinzano Rosso", 8.25],
  ["Gancia Rosso", 10.25],
];

/** Vinos por botella: [nombre, precio botella, precio copa o null]. */
const WINES: Array<[string, number, number | null]> = [
  ["Rosé D'Anjou", 45.99, null],
  ["Rosé Cotes de Provence", 50.0, null],
  ["VDV Ice Rosé", 67.5, null],
  ["VDV Ice", 46.99, null],
  ["Calvet Celebration Brut", 45.5, null],
  ["Calvet Celebration Brut Rosé", 44.5, null],
  ["Demi Sec Concha y Toro", 43.5, null],
  ["Blue Nun 24k", 46.55, null],
  ["Brut Reserva Vilarnau", 45.99, null],
  ["Demi Sec Vilarnau", 42.5, null],
  ["Sauvignon Blanc Casillero", 52.5, null],
  ["Chardonnay Casillero", 52.5, null],
  ["Blanco de Blancas", 45.5, null],
  ["Reservado Sauvignon", 38.5, 8.0],
  ["Faustino V Reserva", 67.5, null],
  ["Malbec Piel de Lobo", 46.99, null],
  ["Merlot Casillero", 45.5, null],
  ["Carmenere Casillero", 44.5, null],
  ["Malbec Casillero", 43.5, null],
  ["Pinot Noir Casillero", 46.55, null],
  ["Syrah Casillero", 45.99, null],
  ["Cabernet Sauvignon Casillero", 42.5, null],
  ["Reservado Cabernet Sauvignon", 38.5, 8.0],
  ["Reservado Merlot", 38.5, 8.0],
];

/** Vinos mini: [nombre, ml, precio]. Se venden cerrados. */
const MINI_WINES: Array<[string, number, number]> = [
  ["Calvet Sauvignon Blanc mini 187ml", 187, 10.99],
  ["Adobe Reserva Chardonnay mini 375ml", 375, 12.5],
  ["Cabernet Sauvignon mini 375ml", 375, 21.99],
  ["Calvet Merlot mini 187ml", 187, 10.99],
  ["Adobe Reserva Carmenere mini 375ml", 375, 12.5],
  ["VDV Ice mini 200ml", 200, 12.5],
  ["VDV Ice Rosé mini 200ml", 200, 12.5],
  ["Henkell Trocken Dry Piccolo 200ml", 200, 16.5],
  ["Henkell Trocken Dry 375ml", 375, 24.99],
  ["Adobe Reserva Rosé mini 375ml", 375, 12.5],
];

const CAN_ML = 355;

function physicals(): PhysicalDef[] {
  const list: PhysicalDef[] = [];

  for (const [name, shot, bottle] of SPIRITS) {
    list.push({
      name: `${name} (botella)`,
      category: "licor",
      icon: "bottle",
      stockUnit: "ml",
      containerSize: BOTTLE_ML,
      containerLabel: "botella",
      sellable: true,
      price: bottle,
      servingSize: SHOT_ML,
      servingPrice: shot,
    });
  }

  for (const [name, shot] of DIGESTIFS) {
    list.push({
      name: `${name} (botella)`,
      category: "licor",
      icon: "bottle",
      stockUnit: "ml",
      containerSize: BOTTLE_ML,
      containerLabel: "botella",
      sellable: false,
      price: 0,
      servingSize: SHOT_ML,
      servingPrice: shot,
    });
  }

  for (const [name, bottle, glass] of WINES) {
    list.push({
      name: `${name} (botella)`,
      category: "vino",
      icon: glass ? "wine" : "bottle",
      stockUnit: "ml",
      containerSize: BOTTLE_ML,
      containerLabel: "botella",
      sellable: true,
      price: bottle,
      servingSize: GLASS_ML,
      servingPrice: glass ?? Math.round((bottle / 5) * 100) / 100,
    });
  }

  for (const [name, ml, price] of MINI_WINES) {
    list.push({
      name,
      category: "vino",
      icon: "bottle",
      stockUnit: "ml",
      containerSize: ml,
      containerLabel: "botella mini",
      sellable: true,
      price,
    });
  }

  const beers: Array<[string, number]> = [
    ["Club", 6.75],
    ["Pilsener", 6.55],
    ["Stella Artois", 9.5],
    ["Corona", 9.0],
  ];
  for (const [name, price] of beers) {
    list.push({
      name,
      category: "cerveza",
      icon: "beer",
      stockUnit: "unidad",
      containerSize: 1,
      containerLabel: "botella",
      sellable: true,
      price,
    });
  }

  // Gaseosas por variante (guía V3): cada una con su stock.
  const sodas: Array<[string, number, string[]?]> = [
    ["Coca Cola", 6.5],
    ["Coca Cola Zero", 6.75],
    ["Fanta", 6.5],
    ["Sprite", 6.5],
    ["Inca Cola", 6.5],
    ["Fioravanti", 6.5],
    ["Ginger Beer", 6.5],
    ["Ginger Ale", 6.5],
    ["Agua tónica", 6.5],
  ];
  for (const [name, price, legacy] of sodas) {
    list.push({
      name,
      legacy,
      category: "gaseosa",
      icon: "soda",
      stockUnit: "ml",
      containerSize: CAN_ML,
      containerLabel: "lata",
      sellable: true,
      price,
      servingSize: CAN_ML,
      servingPrice: price,
    });
  }

  list.push({
    name: "Agua con gas Güitig",
    category: "agua",
    icon: "water",
    stockUnit: "ml",
    containerSize: 500,
    containerLabel: "botella",
    sellable: true,
    price: 6.5,
    servingSize: 500,
    servingPrice: 6.5,
  });

  // Insumos de coctelería (no se venden solos).
  const supplies: Array<[string, StockUnit, number, string, string]> = [
    ["Vermut seco (botella)", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Campari (botella)", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Caña Manabita (botella)", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Baileys (botella)", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Soda (agua carbonatada)", "ml", CAN_ML, "lata", "soda"],
    ["Jugo de lima", "ml", 1000, "litro", "juice"],
    ["Jugo de limón", "ml", 1000, "litro", "juice"],
    ["Jugo de naranja", "ml", 1000, "litro", "juice"],
    ["Jugo de piña", "ml", 1000, "litro", "juice"],
    ["Jugo de cranberry", "ml", 1000, "litro", "juice"],
    ["Granadina", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Jarabe simple", "ml", BOTTLE_ML, "botella", "bottle"],
    ["Crema de coco", "ml", 400, "lata", "soda"],
    ["Azúcar", "cucharadita", 1, "cucharadita", "snack"],
    ["Menta", "ramita", 1, "ramita", "lime"],
    ["Sal para borde", "porción", 1, "porción", "snack"],
    ["Limón (rodaja)", "rodaja", 1, "rodaja", "lime"],
    ["Naranja (rodaja)", "rodaja", 1, "rodaja", "lime"],
    ["Lima (fruta)", "unidad", 1, "unidad", "lime"],
    ["Aceituna", "unidad", 1, "unidad", "snack"],
    ["Clara de huevo", "unidad", 1, "unidad", "snack"],
    ["Angostura", "golpe", 1, "golpe", "bottle"],
  ];
  for (const [name, stockUnit, containerSize, containerLabel, icon] of supplies) {
    list.push({
      name,
      category: "insumo",
      icon,
      stockUnit,
      containerSize,
      containerLabel,
      sellable: false,
      price: 0,
    });
  }

  return list;
}

function recipes(): RecipeDef[] {
  const list: RecipeDef[] = [];

  for (const [name, shot] of SPIRITS) {
    list.push({
      name: `${name} (trago)`,
      category: "licor",
      icon: "shot",
      price: shot,
      recipe: [[`${name} (botella)`, SHOT_ML]],
    });
  }
  for (const [name, shot] of DIGESTIFS) {
    list.push({
      name: `${name} (trago)`,
      category: "licor",
      icon: "shot",
      price: shot,
      recipe: [[`${name} (botella)`, SHOT_ML]],
    });
  }
  for (const [name, , glass] of WINES) {
    if (!glass) continue;
    list.push({
      name: `${name} (copa)`,
      category: "vino",
      icon: "wine",
      price: glass,
      recipe: [[`${name} (botella)`, GLASS_ML]],
    });
  }

  const cocktail = (name: string, price: number, recipe: Array<[string, number]>, legacy?: string[]) =>
    list.push({ name, legacy, category: "coctel", icon: "cocktail", price, recipe });

  cocktail("Classic Margarita", 14.5, [
    ["El Charro (botella)", 60],
    ["Cointreau (botella)", 25],
    ["Jugo de lima", 30],
    ["Sal para borde", 1],
  ]);
  cocktail("Tequila Sunrise", 14.5, [
    ["El Charro (botella)", 45],
    ["Jugo de naranja", 90],
    ["Granadina", 15],
  ]);
  cocktail("Mojito", 13.5, [
    ["Bacardi (botella)", 60],
    ["Jugo de lima", 25],
    ["Azúcar", 2],
    ["Menta", 11],
    ["Soda (agua carbonatada)", 120],
  ]);
  cocktail("Cuba Libre", 13.5, [
    ["Bacardi (botella)", 60],
    ["Coca Cola", 120],
    ["Jugo de lima", 10],
  ]);
  cocktail("Piña Colada", 13.0, [
    ["Bacardi (botella)", 50],
    ["Crema de coco", 30],
    ["Jugo de piña", 90],
  ]);
  cocktail("Daiquiri", 13.0, [
    ["Bacardi (botella)", 60],
    ["Jugo de lima", 30],
    ["Jarabe simple", 15],
  ]);
  cocktail("Gin Tonic", 14.5, [
    ["Tanqueray (botella)", 60],
    ["Agua tónica", 150],
    ["Limón (rodaja)", 1],
  ]);
  cocktail("Martini", 14.5, [
    ["Tanqueray (botella)", 60],
    ["Vermut seco (botella)", 20],
    ["Aceituna", 3],
  ]);
  cocktail("Negroni", 15.5, [
    ["Tanqueray (botella)", 30],
    ["Campari (botella)", 30],
    ["Cinzano Rosso (botella)", 30],
    ["Naranja (rodaja)", 1],
  ]);
  cocktail("Caipirinha", 10.0, [
    ["Caña Manabita (botella)", 60],
    ["Lima (fruta)", 1],
    ["Azúcar", 4],
  ]);
  cocktail("Pisco Sour", 12.5, [
    ["Caña Manabita (botella)", 60],
    ["Jugo de limón", 30],
    ["Jarabe simple", 20],
    ["Clara de huevo", 1],
    ["Angostura", 4],
  ]);
  cocktail("Baileys", 10.0, [["Baileys (botella)", 60]]);
  cocktail("Moscow Mule", 15.5, [
    ["SKY (botella)", 60],
    ["Ginger Beer", 120],
    ["Jugo de lima", 25],
  ]);
  cocktail("Vodka Tonic", 13.5, [
    ["SKY (botella)", 60],
    ["Agua tónica", 150],
  ]);
  cocktail("Cosmopolitan", 16.5, [
    ["SKY (botella)", 45],
    ["Cointreau (botella)", 15],
    ["Jugo de cranberry", 30],
    ["Jugo de lima", 15],
  ]);
  cocktail("Manhattan", 16.5, [
    ["Evan Williams (botella)", 60],
    ["Cinzano Rosso (botella)", 30],
    ["Angostura", 3],
  ]);
  // 1 cucharada de azúcar = 3 cucharaditas.
  cocktail(
    "Old Fashioned",
    16.5,
    [
      ["Evan Williams (botella)", 60],
      ["Azúcar", 3],
      ["Angostura", 5],
    ],
    ["Old Fashion"],
  );

  return list;
}

/** Productos del modelo anterior que ya no se venden así (se desactivan, no se borran). */
export const DEACTIVATE = ["Gaseosas (Coca Cola, Fanta, Sprite, Inca Cola, Fioravanti)"];

async function findByNames(names: string[]) {
  return Product.findOne({ name: { $in: names } });
}

/** Crea o actualiza el catálogo v3. Devuelve el mapa nombre → _id. */
export async function syncCatalogV3(userId: Types.ObjectId | string) {
  const ids = new Map<string, Types.ObjectId>();

  for (const def of physicals()) {
    const existing = await findByNames([def.name, ...(def.legacy ?? [])]);
    const fields = {
      name: def.name,
      category: def.category,
      icon: def.icon,
      kind: "fisico" as const,
      sellable: def.sellable,
      stockUnit: def.stockUnit,
      containerSize: def.containerSize,
      containerLabel: def.containerLabel,
      servingSize: def.servingSize ?? 0,
      servingPrice: def.servingPrice ?? 0,
      recipe: [],
      active: true,
    };
    if (existing) {
      await Product.updateOne(
        { _id: existing._id },
        { $set: { ...fields, ...(existing.price ? {} : { price: def.price }) } },
      );
      ids.set(def.name, existing._id);
    } else {
      const created = await Product.create({
        ...fields,
        price: def.price,
        warehouseStock: 0,
        onboardStock: 0,
        createdBy: userId,
        priceHistory: def.price ? [{ price: def.price, changedBy: userId, at: new Date() }] : [],
      });
      ids.set(def.name, created._id);
    }
  }

  for (const def of recipes()) {
    const recipe = def.recipe.map(([name, qty]) => {
      const id = ids.get(name);
      if (!id) throw new Error(`Ingrediente sin definir: ${name} (en ${def.name})`);
      return { product: id, qty };
    });
    const existing = await findByNames([def.name, ...(def.legacy ?? [])]);
    const fields = {
      name: def.name,
      category: def.category,
      icon: def.icon,
      kind: "receta" as const,
      sellable: true,
      recipe,
      stockUnit: "unidad" as const,
      containerSize: 1,
      containerLabel: "unidad",
      warehouseStock: 0,
      onboardStock: 0,
      active: true,
    };
    if (existing) {
      await Product.updateOne(
        { _id: existing._id },
        { $set: { ...fields, ...(existing.price ? {} : { price: def.price }) } },
      );
      ids.set(def.name, existing._id);
    } else {
      const created = await Product.create({
        ...fields,
        price: def.price,
        createdBy: userId,
        priceHistory: [{ price: def.price, changedBy: userId, at: new Date() }],
      });
      ids.set(def.name, created._id);
    }
  }

  // En la app se llama Descorche; "Corkage fee" solo en el documento en inglés (L12).
  const corkage = await findByNames(["Descorche", "Corkage Fee (descorche)"]);
  const corkageFields = {
    name: "Descorche",
    category: "servicio" as const,
    icon: "bottle",
    kind: "servicio" as const,
    sellable: true,
    recipe: [],
    warehouseStock: 0,
    onboardStock: 0,
    active: true,
  };
  if (corkage) {
    await Product.updateOne({ _id: corkage._id }, { $set: corkageFields });
  } else {
    await Product.create({ ...corkageFields, price: 35, createdBy: userId });
  }

  await Product.updateMany({ name: { $in: DEACTIVATE } }, { $set: { active: false } });

  return ids;
}
