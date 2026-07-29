import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  assertScenarioDefinition,
  minimumScoringPlaceFor,
  type ActionAvailability,
  type AttentionItem,
  type CommandRecordView,
  type CompetitionConfig,
  type CompetitionSnapshot,
  type ScenarioDefinition,
  type ScenarioEvent,
  type TestRunSnapshot,
  type TestScenarioSummary
} from "@ballance/contracts";
import {
  CompetitionController,
  CompetitionEngine,
  type AutomationAction,
  type AutomationSnapshot,
  type CompetitionControllerCheckpoint,
  type EngineSnapshot,
  type ScoreboardVersion
} from "@ballance/core";
import { ScenarioRunner, VirtualClock } from "@ballance/testkit";
import { TestAutomationRuntime } from "./automation-runtime.js";
import type { EventJournal } from "./event-journal.js";
import {
  automationPolicyFor,
  automationView,
  plannedReadyAt,
  plannedStageStartAt,
  scenarioSummary,
  scoreEntries,
  scoreboardView,
  seededBehaviorRandom,
  stageDeadlineAt,
  utcOffsetMinutes
} from "./runtime-shared.js";
import type {
  PendingTestCountdown,
  PersistedTestOperation,
  PersistedTestRun,
  ScheduledTestRecovery,
  ServiceSnapshotPayload
} from "./runtime-types.js";
import { ServiceError } from "./service-error.js";
import { loadScenarioDefinitions } from "./test-scenarios.js";

export interface TestRuntime {
  id: string;
  competitionId: string;
  definition: ScenarioDefinition;
  runner: ScenarioRunner;
  engine: CompetitionEngine;
  automationClock: VirtualClock;
  automation: CompetitionController;
  automationRuntime: TestAutomationRuntime;
  playedEvents: number;
  operations: PersistedTestOperation[];
  clockAdvanceCanCoalesce: boolean;
  pendingCountdown?: PendingTestCountdown;
  appliedFaultIds: Set<string>;
  stageFinishOrdinals: Map<string, number>;
  phaseStartedAt: Map<string, number>;
  recoveries: ScheduledTestRecovery[];
  createdAt: string;
  updatedAt: string;
}

export interface TestStageRecoveryCheckpoint {
  controller: CompetitionControllerCheckpoint;
  engine: EngineSnapshot;
  clockAdvanceCanCoalesce: boolean;
  pendingCountdown?: PendingTestCountdown;
  appliedFaultIds: ReadonlySet<string>;
  stageFinishOrdinals: ReadonlyMap<string, number>;
  phaseStartedAt: ReadonlyMap<string, number>;
  recoveries: readonly ScheduledTestRecovery[];
  updatedAt: string;
}

interface RealtimeTestTimer {
  handle: ReturnType<typeof setInterval>;
  lastWallAtMs: number;
}

export interface TestRuntimeHost {
  getCompetition(competitionId: string): { id: string; mode: "work" | "test"; stateVersion: number };
  getDraftConfig(competitionId: string): CompetitionConfig;
  upsertConfig(competitionId: string, version: number, immutable: boolean, config: CompetitionConfig): void;
  getPayload(competitionId: string): ServiceSnapshotPayload;
  savePayload(competitionId: string, payload: ServiceSnapshotPayload): void;
  setActiveRun(competitionId: string, runId: string): void;
  saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void;
  storedScoreboardVersions(competitionId: string): CompetitionSnapshot["scoreboardVersions"];
  appendRawLog(competitionId: string, source: "test-player" | "test-referee", line: string, occurredAt?: string): void;
  appendAttention(competitionId: string, item: AttentionItem): void;
  recordAutomationAttention(competitionId: string, action: AutomationAction): void;
  completeCompetitionOnReview(competitionId: string, snapshot: AutomationSnapshot): void;
  commandHistory(competitionId: string): CommandRecordView[];
  availableActionsFor(competitionId: string, snapshot?: AutomationSnapshot): ActionAvailability[];
  attentionItemsFor(competitionId: string, snapshot?: AutomationSnapshot): AttentionItem[];
  scoreboardVersions(competitionId: string): CompetitionSnapshot["scoreboardVersions"];
  toScoreboardVersion(competitionId: string, view: CompetitionSnapshot["scoreboardVersions"][number]): ScoreboardVersion;
  journal: EventJournal;
}

export class TestRuntimeManager {
  private readonly runtimes = new Map<string, TestRuntime>();
  private readonly realtimeTimers = new Map<string, RealtimeTestTimer>();

  public constructor(private readonly host: TestRuntimeHost) {}

  public listScenarios(): readonly TestScenarioSummary[] {
    return loadScenarioDefinitions().filter((definition) => definition.kind === "player-behavior").map(scenarioSummary);
  }

  public getScenario(id: string): ScenarioDefinition {
    const scenario = loadScenarioDefinitions().find((candidate) => candidate.id === id);
    if (!scenario) throw new ServiceError("NOT_FOUND", "测试场景不存在", 404);
    return scenario;
  }

