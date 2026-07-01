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
    const countdown = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 15_000 } });
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

  it("publishes an action matrix and separates Ready from stage-deadline changes", async () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as Record<string, unknown>;
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Scheduling", mode: "test", idempotencyKey: "scheduling" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs`, headers: auth(token), payload: scenario });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/start`, headers: auth(token), payload: {} });
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 18_000 } });
    const beforeResponse = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const before = beforeResponse.json<{ data: { runtime: { plannedReadyAt: string; stageDeadlineAt: string; availableActions: Array<{ action: string; enabled: boolean; disabledReason?: string }> } } }>().data.runtime;
    expect(before.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "delay-ready", enabled: true }),
      expect.objectContaining({ action: "extend-stage-deadline", enabled: true }),
      expect.objectContaining({ action: "manual-go", enabled: false, disabledReason: expect.any(String) })
    ]));

    const act = async (stateVersion: number, action: Record<string, unknown>, idempotencyKey: string) => {
      const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "manual-action", target: competitionId } });
      const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string; effect: { currentPhase: string; consequences: string[] } } }>().data;
      expect(confirmation.effect).toMatchObject({ currentPhase: "tail-intake", consequences: expect.any(Array) });
      return app.inject({
        method: "POST", url: `/api/v1/competitions/${competitionId}/actions`, headers: auth(token),
        payload: { expectedStateVersion: stateVersion, idempotencyKey, action: { ...action, confirmationToken: confirmation.token, impactHash: confirmation.impactHash } }
      });
    };
    expect((await act(0, { type: "delay-ready", milliseconds: 60_000 }, "delay-ready")).statusCode).toBe(200);
    expect((await act(1, { type: "extend-stage-deadline", milliseconds: 60_000 }, "extend-deadline")).statusCode).toBe(200);
    const readyTarget = new Date(Date.parse(before.plannedReadyAt) + 120_000).toISOString();
    const deadlineTarget = new Date(Date.parse(before.stageDeadlineAt) + 180_000).toISOString();
    expect((await act(2, { type: "reschedule", plannedReadyAt: readyTarget }, "reschedule-ready")).statusCode).toBe(200);
    expect((await act(3, { type: "reschedule-stage-deadline", deadlineAt: deadlineTarget }, "reschedule-deadline")).statusCode).toBe(200);
    const afterResponse = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    const after = afterResponse.json<{ data: { runtime: { plannedReadyAt: string; stageDeadlineAt: string; attentionItems: Array<{ title: string }> } } }>().data.runtime;
    expect(after.plannedReadyAt).toBe(readyTarget);
    expect(after.stageDeadlineAt).toBe(deadlineTarget);
    expect(after.attentionItems.some((item) => item.title === "流程通知")).toBe(true);
  });

  it("triggers faults from the selected scenario instead of a manual fault endpoint", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/competitions", headers: auth(token), payload: { name: "Fault scenario", mode: "test", idempotencyKey: "fault-scenario" } });
    const competitionId = created.json<{ data: { id: string } }>().data.id;
    const run = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/from-scenario`, headers: auth(token), payload: { scenarioId: "protected-crash-fault" } });
    const runId = run.json<{ data: { runId: string } }>().data.runId;
    await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/automation/enable`, headers: auth(token), payload: { runId } });
    const advanced = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, headers: auth(token), payload: { milliseconds: 23_000 } });
    expect(advanced.json()).toMatchObject({ data: { phase: "incident", incidents: [expect.objectContaining({ type: "protected-crash", recommendedRestart: true })] } });
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/competitions/${competitionId}/snapshot`, headers: auth(token) });
    expect(snapshot.json()).toMatchObject({ data: { runtime: { attentionItems: expect.arrayContaining([expect.objectContaining({ title: "场景故障已触发" })]) } } });
    expect((await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/test-runs/${runId}/faults`, headers: auth(token), payload: { fault: "player-crash" } })).statusCode).toBe(404);
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
    const confirmationResponse = await app.inject({ method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token), payload: { kind: "high-risk", target: competitionId } });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/finish`, headers: auth(token),
      payload: { expectedStateVersion: 0, idempotencyKey: "finish-for-archive", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
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
      payload: { kind: "scoreboard-override", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string; effect: { consequences: string[]; affectedPlayers?: Array<{ playerId: string; displayName: string }> } } }>().data;
    expect(confirmation.effect.consequences).toContain("生成新的榜单版本");
    expect(confirmation.effect.affectedPlayers?.map((player) => player.playerId)).toContain("p4");
    const basePayload = {
      expectedStateVersion: 0,
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
      payload: { kind: "scoreboard-override", target: "p4:s3", playerId: "p4", stageId: "s3", operation: "set-place", place: 1, rankPolicy: "shift" }
    });
    const pointsConfirmation = pointsConfirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    const directPointsEdit = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`,
      headers: auth(token),
      payload: {
        ...basePayload,
        expectedStateVersion: 1,
        idempotencyKey: "forbidden-points-edit",
        points: 999,
        confirmationToken: pointsConfirmation.token,
        impactHash: pointsConfirmation.impactHash
      }
    });
    expect(directPointsEdit.json()).toMatchObject({ error: { code: "VALIDATION_FAILED", message: expect.stringContaining("不接受前端提交") } });
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
    const confirmationResponse = await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/confirmations`, headers: auth(token),
      payload: { kind: "scoreboard-override", target: "p4:s3" }
    });
    const confirmation = confirmationResponse.json<{ data: { token: string; impactHash: string } }>().data;
    await app.inject({
      method: "POST", url: `/api/v1/competitions/${competitionId}/scoreboard/overrides`, headers: auth(token),
      payload: {
        expectedStateVersion: 0, idempotencyKey: "persistent-revision", playerId: "p4", stageId: "s3",
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
});
