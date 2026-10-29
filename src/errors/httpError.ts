export class HttpError extends Error {
  status: number;
  /** Código de máquina para que la app reaccione (p. ej. "sin_stock"). */
  code?: string;
  data?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "No autorizado") => new HttpError(401, message);
export const forbidden = (message = "No tienes permisos para esta acción") =>
  new HttpError(403, message);
export const notFound = (message = "Recurso no encontrado") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** Falta stock de un insumo: la operación no se guarda ni descuenta nada. */
export const insufficientStock = (productId: string, name: string, location: string) =>
  new HttpError(
    409,
    `No hay suficiente ${name} ${location === "bodega" ? "en bodega" : "a bordo"}`,
    "sin_stock",
    { productId, name, location },
  );
