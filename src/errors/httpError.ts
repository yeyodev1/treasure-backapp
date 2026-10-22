export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "No autorizado") => new HttpError(401, message);
export const forbidden = (message = "No tienes permisos para esta acción") =>
  new HttpError(403, message);
export const notFound = (message = "Recurso no encontrado") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
