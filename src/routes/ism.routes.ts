import { RequestHandler, Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import * as ism from "../controllers/ism.controller";
import * as crew from "../controllers/ismCrew.controller";

/**
 * Rutas nuevas de Registros ISM (informe R-14 del 29-oct). Van aparte del
 * índice para que el circuito de firmas crezca sin tocar las rutas del bar.
 * `crewRoles` es el mismo filtro de roles de las rutas ISM existentes.
 */
export function ismRoutes(router: Router, crewRoles: RequestHandler) {
  router.post("/ism/records/:id/test", requireAuth, crewRoles, ism.setTest);
  // Firma por pasos con clave de 4 números (quien hace el chequeo, Capitán, Persona Designada).
  router.post("/ism/records/:id/sign-step", requireAuth, crewRoles, ism.signStep);

  // Lista de tripulantes y claves (la mantiene la Persona Designada; se valida en el controlador).
  router.get("/ism/crew", requireAuth, crewRoles, crew.listCrewMembers);
  router.post("/ism/crew", requireAuth, crewRoles, crew.createCrewMember);
  router.get("/ism/crew/me/pin", requireAuth, crewRoles, crew.myPin);
  router.post("/ism/crew/me/pin", requireAuth, crewRoles, crew.changeMyPin);
  router.patch("/ism/crew/:id", requireAuth, crewRoles, crew.updateCrewMember);
  router.post("/ism/crew/:id/temporary-pin", requireAuth, crewRoles, crew.temporaryPin);

  // Avisos dentro de la app
  router.get("/ism/notices", requireAuth, crewRoles, crew.listNotices);
  router.post("/ism/notices/read", requireAuth, crewRoles, crew.readNotices);
}
