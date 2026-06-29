import Fastify, { type FastifyInstance } from "fastify";
import { HealthResponseSchema, type HealthResponse } from "@ballance/contracts";
import { APPLICATION_VERSION } from "@ballance/core";

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true });
  app.get<{ Reply: HealthResponse }>(
    "/api/v1/health",
    { schema: { response: { 200: HealthResponseSchema } } },
    async () => ({
      status: "ok",
      version: APPLICATION_VERSION,
      now: new Date().toISOString(),
      modes: ["work", "test"]
    })
  );
  return app;
};
