import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("local API", () => {
  let app: FastifyInstance;
  let token: string;
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-api-"));
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    const response = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-1" } });
    token = response.json<{ token: string }>().token;
  });
  afterEach(async () => { if (app) await app.close(); if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }); });

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
    const patched = await app.inject({
      method: "PATCH", url: `/api/v1/competitions/${record.id}/draft`, headers: auth(token),
      payload: {
        expectedStateVersion: 0,
        idempotencyKey: "rename-draft",
        name: "Test Updated"
      }
    });
    const version = patched.json<{ data: { stateVersion: number } }>().data.stateVersion;
    expect((await app.inject({ method: "POST", url: `/api/v1/competitions/${record.id}/publish`, headers: auth(token), payload: { expectedStateVersion: version, idempotencyKey: "publish" } })).statusCode).toBe(200);
    const publishedSnapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${record.id}/snapshot`, headers: auth(token) });
    expect(publishedSnapshot.json()).toMatchObject({ data: { config: { participants: [], playerAliases: [] } } });
    const conflict = await app.inject({ method: "POST", url: `/api/v1/competitions/${record.id}/publish`, headers: auth(token), payload: { expectedStateVersion: version, idempotencyKey: "different" } });
    expect(conflict.json()).toMatchObject({ error: { code: "STATE_CONFLICT", details: { latestStateVersion: version + 1 } } });
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

  it("drives automation with a virtual clock and applies test faults without a real command transport", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Automation", mode: "test", idempotencyKey: "automation" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });

    const started = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    expect(started.json()).toMatchObject({ data: { phase: "ready", actions: expect.any(Array) } });
    const advanced = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 15_000 } });
    expect(advanced.json()).toMatchObject({ data: { phase: "running", attempts: [{ attemptNumber: 1 }] } });
    const fault = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/faults`, headers: auth(token), payload: { fault: "player-crash", playerId: "p1" } });
    expect(fault.json()).toMatchObject({ data: { phase: "incident", incidents: [{ type: "protected-crash", recommendedRestart: true }] } });
  });

  it("exports a fixed test scoreboard version and archives it under the test data tree", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Export", mode: "test", idempotencyKey: "export" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });

    const csv = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/exports/csv?version=1`, headers: auth(token) });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("测试数据");
    const archived = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/archive`, headers: auth(token), payload: { version: 1 } });
    const archive = archived.json<{ data: { directory: string; packagePath: string; manifestHash: string } }>().data;
    expect(archive.directory.replaceAll("\\", "/")).toContain(`/test/${competitionId}/archive/`);
    expect(readFileSync(join(archive.directory, "manifest.json"), "utf8")).toContain('"testData": true');
    expect(archive.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds confirmation tokens to their target and appends an auditable scoreboard revision", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Revision", mode: "test", idempotencyKey: "revision" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });

    const confirmationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/confirmations`,
      headers: auth(token),
      payload: { kind: "scoreboard-override", target: "p4:s3" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const basePayload = {
      expectedStateVersion: 0,
      idempotencyKey: "override-p4",
      playerId: "p4",
      stageId: "s3",
      stage: { place: 1, points: 70 },
      rankPolicy: "tie",
      actor: "referee",
      reason: "录像复核"
    };
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`,
      headers: auth(token),
      payload: { ...basePayload, confirmationToken: confirmation.token, impactHash: "wrong" }
    });
    expect(invalid.json()).toMatchObject({ error: { code: "CONFIRMATION_INVALID" } });

    const revised = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`,
      headers: auth(token),
      payload: { ...basePayload, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    const revision = revised.json<{ data: { version: number; entries: Array<{ playerId: string; rank: number }> } }>().data;
    expect(revision.version).toBe(16);
    expect(revision.entries[0]).toMatchObject({ playerId: "p4", rank: 1 });
    const fixedExport = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/exports/csv`,
      headers: auth(token),
      payload: { version: 16 }
    });
    expect(fixedExport.statusCode).toBe(200);
    expect(fixedExport.body).not.toContain("录像复核");
  });

  it("restores competitions and active test runs after the local service restarts", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Persistent", mode: "test", idempotencyKey: "persistent" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });

    await app.close();
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    const restoredSession = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-restored" } });
    token = restoredSession.json<{ token: string }>().token;
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const restored = snapshot.json<{
      data: {
        competition: { id: string; activeRunId?: string };
        testRun?: { runId: string; nextEventIndex: number };
        scoreboardVersions: Array<{ version: number }>;
      };
    }>().data;
    expect(restored.competition).toMatchObject({ id: competitionId, activeRunId: runId });
    expect(restored.testRun).toMatchObject({
      runId,
      nextEventIndex: Array.isArray(scenario.events) ? scenario.events.length : 0
    });
    expect(restored.scoreboardVersions.at(-1)?.version).toBe(15);
  });
});
