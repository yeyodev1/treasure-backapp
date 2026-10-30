import { Application, Router } from "express";
import { requireAuth, requireRole } from "../middlewares/auth.middleware";
import { upload } from "../middlewares/upload.middleware";
import * as auth from "../controllers/auth.controller";
import * as users from "../controllers/user.controller";
import * as products from "../controllers/product.controller";
import * as cruises from "../controllers/cruise.controller";
import * as orders from "../controllers/order.controller";
import * as accounts from "../controllers/account.controller";
import * as payments from "../controllers/payment.controller";
import * as inventory from "../controllers/inventory.controller";
import * as counts from "../controllers/count.controller";
import * as reports from "../controllers/report.controller";
import * as live from "../controllers/live.controller";
import * as uploads from "../controllers/upload.controller";
import * as publicCtrl from "../controllers/public.controller";
import * as ism from "../controllers/ism.controller";
import * as consumptions from "../controllers/consumption.controller";
import * as supply from "../controllers/supply.controller";
import { ismRoutes } from "./ism.routes";

/**
 * Permisos por rol (guía auditada 27-oct-2026; se validan en el servidor):
 * - duena (Gerencia): toda la operación y finanzas. Única que cambia precios,
 *   autoriza ajustes y conteos, devuelve stock en anulaciones y reversa
 *   cobros. `requireRole` siempre la deja pasar.
 * - admin (Administración): conteo físico y diferencias, compras y recepciones.
 * - direccion (Dirección de crucero): pasajeros, cabinas, inicio/fin del crucero,
 *   aprobación de cuentas y de abastecimiento, cobros.
 * - bartender: consumos y solicitudes de productos.
 * - bodega: compras, recepciones, cargas al barco y conteos en tierra.
 */
