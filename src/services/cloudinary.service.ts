import { v2 as cloudinary, UploadApiResponse } from "cloudinary";
import { env } from "../config/env";

/**
 * Archivos y fotos del proyecto viven en Cloudinary (logos, recursos
 * gráficos, comprobantes). El catálogo del bar sigue siendo por iconos.
 */
let configured = false;

function ensureConfig() {
  if (configured) return;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
  configured = true;
}

export function cloudinaryConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export function uploadBuffer(buffer: Buffer, folder: string): Promise<UploadApiResponse> {
  ensureConfig();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `treasure/${folder}`, resource_type: "auto" },
      (error, result) => {
        if (error || !result) reject(error ?? new Error("Subida vacía"));
        else resolve(result);
      },
    );
    stream.end(buffer);
  });
}

export async function deleteAsset(publicId: string): Promise<void> {
  ensureConfig();
  await cloudinary.uploader.destroy(publicId);
}
