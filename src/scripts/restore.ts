import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";

/**
 * Restaura un respaldo hecho con backup.ts (EJSON canónico).
 * Reemplaza cada colección del respaldo. Uso:
 *   npx ts-node-dev --transpile-only src/scripts/restore.ts <carpeta>
 */
async function restore() {
  const dir = process.argv[2];
  if (!dir) throw new Error("Indica la carpeta del respaldo");

  await dbConnect();
  const db = mongoose.connection.db!;

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const name = path.basename(file, ".json");
    const docs = mongoose.mongo.BSON.EJSON.parse(fs.readFileSync(path.join(dir, file), "utf8"), {
      relaxed: false,
    }) as Array<Record<string, unknown>>;
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs);
    console.log(`[restore] ${name}: ${docs.length}`);
  }

  await mongoose.disconnect();
  console.log("[restore] listo");
}

restore().catch((err) => {
  console.error(err);
  process.exit(1);
});
