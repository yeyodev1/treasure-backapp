import { Resend } from "resend";
import { env } from "../config/env";

/**
 * Correo transaccional con Resend desde team@teseturis.app.
 * Configurado y listo, pero sin uso por ahora (decisión 22-oct-2026):
 * cuando toque enviar facturas/cuentas al pasajero se llama sendMail.
 */
let client: Resend | null = null;

export function mailerConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

function getClient(): Resend {
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export async function sendMail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ id: string }> {
  if (!mailerConfigured()) throw new Error("Resend no está configurado");
  const { data, error } = await getClient().emails.send({
    from: env.EMAIL_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });
  if (error || !data) throw new Error(`Resend: ${error?.message ?? "sin respuesta"}`);
  return { id: data.id };
}
