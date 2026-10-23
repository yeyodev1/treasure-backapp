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

/**
 * Permisos por rol (se validan siempre en el servidor):
 * - admin (Paula): todo; único que cambia precios, aprueba conteos,
 *   ajusta stock, devuelve stock en anulaciones y reversa cobros.
 * - direccion: prepara salidas y pasajeros, aprueba/devuelve cuentas,
 *   revisa anulaciones; cobra solo si está designada como cajera.
 * - bartender: registra, entrega y cancela sus pedidos; envía cuentas a revisión.
 * - bodega: inventario, compras, cargas y conteos.
 */
export default function routerApi(app: Application) {
  const router = Router();
  app.use("/api", router);

  const ALL = requireRole("admin", "direccion", "bartender", "bodega");
  const BAR = requireRole("admin", "direccion", "bartender");
  const LEAD = requireRole("admin", "direccion");
  const ADMIN = requireRole("admin");

  // Autenticación
  router.post("/auth/login", auth.login);
  router.get("/auth/me", requireAuth, auth.me);

  // Pública (pasajero vía QR, sin sesión)
  router.get("/public/account/:token", publicCtrl.publicAccount);

  // Archivos (Cloudinary)
  router.post("/uploads", requireAuth, LEAD, upload.single("file"), uploads.uploadFile);

  // Equipo
  router.get("/users", requireAuth, ADMIN, users.listUsers);
  router.post("/users", requireAuth, ADMIN, users.createUser);
  router.patch("/users/:id", requireAuth, ADMIN, users.updateUser);

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
  router.post("/cruises", requireAuth, LEAD, cruises.createCruise);
  router.get("/cruises/:id", requireAuth, ALL, cruises.getCruise);
  router.patch("/cruises/:id", requireAuth, LEAD, cruises.updateCruise);
  router.put("/cruises/:id/cabins/:cabinNumber/passengers", requireAuth, LEAD, cruises.updatePassengers);

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
  router.post("/accounts/:cruiseId/:cabinNumber/approve", requireAuth, LEAD, accounts.approveAccount);
  router.post("/accounts/:cruiseId/:cabinNumber/return", requireAuth, LEAD, accounts.returnAccount);

  // Cobros (cajero validado en el controlador) y reverso autorizado
  router.post("/payments/collect", requireAuth, LEAD, payments.collectCabin);
  router.get("/payments", requireAuth, LEAD, payments.listPayments);
  router.post("/payments/:id/retry-invoice", requireAuth, ADMIN, payments.retryInvoice);
  router.post("/payments/:id/reverse", requireAuth, ADMIN, payments.reversePayment);

  // Inventario en unidad base (ml, unidad…)
  router.get("/inventory/stock", requireAuth, ALL, inventory.stockByLocation);
  router.get("/inventory/product/:productId", requireAuth, ALL, inventory.productStock);
  router.post("/inventory/waste", requireAuth, ALL, inventory.registerWaste);
  router.post("/inventory/adjust", requireAuth, ADMIN, inventory.adjustStock);
  router.post(
    "/inventory/purchase",
    requireAuth,
    requireRole("admin", "bodega"),
    inventory.warehousePurchase,
  );
  router.post(
    "/inventory/transfer",
    requireAuth,
    requireRole("admin", "bodega", "direccion"),
    inventory.transferToBoard,
  );
  router.get("/inventory/movements", requireAuth, ALL, inventory.listMovements);

  // Conteos físicos: todos cuentan, solo administración aprueba
  router.get("/counts", requireAuth, ALL, counts.listCounts);
  router.post("/counts", requireAuth, ALL, counts.createCount);
  router.get("/counts/:id", requireAuth, ALL, counts.getCount);
  router.patch("/counts/:id", requireAuth, ALL, counts.saveCount);
  router.post("/counts/:id/submit", requireAuth, ALL, counts.submitCount);
  router.post("/counts/:id/approve", requireAuth, ADMIN, counts.approveCount);
  router.post("/counts/:id/reject", requireAuth, ADMIN, counts.rejectCount);

  // En vivo y reportes
  router.get("/live", requireAuth, LEAD, live.livePulse);
  router.get("/reports/sales", requireAuth, LEAD, reports.salesSummary);
  router.get("/reports/by-cruise", requireAuth, LEAD, reports.salesByCruise);
}
