import { afterEach, expect, it } from "vitest";
import type { CompetitionAction, ConfirmationIntent } from "@ballance/contracts";
import { CompetitionService } from "./competition-service.js";
import type { TestRuntimeManager } from "./test-runtime-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./storage/database.js";

let service: CompetitionService;
let database: ReturnType<typeof openDatabase>;
let dataRoot: string;
const clean = () => { if (dataRoot?.startsWith(join(tmpdir(), "ballance-controls-"))) rmSync(dataRoot, { recursive: true, force: true }); };
afterEach(async () => { await service?.close(); database?.close(); clean(); });
function setup() {
  dataRoot = mkdtempSync(join(tmpdir(), "ballance-controls-"));
  database = openDatabase(join(dataRoot, "console.sqlite"));
  service = new CompetitionService(undefined, { database, dataRoot });
  const { id } = service.create({ name: "Controls", mode: "test", idempotencyKey: "create" });
  service.publish(id, 0, "publish");
  const { runId } = service.createTestRunFromScenario(id, "normal-player-roster");
  const manager = (service as unknown as { testRuntimeManager: TestRuntimeManager }).testRuntimeManager;
  const runtime = manager.getRuntime(id, runId);
  let serial = 0;
  const execute = async (type: "force-next-stage-ready" | "force-next-stage" | "advance-ready" | "delay-ready" | "shorten-stage-deadline" | "extend-stage-deadline") => {
    const snapshot = service.snapshot(id);
    const availability = snapshot.runtime.availableActions.find(item => item.action === type)!;
    expect(availability.enabled, availability.disabledReason).toBe(true);
    const confirmation = service.createConfirmation(id, { kind: "manual-action", intent: type as ConfirmationIntent, target: availability.targetStageId!, milliseconds: 60_000 });
    await service.performAction(id, {
      expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: `action-${serial++}`,
      action: { type, stageId: availability.targetStageId!, milliseconds: 60_000, confirmationToken: confirmation.token, impactHash: confirmation.impactHash } as CompetitionAction
    });
  };
  return { id, runId, runtime, manager, execute };
}

it("enters next Ready immediately, preserves scores and never sends a false one-minute notice", async () => {
  const { id, runId, runtime, execute } = setup();
  service.startTestAutomation(id, runId, 0);
  service.advanceTestAutomation(id, runId, 125_000);
  const before = runtime.engine.snapshot().currentScoreboard;
  expect(before.length).toBeGreaterThan(0);
  service.pauseAutomation(id);
  await execute("force-next-stage-ready");
  expect(runtime.automation.snapshot()).toMatchObject({ currentStageId: "sr-2", phase: "ready", automationEnabled: true });
  expect(runtime.engine.snapshot().currentScoreboard).toEqual(before);
  const current = runtime.automation.snapshot().actions.filter(item => item.stageId === "sr-2" && !item.isolated);
  expect(current).toContainEqual(expect.objectContaining({ kind: "ready" }));
  expect(current.some(item => item.kind === "notice" && item.message?.includes("一分钟"))).toBe(false);
  await service.close();
  database.close();
  database = openDatabase(join(dataRoot, "console.sqlite"));
  service = new CompetitionService(undefined, { database, dataRoot });
  const restored = service.getTestRunSnapshot(id, runId);
  expect(restored.automation).toMatchObject({ currentStageId: "sr-2", automationEnabled: false });
  expect(service.snapshot(id).scoreboardVersions.at(-1)?.entries.map(({ playerId, points, stages }) => ({ playerId, points, stages })))
    .toEqual(before.map(({ playerId, points, stages }) => ({ playerId, points, stages })));
});

it("allows paused time changes before T-60, clamps advance to now and rejects all later preparation changes", async () => {
  const { id, runId, runtime, execute } = setup();
  service.startTestAutomation(id, runId, 180_000);
  service.pauseAutomation(id);
  await execute("delay-ready");
  expect(runtime.automation.snapshot()).toMatchObject({ plannedReadyAtMs: 240_000, automationEnabled: false });
  service.advanceTestAutomation(id, runId, 150_000);
  await execute("advance-ready");
  expect(runtime.automation.snapshot()).toMatchObject({ plannedReadyAtMs: 210_000, automationEnabled: false });
  for (const action of ["delay-ready", "advance-ready", "reschedule"] as const) {
    expect(service.snapshot(id).runtime.availableActions.find(item => item.action === action)?.enabled).toBe(false);
    expect(() => service.createConfirmation(id, { kind: "manual-action", intent: action, target: "sr-1", milliseconds: 60_000 })).toThrow();
  }
});

it("closes controller and scoring windows immediately when a paused deadline is shortened past now", async () => {
  const { id, runtime, manager, execute } = setup();
  manager.markCurrentStageStarted(runtime, "sr-1");
  manager.settle(runtime);
  runtime.automation.rescheduleStageDeadline(runtime.automation.snapshot().clockNowMs! + 30_000);
  manager.settle(runtime);
  service.pauseAutomation(id);
  await execute("shorten-stage-deadline");
  expect(runtime.automation.snapshot().attempts[0]?.intakeOpen).toBe(false);
  expect(runtime.engine.snapshot().attempts[0]?.open).toBe(false);
  expect(runtime.automation.snapshot().automationEnabled).toBe(false);
});

it("blocks progression, resets and timing on connection failure, including confirmation and execution", async () => {
  const { id, runId, runtime } = setup();
  service.startTestAutomation(id, runId, 180_000);
  const snapshot = service.snapshot(id);
  const confirmation = service.createConfirmation(id, { kind: "manual-action", intent: "force-next-stage-ready", target: "sr-2" });
  runtime.automation.observeServerDisconnect("connection fault");
  for (const action of ["force-next-stage", "force-next-stage-ready", "force-reset-stage", "restart-stage", "mark-stage-started", "delay-ready", "advance-ready", "reschedule", "end-stage", "extend-stage-deadline", "shorten-stage-deadline", "reschedule-stage-deadline"] as const) {
    const availability = service.snapshot(id).runtime.availableActions.find(item => item.action === action)!;
    expect(availability.enabled, action).toBe(false);
    expect(availability.disabledReason).toContain("连接");
  }
  await expect(service.performAction(id, { expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: "stale", action: {
    type: "force-next-stage-ready", stageId: "sr-2", confirmationToken: confirmation.token, impactHash: confirmation.impactHash
  } })).rejects.toThrow();
  expect(runtime.automation.snapshot().currentStageId).toBe("sr-1");
});
