import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("local API", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false });
    const response = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-1" } });
    token = response.json<{ token: string }>().token;
  });
  afterEach(async () => { if (app) await app.close(); });

  it("rejects invalid bootstrap and gives only the first tab control", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bad", tabId: "bad" } })).statusCode).toBe(401);
    const second = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-2" } });
    const secondSession = second.json<{ token: string; control: boolean }>();
    expect(secondSession.control).toBe(false);
    const denied = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(secondSession.token), payload: { name: "Denied", mode: "test", idempotencyKey: "second" } });
    expect(denied.json()).toMatchObject({ error: { code: "READ_ONLY_SESSION" } });
  });

  it("creates both modes idempotently and enforces state versions", async () => {
    const payload = { name: "Test", mode: "test", idempotencyKey: "create-1" };
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload });
    const record = created.json<{ data: { id: string; stateVersion: number } }>().data;
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload });
    expect(duplicate.json<{ data: { id: string } }>().data.id).toBe(record.id);
    expect((await app.inject({ method: "POST", url: `/api/v1/competitions/${record.id}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish" } })).statusCode).toBe(200);
    const conflict = await app.inject({ method: "POST", url: `/api/v1/competitions/${record.id}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "different" } });
    expect(conflict.json()).toMatchObject({ error: { code: "STATE_CONFLICT", details: { latestStateVersion: 1 } } });
  });

  it("runs the small scenario only in test mode", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const create = async (mode: "work" | "test", key: string) => (await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: mode, mode, idempotencyKey: key } })).json<{ data: { id: string } }>().data.id;
    const testId = await create("test", "test");
    const workId = await create("work", "work");
    const runResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${testId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = runResponse.json<{ data: { runId: string } }>().data.runId;
    const played = await app.inject({ method: "POST", url: `/api/v1/competitions/${testId}/test-runs/${runId}/play`, headers: auth(token) });
    expect(played.json()).toMatchObject({ data: { attempts: expect.any(Array), scoreboardVersions: expect.any(Array) } });
    const forbidden = await app.inject({ method: "POST", url: `/api/v1/competitions/${workId}/test-runs`, headers: auth(token), payload: scenario });
    expect(forbidden.json()).toMatchObject({ error: { code: "CAPABILITY_UNSUPPORTED" } });
  });
});