  public createFromScenario(competitionId: string, scenarioId: string): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    return this.create(competitionId, this.getScenario(scenarioId));
  }

  public create(competitionId: string, input: unknown): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    const competition = this.host.getCompetition(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const parsedDefinition = assertScenarioDefinition(input);
    const definition = parsedDefinition.kind === "player-behavior"
      ? this.materializeBehaviorScenario(competitionId, parsedDefinition)
      : parsedDefinition;
    const runtime = this.makeRuntime(competitionId, definition);
    this.runtimes.set(runtime.id, runtime);
    this.connectPlayers(runtime, true);
    const config = this.host.getDraftConfig(competitionId);
    const primaryScoring = definition.stages[0]?.scoring ?? config.scoring.points;
    const contestType = this.scoringContestType(primaryScoring);
    this.host.upsertConfig(competitionId, 0, false, {
      ...config,
      contestType,
      scoring: {
        ...config.scoring,
        contestType,
        points: [...primaryScoring],
        minimumScoringPlace: minimumScoringPlaceFor(primaryScoring)
      },
      stages: definition.stages.map((stage) => {
        const mapKind = stage.mapKind === "custom" ? "custom" as const : "official" as const;
        return {
          id: stage.id,
          order: stage.order,
          label: mapKind === "custom" ? stage.displayName?.trim() || stage.id : `${stage.mode}${stage.level}`,
          level: mapKind === "custom" ? 0 : stage.level,
          mode: stage.mode,
          mapKind,
          ...(mapKind === "custom" ? { mapHash: stage.mapHash?.trim().toLowerCase() ?? "" } : {}),
          timeLimitMs: stage.timeLimitMs,
          scoring: [...stage.scoring],
          minimumScoringPlace: minimumScoringPlaceFor(stage.scoring)
        };
      }),
      participants: config.participants.length === 0
        ? definition.players.map((player) => ({
          id: player.id,
          displayName: player.displayName,
          role: "participant",
          connectionIds: [player.connectionId],
          online: true,
          currentStageStatus: "waiting"
        }))
        : config.participants
    });
    this.persistRuntime(runtime, true);
    this.host.journal.append({ type: "test-run.created", competitionId, stateVersion: competition.stateVersion, data: { runId: runtime.id, scenarioId: definition.id } });
    return { runId: runtime.id, snapshot: runtime.engine.snapshot(), run: this.snapshot(competitionId, runtime.id) };
  }

  public advance(competitionId: string, runId: string, all: boolean): EngineSnapshot {
    const runtime = this.getRuntime(competitionId, runId);
    const events = all ? runtime.runner.playAll() : [runtime.runner.next()].filter((event): event is ScenarioEvent => event !== undefined);
    for (const event of events) this.applyTestEvent(runtime, event, true);
    this.persistRuntime(runtime);
    const snapshot = runtime.engine.snapshot();
    this.host.saveScoreboards(competitionId, snapshot.scoreboardVersions);
    this.host.journal.append({ type: "scoreboard.snapshot", competitionId, data: snapshot });
    return snapshot;
  }

  public actPlayers(competitionId: string, runId: string): TestRunSnapshot {
    const runtime = this.getRuntime(competitionId, runId);
    this.connectPlayers(runtime, true);
    this.drivePlayers(runtime);
    this.persistRuntime(runtime);
    this.host.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.host.journal.append({ type: "test-run.players-acted", competitionId, data: { runId } });
    return this.snapshot(competitionId, runId);
  }

  public setStartProtectionUsed(competitionId: string, used: boolean): void {
    const runId = this.host.getPayload(competitionId).activeRunId;
    if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
    const runtime = this.getRuntime(competitionId, runId);
    runtime.automation.setStartProtectionUsed(used);
    runtime.operations.push({ kind: "start-protection", used });
    this.persistRuntime(runtime);
  }

  public reset(competitionId: string, runId: string): EngineSnapshot {
    this.stopRealtime(runId);
    const runtime = this.getRuntime(competitionId, runId);
    const reset = this.makeRuntime(competitionId, runtime.definition, runtime.id, runtime.createdAt);
    this.connectPlayers(reset, true);
    this.runtimes.set(runId, reset);
    this.persistRuntime(reset);
    const payload = this.host.getPayload(competitionId);
    this.host.savePayload(competitionId, { ...payload, scoreboardRevisions: [] });
    this.host.journal.append({ type: "test-run.reset", competitionId, data: { runId } });
    return reset.engine.snapshot();
  }

  public startAutomation(competitionId: string, runId: string, readyInMs = 0): AutomationSnapshot {
    const runtime = this.getRuntime(competitionId, runId);
    runtime.automation.enable(runtime.automationClock.now() + readyInMs);
    runtime.operations.push({ kind: "automation-start", readyInMs });
    this.settleAutomation(runtime);
    this.persistRuntime(runtime);
    const snapshot = runtime.automation.snapshot();
    this.host.journal.append({ type: "test-run.automation-started", competitionId, data: snapshot });
    return snapshot;
  }

  public advanceAutomation(competitionId: string, runId: string, milliseconds: number): AutomationSnapshot {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new ServiceError("VALIDATION_FAILED", "推进时间必须是非负数", 400);
    const runtime = this.getRuntime(competitionId, runId);
    runtime.operations.push({ kind: "advance-clock", milliseconds });
    runtime.clockAdvanceCanCoalesce = false;
    this.advanceClock(runtime, milliseconds);
    const snapshot = runtime.automation.snapshot();
    this.host.completeCompetitionOnReview(competitionId, snapshot);
    this.persistRuntime(runtime);
    this.host.journal.append({ type: "test-run.clock-advanced", competitionId, data: { runId, milliseconds, snapshot } });
    return snapshot;
  }

  public automationSnapshot(competitionId: string, runId: string): AutomationSnapshot {
    return this.getRuntime(competitionId, runId).automation.snapshot();
  }

  public snapshot(competitionId: string, runId: string): TestRunSnapshot {
    const runtime = this.getRuntime(competitionId, runId);
    const engine = runtime.engine.snapshot();
    const automation = runtime.automation.snapshot();
    const epochOriginMs = Date.parse(runtime.createdAt);
    return {
      runId,
      scenario: scenarioSummary(runtime.definition),
      nextEventIndex: runtime.playedEvents,
      totalEvents: runtime.definition.events.length,
      engine: {
        attempts: engine.attempts,
        scoreboardVersions: engine.scoreboardVersions.map(scoreboardView),
        anomalies: engine.anomalies,
        currentScoreboard: scoreEntries(engine.currentScoreboard)
      },
      automation: automationView("test", automation, [
        ...this.host.commandHistory(competitionId),
        ...automation.actions.map((action) => ({
          id: action.id,
          actionType: action.kind,
          status: "simulated" as const,
          createdAt: new Date(epochOriginMs + action.createdAtMs).toISOString(),
          updatedAt: new Date(epochOriginMs + action.createdAtMs).toISOString(),
          command: action.message ?? action.kind,
          responseLine: "模拟回显成功",
          simulated: true
        }))
      ], plannedStageStartAt(automation, epochOriginMs), plannedReadyAt(automation, epochOriginMs), runtime.automationClock.now(),
      this.host.availableActionsFor(competitionId, automation), this.host.attentionItemsFor(competitionId, automation), stageDeadlineAt(automation, epochOriginMs))
    };
  }

  public scoreboardVersion(competitionId: string, runId: string, version?: number): {
    competition: ReturnType<TestRuntimeHost["getCompetition"]>;
    definition: ScenarioDefinition;
    scoreboard: ScoreboardVersion;
    automation: AutomationSnapshot;
  } {
    const runtime = this.getRuntime(competitionId, runId);
    const versions = this.host.scoreboardVersions(competitionId);
    const selected = version === undefined ? versions.at(-1) : versions.find((candidate) => candidate.version === version);
    if (!selected) throw new ServiceError("NOT_FOUND", "榜单版本不存在", 404);
    return {
      competition: this.host.getCompetition(competitionId),
      definition: runtime.definition,
      scoreboard: this.host.toScoreboardVersion(competitionId, selected),
      automation: runtime.automation.snapshot()
    };
  }

  public getRuntime(competitionId: string, runId: string): TestRuntime {
    const competition = this.host.getCompetition(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const existing = this.runtimes.get(runId);
    if (existing?.competitionId === competitionId) return existing;
    const persisted = this.host.getPayload(competitionId).testRuns?.find((candidate) => candidate.id === runId);
    if (!persisted) throw new ServiceError("NOT_FOUND", "测试运行不存在", 404);
    const restored = this.restoreRuntime(competitionId, persisted);
    this.runtimes.set(runId, restored);
    return restored;
  }

  public activeRuntime(competitionId: string): TestRuntime | undefined {
    const runId = this.host.getPayload(competitionId).activeRunId;
    return runId ? this.getRuntime(competitionId, runId) : undefined;
  }

  public settle(runtime: TestRuntime): void { this.settleAutomation(runtime); }

  public persist(runtime: TestRuntime): void { this.persistRuntime(runtime); }

  public checkpointStageRecovery(runtime: TestRuntime): TestStageRecoveryCheckpoint {
    return {
      controller: runtime.automation.checkpoint(),
      engine: runtime.engine.snapshot(),
      clockAdvanceCanCoalesce: runtime.clockAdvanceCanCoalesce,
      ...(runtime.pendingCountdown === undefined
        ? {}
        : { pendingCountdown: {
            action: { ...runtime.pendingCountdown.action },
            emitted: runtime.pendingCountdown.emitted
          } }),
      appliedFaultIds: new Set(runtime.appliedFaultIds),
      stageFinishOrdinals: new Map(runtime.stageFinishOrdinals),
      phaseStartedAt: new Map(runtime.phaseStartedAt),
      recoveries: runtime.recoveries.map((recovery) => ({ ...recovery })),
      updatedAt: runtime.updatedAt
    };
  }

  public restoreStageRecovery(runtime: TestRuntime, checkpoint: TestStageRecoveryCheckpoint): void {
    runtime.automation.restore(checkpoint.controller);
    runtime.engine.restore(checkpoint.engine);
    runtime.clockAdvanceCanCoalesce = checkpoint.clockAdvanceCanCoalesce;
    if (checkpoint.pendingCountdown === undefined) delete runtime.pendingCountdown;
    else {
      runtime.pendingCountdown = {
        action: { ...checkpoint.pendingCountdown.action },
        emitted: checkpoint.pendingCountdown.emitted
      };
    }
    runtime.appliedFaultIds = new Set(checkpoint.appliedFaultIds);
    runtime.stageFinishOrdinals = new Map(checkpoint.stageFinishOrdinals);
    runtime.phaseStartedAt = new Map(checkpoint.phaseStartedAt);
    runtime.recoveries = checkpoint.recoveries.map((recovery) => ({ ...recovery }));
    runtime.updatedAt = checkpoint.updatedAt;
  }

  public markCurrentReadyStageStarted(runtime: TestRuntime, expectedStageId: string): AutomationSnapshot["attempts"][number] {
    const before = runtime.automation.snapshot();
    const attempt = this.runExpectedStageAction(() => runtime.automation.markCurrentReadyStageStarted({
      expectedCurrentStageId: expectedStageId
    }));
    this.resetStageCycleAuxiliary(runtime, before.currentStageId);
    runtime.engine.startRefereeMarkedAttempt({
      id: attempt.id,
      stageId: attempt.stageId,
      attemptNumber: attempt.attemptNumber,
      goAtMs: attempt.goAtMs,
      deadlineAtMs: attempt.deadlineAtMs,
      sourceId: `referee-marked-started:${attempt.id}`
    });
    this.settleAutomation(runtime);
    this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.persistRuntime(runtime);
    this.host.journal.append({
      type: "test-run.stage-marked-started",
      competitionId: runtime.competitionId,
      data: {
        runId: runtime.id,
        stageId: attempt.stageId,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        goAtMs: attempt.goAtMs,
        deadlineAtMs: attempt.deadlineAtMs
      }
    });
    return attempt;
  }

  public forceResetCurrentStage(runtime: TestRuntime, sourceId: string, expectedStageId: string): {
    stageId: string;
    voidedAttempts: readonly AutomationSnapshot["attempts"][number][];
  } {
    const before = runtime.automation.snapshot();
    const stageId = before.currentStageId;
    const result = this.runExpectedStageAction(() => runtime.automation.forceResetCurrentStage({
      expectedCurrentStageId: expectedStageId
    }));
    this.resetStageCycleAuxiliary(runtime, stageId);
    this.resetParticipantStageStatuses(runtime, stageId);
    for (const controlledAttempt of result.voidedAttempts) {
      const engineAttempt = runtime.engine.snapshot().attempts.find((attempt) =>
        attempt.stageId === controlledAttempt.stageId
        && attempt.attemptNumber === controlledAttempt.attemptNumber
        && !attempt.voided);
      if (engineAttempt) runtime.engine.voidAttempt(controlledAttempt.stageId, controlledAttempt.attemptNumber, sourceId);
    }
    this.settleAutomation(runtime);
    this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.persistRuntime(runtime);
    this.host.journal.append({
      type: "test-run.stage-force-reset",
      competitionId: runtime.competitionId,
      data: {
        runId: runtime.id,
        stageId,
        attemptIds: result.voidedAttempts.map((attempt) => attempt.id),
        attemptNumbers: result.voidedAttempts.map((attempt) => attempt.attemptNumber)
      }
    });
    return {
      stageId,
      voidedAttempts: result.voidedAttempts
    };
  }

  public forceAdvanceToNextStage(
    runtime: TestRuntime,
    expectedCurrentStageId: string,
    expectedTargetStageId: string
  ): {
    fromStageId: string;
    toStageId: string;
    closedAttempt?: AutomationSnapshot["attempts"][number];
  } {
    const before = runtime.automation.snapshot();
    const fromStageId = before.currentStageId;
    const controlledAttempt = before.attempts.findLast((attempt) =>
      attempt.stageId === fromStageId && !attempt.voided);
    const result = this.runExpectedStageAction(() => runtime.automation.forceAdvanceToNextStage({
      expectedCurrentStageId,
      expectedTargetStageId
    }));
    delete runtime.pendingCountdown;
    const after = runtime.automation.snapshot();
    if (result.previousStageId !== fromStageId || result.targetStageId !== after.currentStageId) {
      throw new ServiceError("STATE_CONFLICT", "强制进入下一关后关卡边界未推进", 409);
    }
    this.resetStageCycleAuxiliary(runtime, after.currentStageId);
    this.resetParticipantStageStatuses(runtime, after.currentStageId);
    this.mirrorClosedAttempts(runtime);
    this.settleAutomation(runtime);
    this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.persistRuntime(runtime);
    this.host.journal.append({
      type: "test-run.stage-force-next",
      competitionId: runtime.competitionId,
      data: {
        runId: runtime.id,
        fromStageId,
        toStageId: after.currentStageId,
        ...(controlledAttempt === undefined ? {} : {
          attemptId: controlledAttempt.id,
          attemptNumber: controlledAttempt.attemptNumber
        })
      }
    });
    return {
      fromStageId,
      toStageId: after.currentStageId,
      ...(controlledAttempt === undefined ? {} : { closedAttempt: controlledAttempt })
    };
  }

  public restartCurrentStage(
    runtime: TestRuntime,
    input: { stageId: string; impactHash: string; token: string; reason: string; sourceId: string }
  ): AutomationSnapshot["attempts"][number] | undefined {
    const before = runtime.automation.snapshot();
    const controlledAttempt = before.attempts.findLast((attempt) =>
      attempt.stageId === input.stageId && !attempt.voided);
    runtime.automation.confirmStageRestart({
      stageId: input.stageId,
      impactHash: input.impactHash,
      token: input.token,
      reason: input.reason
    });
    this.resetStageCycleAuxiliary(runtime, input.stageId);
    this.resetParticipantStageStatuses(runtime, input.stageId);
    if (controlledAttempt) {
      const engineAttempt = runtime.engine.snapshot().attempts.find((attempt) =>
        attempt.stageId === controlledAttempt.stageId
        && attempt.attemptNumber === controlledAttempt.attemptNumber
        && !attempt.voided);
      if (engineAttempt) runtime.engine.voidAttempt(controlledAttempt.stageId, controlledAttempt.attemptNumber, input.sourceId);
    }
    this.settleAutomation(runtime);
    this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.persistRuntime(runtime);
    return controlledAttempt;
  }

  public recordManualNotification(competitionId: string, channel: "bulletin" | "notice" | "announce", text: string): void {
    const runtime = this.activeRuntime(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
    const snapshot = runtime.automation.snapshot();
    const automationAction: AutomationAction = {
      id: randomUUID(), kind: channel, idempotencyKey: `manual-notification:${randomUUID()}`,
      createdAtMs: runtime.automationClock.now(), stageId: snapshot.currentStageId,
      map: String(runtime.definition.stages.find((stage) => stage.id === snapshot.currentStageId)?.level ?? 0),
      mode: (runtime.definition.stages.find((stage) => stage.id === snapshot.currentStageId)?.mode.toLowerCase() ?? "sr") as "sr" | "hs",
      message: text, status: "acknowledged"
    };
    for (const line of this.testAutomationActionLogLines(runtime, automationAction)) {
      this.host.appendRawLog(competitionId, "test-referee", line, this.testOccurredAt(runtime, automationAction.createdAtMs));
    }
    this.host.recordAutomationAttention(competitionId, automationAction);
  }

  public startRealtime(runtime: TestRuntime): void {
    if (this.realtimeTimers.has(runtime.id)) return;
    const timer: RealtimeTestTimer = {
      lastWallAtMs: performance.now(),
      handle: setInterval(() => this.tickRealtime(runtime.id), 500)
    };
    timer.handle.unref?.();
    this.realtimeTimers.set(runtime.id, timer);
  }

  public stopRealtime(runId: string): void {
    const timer = this.realtimeTimers.get(runId);
    if (!timer) return;
    clearInterval(timer.handle);
    this.realtimeTimers.delete(runId);
  }

  public removeCompetition(competitionId: string): void {
    for (const [runId, runtime] of this.runtimes) {
      if (runtime.competitionId !== competitionId) continue;
      this.stopRealtime(runId);
      this.runtimes.delete(runId);
    }
  }

  public close(): void {
    for (const runId of this.realtimeTimers.keys()) this.stopRealtime(runId);
  }

  private makeRuntime(
    competitionId: string,
    definition: ScenarioDefinition,
    id: string = randomUUID(),
    createdAt: string = new Date().toISOString(),
    persisted?: Pick<
      PersistedTestRun,
      "automation" | "engine" | "pendingCountdown" | "appliedFaultIds" | "stageFinishOrdinals" | "phaseStartedAt" | "recoveries"
    >
  ): TestRuntime {
    const config = this.host.getDraftConfig(competitionId);
    const automationClock = new VirtualClock(persisted?.automation?.clockNowMs ?? 0);
    const automation = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      stages: definition.stages.map((stage) => ({
        id: stage.id,
        map: stage.mapKind === "custom" && stage.mapHash ? `${stage.mapHash.toLowerCase()} 0` : `level ${stage.level}`,
        ...(stage.displayName === undefined ? {} : { displayName: stage.displayName }),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      policy: automationPolicyFor(config),
      wallClockOriginMs: Date.parse(createdAt),
      ...(persisted?.automation === undefined
        ? {}
        : { initialSnapshot: persisted.automation, restoreParticipantState: true })
    }, automationClock);
    const engine = new CompetitionEngine(definition);
    if (persisted?.engine) engine.restore(persisted.engine);
    const runtime: TestRuntime = {
      id, competitionId, definition,
      runner: new ScenarioRunner(definition),
      engine,
      automationClock,
      automation,
      automationRuntime: new TestAutomationRuntime(automation),
      playedEvents: 0,
      operations: [],
      clockAdvanceCanCoalesce: false,
      ...(persisted?.pendingCountdown === undefined
        ? {}
        : { pendingCountdown: { action: { ...persisted.pendingCountdown.action }, emitted: persisted.pendingCountdown.emitted } }),
      appliedFaultIds: new Set(persisted?.appliedFaultIds ?? []),
      stageFinishOrdinals: new Map(Object.entries(persisted?.stageFinishOrdinals ?? {})),
      phaseStartedAt: new Map(Object.entries(persisted?.phaseStartedAt ?? {})),
      recoveries: (persisted?.recoveries ?? []).map((recovery) => ({ ...recovery })),
      createdAt,
      updatedAt: createdAt
    };
    return runtime;
  }

  private scoringContestType(points: readonly number[]): CompetitionConfig["contestType"] {
    if (points.length === 12 && points.every((point, index) => point === [20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 1][index])) return "small";
    if (points.length === 15 && points.every((point, index) => point === [30, 24, 21, 18, 16, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1][index])) return "large";
    return "custom";
  }

  private restoreRuntime(competitionId: string, persisted: PersistedTestRun): TestRuntime {
    const hasSnapshot = persisted.automation !== undefined && persisted.engine !== undefined;
    const runtime = this.makeRuntime(
      competitionId,
      persisted.definition,
      persisted.id,
      persisted.createdAt,
      hasSnapshot ? persisted : undefined
    );
    if (hasSnapshot) {
      for (let index = 0; index < persisted.playedEvents; index += 1) runtime.runner.next();
    } else {
      this.connectPlayers(runtime, false);
      for (let index = 0; index < persisted.playedEvents; index += 1) {
        const event = runtime.runner.next();
        if (event) this.applyTestEvent(runtime, event, false, false);
      }
      for (const operation of persisted.operations) {
        if (operation.kind === "automation-start") runtime.automation.enable(runtime.automationClock.now() + (operation.readyInMs ?? 0));
        else if (operation.kind === "advance-clock") {
          this.advanceClock(runtime, operation.milliseconds ?? 0);
          continue;
        } else if (operation.kind === "fault" && operation.fault) {
          this.applyFault(runtime, {
            fault: operation.fault,
            ...(operation.playerId === undefined ? {} : { playerId: operation.playerId }),
            ...(operation.milliseconds === undefined ? {} : { milliseconds: operation.milliseconds })
          });
        } else if (operation.kind === "start-protection") {
          runtime.automation.setStartProtectionUsed(operation.used ?? false);
        }
        this.settleAutomation(runtime);
      }
    }
    runtime.operations = [...persisted.operations];
    runtime.playedEvents = persisted.playedEvents;
    runtime.updatedAt = persisted.updatedAt;
    const highestScoreboardVersion = Math.max(
      0,
      ...runtime.engine.snapshot().scoreboardVersions.map((version) => version.version),
      ...(this.host.getPayload(competitionId).scoreboardRevisions ?? []).map((version) => version.version),
      ...this.host.storedScoreboardVersions(competitionId).map((version) => version.version)
    );
    runtime.engine.setNextScoreboardVersion(highestScoreboardVersion + 1);
    runtime.automation.pause();
    delete runtime.pendingCountdown;
    return runtime;
  }

  private advanceClock(runtime: TestRuntime, milliseconds: number): void {
    let remaining = milliseconds;
    if (remaining === 0) this.settleAutomation(runtime);
    while (remaining > 0) {
      const step = Math.min(1_000, remaining);
      runtime.automationClock.advanceBy(step);
      remaining -= step;
      this.settleAutomation(runtime);
    }
  }

  private persistRuntime(runtime: TestRuntime, makeActive = false): void {
    runtime.updatedAt = new Date().toISOString();
    const payload = this.host.getPayload(runtime.competitionId);
    const withoutCurrent = (payload.testRuns ?? []).filter((candidate) => candidate.id !== runtime.id);
    const persisted: PersistedTestRun = {
      id: runtime.id,
      definition: runtime.definition,
      playedEvents: runtime.playedEvents,
      operations: runtime.operations,
      automation: runtime.automation.snapshot(),
      engine: runtime.engine.snapshot(),
      ...(runtime.pendingCountdown === undefined
        ? {}
        : { pendingCountdown: { action: { ...runtime.pendingCountdown.action }, emitted: runtime.pendingCountdown.emitted } }),
      appliedFaultIds: [...runtime.appliedFaultIds],
      stageFinishOrdinals: Object.fromEntries(runtime.stageFinishOrdinals),
      phaseStartedAt: Object.fromEntries(runtime.phaseStartedAt),
      recoveries: runtime.recoveries.map((recovery) => ({ ...recovery })),
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt
    };
    this.host.savePayload(runtime.competitionId, {
      ...payload,
      ...(makeActive || !payload.activeRunId ? { activeRunId: runtime.id } : {}),
      ...(makeActive ? { scoreboardRevisions: [] } : {}),
      testRuns: [...withoutCurrent, persisted]
    });
    this.host.setActiveRun(runtime.competitionId, runtime.id);
  }

  private configToScenarioDefinition(config: CompetitionConfig): ScenarioDefinition {
    return {
      schemaVersion: 1,
      kind: "scripted-replay",
      id: `config-${randomUUID()}`,
      name: config.name,
      year: Number(config.date.slice(0, 4)),
      timezone: config.timezone,
      refereeConnectionId: "local-referee",
      players: config.participants.map((participant, index) => ({ id: participant.id, displayName: participant.displayName, connectionId: participant.connectionIds[0] ?? String(index + 1) })),
      stages: config.stages.map((stage) => ({
        id: stage.id,
        order: stage.order,
        level: stage.level,
        mode: stage.mode,
        mapKind: stage.mapKind,
        ...(stage.mapHash === undefined ? {} : { mapHash: stage.mapHash }),
        displayName: stage.label,
        timeLimitMs: stage.timeLimitMs,
        scoring: [...stage.scoring],
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      events: [],
      expected: { attempts: 0, scoreboardVersions: 0 }
    };
  }

  private materializeBehaviorScenario(competitionId: string, behavior: ScenarioDefinition): ScenarioDefinition {
    const config = this.host.getDraftConfig(competitionId);
    const base = this.configToScenarioDefinition(config);
    const stages = base.stages;
    return {
      ...behavior,
      id: behavior.id,
      name: behavior.name,
      year: base.year,
      timezone: base.timezone,
      refereeConnectionId: behavior.refereeConnectionId,
      stages,
      events: [],
      expected: { attempts: stages.length, scoreboardVersions: stages.length * behavior.players.length }
    };
  }

  // Player behavior, fault scheduling and log rendering live below; no lifecycle state is owned here.

  private connectPlayers(runtime: TestRuntime, writeLog: boolean): void {
    for (const player of runtime.definition.players) {
      runtime.automation.observeConnection(player.id, true);
      if (writeLog) {
        const event: ScenarioEvent = { atMs: runtime.automationClock.now(), sourceId: `agent-login:${runtime.id}:${player.id}`, type: "login", playerId: player.id, connectionId: player.connectionId };
        this.host.appendRawLog(runtime.competitionId, "test-player", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
      }
    }
  }

  private drivePlayers(runtime: TestRuntime): void {
    if (runtime.definition.kind === "scripted-replay") return;
    runtime.automation.synchronizeStageBoundary();
    this.mirrorClosedAttempts(runtime);
    const snapshot = runtime.automation.snapshot();
    const effectivePhase = (snapshot.phase === "paused" || snapshot.phase === "incident") && snapshot.pausedFromPhase
      ? snapshot.pausedFromPhase
      : snapshot.phase;
    if (effectivePhase !== "running" && effectivePhase !== "tail-intake") return;
    const stageId = snapshot.currentStageId;
    const attempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === stageId && candidate.intakeOpen);
    if (!attempt) return;
    const completed = new Set(attempt.results.map((result) => result.playerId));
    const planned = runtime.definition.players.map((player) => ({ player, plan: this.testPlayerPlan(runtime, attempt, player) }))
      .sort((left, right) => left.plan.dueAtMs - right.plan.dueAtMs || left.player.id.localeCompare(right.player.id));
    for (const { player, plan } of planned) {
      if (completed.has(player.id)) continue;
      if (plan.kind === "timeout" || plan.dueAtMs > runtime.automationClock.now()) continue;
      const sourceId = `agent:${runtime.id}:${attempt.id}:${player.id}`;
      if (plan.kind === "disrupt") {
        const warning = seededBehaviorRandom(runtime.definition.randomSeed ?? 1, stageId, attempt.attemptNumber, player.id, "disrupt-kind") < 0.5;
        const finishEvent: ScenarioEvent = {
          atMs: plan.dueAtMs,
          sourceId,
          type: "finish",
          stageId,
          playerId: player.id,
          elapsedMs: Math.max(1_000, plan.dueAtMs - attempt.goAtMs),
          score: 3_000 + Math.floor(seededBehaviorRandom(runtime.definition.randomSeed ?? 1, stageId, attempt.attemptNumber, player.id, "disrupt-score") * 1_000)
        };
        if (warning) {
          this.applyTestEventsAtomically(runtime, [{
            atMs: plan.dueAtMs,
            sourceId: `${sourceId}:warning`,
            type: "warning",
            playerId: player.id,
            message: "just pressed the Reset hotkey"
          }, finishEvent]);
        } else {
          this.applyTestEventsAtomically(runtime, [
            { atMs: plan.dueAtMs, sourceId: `${sourceId}:cheat`, type: "cheat", playerId: player.id, enabled: true },
            { atMs: plan.dueAtMs, sourceId: `${sourceId}:cheat-off`, type: "cheat", playerId: player.id, enabled: false },
            finishEvent
          ]);
        }
        continue;
      }
      if (plan.kind === "dnf") {
        this.applyTestEvent(runtime, { atMs: plan.dueAtMs, sourceId, type: "dnf", stageId, playerId: player.id, reason: "gave-up" }, false, true, false);
        continue;
      }
      this.applyTestEvent(runtime, {
        atMs: plan.dueAtMs,
        sourceId,
        type: "finish",
        stageId,
        playerId: player.id,
        elapsedMs: plan.elapsedMs,
        score: plan.score
      }, false, true, false);
    }
  }

  private testPlayerPlan(
    runtime: TestRuntime,
    attempt: AutomationSnapshot["attempts"][number],
    player: ScenarioDefinition["players"][number]
  ): { kind: "finish"; dueAtMs: number; elapsedMs: number; score: number }
    | { kind: "dnf"; dueAtMs: number }
    | { kind: "disrupt"; dueAtMs: number }
    | { kind: "timeout"; dueAtMs: number } {
    if (runtime.definition.kind !== "player-behavior") {
      return { kind: "finish", dueAtMs: attempt.goAtMs, elapsedMs: 90_000, score: 5_000 };
    }
    const stage = runtime.definition.stages.find((candidate) => candidate.id === attempt.stageId);
    const timeLimitMs = stage?.timeLimitMs ?? 10 * 60_000;
    const profile = player.profile ?? "normal";
    const random = (channel: string) => seededBehaviorRandom(runtime.definition.randomSeed ?? 1, attempt.stageId, attempt.attemptNumber, player.id, channel);
    const boundedDelay = (milliseconds: number) => Math.min(Math.max(1_000, Math.round(milliseconds)), Math.max(1_000, timeLimitMs - 1));
    if (profile === "struggler") {
      if (random("outcome") < 0.65) return { kind: "timeout", dueAtMs: attempt.deadlineAtMs };
      const delay = boundedDelay(timeLimitMs * (0.55 + random("dnf-time") * 0.35));
      return { kind: "dnf", dueAtMs: attempt.goAtMs + delay };
    }
    if (profile === "disruptor") {
      const delay = boundedDelay(20_000 + random("disrupt-time") * 70_000);
      return { kind: "disrupt", dueAtMs: attempt.goAtMs + delay };
    }
    const delay = boundedDelay(profile === "expert"
      ? 30_000 + random("finish-time") * 45_000
      : 75_000 + random("finish-time") * 150_000);
    const scoreBase = profile === "expert" ? 9_000 : 4_000;
    return {
      kind: "finish",
      dueAtMs: attempt.goAtMs + delay,
      elapsedMs: delay,
      score: scoreBase + Math.floor(random("score") * 1_000)
    };
  }

  private applyTestEvent(runtime: TestRuntime, event: ScenarioEvent, countEvent: boolean, writeLog = true, settleAutomation = true): void {
    if (event.atMs > runtime.automationClock.now()) {
      runtime.automationClock.advanceBy(event.atMs - runtime.automationClock.now());
    }
    runtime.automation.synchronizeStageBoundary();
    this.mirrorClosedAttempts(runtime);
    this.applyTestEventEffects(runtime, event, settleAutomation);
    this.recordTestEvent(runtime, event, countEvent, writeLog);
  }

  private applyTestEventsAtomically(runtime: TestRuntime, events: readonly ScenarioEvent[]): void {
    const first = events[0];
    if (!first) return;
    if (events.some((event) => event.atMs !== first.atMs)) throw new Error("ATOMIC_TEST_EVENTS_MUST_SHARE_TIME");
    if (first.atMs > runtime.automationClock.now()) {
      runtime.automationClock.advanceBy(first.atMs - runtime.automationClock.now());
    }
    const receiptAtMs = runtime.automationClock.now();
    runtime.automation.synchronizeStageBoundary();
    this.mirrorClosedAttempts(runtime);
    const atomicAttempt = runtime.automation.snapshot().attempts.findLast((attempt) =>
      attempt.stageId === runtime.automation.snapshot().currentStageId
      && attempt.intakeOpen
      && !attempt.voided);
    // Warning/[CHEAT] evidence and its finish describe one receipt. Bind the finish
    // to the exact attempt captured before the batch; a later standalone finish must
    // still pass the normal intake and deadline gates.
    for (const event of events) {
      if (this.isPreAttemptEvidence(runtime, event)) {
        this.recordTestEvent(runtime, event, false, true);
        continue;
      }
      if (event.type === "finish" && atomicAttempt) {
        const excluded = runtime.automation.snapshot().attempts
          .find((attempt) => attempt.id === atomicAttempt.id)?.results
          .find((result) =>
            result.playerId === event.playerId
            && result.status === "excluded"
            && result.receivedAtMs === receiptAtMs);
        if (excluded) {
          const accepted = runtime.automation.recordExcludedFinishEvidence({
            attemptId: atomicAttempt.id,
            stageId: atomicAttempt.stageId,
            playerId: event.playerId,
            exclusionSourceId: excluded.sourceId,
            finishSourceId: event.sourceId,
            receivedAtMs: receiptAtMs
          }) === "accepted";
          if (accepted) runtime.engine.apply(event);
        } else {
          this.applyTestEventEffects(runtime, event, false);
        }
      } else {
        this.applyTestEventEffects(runtime, event, false);
      }
      this.recordTestEvent(runtime, event, false, true);
    }
  }

  private applyTestEventEffects(runtime: TestRuntime, event: ScenarioEvent, settleAutomation: boolean): void {
    if (this.isPreAttemptEvidence(runtime, event)) return;
    const controlledAttempt = event.type === "finish" || event.type === "dnf"
      ? runtime.automation.snapshot().attempts.findLast((attempt) =>
        attempt.stageId === event.stageId && !attempt.voided)
      : undefined;
    if ((event.type === "finish" || event.type === "dnf")
      && (runtime.definition.kind === "player-behavior" || controlledAttempt !== undefined)) {
      const accepted = this.applyAutomationEvent(runtime, event, false);
      if (accepted) runtime.engine.apply(event);
      if (settleAutomation) this.settleAutomation(runtime);
    } else {
      runtime.engine.apply(event);
      this.applyAutomationEvent(runtime, event, settleAutomation);
    }
  }

  private recordTestEvent(runtime: TestRuntime, event: ScenarioEvent, countEvent: boolean, writeLog: boolean): void {
    if (countEvent) runtime.playedEvents += 1;
    if (writeLog) {
      const source = event.type === "ready" || event.type === "go" ? "test-referee" : "test-player";
      this.host.appendRawLog(runtime.competitionId, source, this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
    }
    this.host.journal.append({ type: "test-run.event", competitionId: runtime.competitionId, data: event });
  }

  private settleAutomation(runtime: TestRuntime): void {
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const beforeSnapshot = runtime.automation.snapshot();
      const before = beforeSnapshot.stateVersion;
      this.observeScenarioPhase(runtime, beforeSnapshot);
      this.applyScheduledRecoveries(runtime);
      this.applyDueScenarioFaults(runtime);
      this.mirrorVoidedAttempts(runtime);
      this.advancePendingCountdown(runtime);
      this.drivePlayers(runtime);
      const knownResultSources = new Set(runtime.engine.snapshot().currentScoreboard.flatMap((entry) =>
        Object.values(entry.stages).flatMap((result) => [result.sourceId, ...(result.finishSourceId ? [result.finishSourceId] : [])])));
      runtime.automation.tick();
      this.mirrorDeadlineResults(runtime, knownResultSources);
      this.mirrorClosedAttempts(runtime);
      const actions = runtime.automationRuntime.dispatch(true);
      for (const action of actions) {
        if (action.kind === "go") {
          runtime.pendingCountdown = { action, emitted: 0 };
          this.advancePendingCountdown(runtime);
          continue;
        }
        for (const line of this.testAutomationActionLogLines(runtime, action)) {
          this.host.appendRawLog(runtime.competitionId, "test-referee", line, this.testOccurredAt(runtime, action.createdAtMs));
        }
        this.host.recordAutomationAttention(runtime.competitionId, action);
      }
      if (runtime.automation.snapshot().stateVersion === before) break;
    }
  }

  private advancePendingCountdown(runtime: TestRuntime): void {
    const pending = runtime.pendingCountdown;
    if (!pending) return;
    const automation = runtime.automation.snapshot();
    const action = automation.actions.find((candidate) => candidate.id === pending.action.id);
    const effectivePhase = (automation.phase === "paused" || automation.phase === "incident") && automation.pausedFromPhase
      ? automation.pausedFromPhase
      : automation.phase;
    const currentPendingGo = [...automation.actions].reverse().find((candidate) =>
      candidate.kind === "go"
      && candidate.status === "pending"
      && candidate.stageId === automation.currentStageId);
    const activeCycle = action?.kind === "go"
      && action.status === "pending"
      && action.stageId === automation.currentStageId
      && currentPendingGo?.id === action.id
      && effectivePhase === "countdown"
      && !automation.attempts.some((attempt) => attempt.stageId === action.stageId && !attempt.voided);
    if (!activeCycle || !action) {
      delete runtime.pendingCountdown;
      return;
    }
    const dueAtMs = pending.action.createdAtMs + pending.emitted * 1_000;
    if (runtime.automationClock.now() < dueAtMs) return;
    const prefix = this.testLogPrefix(runtime, dueAtMs);
    const stage = runtime.definition.stages.find((candidate) => candidate.id === action.stageId);
    const mapEcho = this.testStageEcho(stage, true);
    const referee = runtime.definition.refereeConnectionId;
    if (pending.emitted < 3) {
      const value = (3 - pending.emitted) as 3 | 2 | 1;
      runtime.automation.observeCountdown(value);
      this.host.appendRawLog(runtime.competitionId, "test-referee", `${prefix} [${referee}, *ContestConsole]: ${mapEcho} - ${value}`, this.testOccurredAt(runtime, dueAtMs));
      pending.emitted += 1;
      return;
    }
    const event: ScenarioEvent = {
      atMs: dueAtMs,
      sourceId: `automation-go:${action.id}`,
      type: "go",
      stageId: action.stageId,
      refereeConnectionId: referee
    };
    runtime.automation.acknowledgeAction(action.id, "acknowledged");
    const after = runtime.automation.snapshot();
    const acknowledged = after.actions.find((candidate) => candidate.id === action.id)?.status === "acknowledged";
    const attemptCreated = after.attempts.some((attempt) => attempt.stageId === action.stageId && !attempt.voided);
    if (!acknowledged || !attemptCreated) {
      delete runtime.pendingCountdown;
      return;
    }
    runtime.engine.apply(event);
    this.host.appendRawLog(runtime.competitionId, "test-referee", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, dueAtMs));
    this.host.recordAutomationAttention(runtime.competitionId, action);
    delete runtime.pendingCountdown;
  }

  private mirrorDeadlineResults(runtime: TestRuntime, knownResultSources: ReadonlySet<string>): void {
    for (const attempt of runtime.automation.snapshot().attempts) {
      for (const result of attempt.results) {
        if (knownResultSources.has(result.sourceId) || result.status !== "dnf" || !result.sourceId.match(/^(deadline|manual-end):/)) continue;
        const event: ScenarioEvent = {
          atMs: result.receivedAtMs,
          sourceId: result.sourceId,
          type: "dnf",
          stageId: attempt.stageId,
          playerId: result.playerId,
          reason: result.reason ?? "time-limit"
        };
        runtime.engine.apply(event);
        this.host.appendAttention(runtime.competitionId, {
          id: `deadline:${attempt.id}:${result.playerId}`,
          category: "result",
          severity: "warning",
          title: "关卡时限已到",
          message: `${result.playerId} 未完成，成绩记为 DNF。`,
          occurredAt: this.testOccurredAt(runtime, result.receivedAtMs),
          stageId: attempt.stageId,
          participantIds: [result.playerId]
        });
        this.host.journal.append({ type: "test-run.event", competitionId: runtime.competitionId, data: event });
      }
    }
  }

  private mirrorVoidedAttempts(runtime: TestRuntime): void {
    const engineAttempts = runtime.engine.snapshot().attempts;
    for (const attempt of runtime.automation.snapshot().attempts) {
      if (!attempt.voided) continue;
      const engineAttempt = engineAttempts.find((candidate) =>
        candidate.stageId === attempt.stageId && candidate.attemptNumber === attempt.attemptNumber && !candidate.voided);
      if (!engineAttempt) continue;
      runtime.engine.voidAttempt(attempt.stageId, attempt.attemptNumber, `start-protection:${attempt.id}`);
    }
  }

  private mirrorClosedAttempts(runtime: TestRuntime): void {
    const engineAttempts = runtime.engine.snapshot().attempts;
    for (const attempt of runtime.automation.snapshot().attempts) {
      if (attempt.intakeOpen || attempt.voided) continue;
      const engineAttempt = engineAttempts.find((candidate) =>
        candidate.stageId === attempt.stageId
        && candidate.attemptNumber === attempt.attemptNumber
        && candidate.open
        && !candidate.voided);
      if (engineAttempt) runtime.engine.closeAttempt(attempt.stageId, attempt.attemptNumber);
    }
  }

  private observeScenarioPhase(runtime: TestRuntime, snapshot: AutomationSnapshot): void {
    const effectivePhase = (snapshot.phase === "paused" || snapshot.phase === "incident") && snapshot.pausedFromPhase
      ? snapshot.pausedFromPhase
      : snapshot.phase;
    const trigger = effectivePhase === "ready" ? "ready" : effectivePhase === "running" || effectivePhase === "tail-intake" ? "running" : undefined;
    if (!trigger) return;
    const key = `${snapshot.currentStageId}:${trigger}`;
    if (!runtime.phaseStartedAt.has(key)) runtime.phaseStartedAt.set(key, runtime.automationClock.now());
  }

  private applyDueScenarioFaults(runtime: TestRuntime): void {
    const snapshot = runtime.automation.snapshot();
    const stage = runtime.definition.stages.find((candidate) => candidate.id === snapshot.currentStageId);
    if (!stage) return;
    for (const fault of runtime.definition.faultPlan ?? []) {
      if (runtime.appliedFaultIds.has(fault.id) || fault.stageOrder !== stage.order) continue;
      const startedAt = runtime.phaseStartedAt.get(`${stage.id}:${fault.trigger}`);
      if (startedAt === undefined || runtime.automationClock.now() < startedAt + fault.offsetMs) continue;
      runtime.appliedFaultIds.add(fault.id);
      this.applyFault(runtime, {
        fault: fault.fault,
        ...(fault.playerId === undefined ? {} : { playerId: fault.playerId }),
        ...(fault.recoverAfterMs === undefined ? {} : { recoverAfterMs: fault.recoverAfterMs }),
        ...(fault.message === undefined ? {} : { message: fault.message })
      });
      this.host.appendAttention(runtime.competitionId, {
        id: `scenario-fault:${runtime.id}:${fault.id}`,
        category: "incident",
        severity: fault.recoverAfterMs ? "warning" : "critical",
        title: "场景故障已触发",
        message: `${fault.fault}${fault.playerId ? ` · ${fault.playerId}` : ""}`,
        occurredAt: this.testOccurredAt(runtime, runtime.automationClock.now()),
        stageId: stage.id,
        ...(fault.playerId === undefined ? {} : { participantIds: [fault.playerId] })
      });
    }
  }

  private applyScheduledRecoveries(runtime: TestRuntime): void {
    const due = runtime.recoveries.filter((recovery) => recovery.dueAtMs <= runtime.automationClock.now());
    runtime.recoveries = runtime.recoveries.filter((recovery) => recovery.dueAtMs > runtime.automationClock.now());
    for (const recovery of due) {
      runtime.automation.observeConnection(recovery.playerId, true);
      const player = runtime.definition.players.find((candidate) => candidate.id === recovery.playerId);
      if (player) {
        const event: ScenarioEvent = { atMs: recovery.dueAtMs, sourceId: `scenario-reconnect:${runtime.id}:${recovery.playerId}:${recovery.dueAtMs}`, type: "login", playerId: player.id, connectionId: player.connectionId };
        this.host.appendRawLog(runtime.competitionId, "test-player", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
      }
      this.host.appendAttention(runtime.competitionId, {
        id: `scenario-recovery:${runtime.id}:${recovery.playerId}:${recovery.dueAtMs}`,
        category: "flow",
        severity: "info",
        title: "选手已重连",
        message: `${recovery.playerId} 已恢复在线，等待稳定期完成。`,
        occurredAt: this.testOccurredAt(runtime, recovery.dueAtMs),
        participantIds: [recovery.playerId]
      });
    }
  }

  private tickRealtime(runId: string): void {
    const timer = this.realtimeTimers.get(runId);
    const runtime = this.runtimes.get(runId);
    if (!timer || !runtime) {
      this.stopRealtime(runId);
      return;
    }
    const wallNow = performance.now();
    const milliseconds = Math.max(0, Math.round(wallNow - timer.lastWallAtMs));
    timer.lastWallAtMs = wallNow;
    if (milliseconds === 0) return;
    const beforeStateVersion = runtime.automation.snapshot().stateVersion;
    const beforeScoreboardVersions = runtime.engine.snapshot().scoreboardVersions.length;
    const lastOperation = runtime.operations.at(-1);
    if (runtime.clockAdvanceCanCoalesce && lastOperation?.kind === "advance-clock") {
      lastOperation.milliseconds = (lastOperation.milliseconds ?? 0) + milliseconds;
    } else {
      runtime.operations.push({ kind: "advance-clock", milliseconds });
    }
    runtime.automationClock.advanceBy(milliseconds);
    try {
      this.settleAutomation(runtime);
      const snapshot = runtime.automation.snapshot();
      const scoreboardVersions = runtime.engine.snapshot().scoreboardVersions.length;
      const changed = snapshot.stateVersion !== beforeStateVersion || scoreboardVersions !== beforeScoreboardVersions;
      runtime.clockAdvanceCanCoalesce = !changed;
      this.host.completeCompetitionOnReview(runtime.competitionId, snapshot);
      this.persistRuntime(runtime);
      if (scoreboardVersions !== beforeScoreboardVersions) this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
      if (changed) this.host.journal.append({ type: "test-run.realtime-progress", competitionId: runtime.competitionId, data: { runId, phase: snapshot.phase } });
    } catch (error) {
      runtime.automation.pause();
      this.persistRuntime(runtime);
      this.stopRealtime(runId);
      this.host.journal.append({ type: "test-run.realtime-error", competitionId: runtime.competitionId, data: { runId, message: error instanceof Error ? error.message : "unknown" } });
    }
  }

  private applyAutomationEvent(runtime: TestRuntime, event: ScenarioDefinition["events"][number], settleAutomation = true): boolean {
    let accepted = true;
    switch (event.type) {
      case "login": runtime.automation.observeConnection(event.playerId, true); break;
      case "disconnect": runtime.automation.observeConnection(event.playerId, false); break;
      case "cheat": {
        const before = runtime.automation.snapshot();
        const targetAttempt = [...before.attempts].reverse().find((attempt) =>
          attempt.stageId === before.currentStageId && attempt.intakeOpen && !attempt.voided);
        runtime.automation.observeCheat(event.playerId, event.enabled, event.sourceId);
        if (event.enabled && targetAttempt) {
          const snapshot = runtime.automation.snapshot();
          const stageId = targetAttempt.stageId;
          const excluded = snapshot.attempts.some((attempt) =>
            attempt.stageId === targetAttempt.stageId
            && attempt.attemptNumber === targetAttempt.attemptNumber
            && attempt.results.some((result) =>
              result.playerId === event.playerId && result.status === "excluded" && result.sourceId === event.sourceId));
          if (excluded) {
            const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
            runtime.engine.apply({ atMs: runtime.automationClock.now(), sourceId: `${event.sourceId}:excluded`, type: "exclude", stageId, playerId: event.playerId, reason: "cheat-enabled" });
            if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
              this.host.appendAttention(runtime.competitionId, {
                id: `excluded:${event.sourceId}`,
                category: "result",
                severity: "warning",
                title: "违规成绩已排除",
                message: `${event.playerId} 在本关开启 cheat；后续完赛日志仍保留，但不参与计分。`,
                occurredAt: this.testOccurredAt(runtime, runtime.automationClock.now()),
                stageId,
                participantIds: [event.playerId]
              });
            }
          }
        }
        break;
      }
      case "finish":
        accepted = runtime.automation.recordResult({
          stageId: event.stageId,
          playerId: event.playerId,
          status: "finished",
          sourceId: event.sourceId,
          receivedAtMs: runtime.automationClock.now()
        }) === "accepted";
        break;
      case "dnf":
        accepted = runtime.automation.recordResult({
          stageId: event.stageId,
          playerId: event.playerId,
          status: "dnf",
          sourceId: event.sourceId,
          reason: event.reason,
          receivedAtMs: runtime.automationClock.now()
        }) === "accepted";
        break;
      case "exclude": runtime.automation.observeViolation(event.playerId, event.sourceId, event.reason); break;
      case "warning": {
        const before = runtime.automation.snapshot();
        const targetAttempt = [...before.attempts].reverse().find((attempt) =>
          attempt.stageId === before.currentStageId && attempt.intakeOpen && !attempt.voided);
        if (event.playerId && targetAttempt) {
          const stageId = targetAttempt.stageId;
          const sourceId = `${event.sourceId}:excluded`;
          runtime.automation.observeViolation(event.playerId, sourceId, event.message);
          const excluded = runtime.automation.snapshot().attempts.some((attempt) =>
            attempt.stageId === targetAttempt.stageId
            && attempt.attemptNumber === targetAttempt.attemptNumber
            && attempt.results.some((result) =>
              result.playerId === event.playerId && result.status === "excluded" && result.sourceId === sourceId));
          if (excluded) {
            const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
            runtime.engine.apply({ atMs: runtime.automationClock.now(), sourceId, type: "exclude", stageId, playerId: event.playerId, reason: event.message });
            if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
              this.host.appendAttention(runtime.competitionId, {
                id: `excluded:${sourceId}`,
                category: "result",
                severity: "warning",
                title: "违规成绩已排除",
                message: `${event.playerId} 触发 Warning；后续完赛日志仍保留，但不参与计分。`,
                occurredAt: this.testOccurredAt(runtime, runtime.automationClock.now()),
                stageId,
                participantIds: [event.playerId]
              });
            }
          }
        }
        break;
      }
      case "fault": this.applyFault(runtime, event); break;
      default: break;
    }
    if (settleAutomation) this.settleAutomation(runtime);
    return accepted;
  }

  private isPreAttemptEvidence(runtime: TestRuntime, event: ScenarioEvent): boolean {
    if (!["finish", "dnf", "warning", "cheat"].includes(event.type)) return false;
    const snapshot = runtime.automation.snapshot();
    const attempt = snapshot.attempts.findLast((candidate) =>
      candidate.stageId === snapshot.currentStageId
      && candidate.intakeOpen
      && !candidate.voided);
    if (!attempt || event.atMs >= attempt.goAtMs) return false;
    if ((event.type === "finish" || event.type === "dnf") && event.stageId !== attempt.stageId) return false;
    return true;
  }

  private resetStageCycleAuxiliary(runtime: TestRuntime, stageId: string): void {
    delete runtime.pendingCountdown;
    runtime.clockAdvanceCanCoalesce = false;
    runtime.stageFinishOrdinals.delete(stageId);
    runtime.phaseStartedAt.delete(`${stageId}:ready`);
    runtime.phaseStartedAt.delete(`${stageId}:running`);
  }

  private resetParticipantStageStatuses(runtime: TestRuntime, stageId: string): void {
    const config = this.host.getDraftConfig(runtime.competitionId);
    let resetCount = 0;
    const participants = config.participants.map((participant) => {
      if (participant.role !== "participant" || participant.currentStageStatus === "waiting") return participant;
      resetCount += 1;
      return { ...participant, currentStageStatus: "waiting" as const };
    });
    if (resetCount > 0) {
      this.host.upsertConfig(runtime.competitionId, 0, false, { ...config, participants });
    }
    this.host.journal.append({
      type: "test-run.participants-stage-reset",
      competitionId: runtime.competitionId,
      data: { runId: runtime.id, stageId, resetCount }
    });
  }

  private runExpectedStageAction<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof Error && error.message === "ACTION_TARGET_CHANGED") {
        throw new ServiceError("CONFIRMATION_STALE", "关卡边界已变化，请刷新现场状态后重新确认", 409);
      }
      throw error;
    }
  }

  private applyFault(runtime: TestRuntime, input: { fault: string; playerId?: string; milliseconds?: number; recoverAfterMs?: number; message?: string }): void {
    switch (input.fault) {
      case "process-exit":
      case "server-disconnect": runtime.automation.observeServerDisconnect(`测试故障：${input.fault}`); break;
      case "participant-disconnect":
        if (!input.playerId) throw new ServiceError("VALIDATION_FAILED", "玩家掉线故障需要 playerId", 400);
        runtime.automation.observeConnection(input.playerId, false);
        if (input.recoverAfterMs) runtime.recoveries.push({ playerId: input.playerId, dueAtMs: runtime.automationClock.now() + input.recoverAfterMs });
        break;
      case "player-crash":
        if (!input.playerId) throw new ServiceError("VALIDATION_FAILED", "玩家崩溃故障需要 playerId", 400);
        runtime.automation.observeCrash(input.playerId, "测试注入玩家崩溃");
        runtime.automation.observeConnection(input.playerId, false);
        break;
      case "clock-jump":
        runtime.automationClock.advanceBy(input.milliseconds ?? 60_000);
        runtime.automation.observeTimingDiscontinuity("测试注入系统时钟或休眠跳变");
        break;
      case "warning": {
        if (!input.playerId) throw new ServiceError("VALIDATION_FAILED", "Warning 故障需要 playerId", 400);
        const stageId = runtime.automation.snapshot().currentStageId;
        const player = runtime.definition.players.find((candidate) => candidate.id === input.playerId);
        if (!stageId || !player) throw new ServiceError("VALIDATION_FAILED", "Warning 故障无法定位玩家或关卡", 400);
        const stage = runtime.definition.stages.find((candidate) => candidate.id === stageId);
        const event: ScenarioEvent = {
          atMs: runtime.automationClock.now(),
          sourceId: `scenario-warning:${runtime.id}:${input.playerId}:${runtime.automationClock.now()}`,
          type: "warning",
          playerId: input.playerId,
          message: input.message ?? "just pressed the Reset hotkey"
        };
        this.applyAutomationEvent(runtime, event, false);
        const prefix = this.testLogPrefix(runtime, event.atMs);
        const level = String(stage?.level ?? 0).padStart(2, "0");
        this.host.appendRawLog(runtime.competitionId, "test-player", `${prefix} [Warning] ${player.displayName} just pressed the Reset hotkey at Level ${level}!`, this.testOccurredAt(runtime, event.atMs));
        break;
      }
      default: throw new ServiceError("VALIDATION_FAILED", "未知故障类型", 400);
    }
  }

  private testEventLogLine(runtime: TestRuntime, event: ScenarioEvent): string {
    const player = "playerId" in event ? runtime.definition.players.find((candidate) => candidate.id === event.playerId) : undefined;
    const playerName = player?.displayName ?? ("playerId" in event ? event.playerId : "server");
    const connectionId = player?.connectionId ?? ("connectionId" in event ? event.connectionId : "0");
    const stage = "stageId" in event ? runtime.definition.stages.find((candidate) => candidate.id === event.stageId) : undefined;
    const mapEcho = this.testStageEcho(stage);
    const modeMapEcho = this.testStageEcho(stage, true);
    const prefix = this.testLogPrefix(runtime, event.atMs);
    switch (event.type) {
      case "login": return `${prefix} ${playerName} (#${event.connectionId}) logged in with cheat mode off.`;
      case "disconnect": return `${prefix} ${playerName} (#${event.connectionId}) disconnected.`;
      case "finish": {
        const place = (runtime.stageFinishOrdinals.get(event.stageId) ?? 0) + 1;
        runtime.stageFinishOrdinals.set(event.stageId, place);
        return `${prefix} (#${connectionId}, ${playerName}) finished ${modeMapEcho} in ${this.ordinal(place)} place (score: ${event.score}${stage?.mapKind === "custom" ? " [0]" : ""}; real time: ${this.formatElapsed(event.elapsedMs)}).`;
      }
      case "dnf": return `${prefix} (#${connectionId}, ${playerName}) did not finish ${mapEcho} (furthest reach: sector 0).`;
      case "exclude": return `${prefix} [Warning] ${playerName} result excluded: ${event.reason}`;
      case "cheat": return `${prefix} (${connectionId}, ${playerName}) turned cheat ${event.enabled ? "on" : "off"}.`;
      case "ready": return `${prefix} [${event.refereeConnectionId}, *ContestConsole]: ${modeMapEcho} - Get ready`;
      case "go":
        runtime.stageFinishOrdinals.set(event.stageId, 0);
        return `${prefix} [${event.refereeConnectionId}, *ContestConsole]: ${modeMapEcho} - Go!`;
      case "warning": return `${prefix} [Warning] ${event.playerId ? `${playerName} ` : ""}${event.message}`;
      case "fault": return `${prefix} ${event.fault === "server-disconnect" ? "Disconnected from server." : `Fault: ${event.fault}${event.playerId ? ` (${playerName})` : ""}`}`;
    }
  }

  private testAutomationActionLogLines(runtime: TestRuntime, action: AutomationAction): string[] {
    const atMs = action.createdAtMs;
    const prefix = this.testLogPrefix(runtime, atMs);
    const stage = runtime.definition.stages.find((candidate) => candidate.id === action.stageId);
    const mapEcho = this.testStageEcho(stage, true);
    const referee = runtime.definition.refereeConnectionId;
    switch (action.kind) {
      case "ready": return [`${prefix} [${referee}, *ContestConsole]: ${mapEcho} - Get ready`];
      case "go": return [];
      case "bulletin": return [`${prefix} [Bulletin] *ContestConsole: ${action.message ?? "比赛流程通知"}`];
      case "notice": return [`${prefix} [Notice] (${referee}, *ContestConsole): ${action.message ?? "比赛流程通知"}`];
      case "announce": return [`${prefix} [Announcement] (${referee}, *ContestConsole): ${action.message ?? "比赛流程通知"}`];
      case "cheat-off": return runtime.definition.players.map((player) => `${prefix} (${player.connectionId}, ${player.displayName}) turned cheat off.`);
    }
  }

  private testStageEcho(stage: ScenarioDefinition["stages"][number] | undefined, includeMode = false): string {
    const map = stage?.mapKind === "custom" && stage.mapHash
      ? `"${stage.displayName?.trim() || `${stage.mapHash.slice(0, 20).toLowerCase()}..`}"`
      : `Level ${String(stage?.level ?? 0).padStart(2, "0")}`;
    return includeMode && stage?.mode.toLowerCase() === "hs" ? `${map} <HS>` : map;
  }

  private testOccurredAt(runtime: TestRuntime, atMs: number): string {
    return new Date(Date.parse(runtime.createdAt) + atMs).toISOString();
  }

  private testLogPrefix(runtime: TestRuntime, atMs: number): string {
    const shifted = new Date(Date.parse(runtime.createdAt) + atMs + utcOffsetMinutes(runtime.definition.timezone) * 60_000);
    const part = (value: number) => String(value).padStart(2, "0");
    return `[${part(shifted.getUTCMonth() + 1)}-${part(shifted.getUTCDate())} ${part(shifted.getUTCHours())}:${part(shifted.getUTCMinutes())}:${part(shifted.getUTCSeconds())}]`;
  }

  private ordinal(place: number): string {
    const remainder = place % 100;
    if (remainder >= 11 && remainder <= 13) return `${place}th`;
    return `${place}${place % 10 === 1 ? "st" : place % 10 === 2 ? "nd" : place % 10 === 3 ? "rd" : "th"}`;
  }

  private formatElapsed(milliseconds: number): string {
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const seconds = Math.floor(milliseconds % 60_000 / 1_000);
    const millis = Math.floor(milliseconds % 1_000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
}
