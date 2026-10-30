import { RequestHandler, Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import * as ism from "../controllers/ism.controller";

/**
 * Rutas nuevas de Registros ISM (informe R-14 del 29-oct). Van aparte del
 * índice para que el circuito de firmas crezca sin tocar las rutas del bar.
 * `crew` es el mismo filtro de roles de las rutas ISM existentes.
 */
export function ismRoutes(router: Router, crew: RequestHandler) {
  router.post("/ism/records/:id/test", requireAuth, crew, ism.setTest);
}
