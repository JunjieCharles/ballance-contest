import {
  createDefaultCompetitionConfig,
  type CompetitionConfig,
  type CompetitionSnapshot,
  type RawClientLogLine,
  type ScenarioDefinition
} from "@ballance/contracts";
import { describe, expect, it } from "vitest";
import { EventJournal } from "./event-journal.js";
import { TestRuntimeManager, type TestRuntimeHost } from "./test-runtime-manager.js";
import type { ServiceSnapshotPayload } from "./runtime-types.js";

const competitionId = "test-competition";
const stages: ScenarioDefinition["stages"] = [
  {
    id: "s1",
    order: 1,
    level: 1,
    mode: "SR",
    mapKind: "official",
    displayName: "SR1",
    timeLimitMs: 200_000,
    scoring: [20],
    minimumScoringPlace: 1
  },
  {
    id: "s2",
    order: 2,
    level: 2,
    mode: "SR",
    mapKind: "official",
    displayName: "SR2",
    timeLimitMs: 200_000,
    scoring: [20],
    minimumScoringPlace: 1
  }
];

const scenario = (events: ScenarioDefinition["events"] = []): ScenarioDefinition => ({
  schemaVersion: 1,
  kind: "scripted-replay",
  id: "generation-safety",
  name: "Generation safety",
  year: 2026,
  timezone: "Asia/Shanghai",
  refereeConnectionId: "test-referee",
  players: [{ id: "p1", displayName: "Player 1", connectionId: "101" }],
  stages,
  events,
  expected: { attempts: 0, scoreboardVersions: 0 }
});

const harness = (): {
  manager: TestRuntimeManager;
  rawLogs: RawClientLogLine[];
  restoreManager: () => TestRuntimeManager;
} => {
  let payload: ServiceSnapshotPayload = {};
  let config: CompetitionConfig = {
    ...createDefaultCompetitionConfig("Test runtime manager"),
    flow: {
      ...createDefaultCompetitionConfig("Test runtime manager").flow,
      intermissionMs: 120_000
    },
    stages: stages.map((stage) => ({
      id: stage.id,
      order: stage.order,
      label: stage.displayName ?? stage.id,
      level: stage.level,
      mode: stage.mode,
      mapKind: stage.mapKind ?? "official",
      ...(stage.mapHash === undefined ? {} : { mapHash: stage.mapHash }),
      timeLimitMs: stage.timeLimitMs,
      scoring: [...stage.scoring],
      minimumScoringPlace: stage.minimumScoringPlace
    })),
    participants: []
  };
  const rawLogs: RawClientLogLine[] = [];
  const journal = new EventJournal();
  const host: TestRuntimeHost = {
    getCompetition: () => ({ id: competitionId, mode: "test", stateVersion: 1 }),
    getDraftConfig: () => config,
    upsertConfig: (_id, _version, _immutable, next) => { config = next; },
    getPayload: () => payload,
    savePayload: (_id, next) => { payload = next; },
    setActiveRun: (_id, runId) => { payload = { ...payload, activeRunId: runId }; },
    saveScoreboards: () => undefined,
    storedScoreboardVersions: () => [],
    appendRawLog: (_id, source, rawLine, occurredAt = new Date(0).toISOString()) => {
      rawLogs.push({ id: `raw-${rawLogs.length + 1}`, source, rawLine, occurredAt });
    },
    appendAttention: () => undefined,
    recordAutomationAttention: () => undefined,
    completeCompetitionOnReview: () => undefined,
    commandHistory: () => [],
    availableActionsFor: () => [],
    attentionItemsFor: () => [],
    scoreboardVersions: () => [] as CompetitionSnapshot["scoreboardVersions"],
    toScoreboardVersion: () => {
      throw new Error("scoreboard conversion is not used in this test");
    },
    journal
  };
  return {
    manager: new TestRuntimeManager(host),
    rawLogs,
    restoreManager: () => new TestRuntimeManager(host)
  };
};

const reachPendingGo = (
  manager: TestRuntimeManager,
  definition = scenario()
): ReturnType<TestRuntimeManager["getRuntime"]> => {
  const { runId } = manager.create(competitionId, definition);
  manager.startAutomation(competitionId, runId, 0);
  const runtime = manager.getRuntime(competitionId, runId);
  for (let elapsed = 0; elapsed < 60_000 && !runtime.pendingCountdown; elapsed += 1_000) {
    manager.advanceAutomation(competitionId, runId, 1_000);
  }
  expect(runtime.pendingCountdown).toMatchObject({
    action: { kind: "go", status: "pending", stageId: "s1" },
    emitted: 1
  });
  return runtime;
};

