import { randomUUID } from "node:crypto";
import { assertScenarioDefinition, capabilitiesFor, type CompetitionMode, type ScenarioDefinition } from "@ballance/contracts";
import { CompetitionController, CompetitionEngine, type AutomationSnapshot, type EngineSnapshot, type ScoreboardVersion } from "@ballance/core";
import { ScenarioRunner, VirtualClock } from "@ballance/testkit";
import { TestAutomationRuntime } from "./automation-runtime.js";
import { EventJournal } from "./event-journal.js";

export interface CompetitionRecord {
  id: string;
  name: string;
  mode: CompetitionMode;
  status: "draft" | "published";
  stateVersion: number;
  capabilities: ReturnType<typeof capabilitiesFor>;
  createdAt: string;
  updatedAt: string;
}

interface TestRuntime {
  id: string;
  competitionId: string;
  definition: ScenarioDefinition;
  runner: ScenarioRunner;
  engine: CompetitionEngine;
  automationClock: VirtualClock;
  automation: CompetitionController;
  automationRuntime: TestAutomationRuntime;
}

export class ServiceError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode: number, public readonly details?: unknown) { super(message); }
}

export class CompetitionService {
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly testRuns = new Map<string, TestRuntime>();
  private readonly idempotency = new Map<string, unknown>();

  public constructor(public readonly journal = new EventJournal()) {}

  public list(): readonly CompetitionRecord[] { return [...this.competitions.values()]; }

  public create(input: { name: string; mode: CompetitionMode; idempotencyKey: string }): CompetitionRecord {
    const old = this.idempotency.get(`create:${input.idempotencyKey}`);
    if (old) return old as CompetitionRecord;
    if (!input.name.trim()) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    if (input.mode !== "work" && input.mode !== "test") throw new ServiceError("VALIDATION_FAILED", "无效比赛模式", 400);
    const now = new Date().toISOString();
    const record: CompetitionRecord = { id: randomUUID(), name: input.name.trim(), mode: input.mode, status: "draft", stateVersion: 0, capabilities: capabilitiesFor(input.mode), createdAt: now, updatedAt: now };
    this.competitions.set(record.id, record);
    this.idempotency.set(`create:${input.idempotencyKey}`, record);
    this.journal.append({ type: "competition.created", competitionId: record.id, stateVersion: 0, data: record });
    return record;
  }

  public get(id: string): CompetitionRecord {
    const record = this.competitions.get(id);
    if (!record) throw new ServiceError("NOT_FOUND", "比赛不存在", 404);
    return record;
  }

