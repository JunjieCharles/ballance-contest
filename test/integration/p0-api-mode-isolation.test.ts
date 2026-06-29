import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app.js";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const loadScenario = (id: string): unknown => JSON.parse(readFileSync(resolve(`test/fixtures/scenarios/${id}/scenario.json`), "utf8")) as unknown;

describe("P0 API mode isolation and test run regression", () => {
  let app: FastifyInstance;
  let token: string;
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-test-api-"));
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    const response = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-1" } });
    token = response.json<{ token: string }>().token;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("BE-MODE-002/003: exposes separate capabilities and rejects test resources in work mode", async () => {
    const testCompetition = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "集中测试模式", mode: "test", idempotencyKey: "test-mode" }
    });
    const workCompetition = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "集中工作模式", mode: "work", idempotencyKey: "work-mode" }
    });
    const testRecord = testCompetition.json<{ data: { id: string; capabilities: Record<string, boolean> } }>().data;
    const workRecord = workCompetition.json<{ data: { id: string; capabilities: Record<string, boolean> } }>().data;

    expect(testRecord.capabilities).toMatchObject({ realProcess: false, network: false, realCommands: false, virtualClock: true, playback: true, faultInjection: true });
    expect(workRecord.capabilities).toMatchObject({ realProcess: true, network: true, realCommands: true, virtualClock: false, playback: false, faultInjection: false });

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${workRecord.id}/test-runs`,
      headers: auth(token),
      payload: loadScenario("three-stage-main")
    });
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json()).toMatchObject({ error: { code: "CAPABILITY_UNSUPPORTED" } });
  });

  it("E2E-TEST-001/002: plays the main scenario, resets deterministically and exports fixed test data", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "主场景集中回归", mode: "test", idempotencyKey: "main-scenario" }
    });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs`,
      headers: auth(token),
      payload: loadScenario("three-stage-main")
    });
    const runId = run.json<{ data: { runId: string; snapshot: { attempts: unknown[]; scoreboardVersions: unknown[] } } }>().data.runId;

    const played = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token), payload: {} });
    expect(played.json()).toMatchObject({ data: { attempts: expect.arrayContaining([expect.objectContaining({ attemptNumber: 1 })]), scoreboardVersions: expect.any(Array) } });
    expect(played.json<{ data: { attempts: unknown[]; scoreboardVersions: unknown[] } }>().data).toMatchObject({ attempts: { length: 3 }, scoreboardVersions: { length: 15 } });

    const csv = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/exports/csv?version=15`, headers: auth(token) });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("测试数据");
    expect(csv.headers["content-disposition"]).toContain("scoreboard-v15.csv");

    const reset = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/reset`, headers: auth(token), payload: {} });
    expect(reset.json()).toMatchObject({ data: { attempts: [], scoreboardVersions: [], anomalies: [] } });
    const replayed = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token), payload: {} });
    expect(replayed.json<{ data: { scoreboardVersions: Array<{ deterministicHash: string }> } }>().data.scoreboardVersions.map((version) => version.deterministicHash))
      .toEqual(played.json<{ data: { scoreboardVersions: Array<{ deterministicHash: string }> } }>().data.scoreboardVersions.map((version) => version.deterministicHash));
  });

  it("BE-MODE-002: drives virtual-clock automation and fault injection without a real command transport", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "虚拟自动化集中回归", mode: "test", idempotencyKey: "virtual-automation" }
    });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs`,
      headers: auth(token),
      payload: loadScenario("three-stage-main")
    });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token), payload: {} });

    const started = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    expect(started.json()).toMatchObject({ data: { phase: "ready", actions: expect.arrayContaining([expect.objectContaining({ kind: "ready", status: "acknowledged" })]) } });
    const running = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 15_000 }
    });
    expect(running.json()).toMatchObject({ data: { phase: "running", attempts: [expect.objectContaining({ attemptNumber: 1 })] } });
    const fault = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/faults`,
      headers: auth(token),
      payload: { fault: "clock-jump", milliseconds: 60_000 }
    });
    expect(fault.json()).toMatchObject({
      data: {
        phase: "paused",
        automationEnabled: false,
        incidents: [expect.objectContaining({ type: "timing-discontinuity", recommendedRestart: false })],
        blockers: [expect.objectContaining({ code: "AUTOMATION_PAUSED" })]
      }
    });
  });
});
