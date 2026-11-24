import { User } from "../models/user.model";

/**
 * Correo válido para facturar (especificación del Resumen, 24-nov-2026, «Datos
 * que hay que corregir» 7): formato válido, sin correos de prueba ni del
 * equipo. El buzón de la casa de «Cliente no da correo» sí vale.
 */
const TEST_DOMAINS = /@(example\.(com|org|net)|test\.com|prueba\.com|mailinator\.com|correo\.com|email\.com|ejemplo\.com)$/i;
const TEST_LOCAL = /^(test|prueba|pruebas|asdf|qwerty|aaa+|xxx+|abc|demo|correo|email|no-?reply|ninguno|na|n\/a)(\d*)@/i;

export async function teamEmails(): Promise<Set<string>> {
  const users = await User.find().select("email").lean();
  return new Set(users.map((u) => (u.email ?? "").trim().toLowerCase()).filter(Boolean));
}

export function isTestOrTeamEmail(email: string, team: Set<string>): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return TEST_DOMAINS.test(e) || TEST_LOCAL.test(e) || team.has(e);
}

export const TEST_EMAIL_ERROR =
  "Ese correo es de prueba o del equipo: pide el correo del cliente o toca «Cliente no da correo».";
