import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { User } from "../models/user.model";

/**
 * Checklist 29-oct, P16: los textos de la app no nombran personas ni género.
 * Propone nombres neutros para los usuarios cuyo nombre es un rol en
 * femenino o lleva el rol entre paréntesis:
 *
 * - Nombre que es solo el rol: "Administradora" → "Administración",
 *   "Directora" → "Dirección de crucero", "Dueña" → "Gerencia".
 * - Nombre de persona con el rol entre paréntesis: se quita solo el
 *   paréntesis ("Kerly (Directora)" → "Kerly").
 * - Cualquier otro nombre de persona no se toca (se lista para revisar).
 *
 * Vista previa por defecto; --apply guarda. Idempotente: una segunda
 * corrida no encuentra nada que cambiar. Solo cambia el nombre del usuario;
 * la bitácora conserva el nombre con que se registró cada acción.
 *
 *   npx ts-node --transpile-only src/scripts/neutral-user-names.ts           (vista previa)
 *   npx ts-node --transpile-only src/scripts/neutral-user-names.ts --apply
 */

const ROLE_WORD = /\b(direc?tora?|direcci[oó]n|administradora?|administraci[oó]n|due[ñn]a|gerente|gerencia)\b/i;
const MATCH = /directora|administradora|due[ñn]a/i;

/** Nombre que es solo un rol → nombre neutro de ese rol. */
const ONLY_ROLE: Array<[RegExp, string]> = [
  [/^\s*administradora?\s*$/i, "Administración"],
  [/^\s*directora?(\s+de\s+crucero)?\s*$/i, "Dirección de crucero"],
  [/^\s*due[ñn]a\s*$/i, "Gerencia"],
];

export function proposeName(name: string): { next: string | null; note: string } {
  for (const [pattern, neutral] of ONLY_ROLE) {
    if (pattern.test(name)) return { next: neutral, note: "nombre de rol → rol neutro" };
  }
  const paren = name.match(/\s*\(([^)]*)\)\s*/);
  if (paren && ROLE_WORD.test(paren[1] ?? "")) {
    const next = name.replace(paren[0], " ").replace(/\s+/g, " ").trim();
    if (next) return { next, note: "se quita el rol entre paréntesis" };
  }
  return { next: null, note: "nombre de persona: no se toca, revisar a mano" };
}

async function main() {
  const apply = process.argv.includes("--apply");
  await dbConnect();
  console.log("[nombres] base:", env.MONGODB_URI.replace(/:\/\/[^@]*@/, "://***@"));

  const users = await User.find().select("name email role active").sort({ name: 1 });
  const candidates = users.filter((u) => MATCH.test(u.name) || /\([^)]*\)/.test(u.name));
  if (!candidates.length) {
    console.log("[nombres] nada que cambiar");
  }

  let changed = 0;
  for (const user of candidates) {
    const { next, note } = proposeName(user.name);
    const line = `${user.email} (${user.role}${user.active ? "" : ", inactivo"}): "${user.name}"`;
    if (!next || next === user.name) {
      console.log(`[nombres] ${line} · ${note}`);
      continue;
    }
    console.log(`[nombres] ${line} → "${next}" · ${note}`);
    if (apply) {
      // Solo si el nombre sigue igual (otra corrida o un cambio a mano no se pisan).
      const res = await User.updateOne({ _id: user._id, name: user.name }, { $set: { name: next } });
      changed += res.modifiedCount;
    }
  }

  if (apply) console.log(`[nombres] ${changed} usuario(s) actualizados`);
  else if (candidates.length) console.log("[nombres] vista previa: agrega --apply para guardar");
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
