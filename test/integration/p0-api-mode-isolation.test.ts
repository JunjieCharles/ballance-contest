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

    expect(testRecord.capabilities).toMatchObject({ realProcess: false, network: false, realCommands: false, virtualClock: true, playback: true, faultInjection: false, scenarioFaults: true });
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
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/publish`,
      headers: auth(token),
      payload: { expectedStateVersion: 0, idempotencyKey: "publish-independent-player-lifecycle" }
    });
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

  it("BE-MODE-002: drives virtual-clock Ready and countdown without a real command transport", async () => {
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
    const started = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    expect(started.json()).toMatchObject({ data: { phase: "ready", actions: expect.arrayContaining([expect.objectContaining({ kind: "ready", status: "acknowledged" })]) } });
    const countdown = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 15_000 }
    });
    expect(countdown.json()).toMatchObject({ data: { phase: "countdown", countdownValue: 3, attempts: [] } });
    const running = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 3_000 }
    });
    const runningSnapshot = running.json<{ data: { phase: string; attempts: Array<{ attemptNumber: number; results: unknown[] }>; actions: Array<{ message?: string }> } }>().data;
    expect(runningSnapshot).toMatchObject({ phase: "tail-intake", attempts: [expect.objectContaining({ attemptNumber: 1 })] });
    expect(runningSnapshot.attempts[0]?.results).toHaveLength(5);
    expect(runningSnapshot.actions.some((action) => action.message?.includes("Ready"))).toBe(true);
    expect(runningSnapshot.actions.every((action) => !action.message?.includes("195000"))).toBe(true);
    const scheduledSnapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(scheduledSnapshot.json()).toMatchObject({ data: { runtime: { plannedReadyAt: expect.stringMatching(/Z$/) } } });
    const raw = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/logs/raw?limit=100`, headers: auth(token) });
    const rawLines = raw.json<{ data: Array<{ rawLine: string }> }>().data.map((item) => item.rawLine);
    expect(rawLines.filter((line) => line.includes("Get ready"))).toHaveLength(3);
    expect(rawLines).toEqual(expect.arrayContaining([expect.stringContaining(" - 3"), expect.stringContaining(" - 2"), expect.stringContaining(" - 1"), expect.stringContaining(" - Go!")]));
  });

  it("drives independent player profiles, exposes raw logs, then finishes and deletes safely", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "独立玩家闭环", mode: "test", idempotencyKey: "independent-player-lifecycle" }
    });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/publish`,
      headers: auth(token),
      payload: { expectedStateVersion: 0, idempotencyKey: "publish-independent-player-lifecycle-case" }
    });
    const scenarios = await app.inject({ method: "GET", url: "/api/v1/test-scenarios", headers: auth(token) });
    const scenarioData = scenarios.json<{ data: Array<{ id: string; players: number; randomSeed: number; playerProfiles: string[] }> }>().data;
    expect(scenarioData.every((scenario) => scenario.players >= 15)).toBe(true);
    expect(new Set(scenarioData.map((scenario) => scenario.randomSeed)).size).toBe(scenarioData.length);
    expect(scenarios.json()).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({
      id: "independent-player-sandbox",
      randomSeed: 20_260_631,
      players: 20,
      faults: 2,
      playerProfiles: expect.arrayContaining(["expert", "normal", "struggler", "disruptor"])
    }), expect.objectContaining({
      id: "large-player-sandbox",
      players: 30,
      faults: 2
    }), expect.objectContaining({
      id: "protected-crash-fault",
      players: 15,
      faults: 1
    })]) });
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`,
      headers: auth(token),
      payload: { scenarioId: "independent-player-sandbox" }
    });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    const automaticStart = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/automation/enable`,
      headers: auth(token),
      payload: { runId, readyInMs: 0 }
    });
    expect(automaticStart.json()).toMatchObject({ data: { phase: "ready", attempts: [] } });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
    const realtimeSnapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(realtimeSnapshot.json()).toMatchObject({ data: { runtime: { phase: "ready", virtualNowMs: expect.any(Number) } } });
    const realtimeNow = realtimeSnapshot.json<{ data: { runtime: { virtualNowMs: number } } }>().data.runtime.virtualNowMs;
    expect(realtimeNow).toBeGreaterThanOrEqual(400);
    expect(realtimeNow).toBeLessThan(5_000);

    type AutomationData = { phase: string; attempts: Array<{ results: Array<{ status: string; reason?: string }> }> };
    let automaticData = automaticStart.json<{ data: AutomationData }>().data;
    const advanced = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 9_000_000 }
    });
    automaticData = advanced.json<{ data: AutomationData }>().data;
    expect(automaticData.phase).toBe("review");
    expect(automaticData.attempts).toHaveLength(13);
    const resultCounts = automaticData.attempts.map((attempt) => attempt.results.length);
    expect(resultCounts.slice(0, -1).every((count) => count >= 12 && count <= 20)).toBe(true);
    expect(resultCounts.slice(0, -1).some((count) => count < 20)).toBe(true);
    expect(resultCounts.at(-1)).toBe(20);
    expect(automaticData.attempts.some((attempt) => attempt.results.some((result) => result.status === "dnf" && result.reason === "time-limit"))).toBe(true);
    expect(automaticData.attempts.some((attempt) => attempt.results.some((result) => result.status === "dnf" && result.reason === "gave-up"))).toBe(true);
    expect(automaticData.attempts.some((attempt) => attempt.results.some((result) => result.status === "excluded"))).toBe(true);
    const automaticallyFinished = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}`, headers: auth(token) });
    expect(automaticallyFinished.json()).toMatchObject({ data: { status: "finished" } });

    const manualCompetition = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "独立玩家手动闭环", mode: "test", idempotencyKey: "independent-player-manual-lifecycle" }
    });
    const manualCompetitionId = manualCompetition.json<{ data: { id: string } }>().data.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/publish`,
      headers: auth(token),
      payload: { expectedStateVersion: 0, idempotencyKey: "publish-independent-player-manual-lifecycle" }
    });
    const manualRun = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/test-runs/from-scenario`,
      headers: auth(token),
      payload: { scenarioId: "independent-player-sandbox" }
    });
    const manualRunId = manualRun.json<{ data: { runId: string } }>().data.runId;
    const ready = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/actions`,
      headers: auth(token),
      payload: { expectedStateVersion: 1, idempotencyKey: "manual-ready", action: { type: "ready" } }
    });
    expect(ready.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/test-runs/${manualRunId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 15_000 }
    });
    const goConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${manualCompetitionId}/confirmations`, headers: auth(token), payload: { kind: "manual-go", target: manualCompetitionId } });
    const goConfirmation = goConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const manualGo = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/actions`,
      headers: auth(token),
      payload: {
        expectedStateVersion: 2,
        idempotencyKey: "manual-go",
        action: { type: "manual-go", confirmationToken: goConfirmation.token, impactHash: goConfirmation.impactHash }
      }
    });
    expect(manualGo.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/v1/competitions/${manualCompetitionId}/test-runs/${manualRunId}/automation/advance`, headers: auth(token), payload: { milliseconds: 3_000 } });
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/test-runs/${manualRunId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 240_000 }
    });
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${manualCompetitionId}/snapshot`, headers: auth(token) });
    const snapshotData = snapshot.json<{ data: { runtime: { phase: string }; currentScoreboard: unknown[]; competition: { stateVersion: number } } }>().data;
    expect(snapshotData.runtime.phase).toBe("tail-intake");
    expect(snapshotData.currentScoreboard).toHaveLength(20);

    const logs = await app.inject({ method: "GET", url: `/api/v1/competitions/${manualCompetitionId}/logs/raw`, headers: auth(token) });
    expect(logs.json()).toMatchObject({ data: expect.arrayContaining([
      expect.objectContaining({ source: "test-player", rawLine: expect.stringContaining("finished Level") }),
      expect.objectContaining({ source: "test-referee", rawLine: expect.stringContaining(" - Go!") })
    ]) });
    expect(logs.json<{ data: Array<{ rawLine: string }> }>().data.every((line) => line.rawLine.startsWith("["))).toBe(true);
    expect(logs.json<{ data: Array<{ rawLine: string }> }>().data.some((line) => line.rawLine.includes("[模拟裁判]"))).toBe(false);

    const finishConfirmation = await app.inject({ method: "POST", url: `/api/v1/competitions/${manualCompetitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", target: manualCompetitionId } });
    const finishToken = finishConfirmation.json<{ data: { token: string; impactHash: string } }>().data;
    const finished = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${manualCompetitionId}/finish`,
      headers: auth(token),
      payload: { expectedStateVersion: snapshotData.competition.stateVersion, idempotencyKey: "finish", confirmationToken: finishToken.token, impactHash: finishToken.impactHash }
    });
    expect(finished.json()).toMatchObject({ data: { status: "finished" } });
    const finishedRecord = finished.json<{ data: { stateVersion: number } }>().data;
    const deleteConfirmation = await app.inject({ method: "POST", url: `/api/v1/competitions/${manualCompetitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", target: manualCompetitionId } });
    const deleteToken = deleteConfirmation.json<{ data: { token: string; impactHash: string } }>().data;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/competitions/${manualCompetitionId}`,
      headers: auth(token),
      payload: { expectedStateVersion: finishedRecord.stateVersion, idempotencyKey: "delete", confirmationToken: deleteToken.token, impactHash: deleteToken.impactHash }
    });
    expect(deleted.json()).toMatchObject({ data: { id: manualCompetitionId } });
    expect((await app.inject({ method: "GET", url: `/api/v1/competitions/${manualCompetitionId}`, headers: auth(token) })).statusCode).toBe(404);
  });
});
