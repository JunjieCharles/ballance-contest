import { join } from "node:path";
import { buildApp } from "../apps/server/dist/app.js";

const port = 32114;
const origin = `http://127.0.0.1:${port}`;

export default async function setupE2eServer() {
  const app = await buildApp({
    bootstrapToken: "e2e-bootstrap-token",
    dataRoot: join(process.cwd(), ".runtime", `e2e-data-${process.pid}`),
    trustedOrigins: [origin]
  });

  try {
    await app.listen({ host: "127.0.0.1", port });
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }

  console.log(`E2E server listening at ${origin}`);
  return async () => {
    await app.close();
    console.log("E2E server shutdown complete");
  };
}
