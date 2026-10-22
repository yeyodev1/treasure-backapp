import axios from "axios";
import { env } from "../config/env";
import { IPayment } from "../models/payment.model";

/**
 * Integración con Contífico para facturación electrónica (SRI).
 * La clienta aún debe contratar el plan con API (~$30/mes); mientras no haya
 * credenciales, las facturas quedan en estado "pendiente" y se reintentan
 * cuando se configuren CONTIFICO_API_KEY / CONTIFICO_API_TOKEN.
 */
const CONTIFICO_BASE_URL = "https://api.contifico.com/sistema/api/v1";

export function contificoConfigured(): boolean {
  return Boolean(env.CONTIFICO_API_KEY && env.CONTIFICO_API_TOKEN);
}

export interface InvoiceResult {
  status: "emitida" | "pendiente" | "error";
  invoiceId: string;
  error: string;
}

export async function emitInvoice(payment: IPayment): Promise<InvoiceResult> {
  if (!contificoConfigured()) {
    return {
      status: "pendiente",
      invoiceId: "",
      error: "Contífico sin configurar: la factura queda en cola",
    };
  }

  try {
    const { data } = await axios.post(
      `${CONTIFICO_BASE_URL}/documento/`,
      {
        pos: env.CONTIFICO_POS_ID,
        tipo_documento: "FAC",
        electronico: true,
        cliente: {
          razon_social: payment.billing.name,
          cedula: payment.billing.idNumber,
          email: payment.billing.email,
          tipo: "N",
        },
        descripcion: `Consumo bar - cabina ${payment.cabinNumber}`,
        total: payment.total,
      },
      { headers: { Authorization: env.CONTIFICO_API_TOKEN } },
    );
    return { status: "emitida", invoiceId: String(data?.id ?? ""), error: "" };
  } catch (err) {
    const message = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    return { status: "error", invoiceId: "", error: message };
  }
}
