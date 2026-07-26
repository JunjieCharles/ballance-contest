import { buildApp } from "../apps/server/dist/app.js";

const port = 32114;
const origin = `http://127.0.0.1:${port}`;
const app = await buildApp({
  bootstrapToken: process.env.BALLANCE_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token",
  dataRoot: process.env.BALLANCE_DATA_ROOT,
  trustedOrigins: [origin]
});

await app.listen({ host: "127.0.0.1", port });
console.log(`E2E server listening at ${origin}`);

let shutdown;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown ??= app.close();
    console.log(`E2E server received ${signal}; waiting for managed runtime shutdown`);
    void shutdown.then(() => {
      console.log("E2E server shutdown complete");
      process.exit(0);
    }, (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
