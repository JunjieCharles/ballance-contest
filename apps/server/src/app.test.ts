import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const defaultCreated = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Default Work", idempotencyKey: "default-work" } });
    expect(defaultCreated.json()).toMatchObject({ data: { mode: "work" } });
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

  it("drives the Ready and 3/2/1/Go sequence with a virtual clock", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Automation", mode: "test", idempotencyKey: "automation" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    const started = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    expect(started.json()).toMatchObject({ data: { phase: "ready", actions: expect.any(Array) } });
    const countdown = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 30_000 } });
    expect(countdown.json()).toMatchObject({ data: { phase: "countdown", countdownValue: 3, attempts: [] } });
    const advanced = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 3_000 } });
    expect(advanced.json()).toMatchObject({ data: { phase: "tail-intake", attempts: [{ attemptNumber: 1, results: { length: 5 } }] } });
    const logs = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/logs/raw?limit=100`, headers: auth(token) });
    const rawLines = logs.json<{ data: Array<{ rawLine: string }> }>().data.map((line) => line.rawLine);
    expect(rawLines.filter((line) => line.includes("Get ready"))).toHaveLength(3);
    expect(rawLines).toEqual(expect.arrayContaining([
      expect.stringContaining("[Announcement]"), expect.stringContaining(" - 3"), expect.stringContaining(" - 2"),
      expect.stringContaining(" - 1"), expect.stringContaining(" - Go!")
    ]));
  });

  it("plans the first Ready three minutes after enabling and emits the schedule bulletin", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Prepared start", mode: "test", idempotencyKey: "prepared-start" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish-prepared-start" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "normal-player-roster" } });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/automation/enable`,
      headers: auth(token),
      payload: { runId, expectedStateVersion: 1, idempotencyKey: "enable-prepared-start" }
    });
    expect(enabled.json()).toMatchObject({ data: { phase: "preparing", plannedReadyAtMs: 180_000, attempts: [] } });
    const logs = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/logs/raw?limit=50`, headers: auth(token) });
    expect(logs.json<{ data: Array<{ rawLine: string }> }>().data.map((line) => line.rawLine)).toEqual(expect.arrayContaining([
      expect.stringContaining("[Bulletin]")
    ]));
    const beforeReady = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 179_999 } });
    expect(beforeReady.json()).toMatchObject({ data: { phase: "preparing" } });
    const ready = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 1 } });
    expect(ready.json()).toMatchObject({ data: { phase: "ready" } });
  });

  it("publishes an action matrix and separates Ready from stage-deadline changes", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Scheduling", mode: "test", idempotencyKey: "scheduling" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish-scheduling" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 33_000 } });
    const beforeResponse = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const before = beforeResponse.json<{ data: { runtime: { plannedReadyAt: string; stageDeadlineAt: string; availableActions: Array<{ action: string; enabled: boolean; disabledReason?: string }> } } }>().data.runtime;
    expect(before.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "delay-ready", enabled: true }),
      expect.objectContaining({ action: "extend-stage-deadline", enabled: true }),
      expect.objectContaining({ action: "manual-go", enabled: false, disabledReason: expect.any(String) })
    ]));

    const act = async (stateVersion: number, action: Record<string, unknown>, idempotencyKey: string) => {
      const { type, ...boundInput } = action;
      const confirmationResponse = await app.inject({
        method: "POST",
        url: `/api/v1/competitions/${competitionId}/confirmations`,
        headers: auth(token),
        payload: { kind: "manual-action", intent: type, target: competitionId, ...boundInput }
      });
      const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string; effect: { currentPhase: string; consequences: string[] } } }>().data;
      expect(confirmation.effect).toMatchObject({ currentPhase: "tail-intake", consequences: expect.any(Array) });
      return app.inject({
        method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
        payload: { expectedStateVersion: stateVersion, idempotencyKey, action: { ...action, confirmationToken: confirmation.token, impactHash: confirmation.impactHash } }
      });
    };
    expect((await act(1, { type: "delay-ready", milliseconds: 60_000 }, "delay-ready")).statusCode).toBe(200);
    expect((await act(2, { type: "extend-stage-deadline", milliseconds: 60_000 }, "extend-deadline")).statusCode).toBe(200);
    const readyTarget = new Date(Date.parse(before.plannedReadyAt) + 120_000).toISOString();
    const deadlineTarget = new Date(Date.parse(before.stageDeadlineAt) + 180_000).toISOString();
    const preparationTarget = new Date(Date.parse(readyTarget) - 60_000).toISOString();
    const staleScheduleConfirmation = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "manual-action", intent: "reschedule", target: competitionId, preparationAt: preparationTarget } });
    const staleSchedule = staleScheduleConfirmation.json<{ data: { token: string; impactHash: string } }>().data;
    const changedSchedule = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 3, idempotencyKey: "changed-t60", action: { type: "reschedule", preparationAt: readyTarget, confirmationToken: staleSchedule.token, impactHash: staleSchedule.impactHash } } });
    expect(changedSchedule.statusCode).toBe(409);
    expect((await act(3, { type: "reschedule", preparationAt: preparationTarget }, "reschedule-preparation")).statusCode).toBe(200);
    expect((await act(4, { type: "reschedule-stage-deadline", deadlineAt: deadlineTarget }, "reschedule-deadline")).statusCode).toBe(200);
    const afterResponse = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const after = afterResponse.json<{
      data: {
        runtime: {
          plannedReadyAt: string;
          plannedReadyAtMs: number;
          plannedReadyStageId: string;
          stageDeadlineAt: string;
          virtualNowMs: number;
          attentionItems: Array<{ title: string }>;
        };
      };
    }>().data.runtime;
    expect(after.plannedReadyAt).toBe(readyTarget);
    expect(afterResponse.json<{ data: { runtime: { nextStagePreparationAt: string } } }>().data.runtime.nextStagePreparationAt).toBe(preparationTarget);
    expect(after.stageDeadlineAt).toBe(deadlineTarget);
    expect(after.attentionItems.some((item) => item.title === "赛程计划已更新")).toBe(true);
    await app.close();
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    const restoredSession = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/bootstrap",
      payload: { bootstrapToken: "bootstrap", tabId: "tab-scheduling-restored" }
    });
    token = restoredSession.json<{ token: string }>().token;
    const restoredResponse = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${competitionId}/snapshot`,
      headers: auth(token)
    });
    const restored = restoredResponse.json<{
      data: {
        runtime: {
          phase: string;
          pausedFromPhase?: string;
          currentStageId: string;
          plannedReadyAt: string;
          plannedReadyAtMs: number;
          plannedReadyStageId: string;
          stageDeadlineAt: string;
          virtualNowMs: number;
        };
      };
    }>().data.runtime;
    expect(restored).toMatchObject({
      phase: "paused",
      pausedFromPhase: "tail-intake",
      currentStageId: "s1",
      plannedReadyAt: readyTarget,
      nextStagePreparationAt: preparationTarget,
      plannedReadyAtMs: after.plannedReadyAtMs,
      plannedReadyStageId: after.plannedReadyStageId,
      stageDeadlineAt: deadlineTarget,
      virtualNowMs: after.virtualNowMs
    });

    const toBoundaryMs = restored.plannedReadyAtMs - 60_000 - restored.virtualNowMs;
    expect(toBoundaryMs).toBeGreaterThanOrEqual(0);
    const crossed = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: toBoundaryMs }
    });
    expect(crossed.json()).toMatchObject({
      data: {
        phase: "paused",
        pausedFromPhase: "preparing",
        currentStageId: after.plannedReadyStageId
      }
    });
  });

  it("separates the scheduled launch flow from manual Ready, cheat-off and authoritative manual Go timing", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Manual controls", mode: "test", idempotencyKey: "manual-controls" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish-manual-controls" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "normal-player-roster" } });
    const runId = run.json<{ data: { runId: string } }>().data.runId;

    const confirm = async (kind: "manual-action" | "manual-go", intent: "start-ready-flow" | "ready" | "manual-go") => (await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind, intent, target: competitionId }
    })).json<{ data: { token: string; impactHash: string } }>().data;
    const flowConfirmation = await confirm("manual-action", "start-ready-flow");
    expect((await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 1, idempotencyKey: "start-ready-flow", action: { type: "start-ready-flow", confirmationToken: flowConfirmation.token, impactHash: flowConfirmation.impactHash } }
    })).statusCode).toBe(200);

    type SnapshotData = { runtime: { phase: string; plannedReadyAtMs?: number; plannedReadyAt?: string; plannedStageStartAt?: string; stageDeadlineAt?: string; attempts: unknown[]; availableActions: Array<{ action: string; enabled: boolean }> }; config: { stages: Array<{ timeLimitMs: number }> } };
    let snapshot = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: SnapshotData }>().data;
    expect(snapshot.runtime).toMatchObject({ phase: "preparing", plannedReadyAtMs: 60_000, attempts: [] });
    const originalReadyAt = snapshot.runtime.plannedReadyAt;
    const logsAfterFlow = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/logs/raw?limit=50`, headers: auth(token) }))
      .json<{ data: Array<{ rawLine: string }> }>().data.map((line) => line.rawLine);
    expect(logsAfterFlow).toContainEqual(expect.stringMatching(/\[Bulletin\].*SR1 将在 \d{2}:\d{2} 发令$/));
    expect(logsAfterFlow).toContainEqual(expect.stringContaining("SR1 将在一分钟后发令。\n请提前重启游戏，做好准备。"));

    const readyConfirmation = await confirm("manual-action", "ready");
    expect((await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: {
        expectedStateVersion: 2,
        idempotencyKey: "manual-ready",
        action: { type: "ready", confirmationToken: readyConfirmation.token, impactHash: readyConfirmation.impactHash }
      }
    })).statusCode).toBe(200);
    snapshot = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: SnapshotData }>().data;
    expect(snapshot.runtime).toMatchObject({ phase: "preparing", plannedReadyAt: originalReadyAt, attempts: [] });

    expect((await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 3, idempotencyKey: "manual-cheat-off", action: { type: "cheat-off" } }
    })).statusCode).toBe(200);
    snapshot = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: SnapshotData }>().data;
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "manual-go", enabled: true }));

    const goConfirmation = await confirm("manual-go", "manual-go");
    expect((await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 4, idempotencyKey: "manual-go", action: { type: "manual-go", confirmationToken: goConfirmation.token, impactHash: goConfirmation.impactHash } }
    })).statusCode).toBe(200);
    snapshot = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: SnapshotData }>().data;
    expect(snapshot.runtime).toMatchObject({ phase: "countdown", attempts: [] });
    expect(snapshot.runtime.stageDeadlineAt).toBeUndefined();

    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 3_000 } });
    snapshot = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: SnapshotData }>().data;
    expect(snapshot.runtime.phase).toMatch(/running|tail-intake/);
    expect(snapshot.runtime.attempts).toHaveLength(1);
    expect(Date.parse(snapshot.runtime.stageDeadlineAt as string) - Date.parse(snapshot.runtime.plannedStageStartAt as string)).toBe(snapshot.config.stages[0]?.timeLimitMs);
  });

  it("allows score review from the next stage T-60 boundary and for every stage after finish", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const stages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>).map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Score gates", mode: "test", idempotencyKey: "score-gates" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "PATCH", url: `/api/v1/competitions/${competitionId}/draft`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "score-gate-stages", stages } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "publish-score-gates" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 33_000 } });

    const current = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(current.json()).toMatchObject({ data: { runtime: { currentStageId: "s1", scoreEditPermissions: expect.arrayContaining([expect.objectContaining({ stageId: "s1", editable: false })]) } } });
    const denied = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p1:s1", playerId: "p1", stageId: "s1", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    expect(denied).toMatchObject({ statusCode: 409 });
    expect(denied.json()).toMatchObject({
      error: {
        code: "ACTION_UNAVAILABLE",
        message: expect.stringContaining("进入下一关 Ready 前 1 分钟的准备阶段后才能修订")
      }
    });

    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 180_000 } });
    const nextStage = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(nextStage.json()).toMatchObject({ data: { runtime: { currentStageId: "s2", scoreEditPermissions: expect.arrayContaining([
      expect.objectContaining({ stageId: "s1", editable: true }),
      expect.objectContaining({ stageId: "s2", editable: false })
    ]) } } });
    const confirmationResponse = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p4:s1", playerId: "p4", stageId: "s1", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const revised = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`, headers: auth(token),
      payload: { expectedStateVersion: 2, idempotencyKey: "review-s1", playerId: "p4", stageId: "s1", operation: "set-place", place: 1, rankPolicy: "shift", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    expect(revised.statusCode).toBe(200);
    const revisedVersion = revised.json<{ data: { version: number } }>().data.version;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 90_000 } });
    const continued = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{ data: { scoreboardVersions: Array<{ version: number; entries: Array<{ playerId: string; stages: Record<string, { place?: number }> }> }> } }>().data.scoreboardVersions;
    expect(new Set(continued.map((version) => version.version)).size).toBe(continued.length);
    expect(continued.at(-1)?.version).toBeGreaterThan(revisedVersion);
    expect(continued.at(-1)?.entries.find((entry) => entry.playerId === "p4")?.stages.s1).toMatchObject({ place: 1 });

    const recheckConfirmationResponse = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p1:s1", playerId: "p1", stageId: "s1", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const recheckConfirmation = recheckConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/reset`, headers: auth(token), payload: {} });
    const deniedAfterConfirmation = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`, headers: auth(token),
      payload: { expectedStateVersion: 3, idempotencyKey: "review-s1-after-reset", playerId: "p1", stageId: "s1", operation: "set-place", place: 1, rankPolicy: "shift", confirmationToken: recheckConfirmation.token, impactHash: recheckConfirmation.impactHash }
    });
    expect(deniedAfterConfirmation.json()).toMatchObject({ error: { code: "ACTION_UNAVAILABLE" } });

    const finishConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: competitionId } });
    const finishConfirmation = finishConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/finish`, headers: auth(token), payload: { expectedStateVersion: 3, idempotencyKey: "finish-score-gates", confirmationToken: finishConfirmation.token, impactHash: finishConfirmation.impactHash } });
    const finished = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(finished.json<{ data: { runtime: { scoreEditPermissions: Array<{ editable: boolean }> } } }>().data.runtime.scoreEditPermissions.every((permission) => permission.editable)).toBe(true);
  });

  it("force-restarts before or after Go and removes an old attempt from scoring", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const stages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>).map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Restart stage", mode: "test", idempotencyKey: "restart-stage" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "PATCH", url: `/api/v1/competitions/${competitionId}/draft`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "restart-stages", stages } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "publish-restart-stage" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    const beforeGo = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{
      data: { runtime: { phase: string; currentStageId: string; attempts: unknown[]; availableActions: Array<{ action: string; enabled: boolean }> } }
    }>().data;
    expect(beforeGo.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "restart-stage", enabled: true }));
    const beforeGoConfirmationResponse = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "restart-stage", intent: "restart-stage", target: beforeGo.runtime.currentStageId }
    });
    const beforeGoConfirmation = beforeGoConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const beforeGoRestart = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 2, idempotencyKey: "restart-before-go", action: { type: "restart-stage", stageId: "s1", confirmationToken: beforeGoConfirmation.token, impactHash: beforeGoConfirmation.impactHash } }
    });
    expect(beforeGoRestart.statusCode).toBe(200);
    const resetBeforeGo = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{
      data: { runtime: { phase: string; attempts: unknown[] } }
    }>().data;
    expect(resetBeforeGo.runtime).toMatchObject({ phase: "ready", attempts: [] });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 33_000 } });
    const before = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{
      data: { runtime: { attempts: Array<{ id: string; attemptNumber: number; voided: boolean }>; availableActions: Array<{ action: string; enabled: boolean }> }; currentScoreboard: Array<{ stages: Record<string, { sourceId: string }> }> }
    }>().data;
    const attempt = before.runtime.attempts[0];
    if (!attempt) throw new Error("missing first attempt");
    expect(before.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "restart-stage", enabled: true }));
    expect(before.currentScoreboard.some((entry) => entry.stages.s1)).toBe(true);

    const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "restart-stage", intent: "restart-stage", target: "s1" } });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const restarted = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
      payload: { expectedStateVersion: 3, idempotencyKey: "restart-current-stage", action: { type: "restart-stage", stageId: "s1", confirmationToken: confirmation.token, impactHash: confirmation.impactHash } }
    });
    expect(restarted.statusCode).toBe(200);
    const afterRestart = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{
      data: { runtime: { phase: string; attempts: Array<{ attemptNumber: number; voided: boolean }> }; currentScoreboard: Array<{ stages: Record<string, unknown> }> }
    }>().data;
    expect(afterRestart.runtime).toMatchObject({ phase: "ready", attempts: [{ attemptNumber: 1, voided: true }] });
    expect(afterRestart.currentScoreboard.every((entry) => entry.stages.s1 === undefined)).toBe(true);

    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 33_000 } });
    const afterNewGo = (await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) })).json<{
      data: { runtime: { attempts: Array<{ attemptNumber: number; voided: boolean }> }; currentScoreboard: Array<{ stages: Record<string, { sourceId: string }> }> }
    }>().data;
    expect(afterNewGo.runtime.attempts).toMatchObject([{ attemptNumber: 1, voided: true }, { attemptNumber: 2, voided: false }]);
    expect(afterNewGo.currentScoreboard.some((entry) => entry.stages.s1)).toBe(true);
  });

  it("executes explicit mark, force-reset, and force-next recovery through the API", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const stages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>)
      .slice(0, 2)
      .map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/competitions",
      headers: auth(token),
      payload: { name: "Explicit API stage recovery", mode: "test", idempotencyKey: "explicit-api-stage-recovery" }
    });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/competitions/${competitionId}/draft`,
      headers: auth(token),
      payload: { expectedStateVersion: 0, idempotencyKey: "explicit-api-stages", stages }
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/publish`,
      headers: auth(token),
      payload: { expectedStateVersion: 1, idempotencyKey: "publish-explicit-api-stage-recovery" }
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`,
      headers: auth(token),
      payload: { scenarioId: "normal-player-roster" }
    });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    const getSnapshot = async () => (await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${competitionId}/snapshot`,
      headers: auth(token)
    })).json<{
      data: {
        competition: { stateVersion: number };
        runtime: {
          phase: string;
          pausedFromPhase?: string;
          currentStageId?: string;
          plannedReadyStageId?: string;
          attempts: Array<{ id: string; stageId: string; origin?: string; voided: boolean }>;
          availableActions: Array<{ action: string; enabled: boolean; targetStageId?: string }>;
        };
      };
    }>().data;
    const execute = async (
      type: "mark-stage-started" | "force-reset-stage" | "force-next-stage",
      stageId: string,
      idempotencyKey: string
    ) => {
      const before = await getSnapshot();
      const confirmationResponse = await app.inject({
        method: "POST",
        url: `/api/v1/competitions/${competitionId}/confirmations`,
        headers: auth(token),
        payload: { kind: "manual-action", intent: type, target: stageId, stageId }
      });
      expect(confirmationResponse.statusCode).toBe(200);
      const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
      return app.inject({
        method: "POST",
        url: `/api/v1/competitions/${competitionId}/actions`,
        headers: auth(token),
        payload: {
          expectedStateVersion: before.competition.stateVersion,
          idempotencyKey,
          action: { type, stageId, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
        }
      });
    };

    let snapshot = await getSnapshot();
    expect(snapshot.runtime.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "mark-stage-started", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-reset-stage", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-next-stage", enabled: true, targetStageId: "s2" })
    ]));
    expect((await execute("force-reset-stage", "s1", "api-force-reset")).statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`,
      headers: auth(token),
      payload: { milliseconds: 60_000 }
    });

    snapshot = await getSnapshot();
    expect(snapshot.runtime).toMatchObject({ phase: "ready", currentStageId: "s1" });
    expect((await execute("mark-stage-started", "s1", "api-mark-started")).statusCode).toBe(200);
    snapshot = await getSnapshot();
    expect(snapshot.runtime).toMatchObject({ phase: "running", automationEnabled: true, currentStageId: "s1" });
    expect(snapshot.runtime.attempts).toContainEqual(expect.objectContaining({
      stageId: "s1",
      origin: "referee-marked-started",
      voided: false
    }));
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({
      action: "mark-stage-started",
      enabled: true,
      targetStageId: "s1"
    }));

    expect((await execute("force-next-stage", "s2", "api-force-next")).statusCode).toBe(200);
    snapshot = await getSnapshot();
    expect(snapshot.runtime).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      plannedReadyStageId: "s2"
    });
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({
      action: "force-next-stage",
      enabled: false
    }));
  });

  it("triggers faults from the selected scenario instead of a manual fault endpoint", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Fault scenario", mode: "test", idempotencyKey: "fault-scenario" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish-fault-scenario" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "protected-crash-fault" } });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/automation/enable`, headers: auth(token), payload: { runId } });
    const advanced = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 218_000 } });
    expect(advanced.json()).toMatchObject({
      data: {
        phase: "restart-preparing",
        startProtectionUsedStageIds: [expect.any(String)],
        attempts: [expect.objectContaining({ attemptNumber: 1, intakeOpen: false, voided: true })],
        incidents: [expect.objectContaining({ type: "protected-crash", recommendedRestart: false, status: "resolved" })],
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: "bulletin",
            message: expect.stringContaining("\n本关起跑保护剩余 1 次，仅保护 fatal error。")
          })
        ])
      }
    });
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(snapshot.json()).toMatchObject({ data: { runtime: { attentionItems: expect.arrayContaining([
      expect.objectContaining({ title: "场景故障已触发" }),
      expect.objectContaining({ title: "起跑保护已自动执行" })
    ]) } } });
    expect(snapshot.json<{ data: { runtime: { attentionItems: Array<{ title: string }> } } }>().data.runtime.attentionItems)
      .not.toContainEqual(expect.objectContaining({ title: "待处理事故" }));
    expect((await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/faults`, headers: auth(token), payload: { fault: "player-crash" } })).statusCode).toBe(404);
  });

  it("exports a fixed test scoreboard version and archives it under the test data tree", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Export", mode: "test", idempotencyKey: "export" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "publish-export" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });

    const csv = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/exports/csv?version=1`, headers: auth(token) });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain('"变化","名次","总分","选手","SR1","HS2","SR13"');
    expect(csv.body).not.toContain("数据标记");
    expect(csv.headers["content-disposition"]).toContain("scoreboard-test-v1.csv");
    expect((await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/exports/html?version=1`, headers: auth(token) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/exports/tsv?version=1`, headers: auth(token) })).statusCode).toBe(400);
    const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: competitionId } });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/finish`, headers: auth(token),
      payload: { expectedStateVersion: 1, idempotencyKey: "finish-for-archive", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    const archived = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/archive`, headers: auth(token), payload: { version: 1 } });
    const archive = archived.json<{ data: { directory: string; packagePath: string; manifestHash: string } }>().data;
    expect(archive.directory.replaceAll("\\", "/")).toContain(`/test/${competitionId}/archive/`);
    expect(readFileSync(join(archive.directory, "manifest.json"), "utf8")).toContain('"testData": true');
    expect(archive.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds confirmation tokens to their target and appends an auditable scoreboard revision", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const stages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>).map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Revision", mode: "test", idempotencyKey: "revision" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "PATCH", url: `/api/v1/competitions/${competitionId}/draft`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "stages-revision", stages } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "publish-revision" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });
    const finishConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: competitionId } });
    const finishConfirmation = finishConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/finish`, headers: auth(token), payload: { expectedStateVersion: 2, idempotencyKey: "finish-revision", confirmationToken: finishConfirmation.token, impactHash: finishConfirmation.impactHash } });

    const confirmationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/confirmations`,
      headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string; effect: { title: string; consequences: string[]; affectedPlayers?: Array<{ playerId: string; displayName: string }> } } }>().data;
    expect(confirmation.effect.title).toMatch(/^把 .+ 的 SR13 成绩设为第 1 名？$/);
    expect(confirmation.effect.consequences).toContain("将生成新的榜单版本，原始成绩不会被覆盖。");
    expect(confirmation.effect.affectedPlayers?.map((player) => player.playerId)).toContain("p4");
    const basePayload = {
      expectedStateVersion: 3,
      idempotencyKey: "override-p4",
      playerId: "p4",
      stageId: "s3",
      operation: "set-place",
      place: 1,
      rankPolicy: "shift",
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
    expect(revised.json()).toMatchObject({ data: { version: 16 } });
    const revision = revised.json<{ data: { version: number; entries: Array<{ playerId: string; rank: number; stages: Record<string, { place: number; points: number }> }> } }>().data;
    expect(revision.version).toBe(16);
    expect(revision.entries).toHaveLength(5);
    expect(new Set(revision.entries.map((entry) => entry.playerId))).toEqual(new Set(["p1", "p2", "p3", "p4", "p5"]));
    expect(revision.entries.find((entry) => entry.playerId === "p4")?.stages.s3).toMatchObject({ place: 1, points: 20 });
    const pointsConfirmationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/confirmations`,
      headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const pointsConfirmation = pointsConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const directPointsEdit = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`,
      headers: auth(token),
      payload: {
        ...basePayload,
        expectedStateVersion: 4,
        idempotencyKey: "forbidden-points-edit",
        points: 999,
        confirmationToken: pointsConfirmation.token,
        impactHash: pointsConfirmation.impactHash
      }
    });
    expect(directPointsEdit.json()).toMatchObject({ error: { code: "VALIDATION_FAILED", message: expect.stringContaining("不接受前端提交") } });
    const dnfConfirmationResponse = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/confirmations`,
      headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-dnf", target: "p2:s3", playerId: "p2", stageId: "s3", operation: "set-dnf", rankPolicy: "shift" }
    });
    const dnfConfirmation = dnfConfirmationResponse.json<{ data: { token: string; impactHash: string; effect: { consequences: string[]; affectedPlayers?: Array<{ playerId: string; displayName: string }> } } }>().data;
    expect(dnfConfirmation.effect.consequences).toContain("其他玩家将顺延重算，共影响 1 名玩家。");
    expect(dnfConfirmation.effect.affectedPlayers?.map((player) => player.playerId)).toContain("p2");
    const dnfRevision = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`,
      headers: auth(token),
      payload: {
        expectedStateVersion: 4,
        idempotencyKey: "override-p2-dnf",
        playerId: "p2",
        stageId: "s3",
        operation: "set-dnf",
        rankPolicy: "shift",
        confirmationToken: dnfConfirmation.token,
        impactHash: dnfConfirmation.impactHash
      }
    });
    expect(dnfRevision.json()).toMatchObject({ data: { version: 17 } });
    expect(dnfRevision.json<{ data: { entries: Array<{ playerId: string; stages: Record<string, { status: string; place: number; points: number }> }> } }>().data.entries.find((entry) => entry.playerId === "p2")?.stages.s3).toMatchObject({ status: "dnf", place: 0, points: 0 });
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
    const stages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>).map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Persistent", mode: "test", idempotencyKey: "persistent" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "PATCH", url: `/api/v1/competitions/${competitionId}/draft`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "stages-persistent", stages } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "publish-persistent" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/play`, headers: auth(token) });
    const finishConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: competitionId } });
    const finishConfirmation = finishConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/finish`, headers: auth(token), payload: { expectedStateVersion: 2, idempotencyKey: "finish-persistent", confirmationToken: finishConfirmation.token, impactHash: finishConfirmation.impactHash } });
    const confirmationResponse = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`, headers: auth(token),
      payload: {
        expectedStateVersion: 3, idempotencyKey: "persistent-revision", playerId: "p4", stageId: "s3",
        operation: "set-place", place: 1, rankPolicy: "shift", confirmationToken: confirmation.token, impactHash: confirmation.impactHash
      }
    });

    await app.close();
    app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    const restoredSession = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab-restored" } });
    token = restoredSession.json<{ token: string }>().token;
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const restored = snapshot.json<{
      data: {
        competition: { id: string; activeRunId?: string };
        testRun?: { runId: string; nextEventIndex: number };
        scoreboardVersions: Array<{ version: number; entries: Array<{ playerId: string }> }>;
      };
    }>().data;
    expect(restored.competition).toMatchObject({ id: competitionId, activeRunId: runId });
    expect(restored.testRun).toMatchObject({
      runId,
      nextEventIndex: Array.isArray(scenario.events) ? scenario.events.length : 0
    });
    expect(restored.scoreboardVersions.at(-1)?.version).toBe(16);
    expect(restored.scoreboardVersions.at(-1)?.entries).toHaveLength(5);
    expect(new Set(restored.scoreboardVersions.at(-1)?.entries.map((entry) => entry.playerId))).toEqual(new Set(["p1", "p2", "p3", "p4", "p5"]));
  });

  it("locks referee actions before publish but still allows deleting a draft competition", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Draft lock", mode: "test", idempotencyKey: "draft-lock" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "independent-player-sandbox" } });
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const actions = snapshot.json<{ data: { runtime: { availableActions: Array<{ action: string; enabled: boolean; disabledReason?: string }> } } }>().data.runtime.availableActions;
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "enable-automation", enabled: false, disabledReason: "请先发布比赛配置" }),
      expect.objectContaining({ action: "ready", enabled: false, disabledReason: "请先发布比赛配置" }),
      expect.objectContaining({ action: "manual-go", enabled: false, disabledReason: "请先发布比赛配置" }),
      expect.objectContaining({ action: "delete", enabled: true })
    ]));

    const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "delete", target: competitionId } });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/competitions/${competitionId}`,
      headers: auth(token),
      payload: {
        expectedStateVersion: 0,
        idempotencyKey: "delete-draft",
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/competitions", headers: auth(token) })).json<{ data: Array<{ id: string }> }>().data.some((item) => item.id === competitionId)).toBe(false);
  });

  it("deletes running, finished and archived competitions through the same confirmed action", async () => {
    const remove = async (competitionId: string, stateVersion: number, key: string) => {
      const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "delete", target: competitionId } });
      const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
      const deleted = await app.inject({
        method: "DELETE", url: `/api/v1/competitions/${competitionId}`, headers: auth(token),
        payload: { expectedStateVersion: stateVersion, idempotencyKey: key, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
      });
      expect(deleted.statusCode).toBe(200);
    };

    const runningCreated = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Delete running", mode: "test", idempotencyKey: "delete-running-create" } });
    const runningId = runningCreated.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${runningId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "delete-running-publish" } });
    const runningRun = await app.inject({ method: "POST", url: `/api/v1/competitions/${runningId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "normal-player-roster" } });
    const runningRunId = runningRun.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${runningId}/test-runs/${runningRunId}/automation/start`, headers: auth(token), payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${runningId}/test-runs/${runningRunId}/automation/advance`, headers: auth(token), payload: { milliseconds: 33_000 } });
    await remove(runningId, 1, "delete-running");

    const finishedCreated = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Delete finished", mode: "test", idempotencyKey: "delete-finished-create" } });
    const finishedId = finishedCreated.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${finishedId}/publish`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "delete-finished-publish" } });
    const finishConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${finishedId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: finishedId } });
    const finishConfirmation = finishConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${finishedId}/finish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "finish-before-delete", confirmationToken: finishConfirmation.token, impactHash: finishConfirmation.impactHash } });
    await remove(finishedId, 2, "delete-finished");

    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const archiveStages = (scenario.stages as Array<{ id: string; order: number; level: number; mode: "SR" | "HS"; timeLimitMs: number; scoring: number[]; minimumScoringPlace: number }>).map((stage) => ({ ...stage, label: `${stage.mode} ${stage.level}` }));
    const archivedCreated = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Delete archived", mode: "test", idempotencyKey: "delete-archived-create" } });
    const archivedId = archivedCreated.json<{ data: { id: string } }>().data.id;
    await app.inject({ method: "PATCH", url: `/api/v1/competitions/${archivedId}/draft`, headers: auth(token), payload: { expectedStateVersion: 0, idempotencyKey: "delete-archived-stages", stages: archiveStages } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "delete-archived-publish" } });
    const archivedRun = await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/test-runs`, headers: auth(token), payload: scenario });
    const archivedRunId = archivedRun.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/test-runs/${archivedRunId}/play`, headers: auth(token) });
    const archiveFinishConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", intent: "finish", target: archivedId } });
    const archiveFinishConfirmation = archiveFinishConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/finish`, headers: auth(token), payload: { expectedStateVersion: 2, idempotencyKey: "finish-before-archive-delete", confirmationToken: archiveFinishConfirmation.token, impactHash: archiveFinishConfirmation.impactHash } });
    const archived = await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/test-runs/${archivedRunId}/archive`, headers: auth(token), payload: { version: 15 } });
    expect(archived.statusCode).toBe(200);
    const revisionConfirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/confirmations`, headers: auth(token), payload: { kind: "scoreboard-override", intent: "scoreboard-set-place", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" } });
    const revisionConfirmation = revisionConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const revision = await app.inject({
      method: "POST", url: `/api/v1/competitions/${archivedId}/scoreboard/overrides`, headers: auth(token),
      payload: { expectedStateVersion: 4, idempotencyKey: "revise-after-archive", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift", confirmationToken: revisionConfirmation.token, impactHash: revisionConfirmation.impactHash }
    });
    expect(revision.json()).toMatchObject({ data: { version: 16 } });
    const rearchive = await app.inject({ method: "POST", url: `/api/v1/competitions/${archivedId}/test-runs/${archivedRunId}/archive`, headers: auth(token), payload: { version: 16 } });
    expect(rearchive.statusCode).toBe(200);
    const retainedPackagePath = rearchive.json<{ data: { packagePath: string } }>().data.packagePath;
    const archivedSnapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${archivedId}/snapshot`, headers: auth(token) });
    expect(archivedSnapshot.json<{ data: { archives: unknown[] } }>().data.archives).toHaveLength(2);
    await remove(archivedId, 6, "delete-archived");
    expect(existsSync(retainedPackagePath)).toBe(true);
  });

  it("auto-marks competition finished when runtime reaches review phase", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Auto finish", mode: "test", idempotencyKey: "auto-finish" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/competitions/${competitionId}/draft`,
      headers: auth(token),
      payload: {
        expectedStateVersion: 0,
        idempotencyKey: "shorten-stages",
        stages: [{ id: "sr-1", order: 1, label: "SR 1", level: 1, mode: "SR", timeLimitMs: 30_000, scoring: [20], minimumScoringPlace: 1 }]
      }
    });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/publish`, headers: auth(token), payload: { expectedStateVersion: 1, idempotencyKey: "publish-auto-finish" } });
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "normal-player-roster" } });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/automation/enable`, headers: auth(token), payload: { runId } });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 245_000 } });

    const beforeSnapshot = await app.inject({ method: "GET", url: "/api/v1/competitions", headers: auth(token) });
    expect(beforeSnapshot.json<{ data: Array<{ id: string; status: string }> }>().data.find((item) => item.id === competitionId)?.status).toBe("finished");
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const data = snapshot.json<{ data: { competition: { status: string }; runtime: { phase: string; availableActions: Array<{ action: string; enabled: boolean }> } } }>().data;
    expect(data.runtime.phase).toBe("review");
    expect(data.competition.status).toBe("finished");
    expect(data.runtime.availableActions.find((item) => item.action === "archive")?.enabled).toBe(true);
  });
});
