import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertScenarioDefinition,
  capabilitiesFor,
  createDefaultCompetitionConfig,
  type CommandRecordView,
  type CompetitionAction,
  type CompetitionConfig,
  type CompetitionLifecycleStatus,
  type CompetitionMode,
  type CompetitionRecordView,
  type CompetitionSnapshot,
  type ConfirmationSummary,
  type ParticipantView,
  type RuntimeSnapshot,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScoreboardOverrideInput,
  type ScoreboardVersionView,
  type TestRunSnapshot,
  type TestScenarioSummary
} from "@ballance/contracts";
import {
  CompetitionController,
  CompetitionEngine,
  parseLogLine,
  ScoreboardRevisionLedger,
  type AutomationSnapshot,
  type DomainEvent,
  type EngineSnapshot,
  type ScoreboardEntry,
  type ScoreboardVersion
} from "@ballance/core";
import { ScenarioRunner, VirtualClock } from "@ballance/testkit";
import { TestAutomationRuntime, WorkAutomationRuntime } from "./automation-runtime.js";
import type { CreatedArchive } from "./archive.js";
import type { CommandAction, CommandRecord } from "./command-queue.js";
import { CommandQueue } from "./command-queue.js";
import { EventJournal } from "./event-journal.js";
import { ManagedMockClient, readMockClientVersion, type CommandTransport } from "./mock-client.js";
import type { OpenedDatabase } from "./storage/database.js";

export interface CompetitionRecord {
  id: string;
  name: string;
  mode: CompetitionMode;
  status: CompetitionLifecycleStatus;
  stateVersion: number;
  capabilities: ReturnType<typeof capabilitiesFor>;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
}

interface PersistedTestOperation {
  kind: "automation-start" | "advance-clock" | "fault";
  readyInMs?: number;
  milliseconds?: number;
  fault?: string;
  playerId?: string;
}

interface PersistedTestRun {
  id: string;
  definition: ScenarioDefinition;
  playedEvents: number;
  operations: PersistedTestOperation[];
  createdAt: string;
  updatedAt: string;
}

interface ServiceSnapshotPayload {
  activeRunId?: string;
  testRuns?: PersistedTestRun[];
  scoreboardRevisions?: ScoreboardVersionView[];
  archives?: Array<{ version: number; directory: string; packagePath: string; manifestHash: string; createdAt: string }>;
  work?: { started: boolean; mockClientVersion?: string };
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
  playedEvents: number;
  operations: PersistedTestOperation[];
  createdAt: string;
  updatedAt: string;
}

interface WorkRuntime {
  competitionId: string;
  controller: CompetitionController;
  engine: CompetitionEngine;
  commands: CommandQueue;
  runtime: WorkAutomationRuntime;
  client?: ManagedMockClient;
  mockClientVersion?: string;
}

interface ConfirmationRecord {
  token: string;
  runtimeToken?: string;
  kind: ConfirmationSummary["kind"];
  competitionId: string;
  target: string;
  stateVersion: number;
  impactHash: string;
  expiresAtMs: number;
}

const rows = <T>(database: OpenedDatabase | undefined, sql: string, ...params: unknown[]): T[] =>
  database ? database.sqlite.prepare(sql).all(...params) as T[] : [];

const row = <T>(database: OpenedDatabase | undefined, sql: string, ...params: unknown[]): T | undefined =>
  database ? database.sqlite.prepare(sql).get(...params) as T | undefined : undefined;

const commandView = (record: CommandRecord): CommandRecordView => ({
  id: record.id,
  actionType: record.action.type,
  status: record.status,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  command: record.command,
  ...(record.responseLine === undefined ? {} : { responseLine: record.responseLine })
});

const simulatedCommand = (type: string, text = "测试模式模拟命令"): CommandRecordView => {
  const now = new Date().toISOString();
  return { id: randomUUID(), actionType: type, status: "simulated", createdAt: now, updatedAt: now, command: text, responseLine: "模拟成功", simulated: true };
};

const scoreEntries = (entries: readonly ScoreboardEntry[]): CompetitionSnapshot["currentScoreboard"] =>
  entries.map((entry) => ({
    rank: entry.rank,
    playerId: entry.playerId,
    displayName: entry.displayName,
    points: entry.points,
    change: entry.change,
    stages: entry.stages
  }));

const scoreboardView = (version: ScoreboardVersion): CompetitionSnapshot["scoreboardVersions"][number] => ({
  id: version.id,
  version: version.version,
  triggerSourceId: version.triggerSourceId,
  stageId: version.stageId,
  entries: scoreEntries(version.entries),
  deterministicHash: version.deterministicHash
});

const automationView = (mode: CompetitionMode, snapshot?: AutomationSnapshot, commands: readonly CommandRecordView[] = []): RuntimeSnapshot => ({
  phase: snapshot?.phase ?? "draft",
  stateVersion: snapshot?.stateVersion ?? 0,
  mode,
  automationEnabled: snapshot?.automationEnabled ?? false,
  ...(snapshot?.currentStageId === undefined ? {} : { currentStageId: snapshot.currentStageId }),
  ...(snapshot?.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: snapshot.plannedReadyAtMs }),
  blockers: snapshot?.blockers ?? [],
  waitingParticipants: snapshot?.waitingParticipants ?? [],
  attempts: snapshot?.attempts ?? [],
  incidents: snapshot?.incidents ?? [],
  rejectedResults: snapshot?.rejectedResults ?? [],
  commands
});

const scenarioSummary = (definition: ScenarioDefinition): TestScenarioSummary => ({
  id: definition.id,
  name: definition.name,
  players: definition.players.length,
  stages: definition.stages.length,
  events: definition.events.length,
  expectedScoreboardVersions: definition.expected.scoreboardVersions
});

const utcOffsetMinutes = (timezone: string): number => timezone === "Asia/Shanghai" ? 8 * 60 : 0;

const serverWindowsRoot = (): string => resolve(process.cwd(), "server-windows");

class SystemMonotonicClock {
  public now(): number { return performance.now(); }
}

export class ServiceError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode: number, public readonly details?: unknown) { super(message); }
}

