import mongoose from "mongoose";
import { env } from "../config/env";
import { Product } from "../models/product.model";
import { contificoProducts } from "../services/contifico.service";
import { round2 } from "../utils/units";

/**
 * Vincula el catálogo de Treasure con los productos de Contífico de Paula
 * (código de Contífico por nombre exacto en Treasure). Idempotente.
 *
 *   npx ts-node-dev --transpile-only src/scripts/link-contifico.ts          (muestra)
 *   npx ts-node-dev --transpile-only src/scripts/link-contifico.ts --apply  (guarda)
 */
const CODES: Record<string, string> = {
  // Cervezas, aguas y gaseosas
  Club: "CC",
  Corona: "CCR",
  Pilsener: "CP",
  "Stella Artois": "CSA",
  "Agua con gas Güitig": "GUI",
  "Agua tónica": "TW",
  "Coca Cola": "CCO",
  "Coca Cola Zero": "CCZ",
  Fanta: "FANTA",
  Fioravanti: "FV",
  "Ginger Ale": "GA",
  "Ginger Beer": "GB",
  "Inca Cola": "IC",
  Sprite: "SP",
  // Cócteles
  Baileys: "BAY",
  Caipirinha: "CAI",
  "Classic Margarita": "M",
  Cosmopolitan: "COS",
  "Cuba Libre": "CL",
  Daiquiri: "DAI",
  "Gin Tonic": "GT",
  Manhattan: "MAN",
  Martini: "MAR",
  Mojito: "MO",
  "Moscow Mule": "MM",
  Negroni: "NEG",
  "Old Fashioned": "OLDF",
  "Pisco Sour": "PS",
  "Piña Colada": "PC",
  "Tequila Sunrise": "TS",
  "Vodka Tonic": "VT",
  // Licores: botella y trago
  "Absolut (botella)": "VAB",
  "Absolut (trago)": "SVAB",
  "Bacardi (botella)": "RBA",
  "Bacardi (trago)": "SRBS",
  "Bombay Sapphire (botella)": "GBOM",
  "Bombay Sapphire (trago)": "SBOM",
  "Buchanan's 12 años (botella)": "WB",
  "Buchanan's 12 años (trago)": "SWB",
  "Cinzano Rosso (trago)": "DCINR",
  "Cognac Hennessy (trago)": "DCOG",
  "Cointreau (trago)": "DCON",
  "Don Julio Blanco (botella)": "TDJB",
  "Don Julio Blanco (trago)": "STDJB",
  "Don Julio Reposado (botella)": "TDJR",
  "Don Julio Reposado (trago)": "STDJR",
  "El Charro (botella)": "TECH",
  "El Charro (trago)": "STECH",
  "Evan Williams (botella)": "WEW",
  "Evan Williams (trago)": "SWEW",
  "Gancia Rosso (trago)": "DGANR",
  "Havana Club 7 años (botella)": "RHC",
  "Havana Club 7 años (trago)": "SRHC",
  "Hendrick's (botella)": "GHEN",
  "Hendrick's (trago)": "SHEN",
  "Jack Daniel's (botella)": "WJD",
  "Jack Daniel's (trago)": "SWJD",
  "Johnnie Walker Azul (botella)": "WJA",
  "Johnnie Walker Azul (trago)": "SWHA",
  "Johnnie Walker Negro 12 años (botella)": "WJN",
  "Johnnie Walker Negro 12 años (trago)": "SWJN",
  "Johnnie Walker Rojo (botella)": "WJR",
  "Johnnie Walker Rojo (trago)": "SWJR",
  "Johnnie Walker Verde 15 años (botella)": "WJV",
  "Johnnie Walker Verde 15 años (trago)": "SWJV",
  "Jose Cuervo (botella)": "TJC",
  "Jose Cuervo (trago)": "STJC",
  "SKY (botella)": "VSKY",
  "SKY (trago)": "SVSKY",
  "San Miguel (botella)": "RSM",
  "San Miguel (trago)": "SRSM",
  "Smirnoff (botella)": "VSMIR",
  "Smirnoff (trago)": "SVSMIR",
  "Tanqueray (botella)": "GTAN",
  "Tanqueray (trago)": "STAN",
  // Vinos y espumantes
  "Adobe Reserva Carmenere mini 375ml": "MRWRCA",
  "Adobe Reserva Chardonnay mini 375ml": "MWWRCH",
  "Adobe Reserva Rosé mini 375ml": "MROWA",
  "Blanco de Blancas (botella)": "WWBBCPL",
  "Blue Nun 24k (botella)": "SWBN24",
  "Brut Reserva Vilarnau (botella)": "SWVIBR",
  "Cabernet Sauvignon Casillero (botella)": "WRCDCS",
  "Cabernet Sauvignon mini 375ml": "MRWCSCD",
  "Calvet Celebration Brut (botella)": "SWCCB",
  "Calvet Celebration Brut Rosé (botella)": "SWCCBRO",
  "Calvet Merlot mini 187ml": "MRWCAME",
  "Calvet Sauvignon Blanc mini 187ml": "MWWCSB",
  "Carmenere Casillero (botella)": "WRCDCAR",
  "Chardonnay Casillero (botella)": "WWCHCD",
  "Demi Sec Concha y Toro (botella)": "SWCTDS",
  "Demi Sec Vilarnau (botella)": "SWVIDE",
  "Faustino V Reserva (botella)": "WRFV",
  "Henkell Trocken Dry 375ml": "MSWHTD",
  "Henkell Trocken Dry Piccolo 200ml": "MSWHTPI",
  "Malbec Casillero (botella)": "WRCDMAL",
  "Malbec Piel de Lobo (botella)": "WRCPLMA",
  "Merlot Casillero (botella)": "WRCDME",
  "Pinot Noir Casillero (botella)": "WRCDPN",
  "Reservado Cabernet Sauvignon (botella)": "WRCSCT",
  "Reservado Cabernet Sauvignon (copa)": "CWRRCSCT",
  "Reservado Merlot (botella)": "WRMECT",
  "Reservado Merlot (copa)": "CWWRMCT",
  "Reservado Sauvignon (botella)": "WWRSCT",
  "Reservado Sauvignon (copa)": "CWWRSCT",
  "Rosé Cotes de Provence (botella)": "WROMC",
  "Rosé D'Anjou (botella)": "WRODAN",
  "Sauvignon Blanc Casillero (botella)": "WWSBCD",
  "Syrah Casillero (botella)": "WRCDSY",
  "VDV Ice (botella)": "SWVDVICE",
  "VDV Ice Rosé (botella)": "SWVDVR",
  "VDV Ice Rosé mini 200ml": "MSWICER",
  "VDV Ice mini 200ml": "MSWICE",
};

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(env.MONGODB_URI);

  const byCode = new Map((await contificoProducts(true)).map((p) => [p.codigo, p]));
  const products = await Product.find({ active: true, sellable: true });

  const linked: string[] = [];
  const priceGaps: string[] = [];
  const missing: string[] = [];

  for (const product of products) {
    const code = CODES[product.name];
    const match = code ? byCode.get(code) : undefined;
    if (!match) {
      missing.push(product.name);
      continue;
    }
    if (match.pvp !== null) {
      const contificoGross = round2(match.pvp * (1 + match.iva / 100));
      if (Math.abs(contificoGross - product.price) > 0.02) {
        priceGaps.push(`${product.name}: Treasure $${product.price} · Contífico ${match.codigo} $${contificoGross}`);
      }
    }
    linked.push(`${product.name} → ${match.codigo}`);
    if (apply && product.contificoId !== match.id) {
      product.contificoId = match.id;
      product.contificoCode = match.codigo;
      await product.save();
    }
  }

  console.log(`Vinculados: ${linked.length}${apply ? " (guardado)" : " (vista previa, usa --apply)"}`);
  console.log(`\nSin equivalente en Contífico (${missing.length}):\n  ${missing.join("\n  ")}`);
  console.log(`\nPrecio distinto (se factura el de Treasure) (${priceGaps.length}):\n  ${priceGaps.join("\n  ")}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
