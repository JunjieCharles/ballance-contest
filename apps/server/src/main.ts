import { buildApp } from "./app.js";

const app = buildApp();

try {
  await app.listen({ host: "127.0.0.1", port: 32113 });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