export default function routerApi(app: Application) {
  const router = Router();
  app.use("/api", router);

  const ALL = requireRole("admin", "direccion", "bartender", "bodega");
  const BAR = requireRole("direccion", "bartender");

  const LEAD = requireRole("admin", "direccion");
  const OWNER = requireRole("duena");
  const DIRECTOR = requireRole("direccion");
  const WAREHOUSE = requireRole("admin", "bodega");
  const COUNTERS = requireRole("admin", "bodega", "direccion");
  // Registros ISM: toda la tripulación llena; las etapas se validan en el controlador.
  const CREW = requireRole(
    "admin",
    "direccion",
    "bartender",
    "bodega",
    "capitan",
    "tripulante",
    "designada",
  );
  // Autenticación
  router.post("/auth/login", auth.login);
  router.get("/auth/me", requireAuth, auth.me);
  router.post("/auth/refresh", requireAuth, auth.refresh);

  // Pública (pasajero vía QR, sin sesión)
  router.get("/public/account/:token", publicCtrl.publicAccount);

  // Archivos (Cloudinary)
  router.post("/uploads", requireAuth, CREW, upload.single("file"), uploads.uploadFile);

  // Equipo
  router.get("/users", requireAuth, OWNER, users.listUsers);
  router.post("/users", requireAuth, OWNER, users.createUser);
  router.patch("/users/:id", requireAuth, OWNER, users.updateUser);

  // Catálogo (el precio solo lo cambia administración: se valida en el controlador)
  router.get("/products", requireAuth, ALL, products.listProducts);
  router.post("/products", requireAuth, requireRole("admin", "bodega"), products.createProduct);
  router.post("/products/custom-cocktail", requireAuth, BAR, products.createCustomCocktail);
  router.patch("/products/:id", requireAuth, requireRole("admin", "bodega"), products.updateProduct);

  // Salidas, ciclo y pasajeros
  router.get("/cruises", requireAuth, ALL, cruises.listCruises);
  router.get("/cruises/active", requireAuth, ALL, cruises.activeCruise);
  router.get("/cruises/cycle-settings", requireAuth, LEAD, cruises.cycleSettings);
  router.put("/cruises/cycle-settings", requireAuth, LEAD, cruises.updateCycleSettings);
  router.post("/cruises/generate", requireAuth, LEAD, cruises.generateCycle);
  router.get("/cruises/plan", requireAuth, LEAD, cruises.previewNewCruise);
  router.post("/cruises/plan", requireAuth, LEAD, cruises.createNewCruise);
  router.post("/cruises", requireAuth, LEAD, cruises.createCruise);
  router.get("/cruises/:id", requireAuth, ALL, cruises.getCruise);
  router.patch("/cruises/:id", requireAuth, LEAD, cruises.updateCruise);
  router.put("/cruises/:id/cabins/:cabinNumber/passengers", requireAuth, LEAD, cruises.updatePassengers);
  router.get("/cruises/:id/start-check", requireAuth, LEAD, cruises.startCheck);
  router.post("/cruises/:id/start", requireAuth, DIRECTOR, cruises.startCruise);
  router.get("/cruises/:id/finish-check", requireAuth, LEAD, cruises.finishCheck);
  router.post("/cruises/:id/finish", requireAuth, DIRECTOR, cruises.finishCruise);

  // Consumo directo: un toque registra lo servido, el cargo y el stock
  router.post("/consumptions", requireAuth, BAR, consumptions.createConsumption);
  router.post("/consumptions/:id/undo", requireAuth, BAR, consumptions.undoConsumption);
  router.post("/consumptions/:id/bonify", requireAuth, DIRECTOR, consumptions.bonifyConsumption);
  router.post("/consumptions/:id/held-review", requireAuth, DIRECTOR, consumptions.reviewHeld);
  router.get(
    "/consumptions/summary/:cruiseId/:cabinNumber",
    requireAuth,
    BAR,
    consumptions.getCabinSummary,
  );
  router.get("/consumptions/availability", requireAuth, ALL, consumptions.availability);
  router.post("/devices/heartbeat", requireAuth, ALL, consumptions.heartbeat);

  // Requerimientos del bar y compras en dos pasos (factura → recepción)
  router.get("/requisitions", requireAuth, ALL, supply.listRequisitions);
  router.post("/requisitions", requireAuth, ALL, supply.createRequisition);
  router.post("/requisitions/:id/review", requireAuth, DIRECTOR, supply.reviewRequisition);
  router.post("/requisitions/:id/receive", requireAuth, WAREHOUSE, supply.receiveRequisition);
  router.post("/requisitions/:id/resolve", requireAuth, WAREHOUSE, supply.resolveRequisition);
  router.get("/purchases", requireAuth, requireRole("admin", "bodega", "direccion"), supply.listPurchases);
  router.post("/purchases", requireAuth, WAREHOUSE, supply.createPurchase);
  router.post("/purchases/:id/receive", requireAuth, WAREHOUSE, supply.receivePurchase);
  router.post("/purchases/:id/cancel", requireAuth, WAREHOUSE, supply.cancelPurchase);

  // Pedidos: registrar → entregar → cancelar pendiente / anular entregado
  router.post("/orders", requireAuth, BAR, orders.createOrder);
  router.get("/orders", requireAuth, BAR, orders.listOrders);
  router.post("/orders/:id/deliver", requireAuth, BAR, orders.deliverOrder);
  router.post("/orders/:id/cancel", requireAuth, BAR, orders.cancelOrder);
  router.post("/orders/:id/annulments", requireAuth, BAR, orders.requestAnnulment);
  router.post(
    "/orders/:id/annulments/:annulmentId/review",
    requireAuth,
    LEAD,
    orders.reviewAnnulment,
  );

  // Cuentas: revisión y aprobación antes de cobrar
  router.get("/accounts/:cruiseId", requireAuth, BAR, accounts.cruiseAccounts);
  router.get("/accounts/:cruiseId/:cabinNumber", requireAuth, BAR, orders.cabinAccount);
  router.post("/accounts/:cruiseId/:cabinNumber/submit", requireAuth, BAR, accounts.submitForReview);
  router.post("/accounts/:cruiseId/:cabinNumber/approve", requireAuth, DIRECTOR, accounts.approveAccount);
  router.post("/accounts/:cruiseId/:cabinNumber/return", requireAuth, DIRECTOR, accounts.returnAccount);
  // Prefactura en inglés (PDF): sin correo ni Contífico.
  router.get("/accounts/:cruiseId/:cabinNumber/proforma", requireAuth, DIRECTOR, accounts.proforma);

  // Cobros (cajero validado en el controlador) y reverso autorizado
  router.post("/payments/collect", requireAuth, DIRECTOR, payments.collectCabin);
  router.get("/payments", requireAuth, LEAD, payments.listPayments);
  router.post("/payments/:id/retry-invoice", requireAuth, DIRECTOR, payments.retryInvoice);
  // Resumen de la cuenta pagada al pagador (Resend); reenvío manual.
  router.post("/payments/:id/resend-summary", requireAuth, DIRECTOR, payments.resendSummary);
  router.get("/contifico", requireAuth, OWNER, payments.contificoInfo);
  router.post("/payments/:id/reverse", requireAuth, OWNER, payments.reversePayment);

  // Inventario en unidad base (ml, unidad…)
  router.get("/inventory/stock", requireAuth, ALL, inventory.stockByLocation);
  router.get("/inventory/product/:productId", requireAuth, ALL, inventory.productStock);
  router.post("/inventory/waste", requireAuth, ALL, inventory.registerWaste);
  router.post("/inventory/adjust", requireAuth, OWNER, inventory.adjustStock);
  router.post(
    "/inventory/transfer",
    requireAuth,
    requireRole("admin", "bodega", "direccion"),
    inventory.transferToBoard,
  );
  router.get("/inventory/movements", requireAuth, ALL, inventory.listMovements);

  // Conteos físicos: Administración cuenta y documenta; Gerencia autoriza
  router.get("/counts", requireAuth, COUNTERS, counts.listCounts);
  router.post("/counts", requireAuth, COUNTERS, counts.createCount);
  router.get("/counts/:id", requireAuth, COUNTERS, counts.getCount);
  router.patch("/counts/:id", requireAuth, COUNTERS, counts.saveCount);
  router.post("/counts/:id/submit", requireAuth, COUNTERS, counts.submitCount);
  router.post("/counts/:id/approve", requireAuth, OWNER, counts.approveCount);
  router.post("/counts/:id/reject", requireAuth, OWNER, counts.rejectCount);

  // Registros ISM (registros.teseturis.app)
  router.get("/ism/catalog", requireAuth, CREW, ism.catalog);
  router.get("/ism/summary", requireAuth, CREW, ism.summary);
  router.get("/ism/forms/:code", requireAuth, CREW, ism.formDefinition);
  router.get("/ism/schemas/:code", requireAuth, CREW, ism.schemaDefinition);
  router.get("/ism/schemas/:code/:version", requireAuth, CREW, ism.schemaDefinition);
  router.get("/ism/records", requireAuth, CREW, ism.listRecords);
  router.post("/ism/records", requireAuth, CREW, ism.createRecord);
  router.get("/ism/records/:id", requireAuth, CREW, ism.getRecord);
  router.patch("/ism/records/:id", requireAuth, CREW, ism.saveData);
  router.delete("/ism/records/:id", requireAuth, CREW, ism.discard);
  router.post("/ism/records/:id/signatures", requireAuth, CREW, ism.sign);
  router.get("/ism/records/:id/signatures/:field/image", requireAuth, CREW, ism.signatureImage);
  router.delete("/ism/records/:id/signatures/:field", requireAuth, CREW, ism.removeSignature);
  router.post("/ism/records/:id/submit", requireAuth, CREW, ism.submit);
  router.post("/ism/records/:id/approve", requireAuth, CREW, ism.approve);
  router.post("/ism/records/:id/return", requireAuth, CREW, ism.giveBack);
  router.get("/ism/records/:id/pdf", requireAuth, CREW, ism.pdf);
  ismRoutes(router, CREW);

  // En vivo y reportes
  router.get("/live", requireAuth, LEAD, live.livePulse);
  // Métricas solo para Gerencia (checklist 29-oct, 07): menú, ruta y servidor.
  router.get("/reports/sales", requireAuth, OWNER, reports.salesSummary);
  router.get("/reports/by-cruise", requireAuth, OWNER, reports.salesByCruise);
  router.get("/reports/owner", requireAuth, OWNER, reports.ownerPanel);
}
