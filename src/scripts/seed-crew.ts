import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { User } from "../models/user.model";

/**
 * Cuentas de los registros ISM (registros.teseturis.app). No toca las
 * cuentas existentes: solo crea las que faltan. Clave inicial: treasure2026.
 */
async function seedCrew() {
  await dbConnect();
  const passwordHash = await bcrypt.hash("treasure2026", 10);
  const admin = await User.findOne({ role: "admin" }).sort({ createdAt: 1 });

  const crew = [
    { name: "Capitán", email: "capitan@treasure.ec", role: "capitan", position: "CAP" },
    { name: "Timonel 1", email: "timonel@treasure.ec", role: "tripulante", position: "TIM_01" },
    { name: "Jefe de Máquinas", email: "maquinas@treasure.ec", role: "tripulante", position: "MAQ" },
    { name: "Persona Designada (Oficina)", email: "oficina@treasure.ec", role: "designada", position: "" },
  ];

  for (const c of crew) {
    const result = await User.updateOne(
      { email: c.email },
      { $setOnInsert: { ...c, passwordHash, active: true, createdBy: admin?._id ?? null } },
      { upsert: true },
    );
    console.log(`[crew] ${c.email}: ${result.upsertedCount ? "creada" : "ya existía"}`);
  }

  await mongoose.disconnect();
}

seedCrew().catch((err) => {
  console.error(err);
  process.exit(1);
});
