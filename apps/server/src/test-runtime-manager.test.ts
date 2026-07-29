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
  getConfig: () => CompetitionConfig;
  setParticipantStageStatus: (status: "waiting" | "running" | "finished" | "dnf") => void;
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
    restoreManager: () => new TestRuntimeManager(host),
    getConfig: () => config,
    setParticipantStageStatus: (status) => {
      config = {
        ...config,
        participants: config.participants.map((participant) => ({
          ...participant,
          currentStageStatus: status
        }))
      };
    }
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

  it("does not attribute a delayed old-cycle finish to a restarted authoritative attempt", () => {
    const { manager, rawLogs } = harness();
    const runtime = reachPendingGo(manager, scenario([
      { atMs: 34_000, sourceId: "old-cycle-late-finish", type: "finish", stageId: "s1", playerId: "p1", score: 999, elapsedMs: 1_000 }
    ]));
    manager.advanceAutomation(competitionId, runtime.id, 3_000);
    const firstAttempt = runtime.automation.snapshot().attempts.findLast((attempt) => !attempt.voided);
    if (!firstAttempt) throw new Error("missing first attempt");
    const confirmation = runtime.automation.issueStageRestartConfirmation("s1");
    manager.restartCurrentStage(runtime, {
      stageId: "s1",
      impactHash: confirmation.impactHash,
      token: confirmation.token,
      reason: "test delayed evidence",
      sourceId: "restart-for-delayed-evidence"
    });
    manager.advanceAutomation(competitionId, runtime.id, 33_000);
    const secondAttempt = runtime.automation.snapshot().attempts.findLast((attempt) => !attempt.voided);
    if (!secondAttempt) throw new Error("missing second attempt");
    expect(secondAttempt.goAtMs).toBeGreaterThan(34_000);
    const rawLogBoundary = rawLogs.length;

    manager.advance(competitionId, runtime.id, true);

    expect(runtime.automation.snapshot().attempts.find((attempt) => attempt.id === firstAttempt.id)?.voided).toBe(true);
    expect(runtime.automation.snapshot().attempts.find((attempt) => attempt.id === secondAttempt.id)?.results).toEqual([]);
    expect(runtime.engine.snapshot().currentScoreboard.every((entry) => entry.stages.s1 === undefined)).toBe(true);
    expect(rawLogs.slice(rawLogBoundary)).toContainEqual(expect.objectContaining({
      rawLine: expect.stringContaining("finished Level 01")
    }));
  });

  it("persists referee-marked attempts, filters pre-mark evidence, resets scoring, and advances the T-60 boundary", () => {
    const { manager, rawLogs, restoreManager, getConfig, setParticipantStageStatus } = harness();
    const definition = scenario([
      { atMs: 1_000, sourceId: "pre-mark-warning", type: "warning", playerId: "p1", message: "old warning" },
      { atMs: 2_000, sourceId: "pre-mark-cheat", type: "cheat", playerId: "p1", enabled: true },
      { atMs: 3_000, sourceId: "pre-mark-finish", type: "finish", stageId: "s1", playerId: "p1", score: 100, elapsedMs: 3_000 },
      { atMs: 4_000, sourceId: "pre-mark-dnf", type: "dnf", stageId: "s1", playerId: "p1", reason: "old dnf" }
    ]);
    const { runId } = manager.create(competitionId, definition);
    manager.startAutomation(competitionId, runId, 10_000);
    manager.advanceAutomation(competitionId, runId, 10_000);
    const runtime = manager.getRuntime(competitionId, runId);
    expect(runtime.automation.snapshot().phase).toBe("ready");

    const marked = manager.markCurrentReadyStageStarted(runtime, "s1");
    expect(marked).toMatchObject({
      stageId: "s1",
      attemptNumber: 1,
      origin: "referee-marked-started",
      goAtMs: 10_000,
      deadlineAtMs: 210_000,
      intakeOpen: true,
      voided: false
    });
    expect(runtime.automation.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "running",
      automationEnabled: false
    });
    expect(runtime.engine.snapshot().attempts).toContainEqual(expect.objectContaining({
      id: marked.id,
      stageId: "s1",
      attemptNumber: 1,
      origin: "referee-marked-started",
      goAtMs: 10_000,
      deadlineAtMs: 210_000,
      open: true,
      voided: false
    }));

    const rawLogBoundary = rawLogs.length;
    manager.advance(competitionId, runId, true);
    expect(runtime.automation.snapshot().attempts[0]?.results).toEqual([]);
    expect(runtime.engine.snapshot().currentScoreboard.every((entry) => Object.keys(entry.stages).length === 0)).toBe(true);
    expect(runtime.engine.snapshot().anomalies).toEqual([]);
    expect(rawLogs.slice(rawLogBoundary)).toHaveLength(4);

    const receivedAtMs = runtime.automationClock.now();
    expect(runtime.automation.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "post-mark-finish",
      receivedAtMs
    })).toBe("accepted");
    runtime.engine.apply({
      atMs: receivedAtMs,
      sourceId: "post-mark-finish",
      type: "finish",
      stageId: "s1",
      playerId: "p1",
      score: 120,
      elapsedMs: 1_000
    });
    manager.settle(runtime);
    setParticipantStageStatus("finished");

    const reset = manager.forceResetCurrentStage(runtime, "force-reset-test", "s1");
    expect(reset).toMatchObject({
      stageId: "s1",
      voidedAttempts: [expect.objectContaining({ id: marked.id, voided: true })]
    });
    expect(runtime.automation.snapshot()).toMatchObject({
      currentStageId: "s1",
      phase: "preparing",
      plannedReadyStageId: "s1",
      plannedReadyAtMs: 70_000,
      attempts: [expect.objectContaining({ id: marked.id, voided: true, intakeOpen: false })]
    });
    expect(runtime.engine.snapshot().attempts).toContainEqual(expect.objectContaining({
      id: marked.id,
      voided: true,
      open: false
    }));
    expect(runtime.engine.snapshot().currentScoreboard.every((entry) => entry.stages.s1 === undefined)).toBe(true);
    expect(getConfig().participants.every((participant) => participant.currentStageStatus === "waiting")).toBe(true);

    manager.advanceAutomation(competitionId, runId, 60_000);
    const secondMarked = manager.markCurrentReadyStageStarted(runtime, "s1");
    expect(secondMarked).toMatchObject({
      stageId: "s1",
      attemptNumber: 2,
      origin: "referee-marked-started",
      goAtMs: 70_000,
      deadlineAtMs: 270_000
    });
    const secondReceivedAtMs = runtime.automationClock.now();
    expect(runtime.automation.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "retained-finish",
      receivedAtMs: secondReceivedAtMs
    })).toBe("accepted");
    runtime.engine.apply({
      atMs: secondReceivedAtMs,
      sourceId: "retained-finish",
      type: "finish",
      stageId: "s1",
      playerId: "p1",
      score: 130,
      elapsedMs: 1_000
    });
    manager.settle(runtime);
    setParticipantStageStatus("finished");

    const advanced = manager.forceAdvanceToNextStage(runtime, "s1", "s2");
    expect(advanced).toMatchObject({
      fromStageId: "s1",
      toStageId: "s2",
      closedAttempt: expect.objectContaining({ id: secondMarked.id, voided: false })
    });
    expect(runtime.automation.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      plannedReadyStageId: "s2",
      plannedReadyAtMs: 130_000,
      attempts: [
        expect.objectContaining({ id: marked.id, voided: true }),
        expect.objectContaining({ id: secondMarked.id, voided: false, intakeOpen: false })
      ]
    });
    expect(runtime.engine.snapshot().currentScoreboard).toContainEqual(expect.objectContaining({
      playerId: "p1",
      stages: { s1: expect.objectContaining({ sourceId: "retained-finish" }) }
    }));
    expect(getConfig().participants.every((participant) => participant.currentStageStatus === "waiting")).toBe(true);

    manager.persist(runtime);
    const restored = restoreManager().getRuntime(competitionId, runId);
    expect(restored.automation.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "paused",
      pausedFromPhase: "preparing",
      plannedReadyStageId: "s2",
      plannedReadyAtMs: 130_000,
      attempts: [
        expect.objectContaining({ id: marked.id, origin: "referee-marked-started", voided: true }),
        expect.objectContaining({ id: secondMarked.id, origin: "referee-marked-started", voided: false, intakeOpen: false })
      ]
    });
    expect(restored.engine.snapshot()).toMatchObject({
      attempts: [
        expect.objectContaining({ id: marked.id, origin: "referee-marked-started", voided: true }),
        expect.objectContaining({ id: secondMarked.id, origin: "referee-marked-started", voided: false, open: false })
      ],
      currentScoreboard: [
        expect.objectContaining({
          playerId: "p1",
          stages: { s1: expect.objectContaining({ sourceId: "retained-finish" }) }
        })
      ]
    });
  });
});