  public publish(id: string, expectedStateVersion: number, idempotencyKey: string): CompetitionRecord {
    const key = `${id}:publish:${idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CompetitionRecord;
    const current = this.get(id);
    if (current.stateVersion !== expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    const updated = { ...current, status: "published" as const, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.competitions.set(id, updated);
    this.idempotency.set(key, updated);
    this.journal.append({ type: "competition.published", competitionId: id, stateVersion: updated.stateVersion, data: updated });
    return updated;
  }

  public createTestRun(competitionId: string, input: unknown): { runId: string; snapshot: EngineSnapshot } {
    const competition = this.get(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const definition = assertScenarioDefinition(input);
    const runtime = this.makeTestRuntime(competitionId, definition);
    this.testRuns.set(runtime.id, runtime);
    this.journal.append({ type: "test-run.created", competitionId, stateVersion: competition.stateVersion, data: { runId: runtime.id, scenarioId: definition.id } });
    return { runId: runtime.id, snapshot: runtime.engine.snapshot() };
  }

  public advanceTestRun(competitionId: string, runId: string, all: boolean): EngineSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    const events = all ? runtime.runner.playAll() : [runtime.runner.next()].filter((event) => event !== undefined);
    for (const event of events) {
      runtime.engine.apply(event);
      this.applyAutomationEvent(runtime, event);
      this.journal.append({ type: "test-run.event", competitionId, data: event });
    }
    const snapshot = runtime.engine.snapshot();
    this.journal.append({ type: "scoreboard.snapshot", competitionId, data: snapshot });
    return snapshot;
  }

  public resetTestRun(competitionId: string, runId: string): EngineSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    const reset = this.makeTestRuntime(competitionId, runtime.definition, runtime.id);
    this.testRuns.set(runId, reset);
    this.journal.append({ type: "test-run.reset", competitionId, data: { runId } });
    return reset.engine.snapshot();
  }

  public startTestAutomation(competitionId: string, runId: string, readyInMs = 0): AutomationSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    runtime.automation.enable(runtime.automationClock.now() + readyInMs);
    this.settleTestAutomation(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.automation-started", competitionId, data: snapshot });
    return snapshot;
  }

  public advanceTestAutomation(competitionId: string, runId: string, milliseconds: number): AutomationSnapshot {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new ServiceError("VALIDATION_FAILED", "推进时间必须是非负数", 400);
    const runtime = this.getTestRuntime(competitionId, runId);
    runtime.automationClock.advanceBy(milliseconds);
    this.settleTestAutomation(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.clock-advanced", competitionId, data: { runId, milliseconds, snapshot } });
    return snapshot;
  }

  public injectTestFault(competitionId: string, runId: string, input: { fault: string; playerId?: string; milliseconds?: number }): AutomationSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    this.applyFault(runtime, input);
    this.settleTestAutomation(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.fault", competitionId, data: { runId, ...input, snapshot } });
    return snapshot;
  }

  public getTestAutomation(competitionId: string, runId: string): AutomationSnapshot {
    return this.getTestRuntime(competitionId, runId).automation.snapshot();
  }

  public getTestScoreboardVersion(competitionId: string, runId: string, version?: number): {
    competition: CompetitionRecord;
    definition: ScenarioDefinition;
    scoreboard: ScoreboardVersion;
    automation: AutomationSnapshot;
  } {
    const runtime = this.getTestRuntime(competitionId, runId);
    const versions = runtime.engine.snapshot().scoreboardVersions;
    const scoreboard = version === undefined ? versions.at(-1) : versions.find((candidate) => candidate.version === version);
    if (!scoreboard) throw new ServiceError("NOT_FOUND", "榜单版本不存在", 404);
    return { competition: this.get(competitionId), definition: runtime.definition, scoreboard, automation: runtime.automation.snapshot() };
  }

  private makeTestRuntime(competitionId: string, definition: ScenarioDefinition, id: string = randomUUID()): TestRuntime {
    const automationClock = new VirtualClock(0);
    const automation = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      stages: [...definition.stages].sort((left, right) => left.order - right.order).map((stage) => ({
        id: stage.id, map: String(stage.level), mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs, minimumScoringPlace: stage.minimumScoringPlace
      }))
    }, automationClock);
    return {
      id, competitionId, definition, runner: new ScenarioRunner(definition), engine: new CompetitionEngine(definition),
      automationClock, automation, automationRuntime: new TestAutomationRuntime(automation)
    };
  }

  private getTestRuntime(competitionId: string, runId: string): TestRuntime {
    const competition = this.get(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const runtime = this.testRuns.get(runId);
    if (!runtime || runtime.competitionId !== competitionId) throw new ServiceError("NOT_FOUND", "测试运行不存在", 404);
    return runtime;
  }

  private settleTestAutomation(runtime: TestRuntime): void {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const before = runtime.automation.snapshot().stateVersion;
      runtime.automation.tick();
      runtime.automationRuntime.dispatch();
      if (runtime.automation.snapshot().stateVersion === before) break;
    }
  }

  private applyAutomationEvent(runtime: TestRuntime, event: ScenarioDefinition["events"][number]): void {
    if (event.atMs > runtime.automationClock.now()) runtime.automationClock.advanceBy(event.atMs - runtime.automationClock.now());
    switch (event.type) {
      case "login": runtime.automation.observeConnection(event.playerId, true); break;
      case "disconnect": runtime.automation.observeConnection(event.playerId, false); break;
      case "cheat": runtime.automation.observeCheat(event.playerId, event.enabled, event.sourceId); break;
      case "finish": runtime.automation.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "finished", sourceId: event.sourceId, receivedAtMs: runtime.automationClock.now() }); break;
      case "dnf": runtime.automation.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "dnf", sourceId: event.sourceId, reason: event.reason, receivedAtMs: runtime.automationClock.now() }); break;
      case "fault": this.applyFault(runtime, event); break;
      default: break;
    }
    this.settleTestAutomation(runtime);
  }

  private applyFault(runtime: TestRuntime, input: { fault: string; playerId?: string; milliseconds?: number }): void {
    switch (input.fault) {
      case "process-exit":
      case "server-disconnect": runtime.automation.observeServerDisconnect(`测试故障：${input.fault}`); break;
      case "participant-disconnect":
        if (!input.playerId) throw new ServiceError("VALIDATION_FAILED", "玩家掉线故障需要 playerId", 400);
        runtime.automation.observeConnection(input.playerId, false);
        break;
      case "player-crash":
        if (!input.playerId) throw new ServiceError("VALIDATION_FAILED", "玩家崩溃故障需要 playerId", 400);
        runtime.automation.observeCrash(input.playerId, "测试注入玩家崩溃");
        break;
      case "clock-jump": runtime.automationClock.advanceBy(input.milliseconds ?? 60_000); break;
      default: throw new ServiceError("VALIDATION_FAILED", "未知故障类型", 400);
    }
  }
}
