/**
 * Factura autorizada por correo con Resend (pedido del cliente, 12-nov-2026):
 *
 *   npx ts-node --transpile-only tests/factura-correo.e2e.ts
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { writeFileSync } from "fs";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (!ok) failures++;
  console.log(`${ok ? "OK   " : "FALLA"} ${label}${detail !== "" ? ` → ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("treasure");
  process.env.PUBLIC_APP_URL = "https://teseturis.app";
  const mongoose = (await import("mongoose")).default;
  await mongoose.connect(process.env.MONGODB_URI);
  const { Payment } = await import("../src/models/payment.model");
  const { Cruise } = await import("../src/models/cruise.model");
  const mail = await import("../src/services/accountEmail.service");

  const sent: any[] = [];
  mail.setMailTransport(async (o) => (sent.push(o), { id: "x" }));
  const cruise = await Cruise.create({ name: "B", code: "B-005", startDate: new Date() });
  const base = {
    cruise: cruise._id, cabinNumber: 5, total: 8, subtotal: 8, method: "efectivo", collectedBy: new mongoose.Types.ObjectId(),
    billing: { name: "Prueba factura", idNumber: "1713921961", email: "pasajero@correo.com", country: "Ecuador" },
  };
  const ok = await Payment.create({ ...base, invoiceStatus: "emitida", invoiceId: "abc", invoiceNumber: "001-100-000000783" });
  const pending = await Payment.create({ ...base, invoiceStatus: "pendiente" });
  const files = { pdfUrl: "https://x/ride.pdf", xmlUrl: "https://x/doc.xml" };
  const fetchFile = async (url: string) => Buffer.from(url);

  const first = await mail.sendInvoiceEmail(ok._id, files, fetchFile);
  check("Envía la factura emitida", first.status === "enviado" && first.to === "pasajero@correo.com", first);
  check("Adjunta PDF y XML", sent[0]?.attachments?.map((a: any) => a.filename).join(",") === "Factura-001-100-000000783.pdf,Factura-001-100-000000783.xml", sent[0]?.attachments?.map((a: any) => a.filename));
  check("Lleva el logo y el número", sent[0]?.html.includes("/brand/seal-pine.png") && sent[0]?.html.includes("001-100-000000783"));
  const again = await mail.sendInvoiceEmail(ok._id, files, fetchFile);
  check("No se envía dos veces", again.status === "omitido" && sent.length === 1, again);
  const notYet = await mail.sendInvoiceEmail(pending._id, files, fetchFile);
  check("Sin factura emitida no se envía", notYet.status === "omitido" && sent.length === 1, notYet);
  const saved = await Payment.findById(ok._id);
  check("Queda registrado en el pago", saved?.invoiceEmail.status === "enviado" && saved.invoiceEmail.to === "pasajero@correo.com");

  writeFileSync(process.env.PREVIEW ?? "/dev/null", sent[0]?.html ?? "");
  await mongoose.disconnect();
  await mongo.stop();
  console.log(failures ? `\n${failures} prueba(s) fallaron` : "\nTodas las pruebas pasaron");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
