import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";

/**
 * Respaldo completo de la base en JSON (EJSON relajado), una colección por
 * archivo. Uso: npx ts-node-dev --transpile-only src/scripts/backup.ts <carpeta>
 */
async function backup() {
  const outDir = process.argv[2];
  if (!outDir) throw new Error("Indica la carpeta de destino");
  fs.mkdirSync(outDir, { recursive: true });

  await dbConnect();
  const db = mongoose.connection.db!;
  const collections = await db.listCollections().toArray();

  for (const { name } of collections) {
    const docs = await db.collection(name).find().toArray();
    const file = path.join(outDir, `${name}.json`);
    // EJSON canónico: conserva ObjectId y Date para poder restaurar exacto.
    fs.writeFileSync(file, mongoose.mongo.BSON.EJSON.stringify(docs, undefined, 2, { relaxed: false }));
    console.log(`[backup] ${name}: ${docs.length}`);
  }

  await mongoose.disconnect();
  console.log("[backup] listo en", outDir);
}

backup().catch((err) => {
  console.error(err);
  process.exit(1);
});
