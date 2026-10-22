import multer from "multer";

/** Archivos en memoria (van directo a Cloudinary), máximo 10 MB. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
