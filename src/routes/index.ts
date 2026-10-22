import { Application, Router } from "express";
import { requireAuth, requireRole } from "../middlewares/auth.middleware";
import * as auth from "../controllers/auth.controller";
import * as users from "../controllers/user.controller";
import * as products from "../controllers/product.controller";
import * as cruises from "../controllers/cruise.controller";
import * as orders from "../controllers/order.controller";
import * as payments from "../controllers/payment.controller";
import * as inventory from "../controllers/inventory.controller";
import * as reports from "../controllers/report.controller";
import * as publicCtrl from "../controllers/public.controller";
import * as uploads from "../controllers/upload.controller";
import { upload } from "../middlewares/upload.middleware";

export default function routerApi(app: Application) {
  const router = Router();
  app.use("/api", router);

  // Autenticación
  router.post("/auth/login", auth.login);
  router.get("/auth/me", requireAuth, auth.me);

  // Pública (pasajero vía QR, sin sesión)
  router.get("/public/account/:token", publicCtrl.publicAccount);

  // Archivos (Cloudinary)
  router.post(
    "/uploads",
    requireAuth,
    requireRole("admin", "direccion"),
    upload.single("file"),
    uploads.uploadFile,
  );

  // Usuarios: solo administración
  router.get("/users", requireAuth, requireRole("admin"), users.listUsers);
  router.post("/users", requireAuth, requireRole("admin"), users.createUser);
  router.patch("/users/:id", requireAuth, requireRole("admin"), users.updateUser);

  // Catálogo
  router.get("/products", requireAuth, products.listProducts);
  router.post("/products", requireAuth, requireRole("admin", "bodega"), products.createProduct);
  router.post("/products/custom-cocktail", requireAuth, products.createCustomCocktail);
  router.patch(
    "/products/:id",
    requireAuth,
    requireRole("admin", "bodega"),
    products.updateProduct,
  );

  // Cruceros y cabinas
  router.get("/cruises", requireAuth, cruises.listCruises);
  router.get("/cruises/active", requireAuth, cruises.activeCruise);
  router.post("/cruises", requireAuth, requireRole("admin", "direccion"), cruises.createCruise);
  router.get("/cruises/:id", requireAuth, cruises.getCruise);
  router.patch("/cruises/:id", requireAuth, requireRole("admin", "direccion"), cruises.updateCruise);
  router.patch("/cruises/:id/cabins/:cabinNumber", requireAuth, cruises.updateCabin);
  router.post(
    "/cruises/:id/load-stock",
    requireAuth,
    requireRole("admin", "bodega", "direccion"),
    cruises.loadStock,
  );

  // Comandas
  router.post("/orders", requireAuth, orders.createOrder);
  router.get("/orders", requireAuth, orders.listOrders);
  router.post(
    "/orders/:id/cancel",
    requireAuth,
    requireRole("admin", "direccion"),
    orders.cancelOrder,
  );
  router.get("/accounts/:cruiseId/:cabinNumber", requireAuth, orders.cabinAccount);

  // Cobros y facturas
  router.post(
    "/payments/collect",
    requireAuth,
    requireRole("admin", "direccion"),
    payments.collectCabin,
  );
  router.get("/payments", requireAuth, requireRole("admin", "direccion"), payments.listPayments);
  router.post(
    "/payments/:id/retry-invoice",
    requireAuth,
    requireRole("admin"),
    payments.retryInvoice,
  );

  // Inventario
  router.get("/inventory/cruise/:cruiseId", requireAuth, inventory.cruiseStock);
  router.post("/inventory/waste", requireAuth, inventory.registerWaste);
  router.post(
    "/inventory/adjust",
    requireAuth,
    requireRole("admin", "bodega"),
    inventory.adjustStock,
  );
  router.post(
    "/inventory/warehouse-purchase",
    requireAuth,
    requireRole("admin", "bodega"),
    inventory.warehousePurchase,
  );
  router.get(
    "/inventory/movements",
    requireAuth,
    requireRole("admin", "bodega", "direccion"),
    inventory.listMovements,
  );

  // Reportes (administración y dirección)
  router.get(
    "/reports/sales",
    requireAuth,
    requireRole("admin", "direccion"),
    reports.salesSummary,
  );
  router.get(
    "/reports/by-cruise",
    requireAuth,
    requireRole("admin", "direccion"),
    reports.salesByCruise,
  );
  router.get(
    "/reports/inventory/:cruiseId",
    requireAuth,
    requireRole("admin", "direccion", "bodega"),
    reports.inventoryStatus,
  );
}
