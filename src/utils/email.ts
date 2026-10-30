/**
 * Correo de pasajero o pagador (checklist 29-oct, 17): vacío o con forma
 * nombre@dominio.ext. Misma regla que la pantalla de pasajeros.
 */
export const EMAIL_ERROR = "Revisa el correo. Ejemplo: nombre@dominio.com.";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Vacío es válido (el correo es opcional). */
export function isValidOptionalEmail(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email === "" || EMAIL_RE.test(email);
}
