import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";

const bootstrapToken = randomBytes(32).toString("base64url");
const app = await buildApp({ bootstrapToken });

try {
  await app.listen({ host: "127.0.0.1", port: 32113 });
  app.log.info(`Open http://127.0.0.1:32113/#token=${bootstrapToken}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
