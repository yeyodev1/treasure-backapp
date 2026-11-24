import { User } from "../models/user.model";

/**
 * Correo válido para facturar (especificación del Resumen, 24-nov-2026, «Datos
 * que hay que corregir» 7): formato válido, sin correos de prueba ni del
 * equipo. El buzón de la casa de «Cliente no da correo» sí vale.
 *
 * Casos reales de noviembre: hola@hola.com, hhyh@hu.com, hhh@gmail.com,
 * simon@gmail.com (Gmail exige 6 caracteres) y el correo personal del
 * bartender (criollogabriel41@gmail.com).
 */
const HOUSE_EMAIL = "facturaspaulateran@gmail.com";
const TEST_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "test.com", "prueba.com", "mailinator.com", "correo.com",
  "email.com", "ejemplo.com", "hola.com", "hu.com", "asd.com", "abc.com", "aaa.com", "xxx.com",
]);
const TEST_LOCAL = /^(test|prueba|pruebas|hola|asdf|asd|qwerty|abc|demo|correo|email|mail|no-?reply|ninguno|na|n\/a|sin|cliente)\d*$/;
/** Proveedores con un mínimo de caracteres en el usuario (Gmail: 6). */
const MIN_LOCAL: Record<string, number> = { "gmail.com": 6, "googlemail.com": 6 };

export interface Team {
  emails: Set<string>;
  /** Nombres del equipo en minúsculas, sin tildes, partidos en palabras de 4+ letras. */
  names: string[][];
}

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function teamEmails(): Promise<Team> {
  const users = await User.find().select("email name").lean();
  return {
    emails: new Set(users.map((u) => (u.email ?? "").trim().toLowerCase()).filter(Boolean)),
    names: users.map((u) => plain(u.name ?? "").split(/[^a-z]+/).filter((w) => w.length >= 4)).filter((w) => w.length >= 2),
  };
}

export function isTestOrTeamEmail(email: string, team: Team): boolean {
  const e = email.trim().toLowerCase();
  if (!e || e === HOUSE_EMAIL) return false;
  const [local = "", domain = ""] = e.split("@");
  if (TEST_DOMAINS.has(domain) || TEST_LOCAL.test(local)) return true;
  // Teclazos: el usuario son letras sin ninguna vocal (hhh, hhyh). «ana» o «bob» sí valen.
  const letters = local.replace(/[^a-z]/g, "");
  if (letters.length >= 2 && !/[aeiou]/.test(letters)) return true;
  if (MIN_LOCAL[domain] && local.replace(/\./g, "").length < MIN_LOCAL[domain]!) return true;
  if (team.emails.has(e)) return true;
  // Correo personal de alguien del equipo: lleva dos palabras de su nombre.
  const flat = plain(local);
  return team.names.some((words) => words.filter((w) => flat.includes(w)).length >= 2);
}

export const TEST_EMAIL_ERROR =
  "Ese correo es de prueba, no existe o es del equipo: pide el correo del cliente o toca «Cliente no da correo».";