const builtinScenario = (): ScenarioDefinition => ({
  schemaVersion: 1,
  id: "three-stage-main",
  name: "三轮混合模式主回归",
  year: 2026,
  timezone: "Asia/Shanghai",
  refereeConnectionId: "ref-1",
  players: [
    { id: "p1", displayName: "Alpha", connectionId: "101" },
    { id: "p2", displayName: "Beta", connectionId: "102" },
    { id: "p3", displayName: "Gamma", connectionId: "103" },
    { id: "p4", displayName: "Delta", connectionId: "104" },
    { id: "p5", displayName: "测试选手", connectionId: "105" }
  ],
  stages: [
    { id: "s1", order: 1, level: 1, mode: "SR", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
    { id: "s2", order: 2, level: 2, mode: "HS", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
    { id: "s3", order: 3, level: 13, mode: "SR", timeLimitMs: 900_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
  ],
  events: [
    { atMs: 0, sourceId: "login-1", type: "login", playerId: "p1", connectionId: "101" },
    { atMs: 0, sourceId: "login-2", type: "login", playerId: "p2", connectionId: "102" },
    { atMs: 0, sourceId: "login-3", type: "login", playerId: "p3", connectionId: "103" },
    { atMs: 0, sourceId: "login-4", type: "login", playerId: "p4", connectionId: "104" },
    { atMs: 0, sourceId: "login-5", type: "login", playerId: "p5", connectionId: "105" },
    { atMs: 500, sourceId: "practice-finish", type: "finish", stageId: "s1", playerId: "p2", score: 500, elapsedMs: 50_000 },
    { atMs: 900, sourceId: "ready-1", type: "ready", stageId: "s1", refereeConnectionId: "ref-1" },
    { atMs: 1_000, sourceId: "go-1", type: "go", stageId: "s1", refereeConnectionId: "ref-1" },
    { atMs: 2_000, sourceId: "s1-f1", type: "finish", stageId: "s1", playerId: "p1", score: 1_000, elapsedMs: 1_000 },
    { atMs: 2_200, sourceId: "s1-f2", type: "finish", stageId: "s1", playerId: "p2", score: 900, elapsedMs: 1_200 },
    { atMs: 2_400, sourceId: "s1-f3", type: "finish", stageId: "s1", playerId: "p3", score: 800, elapsedMs: 1_400 },
    { atMs: 2_600, sourceId: "s1-f4", type: "finish", stageId: "s1", playerId: "p4", score: 700, elapsedMs: 1_600 },
    { atMs: 2_800, sourceId: "s1-d5", type: "dnf", stageId: "s1", playerId: "p5", reason: "timeout" },
    { atMs: 4_000, sourceId: "go-2", type: "go", stageId: "s2", refereeConnectionId: "ref-1" },
    { atMs: 5_000, sourceId: "s2-f2", type: "finish", stageId: "s2", playerId: "p2", score: 1_800, elapsedMs: 1_000 },
    { atMs: 5_100, sourceId: "s2-f1", type: "finish", stageId: "s2", playerId: "p1", score: 2_000, elapsedMs: 1_100 },
    { atMs: 5_200, sourceId: "s2-f3", type: "finish", stageId: "s2", playerId: "p3", score: 1_800, elapsedMs: 1_200 },
    { atMs: 5_300, sourceId: "s2-f4", type: "finish", stageId: "s2", playerId: "p4", score: 1_500, elapsedMs: 1_300 },
    { atMs: 5_400, sourceId: "s2-d5", type: "dnf", stageId: "s2", playerId: "p5", reason: "warning" },
    { atMs: 7_000, sourceId: "go-3", type: "go", stageId: "s3", refereeConnectionId: "ref-1" },
    { atMs: 8_000, sourceId: "s3-f3", type: "finish", stageId: "s3", playerId: "p3", score: 1_000, elapsedMs: 1_000 },
    { atMs: 8_200, sourceId: "s3-f1", type: "finish", stageId: "s3", playerId: "p1", score: 900, elapsedMs: 1_200 },
    { atMs: 8_400, sourceId: "s3-f4", type: "finish", stageId: "s3", playerId: "p4", score: 800, elapsedMs: 1_400 },
    { atMs: 8_600, sourceId: "s3-f2", type: "finish", stageId: "s3", playerId: "p2", score: 700, elapsedMs: 1_600 },
    { atMs: 8_800, sourceId: "s3-d5", type: "dnf", stageId: "s3", playerId: "p5", reason: "timeout" }
  ],
  expected: { attempts: 3, scoreboardVersions: 15 }
});

export class CompetitionService {
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly testRuns = new Map<string, TestRuntime>();
  private readonly workRuntimes = new Map<string, WorkRuntime>();
  private readonly idempotency = new Map<string, unknown>();
  private readonly confirmations = new Map<string, ConfirmationRecord>();

  public constructor(
    public readonly journal = new EventJournal(),
    private readonly options: { database?: OpenedDatabase; dataRoot?: string } = {}
  ) {
    this.loadCompetitions();
  }

  public list(): readonly CompetitionRecord[] {
    if (this.options.database) this.loadCompetitions();
    return [...this.competitions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public create(input: { name: string; mode: CompetitionMode; idempotencyKey: string }): CompetitionRecord {
    const old = this.idempotency.get(`create:${input.idempotencyKey}`);
    if (old) return old as CompetitionRecord;
    if (!input.name.trim()) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    if (input.mode !== "work" && input.mode !== "test") throw new ServiceError("VALIDATION_FAILED", "无效比赛模式", 400);
    const now = new Date().toISOString();
    const record: CompetitionRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      mode: input.mode,
      status: "draft",
      stateVersion: 0,
      capabilities: capabilitiesFor(input.mode),
      createdAt: now,
      updatedAt: now
    };
    const config = createDefaultCompetitionConfig(record.name);
    this.withDatabase((database) => {
      database.sqlite.transaction(() => {
        database.sqlite.prepare("INSERT INTO competitions(id,name,mode,status,timezone,state_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(record.id, record.name, record.mode, record.status, config.timezone, record.stateVersion, record.createdAt, record.updatedAt);
        this.upsertConfig(record.id, 0, false, config);
        this.savePayload(record.id, { archives: [] });
      })();
    });
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

  public updateDraft(id: string, input: Partial<CompetitionConfig> & { expectedStateVersion: number; idempotencyKey: string }): CompetitionRecord {
    const key = `${id}:draft:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CompetitionRecord;
    const current = this.get(id);
    if (current.stateVersion !== input.expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    if (current.status !== "draft") throw new ServiceError("STATE_CONFLICT", "只有草稿比赛可以直接编辑配置", 409);
    const nextConfig = this.normalizeConfig({ ...this.getDraftConfig(id), ...input, name: input.name ?? this.getDraftConfig(id).name });
    const updated = { ...current, name: nextConfig.name, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.withDatabase((database) => {
      database.sqlite.transaction(() => {
        this.upsertConfig(id, 0, false, nextConfig);
        database.sqlite.prepare("UPDATE competitions SET name=?, timezone=?, state_version=?, updated_at=? WHERE id=?")
          .run(updated.name, nextConfig.timezone, updated.stateVersion, updated.updatedAt, id);
        this.savePayload(id, this.getPayload(id));
      })();
    });
    this.competitions.set(id, updated);
    this.idempotency.set(key, updated);
    this.journal.append({ type: "competition.draft-updated", competitionId: id, stateVersion: updated.stateVersion, data: { competition: updated, config: nextConfig } });
    return updated;
  }

  public publish(id: string, expectedStateVersion: number, idempotencyKey: string): CompetitionRecord {
    const key = `${id}:publish:${idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CompetitionRecord;
    const current = this.get(id);
    if (current.stateVersion !== expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    const config = this.normalizeConfig(this.getDraftConfig(id));
    const issues = this.validatePublishConfig(config);
    if (issues.length > 0) throw new ServiceError("VALIDATION_FAILED", "发布检查未通过", 400, { issues });
    const updated = { ...current, status: "published" as const, name: config.name, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.withDatabase((database) => {
      database.sqlite.transaction(() => {
        this.upsertConfig(id, updated.stateVersion, true, config);
        database.sqlite.prepare("UPDATE competitions SET name=?, status=?, timezone=?, state_version=?, updated_at=? WHERE id=?")
          .run(updated.name, updated.status, config.timezone, updated.stateVersion, updated.updatedAt, id);
        this.savePayload(id, this.getPayload(id));
      })();
    });
    this.competitions.set(id, updated);
    this.idempotency.set(key, updated);
    this.journal.append({ type: "competition.published", competitionId: id, stateVersion: updated.stateVersion, data: updated });
    return updated;
  }

  public snapshot(id: string): CompetitionSnapshot {
    const competition = this.toRecordView(this.get(id));
    const payload = this.getPayload(id);
    const activeRunId = competition.activeRunId ?? payload.activeRunId;
    const testRun = activeRunId ? this.getTestRunSnapshot(id, activeRunId) : undefined;
    const workRuntime = this.workRuntimes.get(id);
    const workScoreboard = workRuntime?.engine.snapshot().scoreboardVersions.map(scoreboardView) ?? [];
    const testScoreboard = testRun?.engine.scoreboardVersions ?? [];
    const scoreboardVersions = [
      ...(competition.mode === "test" ? testScoreboard : workScoreboard),
      ...(payload.scoreboardRevisions ?? [])
    ];
    return {
      competition,
      config: this.getDraftConfig(id),
      ...(this.getPublishedConfig(id) === undefined ? {} : { publishedConfig: this.getPublishedConfig(id) as CompetitionConfig }),
      runtime: competition.mode === "test"
        ? testRun?.automation ?? automationView("test")
        : automationView("work", workRuntime?.controller.snapshot(), this.commandHistory(id)),
      scoreboardVersions,
      currentScoreboard: scoreboardVersions.at(-1)?.entries ?? [],
      ...(testRun === undefined ? {} : { testRun }),
      archives: payload.archives ?? []
    };
  }

  public listTestScenarios(): readonly TestScenarioSummary[] {
    return this.loadScenarioDefinitions().map(scenarioSummary);
  }

  public getTestScenario(id: string): ScenarioDefinition {
    const scenario = this.loadScenarioDefinitions().find((candidate) => candidate.id === id);
    if (!scenario) throw new ServiceError("NOT_FOUND", "测试场景不存在", 404);
    return scenario;
  }

  public createTestRunFromScenario(competitionId: string, scenarioId: string): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    return this.createTestRun(competitionId, this.getTestScenario(scenarioId));
  }

  public createTestRun(competitionId: string, input: unknown): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    const competition = this.get(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const definition = assertScenarioDefinition(input);
    const runtime = this.makeTestRuntime(competitionId, definition);
    this.testRuns.set(runtime.id, runtime);
    const config = this.getDraftConfig(competitionId);
    if (config.participants.length === 0) {
      this.upsertConfig(competitionId, 0, false, {
        ...config,
        participants: definition.players.map((player) => ({
          id: player.id,
          displayName: player.displayName,
          role: "participant",
          connectionIds: [player.connectionId],
          online: false,
          currentStageStatus: "not-started"
        }))
      });
    }
    this.persistTestRuntime(runtime, true);
    this.journal.append({ type: "test-run.created", competitionId, stateVersion: competition.stateVersion, data: { runId: runtime.id, scenarioId: definition.id } });
    return { runId: runtime.id, snapshot: runtime.engine.snapshot(), run: this.getTestRunSnapshot(competitionId, runtime.id) };
  }

  public advanceTestRun(competitionId: string, runId: string, all: boolean): EngineSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    const events = all ? runtime.runner.playAll() : [runtime.runner.next()].filter((event): event is ScenarioEvent => event !== undefined);
    for (const event of events) this.applyTestEvent(runtime, event, true);
    this.persistTestRuntime(runtime);
    const snapshot = runtime.engine.snapshot();
    this.saveScoreboards(competitionId, snapshot.scoreboardVersions);
    this.journal.append({ type: "scoreboard.snapshot", competitionId, data: snapshot });
    return snapshot;
  }

  public resetTestRun(competitionId: string, runId: string): EngineSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    const reset = this.makeTestRuntime(competitionId, runtime.definition, runtime.id, runtime.createdAt);
    this.testRuns.set(runId, reset);
    this.persistTestRuntime(reset);
    const payload = this.getPayload(competitionId);
    this.savePayload(competitionId, { ...payload, scoreboardRevisions: [] });
    this.journal.append({ type: "test-run.reset", competitionId, data: { runId } });
    return reset.engine.snapshot();
  }

  public startTestAutomation(competitionId: string, runId: string, readyInMs = 0): AutomationSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    runtime.automation.enable(runtime.automationClock.now() + readyInMs);
    runtime.operations.push({ kind: "automation-start", readyInMs });
    this.settleTestAutomation(runtime);
    this.persistTestRuntime(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.automation-started", competitionId, data: snapshot });
    return snapshot;
  }

  public advanceTestAutomation(competitionId: string, runId: string, milliseconds: number): AutomationSnapshot {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new ServiceError("VALIDATION_FAILED", "推进时间必须是非负数", 400);
    const runtime = this.getTestRuntime(competitionId, runId);
    runtime.automationClock.advanceBy(milliseconds);
    runtime.operations.push({ kind: "advance-clock", milliseconds });
    this.settleTestAutomation(runtime);
    this.persistTestRuntime(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.clock-advanced", competitionId, data: { runId, milliseconds, snapshot } });
    return snapshot;
  }

  public injectTestFault(competitionId: string, runId: string, input: { fault: string; playerId?: string; milliseconds?: number }): AutomationSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    this.applyFault(runtime, input);
    runtime.operations.push({ kind: "fault", fault: input.fault, ...(input.playerId === undefined ? {} : { playerId: input.playerId }), ...(input.milliseconds === undefined ? {} : { milliseconds: input.milliseconds }) });
    this.settleTestAutomation(runtime);
    this.persistTestRuntime(runtime);
    const snapshot = runtime.automation.snapshot();
    this.journal.append({ type: "test-run.fault", competitionId, data: { runId, ...input, snapshot } });
    return snapshot;
  }

  public getTestAutomation(competitionId: string, runId: string): AutomationSnapshot {
    return this.getTestRuntime(competitionId, runId).automation.snapshot();
  }

  public getTestRunSnapshot(competitionId: string, runId: string): TestRunSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    const engine = runtime.engine.snapshot();
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
      automation: automationView("test", runtime.automation.snapshot(), [
        ...this.commandHistory(competitionId),
        ...runtime.automation.snapshot().actions.map((action) => ({
          id: action.id,
          actionType: action.kind,
          status: "simulated" as const,
          createdAt: new Date(action.createdAtMs).toISOString(),
          updatedAt: new Date(action.createdAtMs).toISOString(),
          command: action.message ?? action.kind,
          responseLine: "模拟回显成功",
          simulated: true
        }))
      ])
    };
  }

  public getTestScoreboardVersion(competitionId: string, runId: string, version?: number): {
    competition: CompetitionRecord;
    definition: ScenarioDefinition;
    scoreboard: ScoreboardVersion;
    automation: AutomationSnapshot;
  } {
    const runtime = this.getTestRuntime(competitionId, runId);
    const versions = this.snapshot(competitionId).scoreboardVersions;
    const selected = version === undefined ? versions.at(-1) : versions.find((candidate) => candidate.version === version);
    if (!selected) throw new ServiceError("NOT_FOUND", "榜单版本不存在", 404);
    return {
      competition: this.get(competitionId),
      definition: runtime.definition,
      scoreboard: this.toScoreboardVersion(competitionId, selected),
      automation: runtime.automation.snapshot()
    };
  }

  public getLatestScoreboard(id: string, version?: number): ScoreboardVersion {
    const snapshot = this.snapshot(id);
    const selected = version === undefined ? snapshot.scoreboardVersions.at(-1) : snapshot.scoreboardVersions.find((candidate) => candidate.version === version);
    if (!selected) throw new ServiceError("NOT_FOUND", "榜单版本不存在", 404);
    return this.toScoreboardVersion(id, selected);
  }

  public startWorkMode(competitionId: string): RuntimeSnapshot {
    const competition = this.get(competitionId);
    if (competition.mode !== "work") throw new ServiceError("CAPABILITY_UNSUPPORTED", "测试模式不支持真实 MockClient", 409);
    const config = this.getPublishedConfig(competitionId);
    if (!config) throw new ServiceError("STATE_CONFLICT", "请先发布比赛配置", 409);
    if (config.participants.filter((participant) => participant.role === "participant").length === 0) {
      throw new ServiceError("VALIDATION_FAILED", "工作模式至少需要一名参赛者", 400);
    }
    const existing = this.workRuntimes.get(competitionId);
    if (existing) return automationView("work", existing.controller.snapshot(), this.commandHistory(competitionId));

    const executable = resolve(serverWindowsRoot(), "BallanceMMOMockClient.exe");
    if (!existsSync(executable)) throw new ServiceError("MOCK_CLIENT_MISSING", "未找到 BallanceMMOMockClient.exe", 500, { executable });
    const root = this.competitionDataRoot(competitionId, "work");
    const logPath = join(root, "logs", "mockclient.log");
    mkdirSync(join(root, "logs"), { recursive: true });
    const mockClientVersion = readMockClientVersion(executable, serverWindowsRoot());
    const client = new ManagedMockClient({
      executable,
      workingDirectory: serverWindowsRoot(),
      server: config.server,
      loginName: config.loginName,
      uuid: randomUUID(),
      logPath
    });
    const runtime = this.makeWorkRuntime(competitionId, config, client, mockClientVersion);
    client.onLine((line) => {
      runtime.commands.observeLine(line);
      this.ingestWorkLine(runtime, line);
    });
    client.start();
    this.workRuntimes.set(competitionId, runtime);
    const payload = this.getPayload(competitionId);
    this.savePayload(competitionId, { ...payload, work: { started: true, mockClientVersion } });
    this.journal.append({ type: "work.started", competitionId, data: { mockClientVersion } });
    return automationView("work", runtime.controller.snapshot(), this.commandHistory(competitionId));
  }

  public async enableAutomation(competitionId: string, input: { runId?: string; readyInMs?: number }): Promise<RuntimeSnapshot> {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = input.runId ?? this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      return automationView("test", this.startTestAutomation(competitionId, runId, input.readyInMs ?? 0), [simulatedCommand("automation-start")]);
    }
    const runtime = this.workRuntimes.get(competitionId) ?? this.makeDetachedWorkRuntime(competitionId);
    runtime.controller.enable(runtime.controller.snapshot().plannedReadyAtMs ?? performance.now() + (input.readyInMs ?? 0));
    await runtime.runtime.dispatch();
    this.workRuntimes.set(competitionId, runtime);
    this.saveWorkRuntimeSnapshot(runtime);
    return automationView("work", runtime.controller.snapshot(), this.commandHistory(competitionId));
  }

  public pauseAutomation(competitionId: string): RuntimeSnapshot {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      const runtime = this.getTestRuntime(competitionId, runId);
      runtime.automation.pause();
      this.persistTestRuntime(runtime);
      return automationView("test", runtime.automation.snapshot(), [simulatedCommand("automation-pause")]);
    }
    const runtime = this.workRuntimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
    runtime.controller.pause();
    this.saveWorkRuntimeSnapshot(runtime);
    return automationView("work", runtime.controller.snapshot(), this.commandHistory(competitionId));
  }

  public createConfirmation(competitionId: string, input: { kind: ConfirmationSummary["kind"]; target?: string }): ConfirmationSummary {
    const competition = this.get(competitionId);
    const expiresAtMs = Date.now() + 60_000;
    const token = randomUUID();
    const target = input.target ?? competition.id;
    let impactHash = createHash("sha256").update(`${competitionId}:${target}:${competition.stateVersion}:${input.kind}`).digest("hex");
    let runtimeToken: string | undefined;
    if (input.kind === "restart") {
      try {
        const issued = this.controllerFor(competitionId).issueRestartConfirmation(target);
        impactHash = issued.impactHash;
        runtimeToken = issued.token;
      } catch (error) {
        throw new ServiceError("CONFIRMATION_UNAVAILABLE", error instanceof Error ? error.message : "当前没有可确认的重赛事故", 409);
      }
    }
    const record: ConfirmationRecord = {
      token,
      ...(runtimeToken === undefined ? {} : { runtimeToken }),
      kind: input.kind,
      competitionId,
      target,
      stateVersion: competition.stateVersion,
      impactHash,
      expiresAtMs
    };
    this.confirmations.set(token, record);
    return {
      token,
      kind: input.kind,
      expiresAt: new Date(expiresAtMs).toISOString(),
      target,
      stateVersion: competition.stateVersion,
      impactHash,
      summary: `${competition.name} · ${input.kind} · 目标 ${target} · 版本 ${competition.stateVersion}`
    };
  }

  public async performAction(
    competitionId: string,
    input: { expectedStateVersion: number; idempotencyKey: string; action: CompetitionAction }
  ): Promise<CommandRecordView | ScoreboardVersionView> {
    const key = `${competitionId}:action:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CommandRecordView;
    const competition = this.get(competitionId);
    if (competition.stateVersion !== input.expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: competition.stateVersion });
    if (input.action.type === "scoreboard-override") {
      return this.applyScoreboardOverride(competitionId, {
        ...input.action,
        expectedStateVersion: input.expectedStateVersion,
        idempotencyKey: input.idempotencyKey
      });
    }
    const confirmation = this.consumeActionConfirmation(competitionId, input.action);
    const handledLocally = await this.applyLocalAction(competitionId, input.action, confirmation);
    let view: CommandRecordView;
    if (handledLocally) {
      view = this.localActionRecord(input.action.type, this.describeAction(input.action), competition.mode === "test");
      this.recordCommandView(competitionId, input.idempotencyKey, view);
    } else if (competition.mode === "test") {
      view = simulatedCommand(input.action.type, this.describeAction(input.action));
      this.recordCommandView(competitionId, input.idempotencyKey, view);
    } else {
      const runtime = this.workRuntimes.get(competitionId);
      if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
      const command = this.toCommandAction(competitionId, input.action);
      view = commandView(await runtime.commands.enqueue(command, input.idempotencyKey));
    }
    this.bumpCompetitionVersion(competitionId);
    this.idempotency.set(key, view);
    this.journal.append({
      type: competition.mode === "test" ? "command.simulated" : "command.updated",
      competitionId,
      stateVersion: this.get(competitionId).stateVersion,
      data: view
    });
    return view;
  }

  public applyScoreboardOverride(
    competitionId: string,
    input: ScoreboardOverrideInput & { expectedStateVersion: number; idempotencyKey: string }
  ): ScoreboardVersionView {
    const key = `${competitionId}:scoreboard-override:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as ScoreboardVersionView;
    const competition = this.get(competitionId);
    if (competition.stateVersion !== input.expectedStateVersion) {
      throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: competition.stateVersion });
    }
    this.consumeConfirmation(
      competitionId,
      "scoreboard-override",
      input.confirmationToken,
      input.impactHash,
      `${input.playerId}:${input.stageId ?? "total"}`
    );
    const base = this.getLatestScoreboard(competitionId);
    const ledger = new ScoreboardRevisionLedger(base);
    let revised;
    try {
      revised = ledger.apply({
        playerId: input.playerId,
        ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.totalPoints === undefined ? {} : { totalPoints: input.totalPoints }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.rankPolicy === undefined ? {} : { rankPolicy: input.rankPolicy }),
        actor: input.actor,
        reason: input.reason,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence })
      });
    } catch (error) {
      throw new ServiceError("VALIDATION_FAILED", error instanceof Error ? error.message : "榜单修订失败", 400);
    }
    const override = ledger.history().overrides.at(-1);
    if (!override) throw new ServiceError("INTERNAL_ERROR", "榜单修订记录缺失", 500);
    const versionNumber = base.version + 1;
    const hashPayload = { version: versionNumber, baseVersion: base.version, triggerOverrideId: override.id, entries: revised.entries };
    const version: ScoreboardVersion = {
      id: randomUUID(),
      version: versionNumber,
      triggerSourceId: `override:${override.id}`,
      stageId: input.stageId ?? base.stageId,
      entries: revised.entries,
      deterministicHash: createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex")
    };
    const view = scoreboardView(version);
    const payload = this.getPayload(competitionId);
    this.savePayload(competitionId, { ...payload, scoreboardRevisions: [...(payload.scoreboardRevisions ?? []), view] });
    this.saveScoreboards(competitionId, [version]);
    this.withDatabase((database) => {
      database.sqlite.prepare("INSERT INTO overrides(id,competition_id,target_type,target_id,before_value,after_value,reason,actor,reversed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          override.id,
          competitionId,
          input.stageId ? "stage-result" : "scoreboard-entry",
          input.stageId ? `${input.playerId}:${input.stageId}` : input.playerId,
          JSON.stringify(override.beforeValue),
          JSON.stringify(override.afterValue),
          override.reason,
          override.actor,
          null,
          override.createdAt
        );
    });
    this.bumpCompetitionVersion(competitionId);
    this.idempotency.set(key, view);
    this.journal.append({ type: "scoreboard.override", competitionId, stateVersion: this.get(competitionId).stateVersion, data: view });
    return view;
  }

  public recordArchive(competitionId: string, archive: CreatedArchive): void {
    const payload = this.getPayload(competitionId);
    const archives = [...(payload.archives ?? []), {
      version: archive.manifest.archiveVersion,
      directory: archive.directory,
      packagePath: archive.packagePath,
      manifestHash: archive.manifestHash,
      createdAt: archive.manifest.generatedAt
    }];
    this.savePayload(competitionId, { ...payload, archives });
    this.withDatabase((database) => {
      database.sqlite.prepare("INSERT INTO archive_versions(id,competition_id,version,mode,relative_path,manifest_hash,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          competitionId,
          archive.manifest.archiveVersion,
          this.get(competitionId).mode,
          archive.directory,
          archive.manifestHash,
          archive.manifest.generatedAt
        );
    });
  }

  public close(): void {
    for (const runtime of this.workRuntimes.values()) {
      void runtime.client?.stop().catch(() => undefined);
    }
  }

  private loadCompetitions(): void {
    if (!this.options.database) return;
    this.competitions.clear();
    for (const item of rows<{
      id: string; name: string; mode: CompetitionMode; status: CompetitionLifecycleStatus; state_version: number; created_at: string; updated_at: string;
    }>(this.options.database, "SELECT id,name,mode,status,state_version,created_at,updated_at FROM competitions")) {
      const payload = this.getPayload(item.id);
      this.competitions.set(item.id, {
        id: item.id,
        name: item.name,
        mode: item.mode,
        status: item.status,
        stateVersion: item.state_version,
        capabilities: capabilitiesFor(item.mode),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        ...(payload.activeRunId === undefined ? {} : { activeRunId: payload.activeRunId })
      });
    }
  }

  private toRecordView(record: CompetitionRecord): CompetitionRecordView {
    return {
      id: record.id,
      name: record.name,
      mode: record.mode,
      status: record.status,
      stateVersion: record.stateVersion,
      capabilities: record.capabilities,
      updatedAt: record.updatedAt,
      ...(record.activeRunId === undefined ? {} : { activeRunId: record.activeRunId })
    };
  }

  private withDatabase(operation: (database: OpenedDatabase) => void): void {
    if (this.options.database) operation(this.options.database);
  }

  private getPayload(competitionId: string): ServiceSnapshotPayload {
    const stored = row<{ payload: string }>(this.options.database, "SELECT payload FROM runtime_snapshots WHERE competition_id=?", competitionId);
    if (!stored) return {};
    return JSON.parse(stored.payload) as ServiceSnapshotPayload;
  }

  private savePayload(competitionId: string, payload: ServiceSnapshotPayload): void {
    this.withDatabase((database) => {
      const current = this.competitions.get(competitionId)?.stateVersion ?? 0;
      database.sqlite.prepare("INSERT INTO runtime_snapshots(competition_id,state_version,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(competition_id) DO UPDATE SET state_version=excluded.state_version,payload=excluded.payload,updated_at=excluded.updated_at")
        .run(competitionId, current, JSON.stringify(payload), new Date().toISOString());
    });
  }

  private upsertConfig(competitionId: string, version: number, immutable: boolean, payload: CompetitionConfig): void {
    this.withDatabase((database) => {
      database.sqlite.prepare("INSERT INTO config_versions(id,competition_id,version,immutable,payload,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(competition_id,version) DO UPDATE SET immutable=excluded.immutable,payload=excluded.payload")
        .run(randomUUID(), competitionId, version, immutable ? 1 : 0, JSON.stringify(payload), new Date().toISOString());
    });
  }

  private getDraftConfig(competitionId: string): CompetitionConfig {
    const stored = row<{ payload: string }>(this.options.database, "SELECT payload FROM config_versions WHERE competition_id=? AND version=0", competitionId);
    return stored ? JSON.parse(stored.payload) as CompetitionConfig : createDefaultCompetitionConfig(this.get(competitionId).name);
  }

  private getPublishedConfig(competitionId: string): CompetitionConfig | undefined {
    const stored = row<{ payload: string }>(this.options.database, "SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1 ORDER BY version DESC LIMIT 1", competitionId);
    return stored ? JSON.parse(stored.payload) as CompetitionConfig : undefined;
  }

  private normalizeConfig(config: CompetitionConfig): CompetitionConfig {
    const name = config.name.trim();
    if (!name) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    const scoring = {
      ...config.scoring,
      points: config.scoring.points.map((point) => {
        if (!Number.isFinite(point)) throw new ServiceError("VALIDATION_FAILED", "积分必须是有限数字", 400);
        if (point < 0 && !config.scoring.allowNegative) throw new ServiceError("VALIDATION_FAILED", "默认不允许负分", 400);
        return point;
      })
    };
    const stages = [...config.stages].sort((left, right) => left.order - right.order).map((stage, index) => ({
      ...stage,
      order: index + 1,
      scoring: stage.scoring.length > 0 ? stage.scoring : scoring.points,
      minimumScoringPlace: stage.minimumScoringPlace || scoring.minimumScoringPlace
    }));
    return { ...config, name, scoring, stages };
  }

  private validatePublishConfig(config: CompetitionConfig): string[] {
    const issues: string[] = [];
    if (!config.server.trim()) issues.push("服务器不能为空");
    if (["0.bmmo.win", "1.bmmo.win", "2.bmmo.win"].some((server) => config.server.startsWith(`${server}:`))) issues.push("bmmo.win 预设服务器不得填写端口");
    if (config.stages.length === 0) issues.push("至少需要一个轮次");
    for (const stage of config.stages) {
      if (stage.level < 0 || stage.level > 13) issues.push(`${stage.label} 关卡号必须在 0..13`);
      if (stage.scoring.length === 0) issues.push(`${stage.label} 缺少积分规则`);
    }
    if (config.participants.filter((participant) => participant.role === "participant").length === 0) issues.push("至少需要一名参赛者");
    return issues;
  }

  private makeTestRuntime(competitionId: string, definition: ScenarioDefinition, id: string = randomUUID(), createdAt: string = new Date().toISOString()): TestRuntime {
    const automationClock = new VirtualClock(0);
    const automation = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      stages: [...definition.stages].sort((left, right) => left.order - right.order).map((stage) => ({
        id: stage.id,
        map: String(stage.level),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      }))
    }, automationClock);
    return {
      id,
      competitionId,
      definition,
      runner: new ScenarioRunner(definition),
      engine: new CompetitionEngine(definition),
      automationClock,
      automation,
      automationRuntime: new TestAutomationRuntime(automation),
      playedEvents: 0,
      operations: [],
      createdAt,
      updatedAt: createdAt
    };
  }

  private getTestRuntime(competitionId: string, runId: string): TestRuntime {
    const competition = this.get(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const existing = this.testRuns.get(runId);
    if (existing?.competitionId === competitionId) return existing;
    const persisted = this.getPayload(competitionId).testRuns?.find((candidate) => candidate.id === runId);
    if (!persisted) throw new ServiceError("NOT_FOUND", "测试运行不存在", 404);
    const restored = this.restoreTestRuntime(competitionId, persisted);
    this.testRuns.set(runId, restored);
    return restored;
  }

  private restoreTestRuntime(competitionId: string, persisted: PersistedTestRun): TestRuntime {
    const runtime = this.makeTestRuntime(competitionId, persisted.definition, persisted.id, persisted.createdAt);
    for (let index = 0; index < persisted.playedEvents; index += 1) {
      const event = runtime.runner.next();
      if (event) this.applyTestEvent(runtime, event, false);
    }
    for (const operation of persisted.operations) {
      if (operation.kind === "automation-start") runtime.automation.enable(runtime.automationClock.now() + (operation.readyInMs ?? 0));
      else if (operation.kind === "advance-clock") runtime.automationClock.advanceBy(operation.milliseconds ?? 0);
      else if (operation.kind === "fault" && operation.fault) {
        this.applyFault(runtime, {
          fault: operation.fault,
          ...(operation.playerId === undefined ? {} : { playerId: operation.playerId }),
          ...(operation.milliseconds === undefined ? {} : { milliseconds: operation.milliseconds })
        });
      }
      this.settleTestAutomation(runtime);
    }
    runtime.operations = [...persisted.operations];
    runtime.playedEvents = persisted.playedEvents;
    runtime.updatedAt = persisted.updatedAt;
    return runtime;
  }

  private persistTestRuntime(runtime: TestRuntime, makeActive = false): void {
    runtime.updatedAt = new Date().toISOString();
    const payload = this.getPayload(runtime.competitionId);
    const withoutCurrent = (payload.testRuns ?? []).filter((candidate) => candidate.id !== runtime.id);
    const persisted: PersistedTestRun = {
      id: runtime.id,
      definition: runtime.definition,
      playedEvents: runtime.playedEvents,
      operations: runtime.operations,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt
    };
    this.savePayload(runtime.competitionId, {
      ...payload,
      ...(makeActive || !payload.activeRunId ? { activeRunId: runtime.id } : {}),
      ...(makeActive ? { scoreboardRevisions: [] } : {}),
      testRuns: [...withoutCurrent, persisted]
    });
    const record = this.competitions.get(runtime.competitionId);
    if (record) this.competitions.set(runtime.competitionId, { ...record, activeRunId: runtime.id });
  }

  private applyTestEvent(runtime: TestRuntime, event: ScenarioEvent, countEvent: boolean): void {
    runtime.engine.apply(event);
    this.applyAutomationEvent(runtime, event);
    if (countEvent) runtime.playedEvents += 1;
    this.journal.append({ type: "test-run.event", competitionId: runtime.competitionId, data: event });
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
      case "clock-jump":
        runtime.automationClock.advanceBy(input.milliseconds ?? 60_000);
        runtime.automation.observeTimingDiscontinuity("测试注入系统时钟或休眠跳变");
        break;
      default: throw new ServiceError("VALIDATION_FAILED", "未知故障类型", 400);
    }
  }

  private makeWorkRuntime(competitionId: string, config: CompetitionConfig, transport: CommandTransport, mockClientVersion?: string): WorkRuntime {
    const definition = this.configToScenarioDefinition(config);
    const controller = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      stages: definition.stages.map((stage) => ({
        id: stage.id,
        map: String(stage.level),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      policy: {
        announcementLeadMs: config.flow.announcementLeadMs,
        readyBufferMs: config.flow.readyBufferMs,
        reconnectStableMs: config.flow.reconnectStableMs,
        preStartWaitLimitMs: config.flow.delayLimitMs,
        intermissionMs: config.flow.intermissionMs,
        protectionWindowMs: config.flow.protectionWindowMs,
        groupDisconnectThreshold: config.flow.groupDisconnectThreshold
      }
    }, new SystemMonotonicClock());
    const commands = new CommandQueue(transport, 5_000, (record) => this.recordCommand(competitionId, record));
    return { competitionId, controller, engine: new CompetitionEngine(definition), commands, runtime: new WorkAutomationRuntime(controller, commands), ...(transport instanceof ManagedMockClient ? { client: transport } : {}), ...(mockClientVersion === undefined ? {} : { mockClientVersion }) };
  }

  private makeDetachedWorkRuntime(competitionId: string): WorkRuntime {
    const config = this.getPublishedConfig(competitionId);
    if (!config) throw new ServiceError("STATE_CONFLICT", "请先发布比赛配置", 409);
    const transport: CommandTransport = { write: async () => { throw new Error("MockClient is not running"); } };
    const runtime = this.makeWorkRuntime(competitionId, config, transport);
    this.workRuntimes.set(competitionId, runtime);
    return runtime;
  }

  private ingestWorkLine(runtime: WorkRuntime, line: string): void {
    const config = this.getPublishedConfig(runtime.competitionId);
    if (!config) return;
    const parsed = parseLogLine(line, { year: Number(config.date.slice(0, 4)), utcOffsetMinutes: utcOffsetMinutes(config.timezone) });
    const event = this.domainToScenarioEvent(config, parsed.event);
    if (event) {
      runtime.engine.apply(event);
      if (event.type === "login") runtime.controller.observeConnection(event.playerId, true);
      else if (event.type === "disconnect") runtime.controller.observeConnection(event.playerId, false);
      else if (event.type === "go") runtime.controller.observeAuthoritativeGo(event.stageId);
      else if (event.type === "finish") runtime.controller.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "finished", sourceId: event.sourceId, receivedAtMs: performance.now() });
      else if (event.type === "dnf") runtime.controller.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "dnf", sourceId: event.sourceId, reason: event.reason, receivedAtMs: performance.now() });
      else if (event.type === "cheat") runtime.controller.observeCheat(event.playerId, event.enabled, event.sourceId);
      this.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    }
    this.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
    this.saveWorkRuntimeSnapshot(runtime);
  }

  private domainToScenarioEvent(config: CompetitionConfig, event: DomainEvent): ScenarioEvent | undefined {
    const stage = config.stages.find((candidate) => candidate.level === ("level" in event ? event.level : -1));
    const participant = "connectionId" in event ? this.matchParticipant(config, event.connectionId, "playerName" in event ? event.playerName : "") : undefined;
    switch (event.type) {
      case "player-login":
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "login", playerId: participant.id, connectionId: event.connectionId } : undefined;
      case "player-disconnect":
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "disconnect", playerId: participant.id, connectionId: event.connectionId } : undefined;
      case "go":
        if (!stage || event.refereeName !== config.loginName && event.refereeName !== config.refereeName) return undefined;
        return { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "go", stageId: stage.id, refereeConnectionId: "work-referee" };
      case "finish":
        return stage && participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "finish", stageId: stage.id, playerId: participant.id, score: event.score, elapsedMs: event.elapsedMs } : undefined;
      case "dnf":
        return stage && participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "dnf", stageId: stage.id, playerId: participant.id, reason: event.cheat ? "cheat" : "dnf" } : undefined;
      case "cheat-changed":
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "cheat", playerId: participant.id, enabled: event.enabled } : undefined;
      default:
        return undefined;
    }
  }

  private matchParticipant(config: CompetitionConfig, connectionId: string, rawName: string): ParticipantView | undefined {
    return config.participants.find((participant) => participant.connectionIds.includes(connectionId))
      ?? config.participants.find((participant) => participant.displayName.toLocaleLowerCase("en-US") === rawName.toLocaleLowerCase("en-US"));
  }

  private configToScenarioDefinition(config: CompetitionConfig): ScenarioDefinition {
    const participants = config.participants.filter((participant) => participant.role === "participant");
    return {
      schemaVersion: 1,
      id: `work-${config.name}`,
      name: config.name,
      year: Number(config.date.slice(0, 4)),
      timezone: config.timezone,
      refereeConnectionId: "work-referee",
      players: participants.map((participant) => ({ id: participant.id, displayName: participant.displayName, connectionId: participant.connectionIds[0] ?? participant.id })),
      stages: config.stages.map((stage) => ({
        id: stage.id,
        order: stage.order,
        level: stage.level,
        mode: stage.mode,
        timeLimitMs: stage.timeLimitMs,
        scoring: [...stage.scoring],
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      events: [],
      expected: { attempts: 0, scoreboardVersions: 0 }
    };
  }

  private saveWorkRuntimeSnapshot(runtime: WorkRuntime): void {
    const payload = this.getPayload(runtime.competitionId);
    this.savePayload(runtime.competitionId, { ...payload, work: { started: true, ...(runtime.mockClientVersion === undefined ? {} : { mockClientVersion: runtime.mockClientVersion }) } });
  }

  private saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void {
    this.withDatabase((database) => {
      for (const version of versions) {
        database.sqlite.prepare("INSERT OR IGNORE INTO scoreboard_versions(id,competition_id,version,trigger_event_id,payload,deterministic_hash,created_at) VALUES (?,?,?,?,?,?,?)")
          .run(version.id, competitionId, version.version, version.triggerSourceId, JSON.stringify(version), version.deterministicHash, new Date().toISOString());
      }
    });
  }

  private controllerFor(competitionId: string): CompetitionController {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      return this.getTestRuntime(competitionId, runId).automation;
    }
    const runtime = this.workRuntimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
    return runtime.controller;
  }

  private consumeActionConfirmation(competitionId: string, action: CompetitionAction): ConfirmationRecord | undefined {
    switch (action.type) {
      case "manual-go":
        return this.consumeConfirmation(competitionId, "manual-go", action.confirmationToken, action.impactHash, competitionId);
      case "reschedule":
      case "extend-wait":
      case "end-stage":
        return this.consumeConfirmation(competitionId, "manual-action", action.confirmationToken, action.impactHash, competitionId);
      case "mark-dnf":
        return this.consumeConfirmation(competitionId, "manual-action", action.confirmationToken, action.impactHash, action.participantId);
      case "restart":
        return this.consumeConfirmation(competitionId, "restart", action.confirmationToken, action.impactHash, action.incidentId);
      case "void-attempt":
      case "restore-attempt":
        return this.consumeConfirmation(competitionId, "high-risk", action.confirmationToken, action.impactHash, action.attemptId);
      case "scoreboard-override":
        return this.consumeConfirmation(competitionId, "scoreboard-override", action.confirmationToken, action.impactHash, `${action.playerId}:${action.stageId ?? "total"}`);
      case "kick":
      case "crash":
        return this.consumeConfirmation(competitionId, "high-risk", action.confirmationToken, action.impactHash, action.playerName);
      case "raw-command":
        return this.consumeConfirmation(competitionId, "high-risk", action.confirmationToken, action.impactHash, competitionId);
      default:
        return undefined;
    }
  }

  private consumeConfirmation(
    competitionId: string,
    kind: ConfirmationSummary["kind"],
    token: string,
    impactHash: string,
    target?: string
  ): ConfirmationRecord {
    const record = this.confirmations.get(token);
    const competition = this.get(competitionId);
    if (!record || record.competitionId !== competitionId || record.kind !== kind || record.impactHash !== impactHash || target !== undefined && record.target !== target) {
      throw new ServiceError("CONFIRMATION_INVALID", "确认令牌与当前操作不匹配", 409);
    }
    if (Date.now() > record.expiresAtMs) {
      this.confirmations.delete(token);
      throw new ServiceError("CONFIRMATION_EXPIRED", "确认令牌已失效", 409);
    }
    if (record.stateVersion !== competition.stateVersion) {
      throw new ServiceError("CONFIRMATION_STALE", "比赛状态已变化，请重新确认", 409, { latestStateVersion: competition.stateVersion });
    }
    this.confirmations.delete(token);
    return record;
  }

  private async applyLocalAction(
    competitionId: string,
    action: CompetitionAction,
    confirmation?: ConfirmationRecord
  ): Promise<boolean> {
    const competition = this.get(competitionId);
    const controller = (): CompetitionController => this.controllerFor(competitionId);
    switch (action.type) {
      case "manual-go": {
        if (competition.mode === "work") return false;
        const runId = this.getPayload(competitionId).activeRunId as string;
        const runtime = this.getTestRuntime(competitionId, runId);
        const stageId = runtime.automation.snapshot().currentStageId;
        if (!stageId) throw new ServiceError("STATE_CONFLICT", "当前没有可发令的轮次", 409);
        runtime.automation.observeAuthoritativeGo(stageId);
        runtime.engine.apply({
          atMs: runtime.automationClock.now(),
          sourceId: `manual-go:${randomUUID()}`,
          type: "go",
          stageId,
          refereeConnectionId: runtime.definition.refereeConnectionId
        });
        this.persistTestRuntime(runtime);
        break;
      }
      case "reschedule":
        controller().reschedule(Date.parse(action.plannedReadyAt));
        break;
      case "extend-wait":
        controller().extendWait(action.milliseconds);
        break;
      case "end-stage":
        controller().endStage(action.reason);
        break;
      case "restart": {
        if (!confirmation?.runtimeToken) throw new ServiceError("CONFIRMATION_INVALID", "重赛确认缺少运行时凭据", 409);
        controller().confirmRestart({
          incidentId: action.incidentId,
          impactHash: action.impactHash,
          token: confirmation.runtimeToken,
          reason: action.reason
        });
        break;
      }
      case "void-attempt":
        controller().voidAttempt(action.attemptId);
        break;
      case "restore-attempt":
        controller().restoreAttempt(action.attemptId);
        break;
      case "mark-dnf": {
        const stageId = action.stageId ?? controller().snapshot().currentStageId;
        if (!stageId) throw new ServiceError("STATE_CONFLICT", "当前没有可标记 DNF 的轮次", 409);
        const sourceId = `manual-dnf:${randomUUID()}`;
        const event: ScenarioEvent = { atMs: Date.now(), sourceId, type: "dnf", stageId, playerId: action.participantId, reason: action.reason };
        if (competition.mode === "test") {
          const runId = this.getPayload(competitionId).activeRunId as string;
          const runtime = this.getTestRuntime(competitionId, runId);
          runtime.engine.apply(event);
          this.persistTestRuntime(runtime);
          this.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
        } else {
          const accepted = controller().recordResult({ stageId, playerId: action.participantId, status: "dnf", sourceId, reason: action.reason });
          if (accepted !== "accepted") throw new ServiceError("STATE_CONFLICT", `DNF 未被接受：${accepted}`, 409);
          const runtime = this.workRuntimes.get(competitionId) as WorkRuntime;
          runtime.engine.apply(event);
          this.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
        }
        break;
      }
      case "participant-associate":
        this.updateParticipantConnections(competitionId, action.participantId, (connections) =>
          [...new Set([...connections, action.connectionId])]);
        break;
      case "participant-split":
        this.updateParticipantConnections(competitionId, undefined, (connections) =>
          connections.filter((connectionId) => connectionId !== action.connectionId));
        break;
      case "participant-edit":
        this.editParticipant(competitionId, action);
        break;
      case "scoreboard-override":
        throw new ServiceError("CAPABILITY_UNSUPPORTED", "请使用榜单修订接口提交该动作", 409);
      default:
        return false;
    }
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (runId) this.persistTestRuntime(this.getTestRuntime(competitionId, runId));
    } else {
      const runtime = this.workRuntimes.get(competitionId);
      if (runtime) {
        await runtime.runtime.dispatch();
        this.saveWorkRuntimeSnapshot(runtime);
      }
    }
    return true;
  }

  private updateParticipantConnections(
    competitionId: string,
    participantId: string | undefined,
    update: (connections: readonly string[]) => string[]
  ): void {
    const config = this.getDraftConfig(competitionId);
    const participants = config.participants.map((participant) =>
      participantId === undefined || participant.id === participantId
        ? { ...participant, connectionIds: update(participant.connectionIds) }
        : participant);
    if (participantId !== undefined && !participants.some((participant) => participant.id === participantId)) {
      throw new ServiceError("NOT_FOUND", "参赛者不存在", 404);
    }
    this.upsertConfig(competitionId, 0, false, { ...config, participants });
  }

  private editParticipant(
    competitionId: string,
    action: Extract<CompetitionAction, { type: "participant-edit" }>
  ): void {
    const config = this.getDraftConfig(competitionId);
    let found = false;
    const participants = config.participants.map((participant) => {
      if (participant.id !== action.participantId) return participant;
      found = true;
      return {
        ...participant,
        ...(action.displayName === undefined ? {} : { displayName: action.displayName.trim() }),
        ...(action.notes === undefined ? {} : { notes: action.notes })
      };
    });
    if (!found) throw new ServiceError("NOT_FOUND", "参赛者不存在", 404);
    this.upsertConfig(competitionId, 0, false, { ...config, participants });
  }

  private localActionRecord(actionType: string, command: string, simulated: boolean): CommandRecordView {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      actionType,
      status: simulated ? "simulated" : "acknowledged",
      createdAt: now,
      updatedAt: now,
      command,
      responseLine: simulated ? "模拟结果已应用" : "本地裁判状态已更新",
      ...(simulated ? { simulated: true } : {})
    };
  }

  private bumpCompetitionVersion(competitionId: string): CompetitionRecord {
    const current = this.get(competitionId);
    const updated = { ...current, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.competitions.set(competitionId, updated);
    this.withDatabase((database) => {
      database.sqlite.prepare("UPDATE competitions SET state_version=?,updated_at=? WHERE id=?")
        .run(updated.stateVersion, updated.updatedAt, competitionId);
    });
    return updated;
  }

  private toScoreboardVersion(competitionId: string, view: ScoreboardVersionView): ScoreboardVersion {
    const participantCount = Math.max(this.getDraftConfig(competitionId).participants.length, view.entries.length);
    return {
      id: view.id,
      version: view.version,
      triggerSourceId: view.triggerSourceId,
      stageId: view.stageId,
      entries: view.entries.map((entry) => {
        const stages = entry.stages as ScoreboardEntry["stages"];
        const placeCounts = Array.from({ length: participantCount }, () => 0);
        for (const result of Object.values(stages)) {
          if (result.status === "finished") placeCounts[result.place - 1] = (placeCounts[result.place - 1] ?? 0) + 1;
        }
        return { ...entry, placeCounts, stages };
      }),
      deterministicHash: view.deterministicHash
    };
  }

  private recordCommand(competitionId: string, record: CommandRecord): void {
    this.withDatabase((database) => {
      database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(competition_id,idempotency_key) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at")
        .run(record.id, competitionId, record.idempotencyKey, record.action.type, record.status, JSON.stringify(record), record.createdAt, record.updatedAt);
    });
  }

  private recordCommandView(competitionId: string, idempotencyKey: string, record: CommandRecordView): void {
    this.withDatabase((database) => {
      database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(competition_id,idempotency_key) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at")
        .run(record.id, competitionId, idempotencyKey, record.actionType, record.status, JSON.stringify(record), record.createdAt, record.updatedAt);
    });
  }

  private commandHistory(competitionId: string): CommandRecordView[] {
    return rows<{ payload: string }>(this.options.database, "SELECT payload FROM command_audits WHERE competition_id=? ORDER BY created_at DESC LIMIT 50", competitionId)
      .map((item) => {
        const stored = JSON.parse(item.payload) as CommandRecord | CommandRecordView;
        return "action" in stored ? commandView(stored) : stored;
      });
  }

  private toCommandAction(competitionId: string, action: CompetitionAction): CommandAction {
    const runtime = this.workRuntimes.get(competitionId);
    const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
    const currentStageId = runtime?.controller.snapshot().currentStageId;
    const stage = config.stages.find((candidate) => candidate.id === currentStageId) ?? config.stages[0];
    if (!stage) throw new ServiceError("STATE_CONFLICT", "比赛没有可执行动作的轮次", 409);
    switch (action.type) {
      case "announcement": return { type: "announcement", text: action.text };
      case "ready": return { type: "ready", map: String(stage.level), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "cheat-off": return { type: "cheat-off" };
      case "manual-go": return { type: "go", map: String(stage.level), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "kick": return { type: "kick", playerName: action.playerName, reason: action.reason };
      case "crash": return { type: "crash", playerName: action.playerName, reason: action.reason };
      case "raw-command": return { type: "raw", command: action.command };
      default: throw new ServiceError("CAPABILITY_UNSUPPORTED", `动作 ${action.type} 不需要或不支持 MockClient 命令`, 409);
    }
  }

  private describeAction(action: CompetitionAction): string {
    switch (action.type) {
      case "announcement": return action.text;
      case "kick": return `kick ${action.playerName}`;
      case "crash": return `crash ${action.playerName}`;
      case "raw-command": return action.command;
      case "participant-associate": return `${action.participantId} <- ${action.connectionId}`;
      case "participant-split": return action.connectionId;
      case "participant-edit": return action.participantId;
      case "scoreboard-override": return `${action.playerId}:${action.stageId ?? "total"}`;
      default: return action.type;
    }
  }

  private competitionDataRoot(competitionId: string, mode: CompetitionMode): string {
    return join(resolve(this.options.dataRoot ?? process.cwd()), mode, competitionId);
  }

  private loadScenarioDefinitions(): ScenarioDefinition[] {
    const loaded: ScenarioDefinition[] = [];
    const root = resolve(process.cwd(), "test", "fixtures", "scenarios");
    if (existsSync(root)) {
      for (const directory of readdirSync(root, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const file = join(root, directory.name, "scenario.json");
        if (!existsSync(file)) continue;
        try {
          loaded.push(assertScenarioDefinition(JSON.parse(readFileSync(file, "utf8")) as unknown));
        } catch {
          // Invalid fixture files are ignored by the scenario browser; tests still validate them directly.
        }
      }
    }
    if (!loaded.some((scenario) => scenario.id === "three-stage-main")) loaded.push(builtinScenario());
    return loaded.sort((left, right) => left.name.localeCompare(right.name));
  }
}
