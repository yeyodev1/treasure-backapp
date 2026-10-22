import { NextFunction, Request, Response } from "express";
import { cloudinaryConfigured, uploadBuffer } from "../services/cloudinary.service";
import { badRequest } from "../errors/httpError";

/** Sube un archivo (foto, logo, comprobante) a Cloudinary y devuelve su URL. */
export async function uploadFile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!cloudinaryConfigured()) throw badRequest("Cloudinary no está configurado");
    if (!req.file) throw badRequest("No llegó ningún archivo");

    const folder = typeof req.body.folder === "string" && req.body.folder ? req.body.folder : "general";
    const result = await uploadBuffer(req.file.buffer, folder);

    res.status(201).json({
      url: result.secure_url,
      publicId: result.public_id,
      bytes: result.bytes,
      format: result.format,
    });
  } catch (err) {
    next(err);
  }
}