describe("TestRuntimeManager generation safety", () => {
  it.each(["restart", "start-protection"] as const)(
    "drops an old deferred Go after %s invalidates its action",
    (invalidation) => {
      const { manager, rawLogs } = harness();
      const runtime = reachPendingGo(manager);
      const oldGoId = runtime.pendingCountdown?.action.id;
      if (!oldGoId) throw new Error("missing deferred Go");
      const rawLogBoundary = rawLogs.length;

      if (invalidation === "restart") {
        const confirmation = runtime.automation.issueStageRestartConfirmation("s1");
        runtime.automation.confirmStageRestart({
          stageId: "s1",
          impactHash: confirmation.impactHash,
          token: confirmation.token,
          reason: "test restart"
        });
      } else {
        runtime.automation.observeConnection("p1", false);
      }
      expect(runtime.automation.snapshot().actions.find((action) => action.id === oldGoId)?.status).toBe("cancelled");

      manager.settle(runtime);
      manager.advanceAutomation(competitionId, runtime.id, 5_000);

      expect(runtime.pendingCountdown).toBeUndefined();
      expect(runtime.automation.snapshot().attempts).toEqual([]);
      expect(runtime.engine.snapshot().attempts).toEqual([]);
      expect(rawLogs.some((line) => /Level 01.* - 3$/.test(line.rawLine))).toBe(true);
      expect(rawLogs.slice(rawLogBoundary).some((line) => /Level 01.* - (?:2|1|Go!)$/.test(line.rawLine))).toBe(false);
    }
  );

  it("keeps a scripted finish after T-60 as raw evidence without changing controller or engine", () => {
    const { manager, rawLogs } = harness();
    const definition = scenario([
      { atMs: 40_000, sourceId: "exclude-p1", type: "exclude", stageId: "s1", playerId: "p1", reason: "warning" },
      { atMs: 102_000, sourceId: "late-finish-p1", type: "finish", stageId: "s1", playerId: "p1", score: 100, elapsedMs: 70_000 }
    ]);
    const runtime = reachPendingGo(manager, definition);
    manager.advanceAutomation(competitionId, runtime.id, 3_000);
    expect(runtime.automation.snapshot().attempts).toHaveLength(1);
    expect(runtime.engine.snapshot().attempts).toHaveLength(1);

    manager.advance(competitionId, runtime.id, true);
    const controllerAttempt = runtime.automation.snapshot().attempts.find((attempt) => attempt.stageId === "s1");
    const engineResult = runtime.engine.snapshot().currentScoreboard
      .find((entry) => entry.playerId === "p1")?.stages["s1"];

    expect(runtime.automation.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      rejectedResults: [expect.objectContaining({ sourceId: "late-finish-p1", reason: "intake-closed" })]
    });
    expect(controllerAttempt?.results).toEqual([
      expect.objectContaining({ playerId: "p1", status: "excluded", sourceId: "exclude-p1" })
    ]);
    expect(controllerAttempt?.results[0]?.finishSourceId).toBeUndefined();
    expect(engineResult).toMatchObject({ status: "excluded", sourceId: "exclude-p1" });
    expect(engineResult?.finishSourceId).toBeUndefined();
    expect(runtime.engine.snapshot().anomalies.some((anomaly) => anomaly.sourceId === "late-finish-p1")).toBe(false);
    expect(rawLogs.some((line) => line.rawLine.includes("finished Level 01"))).toBe(true);
  });

  it("restores the exact referee-rescheduled T-60 boundary and engine state from a persisted test snapshot", () => {
    const { manager, restoreManager } = harness();
    const runtime = reachPendingGo(manager);
    manager.advanceAutomation(competitionId, runtime.id, 3_000);
    const attempt = runtime.automation.snapshot().attempts.findLast((candidate) =>
      candidate.stageId === "s1" && candidate.intakeOpen && !candidate.voided);
    if (!attempt) throw new Error("missing running attempt");

    const receivedAtMs = runtime.automationClock.now();
    expect(runtime.automation.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "persisted-threshold-finish",
      receivedAtMs
    })).toBe("accepted");
    runtime.engine.apply({
      atMs: receivedAtMs,
      sourceId: "persisted-threshold-finish",
      type: "finish",
      stageId: "s1",
      playerId: "p1",
      score: 100,
      elapsedMs: 3_000
    });
    manager.settle(runtime);

    const originalPlan = runtime.automation.snapshot().plannedReadyAtMs;
    if (originalPlan === undefined) throw new Error("missing next-stage Ready plan");
    const rescheduledReadyAtMs = originalPlan + 45_000;
    runtime.automation.reschedule(rescheduledReadyAtMs);
    manager.settle(runtime);
    manager.persist(runtime);

    const restoredManager = restoreManager();
    const restored = restoredManager.getRuntime(competitionId, runtime.id);
    expect(restored.automation.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "tail-intake",
      currentStageId: "s1",
      plannedReadyStageId: "s2",
      plannedReadyAtMs: rescheduledReadyAtMs,
      attempts: [{
        id: attempt.id,
        stageId: "s1",
        intakeOpen: true,
        results: [expect.objectContaining({ sourceId: "persisted-threshold-finish" })]
      }]
    });
    expect(restored.engine.snapshot()).toMatchObject({
      attempts: [{ stageId: "s1", open: true }],
      currentScoreboard: [
        expect.objectContaining({
          playerId: "p1",
          stages: { s1: expect.objectContaining({ sourceId: "persisted-threshold-finish" }) }
        })
      ]
    });

    const boundaryAtMs = rescheduledReadyAtMs - 60_000;
    restoredManager.advanceAutomation(competitionId, restored.id, boundaryAtMs - restored.automationClock.now());
    expect(restored.automation.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "paused",
      pausedFromPhase: "preparing",
      attempts: [{ id: attempt.id, intakeOpen: false, intakeClosedAtMs: boundaryAtMs }]
    });
    expect(restored.engine.snapshot().attempts).toContainEqual(expect.objectContaining({
      stageId: "s1",
      open: false
    }));
  });
});
