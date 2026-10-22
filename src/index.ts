import { createApp } from "./app";
import { dbConnect } from "./config/mongo";
import { env } from "./config/env";

async function main() {
  await dbConnect();
  console.log("[mongo] conectado");

  const { server } = createApp();
  server.listen(env.PORT, () => {
    console.log(`[api] escuchando en http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error("No se pudo iniciar el servidor", err);
  process.exit(1);
});
