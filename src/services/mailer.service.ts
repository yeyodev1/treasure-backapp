import { Resend } from "resend";
import { env } from "../config/env";

/**
 * Correo transaccional con Resend desde team@teseturis.app. Se usa para el
 * resumen de la cuenta al pagador cuando la cuenta queda pagada.
 * Sin RESEND_API_KEY (pruebas, ensayo) no se envía nada.
 */
let client: Resend | null = null;

export function mailerConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

function getClient(): Resend {
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
}

export interface MailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: MailAttachment[];
}

export async function sendMail(options: MailOptions): Promise<{ id: string }> {
  if (!mailerConfigured()) throw new Error("el envío de correos no está configurado");
  const { data, error } = await getClient().emails.send({
    from: env.EMAIL_FROM,
    to: options.to,
    subject: options.subject,
    html: options.html,
    ...(options.text ? { text: options.text } : {}),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
  });
  if (error || !data) throw new Error(`Resend: ${error?.message ?? "sin respuesta"}`);
  return { id: data.id };
}
