import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  assertScenarioDefinition,
  capabilitiesFor,
  createDefaultCompetitionConfig,
  minimumScoringPlaceFor,
  normalizeRefereeName,
  validateCompetitionConfigForPublish,
  type CommandRecordView,
  type ActionAvailability,
  type AttentionItem,
  type CompetitionAction,
  type CompetitionConfig,
  type CompetitionLifecycleStatus,
  type CompetitionMode,
  type CompetitionRecordView,
  type CompetitionSnapshot,
  type ConfirmationSummary,
  type ParticipantView,
  type RawClientLogLine,
  type RefereeActionId,
  type RuntimeSnapshot,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioPlayerProfile,
  type ScenarioFaultPlan,
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
  type AutomationAction,
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
import { ManagedMockClient, readMockClientVersion, resolveMockClientUuid, type CommandTransport } from "./mock-client.js";
import type { OpenedDatabase } from "./storage/database.js";

export const seededBehaviorRandom = (seed: number, stageId: string, attemptNumber: number, playerId: string, channel: string): number => {
  const digest = createHash("sha256").update(`${seed}:${stageId}:${attemptNumber}:${playerId}:${channel}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
};

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

interface PendingTestCountdown {
  action: AutomationAction;
  emitted: number;
}

interface ScheduledTestRecovery {
  playerId: string;
  dueAtMs: number;
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
  work?: { started: boolean; mockClientVersion?: string; automation?: AutomationSnapshot };
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
  clockAdvanceCanCoalesce: boolean;
  pendingCountdown?: PendingTestCountdown;
  appliedFaultIds: Set<string>;
  stageFinishOrdinals: Map<string, number>;
  phaseStartedAt: Map<string, number>;
  recoveries: ScheduledTestRecovery[];
  createdAt: string;
  updatedAt: string;
}

interface RealtimeTestTimer {
  handle: ReturnType<typeof setInterval>;
  lastWallAtMs: number;
}

interface WorkRuntime {
  competitionId: string;
  controller: CompetitionController;
  engine: CompetitionEngine;
  commands: CommandQueue;
  runtime: WorkAutomationRuntime;
  client?: ManagedMockClient;
  mockClientVersion?: string;
  initialListTimer?: ReturnType<typeof setTimeout>;
  listTimer?: ReturnType<typeof setInterval>;
  automationTimer?: ReturnType<typeof setInterval>;
  automationDispatching?: boolean;
  listReconciliation?: { expected: number; seen: number; onlinePlayerIds: Set<string> };
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

const automationView = (
  mode: CompetitionMode,
  snapshot?: AutomationSnapshot,
  commands: readonly CommandRecordView[] = [],
  plannedStageStartAt?: string,
  plannedReadyAt?: string,
  virtualNowMs?: number,
  availableActions: readonly ActionAvailability[] = [],
  attentionItems: readonly AttentionItem[] = [],
  deadlineAt?: string
): RuntimeSnapshot => ({
  phase: snapshot?.phase ?? "draft",
  stateVersion: snapshot?.stateVersion ?? 0,
  mode,
  automationEnabled: snapshot?.automationEnabled ?? false,
  ...(snapshot?.currentStageId === undefined ? {} : { currentStageId: snapshot.currentStageId }),
  ...(snapshot?.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: snapshot.plannedReadyAtMs }),
  ...(plannedReadyAt === undefined ? {} : { plannedReadyAt }),
  ...(plannedStageStartAt === undefined ? {} : { plannedStageStartAt }),
  ...(deadlineAt === undefined ? {} : { stageDeadlineAt: deadlineAt }),
  ...(virtualNowMs === undefined ? {} : { virtualNowMs }),
  ...(snapshot?.countdownValue === undefined ? {} : { countdownValue: snapshot.countdownValue }),
  blockers: snapshot?.blockers ?? [],
  waitingParticipants: snapshot?.waitingParticipants ?? [],
  attempts: snapshot?.attempts ?? [],
  incidents: snapshot?.incidents ?? [],
  rejectedResults: snapshot?.rejectedResults ?? [],
  commands,
  availableActions,
  attentionItems
});

const plannedStageStartAt = (snapshot: AutomationSnapshot, epochOriginMs: number, readyBufferMs: number): string | undefined => {
  const stageActions = snapshot.actions.filter((action) => action.stageId === snapshot.currentStageId && action.status === "acknowledged");
  const latestGo = [...stageActions].reverse().find((action) => action.kind === "go");
  if (latestGo && (snapshot.phase === "running" || snapshot.phase === "tail-intake" || snapshot.phase === "review")) {
    return new Date(epochOriginMs + latestGo.createdAtMs).toISOString();
  }
  const latestReady = [...stageActions].reverse().find((action) => action.kind === "ready");
  const plannedAtMs = latestReady ? latestReady.createdAtMs + readyBufferMs
    : snapshot.plannedReadyAtMs === undefined ? undefined : snapshot.plannedReadyAtMs + readyBufferMs;
  return plannedAtMs === undefined ? undefined : new Date(epochOriginMs + plannedAtMs).toISOString();
};

const plannedReadyAt = (snapshot: AutomationSnapshot, epochOriginMs: number): string | undefined =>
  snapshot.plannedReadyAtMs === undefined ? undefined : new Date(epochOriginMs + snapshot.plannedReadyAtMs).toISOString();

const stageDeadlineAt = (snapshot: AutomationSnapshot, epochOriginMs: number): string | undefined => {
  const attempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === snapshot.currentStageId && candidate.intakeOpen);
  return attempt ? new Date(epochOriginMs + attempt.deadlineAtMs).toISOString() : undefined;
};

const automationPolicyFor = (config: CompetitionConfig) => ({
  announcementLeadMs: config.flow.announcementLeadMs,
  readyBufferMs: config.flow.readyBufferMs,
  reconnectStableMs: config.flow.reconnectStableMs,
  preStartWaitLimitMs: config.flow.delayLimitMs,
  intermissionMs: config.flow.intermissionMs,
  protectionWindowMs: config.flow.protectionWindowMs,
  groupDisconnectThreshold: config.flow.groupDisconnectThreshold
});

const scenarioSummary = (definition: ScenarioDefinition): TestScenarioSummary => ({
  id: definition.id,
  name: definition.name,
  kind: definition.kind ?? "scripted-replay",
  randomSeed: definition.randomSeed ?? 1,
  players: definition.players.length,
  stages: definition.stages.length,
  events: definition.events.length,
  expectedScoreboardVersions: definition.expected.scoreboardVersions,
  playerProfiles: [...new Set(definition.players.map((player) => player.profile ?? "normal"))],
  faults: definition.faultPlan?.length ?? 0
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
    { id: "p1", displayName: "Alpha", connectionId: "101", profile: "expert" },
    { id: "p2", displayName: "Beta", connectionId: "102", profile: "normal" },
    { id: "p3", displayName: "Gamma", connectionId: "103", profile: "normal" },
    { id: "p4", displayName: "Delta", connectionId: "104", profile: "struggler" },
    { id: "p5", displayName: "测试选手", connectionId: "105", profile: "disruptor" }
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

const builtinBehaviorScenario = (
  id: string,
  name: string,
  randomSeed: number,
  profiles: readonly ScenarioPlayerProfile[],
  faultPlan: readonly ScenarioFaultPlan[] = []
): ScenarioDefinition => ({
  schemaVersion: 1,
  kind: "player-behavior",
  randomSeed,
  id,
  name,
  year: 2026,
  timezone: "Asia/Shanghai",
  refereeConnectionId: `${id}-referee`,
  players: profiles.map((profile, index) => ({
    id: `${id}-p${index + 1}`,
    displayName: `${({ normal: "普通玩家", expert: "游戏高手", struggler: "游戏低手", disruptor: "捣乱分子" } as const)[profile]} ${index + 1}`,
    connectionId: String(300 + index),
    profile
  })),
  stages: [],
  events: [],
  ...(faultPlan.length === 0 ? {} : { faultPlan: [...faultPlan] }),
  expected: { attempts: 0, scoreboardVersions: 0 }
});

const builtinPlayerSandbox = (): ScenarioDefinition => builtinBehaviorScenario(
  "independent-player-sandbox",
  "20 人小型综合沙盒",
  20_260_631,
  [
    ...Array.from({ length: 8 }, () => "normal" as const),
    ...Array.from({ length: 6 }, () => "expert" as const),
    ...Array.from({ length: 3 }, () => "struggler" as const),
    ...Array.from({ length: 3 }, () => "disruptor" as const)
  ],
  [
    { id: "small-reconnect", fault: "participant-disconnect", trigger: "running", stageOrder: 1, offsetMs: 35_000, playerId: "independent-player-sandbox-p2", recoverAfterMs: 8_000 },
    { id: "small-warning", fault: "warning", trigger: "running", stageOrder: 1, offsetMs: 50_000, playerId: "independent-player-sandbox-p19", message: "just pressed the Reset hotkey" }
  ]
);

const builtinBehaviorScenarios = (): ScenarioDefinition[] => [
  builtinPlayerSandbox(),
  builtinBehaviorScenario("large-player-sandbox", "30 人大型综合沙盒", 20_260_701, [
    ...Array.from({ length: 12 }, () => "normal" as const),
    ...Array.from({ length: 8 }, () => "expert" as const),
    ...Array.from({ length: 6 }, () => "struggler" as const),
    ...Array.from({ length: 4 }, () => "disruptor" as const)
  ], [
    { id: "large-reconnect", fault: "participant-disconnect", trigger: "running", stageOrder: 1, offsetMs: 30_000, playerId: "large-player-sandbox-p3", recoverAfterMs: 10_000 },
    { id: "large-warning", fault: "warning", trigger: "running", stageOrder: 2, offsetMs: 45_000, playerId: "large-player-sandbox-p27", message: "just restarted while uncontrollable" }
  ]),
  builtinBehaviorScenario("normal-player-roster", "普通玩家场景", 10_001, Array.from({ length: 15 }, () => "normal")),
  builtinBehaviorScenario("expert-player-roster", "高手竞速场景", 20_003, [
    ...Array.from({ length: 12 }, () => "expert" as const),
    ...Array.from({ length: 3 }, () => "normal" as const)
  ]),
  builtinBehaviorScenario("timeout-player-roster", "低手超时与 DNF 场景", 30_007, [
    ...Array.from({ length: 10 }, () => "normal" as const),
    ...Array.from({ length: 5 }, () => "struggler" as const)
  ]),
  builtinBehaviorScenario("disruptor-player-roster", "捣乱与违规场景", 40_009, [
    ...Array.from({ length: 12 }, () => "normal" as const),
    ...Array.from({ length: 3 }, () => "disruptor" as const)
  ]),
  builtinBehaviorScenario("protected-crash-fault", "保护期崩溃故障场景", 50_011, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "protected-crash", fault: "player-crash", trigger: "running", stageOrder: 1, offsetMs: 5_000, playerId: "protected-crash-fault-p1" }
  ]),
  builtinBehaviorScenario("server-disconnect-fault", "服务器断线故障场景", 50_013, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "server-disconnect", fault: "server-disconnect", trigger: "running", stageOrder: 1, offsetMs: 20_000 }
  ]),
  builtinBehaviorScenario("mock-client-exit-fault", "MockClient 退出故障场景", 50_017, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "mock-client-exit", fault: "process-exit", trigger: "ready", stageOrder: 1, offsetMs: 4_000 }
  ]),
  builtinBehaviorScenario("clock-jump-fault", "时钟跳变故障场景", 50_021, Array.from({ length: 15 }, () => "normal" as const), [
    { id: "clock-jump", fault: "clock-jump", trigger: "running", stageOrder: 1, offsetMs: 30_000 }
  ])
];

export class CompetitionService {
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly testRuns = new Map<string, TestRuntime>();
  private readonly realtimeTestTimers = new Map<string, RealtimeTestTimer>();
  private readonly workRuntimes = new Map<string, WorkRuntime>();
  private readonly idempotency = new Map<string, unknown>();
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private readonly rawLogs = new Map<string, RawClientLogLine[]>();
  private readonly memoryAttentionItems = new Map<string, AttentionItem[]>();

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

  public create(input: { name: string; mode?: CompetitionMode; idempotencyKey: string }): CompetitionRecord {
    const old = this.idempotency.get(`create:${input.idempotencyKey}`);
    if (old) return old as CompetitionRecord;
    if (!input.name.trim()) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    const mode = input.mode ?? "work";
    if (mode !== "work" && mode !== "test") throw new ServiceError("VALIDATION_FAILED", "无效比赛模式", 400);
    const now = new Date().toISOString();
    const record: CompetitionRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      mode,
      status: "draft",
      stateVersion: 0,
      capabilities: capabilitiesFor(mode),
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
    const issues = validateCompetitionConfigForPublish(config);
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
    const config = this.getDraftConfig(id);
    const activeRunId = competition.activeRunId ?? payload.activeRunId;
    const testRun = activeRunId ? this.getTestRunSnapshot(id, activeRunId) : undefined;
    const workRuntime = this.workRuntimes.get(id);
    const persistedWorkAutomation = payload.work?.automation;
    const workAutomation = workRuntime?.controller.snapshot() ?? (persistedWorkAutomation ? {
      ...persistedWorkAutomation,
      phase: "paused" as const,
      automationEnabled: false,
      blockers: [
        ...persistedWorkAutomation.blockers.filter((blocker) => blocker.code !== "AUTOMATION_PAUSED"),
        { code: "AUTOMATION_PAUSED" as const, severity: "critical" as const, autoRecoverable: false, suggestion: "服务已重启；请核对服务器现场和不确定命令后重新启动工作运行。" }
      ]
    } : undefined);
    const workScoreboard = workRuntime?.engine.snapshot().scoreboardVersions.map(scoreboardView) ?? this.storedScoreboardVersions(id);
    const testScoreboard = testRun?.engine.scoreboardVersions ?? [];
    const scoreboardVersions = this.applyPlayerAliases(config, [
      ...(competition.mode === "test" ? testScoreboard : workScoreboard),
      ...((competition.mode === "work" && !workRuntime) ? [] : payload.scoreboardRevisions ?? [])
    ]);
    return {
      competition,
      config,
      ...(this.getPublishedConfig(id) === undefined ? {} : { publishedConfig: this.getPublishedConfig(id) as CompetitionConfig }),
      runtime: competition.mode === "test"
        ? testRun?.automation ?? automationView("test")
        : automationView(
            "work",
            workAutomation,
            this.commandHistory(id),
            workAutomation ? plannedStageStartAt(workAutomation, Date.now() - performance.now(), config.flow.readyBufferMs) : undefined,
            workAutomation ? plannedReadyAt(workAutomation, Date.now() - performance.now()) : undefined,
            undefined,
            this.availableActionsFor(id, workAutomation),
            this.attentionItemsFor(id, workAutomation),
            workAutomation ? stageDeadlineAt(workAutomation, Date.now() - performance.now()) : undefined
          ),
      scoreboardVersions,
      currentScoreboard: scoreboardVersions.at(-1)?.entries ?? [],
      scoreboardOverrides: this.scoreboardOverrideHistory(id),
      ...(testRun === undefined ? {} : { testRun }),
      archives: payload.archives ?? []
    };
  }

  public getRawClientLogs(competitionId: string, limit = 200): readonly RawClientLogLine[] {
    this.get(competitionId);
    const boundedLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)));
    if (!this.options.database) return (this.rawLogs.get(competitionId) ?? []).slice(-boundedLimit);
    return rows<{ source_id: string; source_file: string; occurred_at: string; raw_line: string }>(
      this.options.database,
      "SELECT source_id,source_file,occurred_at,raw_line FROM raw_log_events WHERE competition_id=? ORDER BY rowid DESC LIMIT ?",
      competitionId,
      boundedLimit
    ).reverse().map((item) => ({
      id: item.source_id,
      source: item.source_file as RawClientLogLine["source"],
      occurredAt: item.occurred_at,
      rawLine: item.raw_line
    }));
  }

  public listTestScenarios(): readonly TestScenarioSummary[] {
    return this.loadScenarioDefinitions().filter((definition) => definition.kind === "player-behavior").map(scenarioSummary);
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
    const parsedDefinition = assertScenarioDefinition(input);
    const definition = parsedDefinition.kind === "player-behavior"
      ? this.materializeBehaviorScenario(competitionId, parsedDefinition)
      : parsedDefinition;
    const runtime = this.makeTestRuntime(competitionId, definition);
    this.testRuns.set(runtime.id, runtime);
    this.connectTestPlayers(runtime, true);
    const config = this.getDraftConfig(competitionId);
    const primaryScoring = definition.stages[0]?.scoring ?? config.scoring.points;
    const contestType = this.scoringContestType(primaryScoring);
    this.upsertConfig(competitionId, 0, false, {
      ...config,
      contestType,
      scoring: {
        ...config.scoring,
        contestType,
        points: [...primaryScoring],
        minimumScoringPlace: minimumScoringPlaceFor(primaryScoring)
      },
      stages: definition.stages.map((stage) => ({
        id: stage.id,
        order: stage.order,
        label: `${stage.mode} ${stage.level}`,
        level: stage.level,
        mode: stage.mode,
        timeLimitMs: stage.timeLimitMs,
        scoring: [...stage.scoring],
        minimumScoringPlace: minimumScoringPlaceFor(stage.scoring)
      })),
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

  public actTestPlayers(competitionId: string, runId: string): TestRunSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
    this.connectTestPlayers(runtime, true);
    this.driveTestPlayers(runtime);
    this.persistTestRuntime(runtime);
    this.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
    this.journal.append({ type: "test-run.players-acted", competitionId, data: { runId } });
    return this.getTestRunSnapshot(competitionId, runId);
  }

  public resetTestRun(competitionId: string, runId: string): EngineSnapshot {
    this.stopRealtimeTestAutomation(runId);
    const runtime = this.getTestRuntime(competitionId, runId);
    const reset = this.makeTestRuntime(competitionId, runtime.definition, runtime.id, runtime.createdAt);
    this.connectTestPlayers(reset, true);
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
    runtime.operations.push({ kind: "advance-clock", milliseconds });
    runtime.clockAdvanceCanCoalesce = false;
    this.advanceTestClock(runtime, milliseconds);
    this.persistTestRuntime(runtime);
    const snapshot = runtime.automation.snapshot();
    if (snapshot.phase === "review" || snapshot.phase === "paused" || snapshot.phase === "incident") this.stopRealtimeTestAutomation(runId);
    this.journal.append({ type: "test-run.clock-advanced", competitionId, data: { runId, milliseconds, snapshot } });
    return snapshot;
  }

  public getTestAutomation(competitionId: string, runId: string): AutomationSnapshot {
    return this.getTestRuntime(competitionId, runId).automation.snapshot();
  }

  public getTestRunSnapshot(competitionId: string, runId: string): TestRunSnapshot {
    const runtime = this.getTestRuntime(competitionId, runId);
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
        ...this.commandHistory(competitionId),
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
      ], plannedStageStartAt(automation, epochOriginMs, this.getDraftConfig(competitionId).flow.readyBufferMs), plannedReadyAt(automation, epochOriginMs), runtime.automationClock.now(),
      this.availableActionsFor(competitionId, automation), this.attentionItemsFor(competitionId, automation), stageDeadlineAt(automation, epochOriginMs))
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
    const config = this.getOperationalWorkConfig(competitionId);
    const existing = this.workRuntimes.get(competitionId);
    if (existing) {
      const snapshot = existing.controller.snapshot();
      const origin = Date.now() - performance.now();
      return automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin, config.flow.readyBufferMs), plannedReadyAt(snapshot, origin), undefined,
        this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
    }
    this.assertActionAvailable(competitionId, "start-work");

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
      refereeName: config.refereeName,
      uuid: resolveMockClientUuid(serverWindowsRoot(), randomUUID()),
      logPath
    });
    const runtime = this.makeWorkRuntime(competitionId, config, client, mockClientVersion);
    client.onLine((line) => {
      runtime.commands.observeLine(line);
      this.ingestWorkLine(runtime, line);
    });
    client.start();
    this.workRuntimes.set(competitionId, runtime);
    this.startParticipantReconciliation(runtime);
    this.saveWorkRuntimeSnapshot(runtime);
    this.journal.append({ type: "work.started", competitionId, data: { mockClientVersion } });
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin, config.flow.readyBufferMs), plannedReadyAt(snapshot, origin), undefined,
      this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
  }

  public async enableAutomation(competitionId: string, input: { runId?: string; readyInMs?: number }): Promise<RuntimeSnapshot> {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = input.runId ?? this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      this.assertActionAvailable(competitionId, "enable-automation", this.getTestRuntime(competitionId, runId).automation.snapshot());
      const readyInMs = input.readyInMs ?? 0;
      this.startTestAutomation(competitionId, runId, readyInMs);
      const runtime = this.getTestRuntime(competitionId, runId);
      this.startRealtimeTestAutomation(runtime);
      return this.getTestRunSnapshot(competitionId, runId).automation;
    }
    const runtime = this.workRuntimes.get(competitionId);
    this.assertActionAvailable(competitionId, "enable-automation", runtime?.controller.snapshot());
    if (!runtime) throw new ServiceError("NOT_FOUND", "请先启动工作运行", 404);
    runtime.controller.enable(runtime.controller.snapshot().plannedReadyAtMs ?? performance.now() + (input.readyInMs ?? 0));
    await runtime.runtime.dispatch();
    for (const action of runtime.controller.snapshot().actions.filter((candidate) => candidate.status === "acknowledged")) this.recordAutomationAttention(competitionId, action);
    this.workRuntimes.set(competitionId, runtime);
    this.startRealtimeWorkAutomation(runtime);
    this.saveWorkRuntimeSnapshot(runtime);
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin, this.getDraftConfig(competitionId).flow.readyBufferMs), plannedReadyAt(snapshot, origin), undefined,
      this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
  }

  public pauseAutomation(competitionId: string): RuntimeSnapshot {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      this.assertActionAvailable(competitionId, "pause-automation", this.getTestRuntime(competitionId, runId).automation.snapshot());
      this.stopRealtimeTestAutomation(runId);
      const runtime = this.getTestRuntime(competitionId, runId);
      runtime.automation.pause();
      this.persistTestRuntime(runtime);
      const snapshot = runtime.automation.snapshot();
      const origin = Date.parse(runtime.createdAt);
      return automationView("test", snapshot, [simulatedCommand("automation-pause")], plannedStageStartAt(snapshot, origin, this.getDraftConfig(competitionId).flow.readyBufferMs), plannedReadyAt(snapshot, origin), runtime.automationClock.now(),
        this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
    }
    const runtime = this.workRuntimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
    this.assertActionAvailable(competitionId, "pause-automation", runtime.controller.snapshot());
    this.stopRealtimeWorkAutomation(runtime);
    runtime.controller.pause();
    this.saveWorkRuntimeSnapshot(runtime);
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin, this.getDraftConfig(competitionId).flow.readyBufferMs), plannedReadyAt(snapshot, origin), undefined,
      this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
  }

  public createConfirmation(
    competitionId: string,
    input: { kind: ConfirmationSummary["kind"]; target?: string; playerId?: string; stageId?: string; operation?: "set-place" | "set-dnf"; place?: number; rankPolicy?: "tie" | "shift" }
  ): ConfirmationSummary {
    const competition = this.get(competitionId);
    const runtimeSnapshot = this.runtimeAutomationSnapshot(competitionId);
    const expiresAtMs = Date.now() + 60_000;
    const token = randomUUID();
    const target = input.target ?? (input.kind === "scoreboard-override" && input.playerId && input.stageId ? `${input.playerId}:${input.stageId}` : competition.id);
    let impactHash = createHash("sha256").update(JSON.stringify({ competitionId, target, stateVersion: competition.stateVersion, kind: input.kind, playerId: input.playerId, stageId: input.stageId, operation: input.operation, place: input.place, rankPolicy: input.rankPolicy })).digest("hex");
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
    const scorePreview = input.kind === "scoreboard-override" && input.playerId && input.stageId && input.operation
      ? (() => {
          const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
          const activeTestRunId = competition.mode === "test" ? this.getPayload(competitionId).activeRunId : undefined;
          const testStages = activeTestRunId ? this.getTestRuntime(competitionId, activeTestRunId).definition.stages : [];
          const base = this.getLatestScoreboard(competitionId);
          const ledger = new ScoreboardRevisionLedger(base, Object.fromEntries([...config.stages, ...testStages].map((stage) => [stage.id, stage.scoring])));
          if (input.operation === "set-place" && !Number.isInteger(input.place)) throw new ServiceError("VALIDATION_FAILED", "成绩修订缺少名次", 400);
          const revised = ledger.apply({
            playerId: input.playerId,
            stageId: input.stageId,
            stage: input.operation === "set-place"
              ? { status: "finished", place: input.place as number, reason: "referee-adjudicated-place" }
              : { status: "dnf", reason: "referee-adjudicated-dnf" },
            ...(input.rankPolicy === undefined ? {} : { rankPolicy: input.rankPolicy }),
            actor: "local-referee",
            reason: input.operation === "set-place" ? `set-place:${input.place}` : "set-dnf"
          });
          const beforeByPlayer = new Map(base.entries.map((entry) => [entry.playerId, entry]));
          const affectedPlayers = revised.entries
            .map((entry) => {
              const beforeEntry = beforeByPlayer.get(entry.playerId);
              const beforeResult = beforeEntry && input.stageId ? beforeEntry.stages[input.stageId] ?? null : null;
              const afterResult = input.stageId ? entry.stages[input.stageId] ?? null : null;
              const beforePlace = beforeResult ? beforeResult.place : null;
              const afterPlace = afterResult ? afterResult.place : null;
              const beforePoints = beforeResult ? beforeResult.points : 0;
              const afterPoints = afterResult ? afterResult.points : 0;
              if (beforePlace === afterPlace && beforePoints === afterPoints) return null;
              return { playerId: entry.playerId, displayName: entry.displayName, beforePlace, afterPlace, beforePoints, afterPoints };
            })
            .filter((entry): entry is { playerId: string; displayName: string; beforePlace: number | null; afterPlace: number | null; beforePoints: number; afterPoints: number; } => entry !== null)
            .sort((left, right) => {
              if (left.playerId === input.playerId) return -1;
              if (right.playerId === input.playerId) return 1;
              return (left.afterPlace ?? left.beforePlace ?? Number.MAX_SAFE_INTEGER) - (right.afterPlace ?? right.beforePlace ?? Number.MAX_SAFE_INTEGER);
            });
          return { affectedPlayers };
        })()
      : undefined;
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
    const effect = input.kind === "manual-go"
      ? { title: "确认手动发令", consequences: ["将发送真实倒数命令", "只有 Go 回显后才创建尝试并启动关卡时限"], irreversible: false }
      : input.kind === "restart"
        ? { title: "确认重赛", consequences: ["当前尝试将作废但保留证据", "重新执行 Ready ×3、READY、关闭 cheat 和 3/2/1/Go"], irreversible: false }
        : input.kind === "scoreboard-override"
          ? {
              title: "确认成绩修订",
              consequences: [
                "生成新的榜单版本",
                ...(input.operation === "set-place" || input.operation === "set-dnf"
                  ? [
                      input.rankPolicy === "shift"
                        ? `其他玩家将顺延重算，受影响 ${scorePreview?.affectedPlayers.length ?? 0} 名玩家`
                        : "不会顺延其他玩家，按当前规则直接计分"
                    ]
                  : ["该成绩将改为 DNF，原始事件不覆盖"])
              ],
              irreversible: false,
              ...(scorePreview === undefined ? {} : { affectedPlayers: scorePreview.affectedPlayers })
            }
          : input.kind === "high-risk" && target === competition.id
            ? { title: "确认比赛级操作", consequences: ["将结束或删除目标比赛，具体结果以按钮所示操作为准", "删除操作会移除本地比赛数据"], irreversible: true }
            : input.kind === "high-risk"
              ? { title: "确认高风险操作", consequences: ["将影响目标玩家或比赛尝试", "真实命令结果不确定时不会自动重试"], irreversible: false }
              : { title: "确认流程控制", consequences: ["立即按按钮说明修改当前流程计划", "状态版本变化后本确认自动失效"], irreversible: false };
    return {
      token,
      kind: input.kind,
      expiresAt: new Date(expiresAtMs).toISOString(),
      target,
      stateVersion: competition.stateVersion,
      impactHash,
      summary: `${competition.name} · ${input.kind} · 目标 ${target} · 版本 ${competition.stateVersion}`,
      effect: {
        title: effect.title,
        target,
        currentPhase: runtimeSnapshot?.phase ?? competition.status,
        consequences: effect.consequences,
        irreversible: effect.irreversible,
        ...(effect.affectedPlayers === undefined ? {} : { affectedPlayers: effect.affectedPlayers })
      }
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
    const actionId = this.actionIdFor(input.action);
    if (actionId) this.assertActionAvailable(competitionId, actionId, this.runtimeAutomationSnapshot(competitionId));
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
    const operation = (input as { operation?: string }).operation;
    if (operation !== "set-place" && operation !== "set-dnf") throw new ServiceError("VALIDATION_FAILED", "成绩修订只允许设置名次或设置 DNF", 400);
    const allowedKeys = new Set(["playerId", "stageId", "operation", "place", "rankPolicy", "confirmationToken", "impactHash", "expectedStateVersion", "idempotencyKey"]);
    if (Object.keys(input).some((keyName) => !allowedKeys.has(keyName))) {
      throw new ServiceError("VALIDATION_FAILED", "成绩修订不接受前端提交的得分、总分、原因或证据", 400);
    }
    this.consumeConfirmation(
      competitionId,
      "scoreboard-override",
      input.confirmationToken,
      input.impactHash,
      `${input.playerId}:${input.stageId}`
    );
    if (input.operation === "set-place" && (!Number.isInteger(input.place) || input.place < 1)) {
      throw new ServiceError("VALIDATION_FAILED", "名次必须是大于等于 1 的整数", 400);
    }
    const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
    const activeTestRunId = competition.mode === "test" ? this.getPayload(competitionId).activeRunId : undefined;
    const testStages = activeTestRunId ? this.getTestRuntime(competitionId, activeTestRunId).definition.stages : [];
    const stageConfig = config.stages.find((stage) => stage.id === input.stageId) ?? testStages.find((stage) => stage.id === input.stageId);
    if (!stageConfig) throw new ServiceError("NOT_FOUND", "修订轮次不存在", 404);
    const base = this.getLatestScoreboard(competitionId);
    const ledger = new ScoreboardRevisionLedger(base, Object.fromEntries([...config.stages, ...testStages].map((stage) => [stage.id, stage.scoring])));
    let revised;
    try {
      revised = ledger.apply({
        playerId: input.playerId,
        stageId: input.stageId,
        stage: input.operation === "set-place"
          ? { status: "finished", place: input.place, reason: "referee-adjudicated-place" }
          : { status: "dnf", reason: "referee-adjudicated-dnf" },
        ...(input.operation === "set-place" ? { rankPolicy: input.rankPolicy ?? "shift" } : {}),
        actor: "local-referee",
        reason: input.operation === "set-place" ? `set-place:${input.place}` : "set-dnf"
      });
    } catch (error) {
      throw new ServiceError("VALIDATION_FAILED", error instanceof Error ? error.message : "榜单修订失败", 400);
    }
    const override = ledger.history().overrides.at(-1);
    if (!override) throw new ServiceError("INTERNAL_ERROR", "榜单修订记录缺失", 500);
    const versionNumber = Math.max(base.version, ...this.snapshot(competitionId).scoreboardVersions.map((candidate) => candidate.version)) + 1;
    const hashPayload = { version: versionNumber, baseVersion: base.version, triggerOverrideId: override.id, entries: revised.entries };
    const version: ScoreboardVersion = {
      id: randomUUID(),
      version: versionNumber,
      triggerSourceId: `override:${override.id}`,
      stageId: input.stageId,
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
    this.appendAttention(competitionId, {
      id: `scoreboard-override:${override.id}`,
      category: "result",
      severity: "info",
      title: "成绩修订已生成新版本",
      message: input.operation === "set-place" ? `${input.playerId} 在 ${input.stageId} 改为第 ${input.place} 名，关联名次已重算。` : `${input.playerId} 在 ${input.stageId} 改为 DNF，关联名次已重算。`,
      occurredAt: override.createdAt,
      stageId: input.stageId,
      participantIds: [input.playerId]
    });
    this.journal.append({ type: "scoreboard.override", competitionId, stateVersion: this.get(competitionId).stateVersion, data: view });
    return view;
  }

  public recordArchive(competitionId: string, archive: CreatedArchive): void {
    this.assertArchiveAvailable(competitionId);
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
    const current = this.get(competitionId);
    if (current.status !== "finished" && current.status !== "archived") return;
    const updated = { ...current, status: "archived" as const, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.competitions.set(competitionId, updated);
    this.withDatabase((database) => {
      database.sqlite.prepare("UPDATE competitions SET status=?,state_version=?,updated_at=? WHERE id=?")
        .run(updated.status, updated.stateVersion, updated.updatedAt, competitionId);
    });
  }

  public assertArchiveAvailable(competitionId: string): void {
    this.assertActionAvailable(competitionId, "archive", this.runtimeAutomationSnapshot(competitionId));
  }

  public async finishCompetition(competitionId: string, input: {
    expectedStateVersion: number;
    idempotencyKey: string;
    confirmationToken: string;
    impactHash: string;
  }): Promise<CompetitionRecord> {
    const key = `${competitionId}:finish:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CompetitionRecord;
    const current = this.get(competitionId);
    if (current.stateVersion !== input.expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    this.assertActionAvailable(competitionId, "finish", this.runtimeAutomationSnapshot(competitionId));
    this.consumeConfirmation(competitionId, "high-risk", input.confirmationToken, input.impactHash, competitionId);
    const runtime = this.workRuntimes.get(competitionId);
    if (runtime) this.stopRealtimeWorkAutomation(runtime);
    runtime?.controller.pause();
    if (runtime?.initialListTimer) clearTimeout(runtime.initialListTimer);
    if (runtime?.listTimer) clearInterval(runtime.listTimer);
    await runtime?.client?.stop().catch(() => undefined);
    this.workRuntimes.delete(competitionId);
    for (const [runId, testRuntime] of this.testRuns) {
      if (testRuntime.competitionId === competitionId) this.stopRealtimeTestAutomation(runId);
    }
    const updated = { ...current, status: "finished" as const, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.competitions.set(competitionId, updated);
    this.withDatabase((database) => {
      database.sqlite.prepare("UPDATE competitions SET status=?,state_version=?,updated_at=? WHERE id=?")
        .run(updated.status, updated.stateVersion, updated.updatedAt, competitionId);
    });
    this.idempotency.set(key, updated);
    this.appendAttention(competitionId, {
      id: `competition-finished:${updated.stateVersion}`,
      category: "flow",
      severity: "info",
      title: "比赛已结束",
      message: "运行已停止；请固定榜单版本并生成归档。",
      occurredAt: updated.updatedAt,
      action: "archive"
    });
    this.journal.append({ type: "competition.finished", competitionId, stateVersion: updated.stateVersion, data: { reason: "competition-finished-by-referee" } });
    return updated;
  }

  public async deleteCompetition(competitionId: string, input: {
    expectedStateVersion: number;
    idempotencyKey: string;
    confirmationToken: string;
    impactHash: string;
  }): Promise<{ id: string }> {
    const key = `${competitionId}:delete:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as { id: string };
    const current = this.get(competitionId);
    if (current.stateVersion !== input.expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    this.assertActionAvailable(competitionId, "delete", this.runtimeAutomationSnapshot(competitionId));
    this.consumeConfirmation(competitionId, "high-risk", input.confirmationToken, input.impactHash, competitionId);
    const runtime = this.workRuntimes.get(competitionId);
    if (runtime) this.stopRealtimeWorkAutomation(runtime);
    await runtime?.client?.stop().catch(() => undefined);
    this.workRuntimes.delete(competitionId);
    for (const [runId, testRuntime] of this.testRuns) if (testRuntime.competitionId === competitionId) {
      this.stopRealtimeTestAutomation(runId);
      this.testRuns.delete(runId);
    }
    this.withDatabase((database) => {
      database.sqlite.transaction(() => {
        database.sqlite.prepare("DELETE FROM domain_events WHERE competition_id=?").run(competitionId);
        database.sqlite.prepare("DELETE FROM raw_log_events WHERE competition_id=?").run(competitionId);
        database.sqlite.prepare("DELETE FROM result_intake_windows WHERE attempt_id IN (SELECT id FROM attempts WHERE competition_id=?)").run(competitionId);
        for (const table of ["connection_identities", "participants", "attempts", "scoreboard_versions", "command_audits", "incidents", "overrides", "recovery_audits", "observation_gaps", "archive_versions", "attention_items", "config_versions", "runtime_snapshots"]) {
          database.sqlite.prepare(`DELETE FROM ${table} WHERE competition_id=?`).run(competitionId);
        }
        database.sqlite.prepare("DELETE FROM competitions WHERE id=?").run(competitionId);
      })();
    });
    this.competitions.delete(competitionId);
    this.rawLogs.delete(competitionId);
    this.memoryAttentionItems.delete(competitionId);
    for (const mode of ["work", "test"] as const) this.removeCompetitionDirectory(competitionId, mode);
    const result = { id: competitionId };
    this.idempotency.set(key, result);
    this.journal.append({ type: "competition.deleted", competitionId, data: { reason: "competition-deleted-by-referee" } });
    return result;
  }

  public close(): void {
    for (const runId of this.realtimeTestTimers.keys()) this.stopRealtimeTestAutomation(runId);
    for (const runtime of this.workRuntimes.values()) {
      this.stopRealtimeWorkAutomation(runtime);
      if (runtime.initialListTimer) clearTimeout(runtime.initialListTimer);
      if (runtime.listTimer) clearInterval(runtime.listTimer);
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
      this.recoverSentCommands(item.id);
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
    return stored ? this.parseStoredConfig(stored.payload) : createDefaultCompetitionConfig(this.get(competitionId).name);
  }

  private getPublishedConfig(competitionId: string): CompetitionConfig | undefined {
    const stored = row<{ payload: string }>(this.options.database, "SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1 ORDER BY version DESC LIMIT 1", competitionId);
    return stored ? this.parseStoredConfig(stored.payload) : undefined;
  }

  private getOperationalWorkConfig(competitionId: string): CompetitionConfig {
    const published = this.getPublishedConfig(competitionId);
    if (!published) throw new ServiceError("STATE_CONFLICT", "请先发布比赛配置", 409);
    const operational = this.getDraftConfig(competitionId);
    return {
      ...published,
      playerAliases: operational.playerAliases,
      participants: operational.participants
    };
  }

  private applyPlayerAliases(
    config: CompetitionConfig,
    versions: readonly ScoreboardVersionView[]
  ): ScoreboardVersionView[] {
    const aliases = new Map(config.playerAliases.map((alias) => [alias.playerId.toLocaleLowerCase("en-US"), alias.displayName]));
    if (aliases.size === 0) return [...versions];
    return versions.map((version) => ({
      ...version,
      entries: version.entries.map((entry) => ({
        ...entry,
        displayName: aliases.get(entry.playerId.toLocaleLowerCase("en-US")) ?? entry.displayName
      }))
    }));
  }

  private parseStoredConfig(payload: string): CompetitionConfig {
    const { loginName, ...config } = JSON.parse(payload) as CompetitionConfig & { loginName?: string };
    return {
      ...config,
      refereeName: normalizeRefereeName(config.refereeName || loginName || "ContestConsole"),
      playerAliases: config.playerAliases ?? []
    };
  }

  private normalizeConfig(config: CompetitionConfig): CompetitionConfig {
    const name = config.name.trim();
    if (!name) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    const refereeName = normalizeRefereeName(config.refereeName);
    const normalizedPoints = config.scoring.points.map((point) => {
      if (!Number.isFinite(point)) throw new ServiceError("VALIDATION_FAILED", "计分必须是有限数字", 400);
      if (point < 0 && !config.scoring.allowNegative) throw new ServiceError("VALIDATION_FAILED", "默认不允许负分", 400);
      return point;
    });
    if (normalizedPoints.length === 0) throw new ServiceError("VALIDATION_FAILED", "计分表至少需要一个名次", 400);
    const scoring = {
      ...config.scoring,
      points: normalizedPoints,
      minimumScoringPlace: minimumScoringPlaceFor(normalizedPoints)
    };
    const stages = [...config.stages].sort((left, right) => left.order - right.order).map((stage, index) => ({
      ...stage,
      order: index + 1,
      scoring: stage.scoring.length > 0 ? stage.scoring : scoring.points,
      minimumScoringPlace: minimumScoringPlaceFor(stage.scoring.length > 0 ? stage.scoring : scoring.points)
    }));
    return { ...config, name, refereeName, contestType: scoring.contestType, scoring, stages };
  }

  private makeTestRuntime(competitionId: string, definition: ScenarioDefinition, id: string = randomUUID(), createdAt: string = new Date().toISOString()): TestRuntime {
    const automationClock = new VirtualClock(0);
    const config = this.getDraftConfig(competitionId);
    const automation = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      stages: [...definition.stages].sort((left, right) => left.order - right.order).map((stage) => ({
        id: stage.id,
        map: String(stage.level),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      policy: automationPolicyFor(config)
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
      clockAdvanceCanCoalesce: false,
      appliedFaultIds: new Set(),
      stageFinishOrdinals: new Map(),
      phaseStartedAt: new Map(),
      recoveries: [],
      createdAt,
      updatedAt: createdAt
    };
  }

  private connectTestPlayers(runtime: TestRuntime, writeLog: boolean): void {
    for (const player of runtime.definition.players) {
      runtime.automation.observeConnection(player.id, true);
      if (writeLog) {
        const event: ScenarioEvent = { atMs: runtime.automationClock.now(), sourceId: `agent-login:${runtime.id}:${player.id}`, type: "login", playerId: player.id, connectionId: player.connectionId };
        this.appendRawLog(runtime.competitionId, "test-player", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
      }
    }
  }

  private driveTestPlayers(runtime: TestRuntime): void {
    const snapshot = runtime.automation.snapshot();
    if (snapshot.phase !== "running" && snapshot.phase !== "tail-intake") return;
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
        this.applyTestEvent(runtime, { atMs: plan.dueAtMs, sourceId: `${sourceId}:cheat`, type: "cheat", playerId: player.id, enabled: true }, false, true, false);
        this.applyTestEvent(runtime, { atMs: plan.dueAtMs, sourceId: `${sourceId}:cheat-off`, type: "cheat", playerId: player.id, enabled: false }, false, true, false);
        this.applyTestEvent(runtime, {
          atMs: plan.dueAtMs,
          sourceId,
          type: "finish",
          stageId,
          playerId: player.id,
          elapsedMs: Math.max(1_000, plan.dueAtMs - attempt.goAtMs),
          score: 3_000 + Math.floor(seededBehaviorRandom(runtime.definition.randomSeed ?? 1, stageId, attempt.attemptNumber, player.id, "disrupt-score") * 1_000)
        }, false, true, false);
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

  private scoringContestType(points: readonly number[]): CompetitionConfig["contestType"] {
    const same = (expected: readonly number[]) => expected.length === points.length && expected.every((point, index) => point === points[index]);
    if (same([20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 1])) return "small";
    if (same([30, 24, 21, 18, 16, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1])) return "large";
    return "custom";
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
    this.connectTestPlayers(runtime, false);
    for (let index = 0; index < persisted.playedEvents; index += 1) {
      const event = runtime.runner.next();
      if (event) this.applyTestEvent(runtime, event, false, false);
    }
    for (const operation of persisted.operations) {
      if (operation.kind === "automation-start") runtime.automation.enable(runtime.automationClock.now() + (operation.readyInMs ?? 0));
      else if (operation.kind === "advance-clock") {
        this.advanceTestClock(runtime, operation.milliseconds ?? 0);
        continue;
      }
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
    runtime.automation.pause();
    delete runtime.pendingCountdown;
    return runtime;
  }

  private advanceTestClock(runtime: TestRuntime, milliseconds: number): void {
    let remaining = milliseconds;
    if (remaining === 0) this.settleTestAutomation(runtime);
    while (remaining > 0) {
      const step = Math.min(1_000, remaining);
      runtime.automationClock.advanceBy(step);
      remaining -= step;
      this.settleTestAutomation(runtime);
    }
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

  private applyTestEvent(runtime: TestRuntime, event: ScenarioEvent, countEvent: boolean, writeLog = true, settleAutomation = true): void {
    runtime.engine.apply(event);
    this.applyAutomationEvent(runtime, event, settleAutomation);
    if (countEvent) runtime.playedEvents += 1;
    if (writeLog) {
      const source = event.type === "ready" || event.type === "go" ? "test-referee" : "test-player";
      this.appendRawLog(runtime.competitionId, source, this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
    }
    this.journal.append({ type: "test-run.event", competitionId: runtime.competitionId, data: event });
  }

  private settleTestAutomation(runtime: TestRuntime): void {
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const beforeSnapshot = runtime.automation.snapshot();
      const before = beforeSnapshot.stateVersion;
      this.observeScenarioPhase(runtime, beforeSnapshot);
      this.applyScheduledTestRecoveries(runtime);
      this.applyDueScenarioFaults(runtime);
      this.advancePendingTestCountdown(runtime);
      this.driveTestPlayers(runtime);
      const knownResultSources = new Set(runtime.engine.snapshot().currentScoreboard.flatMap((entry) =>
        Object.values(entry.stages).flatMap((result) => [result.sourceId, ...(result.finishSourceId ? [result.finishSourceId] : [])])));
      runtime.automation.tick();
      this.mirrorDeadlineResults(runtime, knownResultSources);
      const actions = runtime.automationRuntime.dispatch(true);
      for (const action of actions) {
        if (action.kind === "go") {
          runtime.pendingCountdown = { action, emitted: 0 };
          this.advancePendingTestCountdown(runtime);
          continue;
        }
        for (const line of this.testAutomationActionLogLines(runtime, action)) {
          this.appendRawLog(runtime.competitionId, "test-referee", line, this.testOccurredAt(runtime, action.createdAtMs));
        }
        this.recordAutomationAttention(runtime.competitionId, action);
      }
      if (runtime.automation.snapshot().stateVersion === before) break;
    }
  }

  private advancePendingTestCountdown(runtime: TestRuntime): void {
    const pending = runtime.pendingCountdown;
    if (!pending) return;
    const dueAtMs = pending.action.createdAtMs + pending.emitted * 1_000;
    if (runtime.automationClock.now() < dueAtMs) return;
    const prefix = this.testLogPrefix(runtime, dueAtMs);
    const stage = runtime.definition.stages.find((candidate) => candidate.id === pending.action.stageId);
    const level = String(stage?.level ?? 0).padStart(2, "0");
    const referee = runtime.definition.refereeConnectionId;
    if (pending.emitted < 3) {
      const value = (3 - pending.emitted) as 3 | 2 | 1;
      runtime.automation.observeCountdown(value);
      this.appendRawLog(runtime.competitionId, "test-referee", `${prefix} [${referee}, *ContestConsole]: Level ${level} - ${value}`, this.testOccurredAt(runtime, dueAtMs));
      pending.emitted += 1;
      return;
    }
    const event: ScenarioEvent = {
      atMs: dueAtMs,
      sourceId: `automation-go:${pending.action.id}`,
      type: "go",
      stageId: pending.action.stageId,
      refereeConnectionId: referee
    };
    runtime.engine.apply(event);
    runtime.automation.acknowledgeAction(pending.action.id, "acknowledged");
    this.appendRawLog(runtime.competitionId, "test-referee", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, dueAtMs));
    this.recordAutomationAttention(runtime.competitionId, pending.action);
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
        this.appendAttention(runtime.competitionId, {
          id: `deadline:${attempt.id}:${result.playerId}`,
          category: "result",
          severity: "warning",
          title: "关卡时限已到",
          message: `${result.playerId} 未完成，成绩记为 DNF。`,
          occurredAt: this.testOccurredAt(runtime, result.receivedAtMs),
          stageId: attempt.stageId,
          participantIds: [result.playerId]
        });
        this.journal.append({ type: "test-run.event", competitionId: runtime.competitionId, data: event });
      }
    }
  }

  private observeScenarioPhase(runtime: TestRuntime, snapshot: AutomationSnapshot): void {
    const trigger = snapshot.phase === "ready" ? "ready" : snapshot.phase === "running" || snapshot.phase === "tail-intake" ? "running" : undefined;
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
      this.appendAttention(runtime.competitionId, {
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

  private applyScheduledTestRecoveries(runtime: TestRuntime): void {
    const due = runtime.recoveries.filter((recovery) => recovery.dueAtMs <= runtime.automationClock.now());
    runtime.recoveries = runtime.recoveries.filter((recovery) => recovery.dueAtMs > runtime.automationClock.now());
    for (const recovery of due) {
      runtime.automation.observeConnection(recovery.playerId, true);
      const player = runtime.definition.players.find((candidate) => candidate.id === recovery.playerId);
      if (player) {
        const event: ScenarioEvent = { atMs: recovery.dueAtMs, sourceId: `scenario-reconnect:${runtime.id}:${recovery.playerId}:${recovery.dueAtMs}`, type: "login", playerId: player.id, connectionId: player.connectionId };
        this.appendRawLog(runtime.competitionId, "test-player", this.testEventLogLine(runtime, event), this.testOccurredAt(runtime, event.atMs));
      }
      this.appendAttention(runtime.competitionId, {
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

  private startRealtimeTestAutomation(runtime: TestRuntime): void {
    if (this.realtimeTestTimers.has(runtime.id)) return;
    const timer: RealtimeTestTimer = {
      lastWallAtMs: performance.now(),
      handle: setInterval(() => this.tickRealtimeTestAutomation(runtime.id), 500)
    };
    timer.handle.unref?.();
    this.realtimeTestTimers.set(runtime.id, timer);
  }

  private stopRealtimeTestAutomation(runId: string): void {
    const timer = this.realtimeTestTimers.get(runId);
    if (!timer) return;
    clearInterval(timer.handle);
    this.realtimeTestTimers.delete(runId);
  }

  private tickRealtimeTestAutomation(runId: string): void {
    const timer = this.realtimeTestTimers.get(runId);
    const runtime = this.testRuns.get(runId);
    if (!timer || !runtime) {
      this.stopRealtimeTestAutomation(runId);
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
      this.settleTestAutomation(runtime);
      const snapshot = runtime.automation.snapshot();
      const scoreboardVersions = runtime.engine.snapshot().scoreboardVersions.length;
      const changed = snapshot.stateVersion !== beforeStateVersion || scoreboardVersions !== beforeScoreboardVersions;
      runtime.clockAdvanceCanCoalesce = !changed;
      this.persistTestRuntime(runtime);
      if (scoreboardVersions !== beforeScoreboardVersions) this.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
      if (changed) this.journal.append({ type: "test-run.realtime-progress", competitionId: runtime.competitionId, data: { runId, phase: snapshot.phase } });
      if (!snapshot.automationEnabled || snapshot.phase === "review" || snapshot.phase === "paused" || snapshot.phase === "incident") {
        this.stopRealtimeTestAutomation(runId);
      }
    } catch (error) {
      runtime.automation.pause();
      this.persistTestRuntime(runtime);
      this.stopRealtimeTestAutomation(runId);
      this.journal.append({ type: "test-run.realtime-error", competitionId: runtime.competitionId, data: { runId, message: error instanceof Error ? error.message : "unknown" } });
    }
  }

  private applyAutomationEvent(runtime: TestRuntime, event: ScenarioDefinition["events"][number], settleAutomation = true): void {
    if (event.atMs > runtime.automationClock.now()) runtime.automationClock.advanceBy(event.atMs - runtime.automationClock.now());
    switch (event.type) {
      case "login": runtime.automation.observeConnection(event.playerId, true); break;
      case "disconnect": runtime.automation.observeConnection(event.playerId, false); break;
      case "cheat": {
        runtime.automation.observeCheat(event.playerId, event.enabled, event.sourceId);
        if (event.enabled) {
          const stageId = runtime.automation.snapshot().currentStageId;
          const phase = runtime.automation.snapshot().phase;
          if (stageId && (phase === "running" || phase === "tail-intake")) {
            runtime.engine.apply({ atMs: runtime.automationClock.now(), sourceId: `${event.sourceId}:excluded`, type: "exclude", stageId, playerId: event.playerId, reason: "cheat-enabled" });
            this.appendAttention(runtime.competitionId, {
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
        break;
      }
      case "finish": runtime.automation.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "finished", sourceId: event.sourceId, receivedAtMs: runtime.automationClock.now() }); break;
      case "dnf": runtime.automation.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "dnf", sourceId: event.sourceId, reason: event.reason, receivedAtMs: runtime.automationClock.now() }); break;
      case "exclude": runtime.automation.observeViolation(event.playerId, event.sourceId, event.reason); break;
      case "warning": {
        const stageId = runtime.automation.snapshot().currentStageId;
        if (event.playerId && stageId) {
          const sourceId = `${event.sourceId}:excluded`;
          runtime.automation.observeViolation(event.playerId, sourceId, event.message);
          runtime.engine.apply({ atMs: runtime.automationClock.now(), sourceId, type: "exclude", stageId, playerId: event.playerId, reason: event.message });
        }
        break;
      }
      case "fault": this.applyFault(runtime, event); break;
      default: break;
    }
    if (settleAutomation) this.settleTestAutomation(runtime);
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
        this.appendRawLog(runtime.competitionId, "test-player", `${prefix} [Warning] ${player.displayName} just pressed the Reset hotkey at Level ${level}!`, this.testOccurredAt(runtime, event.atMs));
        break;
      }
      default: throw new ServiceError("VALIDATION_FAILED", "未知故障类型", 400);
    }
  }

  private makeWorkRuntime(competitionId: string, config: CompetitionConfig, transport: CommandTransport, mockClientVersion?: string): WorkRuntime {
    const definition = this.configToScenarioDefinition(config);
    const controller = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      dynamicParticipants: true,
      stages: definition.stages.map((stage) => ({
        id: stage.id,
        map: String(stage.level),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      policy: automationPolicyFor(config)
    }, new SystemMonotonicClock());
    const commands = new CommandQueue(transport, 5_000, (record) => this.recordCommand(competitionId, record));
    return { competitionId, controller, engine: new CompetitionEngine(definition), commands, runtime: new WorkAutomationRuntime(controller, commands), ...(transport instanceof ManagedMockClient ? { client: transport } : {}), ...(mockClientVersion === undefined ? {} : { mockClientVersion }) };
  }

  private startParticipantReconciliation(runtime: WorkRuntime): void {
    let sequence = 0;
    const requestList = () => {
      const phase = runtime.controller.snapshot().phase;
      if (phase !== "lobby" && phase !== "paused" && phase !== "review") return;
      sequence += 1;
      void runtime.commands.enqueue({ type: "list" }, `${runtime.competitionId}:participant-list:${Date.now()}:${sequence}`);
    };
    runtime.initialListTimer = setTimeout(requestList, 1_000);
    runtime.initialListTimer.unref?.();
    runtime.listTimer = setInterval(requestList, 30_000);
    runtime.listTimer.unref?.();
  }

  private startRealtimeWorkAutomation(runtime: WorkRuntime): void {
    if (runtime.automationTimer) return;
    runtime.automationTimer = setInterval(() => void this.tickRealtimeWorkAutomation(runtime), 500);
    runtime.automationTimer.unref?.();
  }

  private stopRealtimeWorkAutomation(runtime: WorkRuntime): void {
    if (!runtime.automationTimer) return;
    clearInterval(runtime.automationTimer);
    delete runtime.automationTimer;
    delete runtime.automationDispatching;
  }

  private async tickRealtimeWorkAutomation(runtime: WorkRuntime): Promise<void> {
    if (runtime.automationDispatching || this.workRuntimes.get(runtime.competitionId) !== runtime) return;
    runtime.automationDispatching = true;
    const before = runtime.controller.snapshot().stateVersion;
    try {
      runtime.controller.tick();
      this.mirrorWorkSystemResults(runtime);
      const records = await runtime.runtime.dispatch();
      const snapshot = runtime.controller.snapshot();
      for (const action of snapshot.actions.filter((candidate) => candidate.status === "acknowledged")) this.recordAutomationAttention(runtime.competitionId, action);
      this.saveWorkRuntimeSnapshot(runtime);
      if (snapshot.stateVersion !== before || records.length > 0) {
        this.journal.append({ type: "work.automation-progress", competitionId: runtime.competitionId, data: { phase: snapshot.phase } });
      }
      if (!snapshot.automationEnabled || snapshot.phase === "review" || snapshot.phase === "paused" || snapshot.phase === "incident") {
        this.stopRealtimeWorkAutomation(runtime);
      }
    } catch (error) {
      runtime.controller.pause();
      this.saveWorkRuntimeSnapshot(runtime);
      this.stopRealtimeWorkAutomation(runtime);
      this.journal.append({ type: "work.automation-error", competitionId: runtime.competitionId, data: { message: error instanceof Error ? error.message : "unknown" } });
    } finally {
      runtime.automationDispatching = false;
    }
  }

  private ingestWorkLine(runtime: WorkRuntime, line: string): void {
    const config = this.getPublishedConfig(runtime.competitionId);
    if (!config) return;
    this.appendRawLog(runtime.competitionId, "mock-client", line);
    const parsed = parseLogLine(line, { year: Number(config.date.slice(0, 4)), utcOffsetMinutes: utcOffsetMinutes(config.timezone) });
    const before = runtime.controller.snapshot();
    const currentStage = config.stages.find((candidate) => candidate.id === before.currentStageId);
    if ((parsed.event.type === "finish" || parsed.event.type === "dnf")
      && (before.phase === "running" || before.phase === "tail-intake")
      && currentStage && parsed.event.level !== currentStage.level) {
      this.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveWorkRuntimeSnapshot(runtime);
      return;
    }
    if (parsed.event.type === "player-list-start") this.beginListReconciliation(runtime, parsed.event.count);
    if (parsed.event.type === "countdown") runtime.controller.observeCountdown(parsed.event.value);
    if (parsed.event.type === "warning") this.handleWorkWarning(runtime, config, parsed.event);
    const event = this.domainToScenarioEvent(runtime.competitionId, config, parsed.event);
    if (event) {
      if ("playerId" in event) {
        runtime.controller.registerParticipant(event.playerId);
        const participant = this.getDraftConfig(runtime.competitionId).participants.find((candidate) => candidate.id === event.playerId);
        runtime.engine.registerPlayer(event.playerId, participant?.displayName ?? event.playerId);
      }
      runtime.engine.apply(event);
      if (event.type === "login") runtime.controller.observeConnection(event.playerId, true);
      else if (event.type === "disconnect") runtime.controller.observeConnection(event.playerId, false);
      else if (event.type === "go") runtime.controller.observeAuthoritativeGo(event.stageId);
      else if (event.type === "finish") runtime.controller.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "finished", sourceId: event.sourceId, receivedAtMs: performance.now() });
      else if (event.type === "dnf") runtime.controller.recordResult({ stageId: event.stageId, playerId: event.playerId, status: "dnf", sourceId: event.sourceId, reason: event.reason, receivedAtMs: performance.now() });
      else if (event.type === "exclude") {
        runtime.controller.observeViolation(event.playerId, event.sourceId, event.reason);
        this.recordExclusionAttention(runtime.competitionId, event.stageId, event.playerId, event.sourceId, event.reason);
      }
      else if (event.type === "cheat") {
        const snapshotBeforeCheat = runtime.controller.snapshot();
        const activeAttempt = [...snapshotBeforeCheat.attempts].reverse().find((candidate) =>
          candidate.stageId === snapshotBeforeCheat.currentStageId && candidate.intakeOpen);
        const playerAlreadyCompleted = activeAttempt?.results.some((result) => result.playerId === event.playerId) ?? false;
        if (!playerAlreadyCompleted) {
          runtime.controller.observeCheat(event.playerId, event.enabled, event.sourceId);
          const snapshot = runtime.controller.snapshot();
          const excludedByThisEvent = snapshot.attempts.some((attempt) => attempt.results.some((result) =>
            result.playerId === event.playerId && result.status === "excluded" && result.sourceId === event.sourceId));
          if (event.enabled && excludedByThisEvent && (snapshot.phase === "running" || snapshot.phase === "tail-intake")) {
            runtime.engine.apply({ atMs: Date.parse(parsed.event.occurredAt), sourceId: `${event.sourceId}:excluded`, type: "exclude", stageId: snapshot.currentStageId, playerId: event.playerId, reason: "cheat-enabled" });
            this.recordExclusionAttention(runtime.competitionId, snapshot.currentStageId, event.playerId, event.sourceId, "开启 cheat");
          }
        }
      }
      if (event.type === "finish" && parsed.event.type === "finish" && parsed.event.cheat) {
        const exclusionSourceId = `${event.sourceId}:cheat-finish`;
        runtime.engine.apply({ atMs: event.atMs, sourceId: exclusionSourceId, type: "exclude", stageId: event.stageId, playerId: event.playerId, reason: "cheat-finish" });
        runtime.controller.observeViolation(event.playerId, exclusionSourceId, "cheat-finish");
        this.observeWorkParticipant(runtime.competitionId, parsed.event.playerName, parsed.event.connectionId, true, "excluded");
        this.recordExclusionAttention(runtime.competitionId, event.stageId, event.playerId, exclusionSourceId, "[CHEAT] 完赛");
      }
      if (event.type === "login" && (parsed.event.type === "player-login" || parsed.event.type === "player-listed") && parsed.event.cheat) {
        const snapshot = runtime.controller.snapshot();
        const activeAttempt = [...snapshot.attempts].reverse().find((candidate) =>
          candidate.stageId === snapshot.currentStageId && candidate.intakeOpen);
        if (!activeAttempt?.results.some((result) => result.playerId === event.playerId)) {
          runtime.controller.observeCheat(event.playerId, true, event.sourceId);
        }
      }
      this.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    }
    if (parsed.event.type === "player-listed") this.recordListParticipant(runtime, parsed.event.playerName);
    this.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
    this.saveWorkRuntimeSnapshot(runtime);
  }

  private handleWorkWarning(runtime: WorkRuntime, config: CompetitionConfig, event: Extract<DomainEvent, { type: "warning" }>): void {
    if (!event.playerName || event.level === undefined || !event.violationCode) {
      this.appendAttention(runtime.competitionId, {
        id: `warning:${event.sourceId}`,
        category: "command",
        severity: "warning",
        title: "服务器 Warning",
        message: event.message,
        occurredAt: event.occurredAt
      });
      return;
    }
    const snapshot = runtime.controller.snapshot();
    const stage = config.stages.find((candidate) => candidate.id === snapshot.currentStageId);
    if ((snapshot.phase !== "running" && snapshot.phase !== "tail-intake") || stage?.level !== event.level) return;
    const participant = this.getDraftConfig(runtime.competitionId).participants.find((candidate) =>
      candidate.id.toLocaleLowerCase("en-US") === event.playerName?.trim().toLocaleLowerCase("en-US"));
    if (!stage || !participant) {
      this.appendAttention(runtime.competitionId, {
        id: `warning:${event.sourceId}`,
        category: "command",
        severity: "warning",
        title: "Warning 无法自动定位",
        message: `${event.message}；未自动排除成绩，请裁判核对。`,
        occurredAt: event.occurredAt
      });
      return;
    }
    runtime.controller.registerParticipant(participant.id);
    runtime.engine.registerPlayer(participant.id, participant.displayName);
    const sourceId = `${event.sourceId}:excluded`;
    runtime.engine.apply({ atMs: Date.parse(event.occurredAt), sourceId, type: "exclude", stageId: stage.id, playerId: participant.id, reason: event.violationCode });
    runtime.controller.observeViolation(participant.id, sourceId, event.violationCode);
    this.observeWorkParticipant(runtime.competitionId, participant.id, participant.connectionIds.at(-1) ?? participant.id, true, "excluded");
    this.recordExclusionAttention(runtime.competitionId, stage.id, participant.id, sourceId, event.message);
    this.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
  }

  private domainToScenarioEvent(competitionId: string, config: CompetitionConfig, event: DomainEvent): ScenarioEvent | undefined {
    const stage = config.stages.find((candidate) => candidate.level === ("level" in event ? event.level : -1));
    switch (event.type) {
      case "player-login":
      case "player-listed": {
        const participant = this.observeWorkParticipant(competitionId, event.playerName, event.connectionId, true);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "login", playerId: participant.id, connectionId: event.connectionId } : undefined;
      }
      case "player-disconnect": {
        const participant = this.observeWorkParticipant(competitionId, event.playerName, event.connectionId, false);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "disconnect", playerId: participant.id, connectionId: event.connectionId } : undefined;
      }
      case "go":
        if (!stage || normalizeRefereeName(event.refereeName) !== normalizeRefereeName(config.refereeName)) return undefined;
        return { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "go", stageId: stage.id, refereeConnectionId: "work-referee" };
      case "finish": {
        const participant = this.observeWorkParticipant(competitionId, event.playerName, event.connectionId, true, "finished");
        return stage && participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "finish", stageId: stage.id, playerId: participant.id, score: event.score, elapsedMs: event.elapsedMs } : undefined;
      }
      case "dnf": {
        const participant = this.observeWorkParticipant(competitionId, event.playerName, event.connectionId, true, event.cheat ? "excluded" : "dnf");
        return stage && participant ? event.cheat
          ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "exclude", stageId: stage.id, playerId: participant.id, reason: "cheat-dnf" }
          : { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "dnf", stageId: stage.id, playerId: participant.id, reason: "dnf" }
          : undefined;
      }
      case "cheat-changed": {
        const participant = this.observeWorkParticipant(competitionId, event.playerName, event.connectionId, true);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "cheat", playerId: participant.id, enabled: event.enabled } : undefined;
      }
      default:
        return undefined;
    }
  }

  private beginListReconciliation(runtime: WorkRuntime, expected: number): void {
    runtime.listReconciliation = { expected, seen: 0, onlinePlayerIds: new Set<string>() };
    if (expected === 0) this.finishListReconciliation(runtime);
  }

  private recordListParticipant(runtime: WorkRuntime, rawName: string): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation) return;
    reconciliation.seen += 1;
    const playerId = rawName.trim();
    if (playerId && !playerId.startsWith("*")) reconciliation.onlinePlayerIds.add(playerId.toLocaleLowerCase("en-US"));
    if (reconciliation.seen >= reconciliation.expected) this.finishListReconciliation(runtime);
  }

  private finishListReconciliation(runtime: WorkRuntime): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation) return;
    const config = this.getDraftConfig(runtime.competitionId);
    const participants = config.participants.map((participant) => {
      const online = reconciliation.onlinePlayerIds.has(participant.id.toLocaleLowerCase("en-US"));
      if (participant.online !== online) runtime.controller.observeConnection(participant.id, online);
      return participant.online === online ? participant : { ...participant, online };
    });
    this.upsertConfig(runtime.competitionId, 0, false, { ...config, participants });
    delete runtime.listReconciliation;
    this.journal.append({ type: "participants.reconciled", competitionId: runtime.competitionId, data: { online: [...reconciliation.onlinePlayerIds] } });
  }

  private observeWorkParticipant(
    competitionId: string,
    rawName: string,
    connectionId: string,
    online: boolean,
    stageStatus?: ParticipantView["currentStageStatus"]
  ): ParticipantView | undefined {
    const playerId = rawName.trim();
    if (!playerId || playerId.startsWith("*")) return undefined;
    const config = this.getDraftConfig(competitionId);
    const normalizedPlayerId = playerId.toLocaleLowerCase("en-US");
    const existing = config.participants.find((participant) => participant.id.toLocaleLowerCase("en-US") === normalizedPlayerId);
    const alias = config.playerAliases.find((candidate) => candidate.playerId.toLocaleLowerCase("en-US") === normalizedPlayerId);
    const participant: ParticipantView = existing
      ? {
          ...existing,
          displayName: alias?.displayName ?? existing.displayName,
          connectionIds: [...new Set([...existing.connectionIds, connectionId])],
          online,
          ...(stageStatus === undefined ? {} : { currentStageStatus: stageStatus })
        }
      : {
          id: playerId,
          displayName: alias?.displayName ?? playerId,
          role: "participant",
          connectionIds: [connectionId],
          online,
          currentStageStatus: stageStatus ?? (online ? "waiting" : "not-started")
        };
    const participants = existing
      ? config.participants.map((candidate) => candidate.id === existing.id ? participant : candidate)
      : [...config.participants, participant];
    this.upsertConfig(competitionId, 0, false, { ...config, participants });
    if (!existing) this.journal.append({ type: "participant.registered", competitionId, data: participant });
    return participant;
  }

  private configToScenarioDefinition(config: CompetitionConfig): ScenarioDefinition {
    const participants = config.participants.filter((participant) => participant.role === "participant");
    const aliases = new Map(config.playerAliases.map((alias) => [alias.playerId.toLocaleLowerCase("en-US"), alias.displayName]));
    return {
      schemaVersion: 1,
      id: `work-${config.name}`,
      name: config.name,
      year: Number(config.date.slice(0, 4)),
      timezone: config.timezone,
      refereeConnectionId: "work-referee",
      players: participants.map((participant) => ({
        id: participant.id,
        displayName: aliases.get(participant.id.toLocaleLowerCase("en-US")) ?? participant.displayName,
        connectionId: participant.connectionIds[0] ?? participant.id
      })),
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

  private materializeBehaviorScenario(competitionId: string, behavior: ScenarioDefinition): ScenarioDefinition {
    const config = this.getDraftConfig(competitionId);
    return {
      ...behavior,
      year: Number(config.date.slice(0, 4)),
      timezone: config.timezone,
      refereeConnectionId: `test-referee:${competitionId}`,
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
      expected: { attempts: config.stages.length, scoreboardVersions: config.stages.length * behavior.players.length }
    };
  }

  private saveWorkRuntimeSnapshot(runtime: WorkRuntime): void {
    const payload = this.getPayload(runtime.competitionId);
    this.savePayload(runtime.competitionId, {
      ...payload,
      work: {
        started: true,
        ...(runtime.mockClientVersion === undefined ? {} : { mockClientVersion: runtime.mockClientVersion }),
        automation: runtime.controller.snapshot()
      }
    });
  }

  private storedScoreboardVersions(competitionId: string): ScoreboardVersionView[] {
    return rows<{ payload: string }>(this.options.database, "SELECT payload FROM scoreboard_versions WHERE competition_id=? ORDER BY version", competitionId)
      .map((item) => scoreboardView(JSON.parse(item.payload) as ScoreboardVersion));
  }

  private recoverSentCommands(competitionId: string): void {
    if (!this.options.database) return;
    const sent = rows<{ id: string; payload: string }>(this.options.database, "SELECT id,payload FROM command_audits WHERE competition_id=? AND status='sent'", competitionId);
    for (const item of sent) {
      const stored = JSON.parse(item.payload) as CommandRecord;
      const recovered: CommandRecord = { ...stored, status: "uncertain", updatedAt: new Date().toISOString() };
      this.options.database.sqlite.prepare("UPDATE command_audits SET status='uncertain',payload=?,updated_at=? WHERE id=?").run(JSON.stringify(recovered), recovered.updatedAt, item.id);
      this.appendAttention(competitionId, {
        id: `recovered-command:${item.id}`,
        category: "command",
        severity: "critical",
        title: "重启前命令结果不确定",
        message: `${recovered.command}；不会自动重试，请裁判核对现场。`,
        occurredAt: recovered.updatedAt
      });
    }
  }

  private saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void {
    this.withDatabase((database) => {
      for (const version of versions) {
        database.sqlite.prepare("INSERT OR IGNORE INTO scoreboard_versions(id,competition_id,version,trigger_event_id,payload,deterministic_hash,created_at) VALUES (?,?,?,?,?,?,?)")
          .run(version.id, competitionId, version.version, version.triggerSourceId, JSON.stringify(version), version.deterministicHash, new Date().toISOString());
      }
    });
  }

  private mirrorWorkSystemResults(runtime: WorkRuntime): void {
    const engineSources = new Set(runtime.engine.snapshot().currentScoreboard.flatMap((entry) => Object.values(entry.stages).map((result) => result.sourceId)));
    let changed = false;
    for (const attempt of runtime.controller.snapshot().attempts) {
      for (const result of attempt.results) {
        if (result.status !== "dnf" || engineSources.has(result.sourceId) || !result.sourceId.match(/^(deadline|manual-end):/)) continue;
        runtime.engine.apply({ atMs: Date.now(), sourceId: result.sourceId, type: "dnf", stageId: attempt.stageId, playerId: result.playerId, reason: result.reason ?? "time-limit" });
        changed = true;
        this.appendAttention(runtime.competitionId, {
          id: `system-dnf:${result.sourceId}`,
          category: "result",
          severity: "warning",
          title: result.sourceId.startsWith("deadline:") ? "关卡时限已到" : "本关已提前结束",
          message: `${result.playerId} 未完成，成绩记为 DNF。`,
          occurredAt: new Date().toISOString(),
          stageId: attempt.stageId,
          participantIds: [result.playerId]
        });
      }
    }
    if (changed) this.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
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

  private runtimeAutomationSnapshot(competitionId: string): AutomationSnapshot | undefined {
    const competition = this.get(competitionId);
    if (competition.mode === "work") return this.workRuntimes.get(competitionId)?.controller.snapshot();
    const runId = this.getPayload(competitionId).activeRunId;
    return runId ? this.getTestRuntime(competitionId, runId).automation.snapshot() : undefined;
  }

  private consumeActionConfirmation(competitionId: string, action: CompetitionAction): ConfirmationRecord | undefined {
    switch (action.type) {
      case "manual-go":
        return this.consumeConfirmation(competitionId, "manual-go", action.confirmationToken, action.impactHash, competitionId);
      case "reschedule":
      case "reschedule-stage-deadline":
      case "delay-ready":
      case "extend-stage-deadline":
      case "end-stage":
        return this.consumeConfirmation(competitionId, "manual-action", action.confirmationToken, action.impactHash, competitionId);
      case "restart":
        return this.consumeConfirmation(competitionId, "restart", action.confirmationToken, action.impactHash, action.incidentId);
      case "void-attempt":
      case "restore-attempt":
        return this.consumeConfirmation(competitionId, "high-risk", action.confirmationToken, action.impactHash, action.attemptId);
      case "scoreboard-override":
        return this.consumeConfirmation(competitionId, "scoreboard-override", action.confirmationToken, action.impactHash, `${action.playerId}:${action.stageId}`);
      case "kick":
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
        controller().requestManualGo();
        if (competition.mode === "test") {
          const runId = this.getPayload(competitionId).activeRunId as string;
          this.settleTestAutomation(this.getTestRuntime(competitionId, runId));
        }
        break;
      }
      case "ready": {
        controller().manualReady();
        if (competition.mode === "test") {
          const runId = this.getPayload(competitionId).activeRunId as string;
          this.settleTestAutomation(this.getTestRuntime(competitionId, runId));
        }
        break;
      }
      case "reschedule": {
        const target = Date.parse(action.plannedReadyAt);
        if (!Number.isFinite(target)) throw new ServiceError("VALIDATION_FAILED", "Ready 改期时间无效", 400);
        controller().reschedule(this.wallTimeToRuntimeMs(competitionId, target));
        break;
      }
      case "reschedule-stage-deadline": {
        const target = Date.parse(action.deadlineAt);
        if (!Number.isFinite(target)) throw new ServiceError("VALIDATION_FAILED", "关卡时限改期时间无效", 400);
        controller().rescheduleStageDeadline(this.wallTimeToRuntimeMs(competitionId, target));
        break;
      }
      case "delay-ready":
        controller().delayReady(action.milliseconds);
        break;
      case "extend-stage-deadline":
        controller().extendStageDeadline(action.milliseconds);
        break;
      case "end-stage":
        controller().endStage("referee-ended-stage");
        if (competition.mode === "work") this.mirrorWorkSystemResults(this.workRuntimes.get(competitionId) as WorkRuntime);
        break;
      case "restart": {
        if (!confirmation?.runtimeToken) throw new ServiceError("CONFIRMATION_INVALID", "重赛确认缺少运行时凭据", 409);
        controller().confirmRestart({
          incidentId: action.incidentId,
          impactHash: action.impactHash,
          token: confirmation.runtimeToken,
          reason: "referee-confirmed-restart"
        });
        break;
      }
      case "void-attempt":
        controller().voidAttempt(action.attemptId);
        break;
      case "restore-attempt":
        controller().restoreAttempt(action.attemptId);
        break;
      case "notification": {
        if (competition.mode === "work") return false;
        const runId = this.getPayload(competitionId).activeRunId as string;
        const runtime = this.getTestRuntime(competitionId, runId);
        const snapshot = runtime.automation.snapshot();
        const automationAction: AutomationAction = {
          id: randomUUID(), kind: action.channel, idempotencyKey: `manual-notification:${randomUUID()}`,
          createdAtMs: runtime.automationClock.now(), stageId: snapshot.currentStageId,
          map: String(runtime.definition.stages.find((stage) => stage.id === snapshot.currentStageId)?.level ?? 0),
          mode: (runtime.definition.stages.find((stage) => stage.id === snapshot.currentStageId)?.mode.toLowerCase() ?? "sr") as "sr" | "hs",
          message: action.text, status: "acknowledged"
        };
        for (const line of this.testAutomationActionLogLines(runtime, automationAction)) this.appendRawLog(competitionId, "test-referee", line, this.testOccurredAt(runtime, automationAction.createdAtMs));
        this.recordAutomationAttention(competitionId, automationAction);
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
      case "player-alias-upsert":
        this.upsertPlayerAlias(competitionId, action.playerId, action.displayName);
        break;
      case "scoreboard-override":
        throw new ServiceError("CAPABILITY_UNSUPPORTED", "请使用榜单修订接口提交该动作", 409);
      default:
        return false;
    }
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (runId) {
        const runtime = this.getTestRuntime(competitionId, runId);
        this.settleTestAutomation(runtime);
        this.persistTestRuntime(runtime);
      }
    } else {
      const runtime = this.workRuntimes.get(competitionId);
      if (runtime) {
        await runtime.runtime.dispatch();
        this.saveWorkRuntimeSnapshot(runtime);
      }
    }
    return true;
  }

  private wallTimeToRuntimeMs(competitionId: string, wallTimeMs: number): number {
    const competition = this.get(competitionId);
    if (competition.mode === "work") return performance.now() + (wallTimeMs - Date.now());
    const runId = this.getPayload(competitionId).activeRunId;
    if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
    const runtime = this.getTestRuntime(competitionId, runId);
    return wallTimeMs - Date.parse(runtime.createdAt);
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

  private upsertPlayerAlias(competitionId: string, rawPlayerId: string, rawDisplayName: string): void {
    const playerId = rawPlayerId.trim();
    const displayName = rawDisplayName.trim();
    if (!playerId || playerId.startsWith("*")) throw new ServiceError("VALIDATION_FAILED", "玩家 ID 必须是非旁观模式的游戏内名称", 400);
    if (!displayName) throw new ServiceError("VALIDATION_FAILED", "排行榜显示名不能为空", 400);
    const config = this.getDraftConfig(competitionId);
    const normalizedPlayerId = playerId.toLocaleLowerCase("en-US");
    const aliases = [
      ...config.playerAliases.filter((alias) => alias.playerId.toLocaleLowerCase("en-US") !== normalizedPlayerId),
      { playerId, displayName }
    ];
    const participants = config.participants.map((participant) =>
      participant.id.toLocaleLowerCase("en-US") === normalizedPlayerId ? { ...participant, displayName } : participant);
    this.upsertConfig(competitionId, 0, false, { ...config, playerAliases: aliases, participants });

    const workRuntime = this.workRuntimes.get(competitionId);
    const participant = participants.find((candidate) => candidate.id.toLocaleLowerCase("en-US") === normalizedPlayerId);
    if (workRuntime && participant) workRuntime.engine.registerPlayer(participant.id, displayName);
    const runId = this.getPayload(competitionId).activeRunId;
    if (runId && this.get(competitionId).mode === "test" && participant) {
      this.getTestRuntime(competitionId, runId).engine.registerPlayer(participant.id, displayName);
    }
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

  private availableActionsFor(competitionId: string, snapshot?: AutomationSnapshot): ActionAvailability[] {
    const competition = this.get(competitionId);
    const phase = snapshot?.phase ?? competition.status;
    const blockers = snapshot?.blockers.filter((blocker) => blocker.code !== "AUTOMATION_PAUSED") ?? [];
    const hasBlockingIssue = blockers.some((blocker) => blocker.severity === "critical" || blocker.code === "PARTICIPANT_OFFLINE");
    const openAttempt = snapshot?.attempts.findLast((attempt) => attempt.intakeOpen && !attempt.voided);
    const currentStageActions = snapshot?.actions.filter((action) => action.stageId === snapshot.currentStageId) ?? [];
    const firstReadyAtMs = currentStageActions.find((action) => action.kind === "ready")?.createdAtMs;
    const activeRunId = competition.mode === "test" ? this.getPayload(competitionId).activeRunId : undefined;
    const runtimeNowMs = competition.mode === "test" && activeRunId ? this.testRuns.get(activeRunId)?.automationClock.now() : performance.now();
    const readyBufferElapsed = firstReadyAtMs !== undefined && runtimeNowMs !== undefined
      && runtimeNowMs >= firstReadyAtMs + this.getDraftConfig(competitionId).flow.readyBufferMs;
    const readySequenceComplete = currentStageActions.filter((action) => action.kind === "ready" && action.status === "acknowledged").length >= 3
      && currentStageActions.some((action) => action.kind === "announce" && action.status === "acknowledged" && action.message === "READY!")
      && currentStageActions.some((action) => action.kind === "cheat-off" && action.status === "acknowledged");
    const hasRuntime = competition.mode === "work"
      ? this.workRuntimes.has(competitionId)
      : Boolean(this.getPayload(competitionId).activeRunId && snapshot);
    const descriptor = (
      action: RefereeActionId,
      label: string,
      effect: string,
      enabled: boolean,
      disabledReason: string
    ): ActionAvailability => ({ action, label, effect, enabled, ...(enabled ? {} : { disabledReason }) });
    return [
      descriptor("start-work", "启动工作运行", "启动真实 MockClient，并立即开始在线名单对账。", competition.mode === "work" && competition.status === "published" && !hasRuntime,
        competition.mode !== "work" ? "测试比赛不启动真实 MockClient" : competition.status !== "published" ? "请先发布比赛配置" : "工作运行已经启动"),
      descriptor("enable-automation", "启用自动化", "由状态机按固定节奏推进 Ready、倒数和关卡切换。", hasRuntime && !snapshot?.automationEnabled && !["review", "incident"].includes(phase) && !hasBlockingIssue,
        !hasRuntime ? "请先启动运行" : snapshot?.automationEnabled ? "自动化已经启用" : phase === "incident" ? "请先处理当前事故" : phase === "review" ? "比赛已进入复核" : "存在未解除的流程阻断"),
      descriptor("pause-automation", "暂停自动化", "停止自动推进；已经发出的真实命令不会自动撤回。", Boolean(snapshot?.automationEnabled), "自动化当前未启用"),
      descriptor("ready", "开始 Ready", "立即进入三次 Get ready、READY 公告和关闭 cheat 流程，不会跳过倒数。", hasRuntime && ["lobby", "preparing", "paused", "restart-preparing"].includes(phase) && !hasBlockingIssue,
        !hasRuntime ? "请先启动运行" : !["lobby", "preparing", "paused", "restart-preparing"].includes(phase) ? `当前阶段 ${phase} 不能开始 Ready` : "存在离线、cheat、事故或不确定命令"),
      descriptor("cheat-off", "关闭 cheat", "向服务器发送关闭 cheat 命令。", hasRuntime && !["review", "incident"].includes(phase), !hasRuntime ? "请先启动运行" : "当前阶段不可发送"),
      descriptor("manual-go", "手动发令", "完成真实 3/2/1 倒数；只有 Go 回显后才创建比赛尝试并启动时限。", phase === "ready" && readySequenceComplete && readyBufferElapsed && !hasBlockingIssue,
        phase !== "ready" ? "仅 Ready 阶段可手动发令" : !readySequenceComplete ? "三次 Ready、READY 公告或关闭 cheat 尚未全部确认" : !readyBufferElapsed ? "Ready 起点尚未满配置缓冲时间" : "存在流程阻断"),
      descriptor("delay-ready", "Ready 延后 1 分钟", "将下一次已安排的 Ready 时间顺延 1 分钟。", snapshot?.plannedReadyAtMs !== undefined && ["preparing", "pre-start-wait", "tail-intake", "restart-preparing"].includes(phase), "当前没有可延后的 Ready 计划"),
      descriptor("reschedule", "Ready 改期", "把下一次 Ready 改到指定时间，不改变本关时限。", snapshot?.plannedReadyAtMs !== undefined && ["preparing", "pre-start-wait", "tail-intake", "restart-preparing"].includes(phase), "当前没有可改期的 Ready 计划"),
      descriptor("extend-stage-deadline", "本关时限延长 1 分钟", "立即把当前关卡最晚结束时间顺延 1 分钟。", Boolean(openAttempt) && ["running", "tail-intake"].includes(phase), "当前没有开放的成绩接收窗口"),
      descriptor("reschedule-stage-deadline", "关卡时限改期", "把当前关卡最晚结束时间改到指定时间，不改变下一次 Ready。", Boolean(openAttempt) && ["running", "tail-intake"].includes(phase), "当前没有开放的成绩接收窗口"),
      descriptor("end-stage", "提前结束本关", "关闭成绩窗口，未完成且未排除的选手记为 DNF。", Boolean(openAttempt) && ["running", "tail-intake"].includes(phase), "当前没有可结束的开放关卡"),
      descriptor("restart", "重赛", "作废当前尝试，公告重赛并重新执行完整 Ready 与倒数。", Boolean(snapshot?.incidents.some((incident) => (incident as { status?: string; recommendedRestart?: boolean }).status === "open" && (incident as { recommendedRestart?: boolean }).recommendedRestart)), "当前没有建议重赛的开放事故"),
      descriptor("void-attempt", "作废尝试", "关闭并作废目标尝试，保留原始成绩证据。", Boolean(snapshot?.attempts.some((attempt) => !attempt.voided)), "当前没有可作废的尝试"),
      descriptor("restore-attempt", "恢复尝试", "恢复已作废尝试；同关已有有效尝试时会拒绝。", Boolean(snapshot?.attempts.some((attempt) => attempt.voided)), "当前没有已作废尝试"),
      descriptor("kick", "Kick 玩家", "从服务器移除目标玩家；结果不确定时不会自动重试。", competition.mode === "work" && hasRuntime, competition.mode !== "work" ? "测试模式不发送真实 Kick" : "请先启动工作运行"),
      descriptor("raw-command", "发送原始命令", "原样发送一条 MockClient 命令；结果不确定时不会自动重试。", competition.mode === "work" && hasRuntime, competition.mode !== "work" ? "测试模式不发送真实命令" : "请先启动工作运行"),
      descriptor("finish", "结束比赛", "停止运行并固定比赛为已结束状态，之后可归档。", !["finished", "archived"].includes(competition.status) && (competition.status !== "draft" || hasRuntime), competition.status === "draft" && !hasRuntime ? "草稿比赛尚未开始" : "比赛已经结束"),
      descriptor("archive", "生成归档", "基于明确榜单版本生成不可变归档。", ["finished", "archived"].includes(competition.status), "请先结束比赛"),
      descriptor("delete", "删除比赛", "删除该比赛的配置、运行、审计与本地数据目录。", ["draft", "finished", "archived"].includes(competition.status), "进行中的比赛必须先结束")
    ];
  }

  private assertActionAvailable(competitionId: string, action: RefereeActionId, snapshot?: AutomationSnapshot): void {
    const availability = this.availableActionsFor(competitionId, snapshot).find((candidate) => candidate.action === action);
    if (!availability?.enabled) throw new ServiceError("ACTION_UNAVAILABLE", availability?.disabledReason ?? "当前状态不能执行该动作", 409, availability);
  }

  private actionIdFor(action: CompetitionAction): RefereeActionId | undefined {
    switch (action.type) {
      case "ready": case "cheat-off": case "manual-go": case "reschedule": case "reschedule-stage-deadline": case "delay-ready":
      case "extend-stage-deadline": case "end-stage": case "restart": case "void-attempt": case "restore-attempt": case "kick": case "raw-command":
        return action.type;
      default: return undefined;
    }
  }

  private appendAttention(competitionId: string, item: AttentionItem): void {
    let inserted = false;
    if (this.options.database) {
      inserted = this.options.database.sqlite.prepare("INSERT OR IGNORE INTO attention_items(id,competition_id,category,severity,title,message,occurred_at,stage_id,participant_ids,action) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(item.id, competitionId, item.category, item.severity, item.title, item.message, item.occurredAt, item.stageId ?? null, item.participantIds ? JSON.stringify(item.participantIds) : null, item.action ?? null).changes > 0;
    } else {
      const items = this.memoryAttentionItems.get(competitionId) ?? [];
      if (!items.some((candidate) => candidate.id === item.id)) {
        this.memoryAttentionItems.set(competitionId, [...items, item].slice(-200));
        inserted = true;
      }
    }
    if (inserted) this.journal.append({ type: "flow.attention", competitionId, data: item });
  }

  private attentionItemsFor(competitionId: string, snapshot?: AutomationSnapshot): AttentionItem[] {
    const stored = this.options.database
      ? rows<{ id: string; category: AttentionItem["category"]; severity: AttentionItem["severity"]; title: string; message: string; occurred_at: string; stage_id: string | null; participant_ids: string | null; action: RefereeActionId | null }>(
        this.options.database,
        "SELECT id,category,severity,title,message,occurred_at,stage_id,participant_ids,action FROM attention_items WHERE competition_id=? ORDER BY occurred_at DESC LIMIT 100",
        competitionId
      ).map((item) => ({
        id: item.id, category: item.category, severity: item.severity, title: item.title, message: item.message, occurredAt: item.occurred_at,
        ...(item.stage_id ? { stageId: item.stage_id } : {}),
        ...(item.participant_ids ? { participantIds: JSON.parse(item.participant_ids) as string[] } : {}),
        ...(item.action ? { action: item.action } : {})
      }))
      : [...(this.memoryAttentionItems.get(competitionId) ?? [])].reverse();
    const dynamic: AttentionItem[] = [
      ...(snapshot?.blockers ?? []).map((blocker, index) => ({
        id: `blocker:${blocker.code}:${blocker.participantId ?? index}`,
        category: "blocker" as const,
        severity: blocker.severity,
        title: blocker.code === "COMMAND_UNCONFIRMED" ? "命令结果不确定" : "流程暂时阻断",
        message: blocker.suggestion,
        occurredAt: new Date().toISOString(),
        ...(blocker.participantId ? { participantIds: [blocker.participantId] } : {})
      })),
      ...(snapshot?.incidents ?? []).filter((incident) => (incident as { status?: string }).status === "open").map((incident) => {
        const value = incident as { id: string; type: string; evidence: string; participantIds: readonly string[]; createdAtMs: number };
        return {
          id: `incident:${value.id}`,
          category: "incident" as const,
          severity: "critical" as const,
          title: "待处理事故",
          message: `${value.type}：${value.evidence}`,
          occurredAt: new Date().toISOString(),
          ...(value.participantIds.length ? { participantIds: value.participantIds } : {})
        };
      })
    ];
    return [...dynamic, ...stored].slice(0, 100);
  }

  private recordAutomationAttention(competitionId: string, action: AutomationAction): void {
    const details = action.kind === "bulletin" ? ["flow", "info", "赛程计划已更新"] as const
      : action.kind === "notice" ? ["flow", "info", "流程通知"] as const
      : action.kind === "announce" ? ["flow", "warning", action.message === "READY!" ? "已发出 READY" : "重要比赛通知"] as const
      : action.kind === "go" ? ["flow", "info", "本关已发令 Go"] as const
      : ["command", "info", "裁判命令已确认"] as const;
    this.appendAttention(competitionId, {
      id: `automation:${action.id}`,
      category: details[0],
      severity: details[1],
      title: details[2],
      message: action.message ?? action.kind,
      occurredAt: new Date().toISOString(),
      stageId: action.stageId
    });
  }

  private recordExclusionAttention(competitionId: string, stageId: string, playerId: string, sourceId: string, reason: string): void {
    this.appendAttention(competitionId, {
      id: `excluded:${sourceId}`,
      category: "result",
      severity: "warning",
      title: "违规成绩已排除",
      message: `${playerId}：${reason}。真实完赛日志保留，但本关计 0 分并顺延其他选手。`,
      occurredAt: new Date().toISOString(),
      stageId,
      participantIds: [playerId]
    });
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
    if (record.status === "uncertain" || record.status === "failed") {
      this.appendAttention(competitionId, {
        id: `command:${record.id}:${record.status}`,
        category: "command",
        severity: "critical",
        title: record.status === "uncertain" ? "命令结果不确定" : "命令发送失败",
        message: `${record.command}；自动化已停止，不会自动重试。`,
        occurredAt: record.updatedAt
      });
    }
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

  private scoreboardOverrideHistory(competitionId: string): CompetitionSnapshot["scoreboardOverrides"] {
    return rows<{
      id: string; target_type: string; target_id: string; before_value: string | null; after_value: string;
      reason: string; actor: string; created_at: string;
    }>(this.options.database, "SELECT id,target_type,target_id,before_value,after_value,reason,actor,created_at FROM overrides WHERE competition_id=? ORDER BY created_at DESC", competitionId)
      .map((item) => ({
        id: item.id,
        targetType: item.target_type,
        targetId: item.target_id,
        beforeValue: item.before_value ? JSON.parse(item.before_value) as unknown : null,
        afterValue: JSON.parse(item.after_value) as unknown,
        reason: item.reason,
        actor: item.actor,
        createdAt: item.created_at
      }));
  }

  private appendRawLog(competitionId: string, source: RawClientLogLine["source"], rawLine: string, occurredAt = new Date().toISOString()): void {
    const line: RawClientLogLine = { id: randomUUID(), source, occurredAt, rawLine };
    if (this.options.database) {
      this.options.database.sqlite.prepare("INSERT INTO raw_log_events(source_id,competition_id,source_file,byte_offset,occurred_at,raw_line,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(line.id, competitionId, source, 0, occurredAt, rawLine, createHash("sha256").update(rawLine).digest("hex"), new Date().toISOString());
    } else {
      const logs = [...(this.rawLogs.get(competitionId) ?? []), line];
      this.rawLogs.set(competitionId, logs.slice(-1_000));
    }
    this.journal.append({ type: "client.raw-log", competitionId, data: line });
  }

  private testEventLogLine(runtime: TestRuntime, event: ScenarioEvent): string {
    const player = "playerId" in event ? runtime.definition.players.find((candidate) => candidate.id === event.playerId) : undefined;
    const playerName = player?.displayName ?? ("playerId" in event ? event.playerId : "server");
    const connectionId = player?.connectionId ?? ("connectionId" in event ? event.connectionId : "0");
    const stage = "stageId" in event ? runtime.definition.stages.find((candidate) => candidate.id === event.stageId) : undefined;
    const level = String(stage?.level ?? 0).padStart(2, "0");
    const prefix = this.testLogPrefix(runtime, event.atMs);
    switch (event.type) {
      case "login": return `${prefix} ${playerName} (#${event.connectionId}) logged in with cheat mode off.`;
      case "disconnect": return `${prefix} ${playerName} (#${event.connectionId}) disconnected.`;
      case "finish": {
        const place = (runtime.stageFinishOrdinals.get(event.stageId) ?? 0) + 1;
        runtime.stageFinishOrdinals.set(event.stageId, place);
        return `${prefix} (#${connectionId}, ${playerName}) finished Level ${level} in ${this.ordinal(place)} place (score: ${event.score}; real time: ${this.formatElapsed(event.elapsedMs)}).`;
      }
      case "dnf": return `${prefix} (#${connectionId}, ${playerName}) did not finish Level ${level} (furthest reach: sector 0).`;
      case "exclude": return `${prefix} [Warning] ${playerName} result excluded: ${event.reason}`;
      case "cheat": return `${prefix} (${connectionId}, ${playerName}) turned cheat ${event.enabled ? "on" : "off"}.`;
      case "ready": return `${prefix} [${event.refereeConnectionId}, *ContestConsole]: Level ${level} - Get ready`;
      case "go": return `${prefix} [${event.refereeConnectionId}, *ContestConsole]: Level ${level} - Go!`;
      case "warning": return `${prefix} [Warning] ${event.playerId ? `${playerName} ` : ""}${event.message}`;
      case "fault": return `${prefix} ${event.fault === "server-disconnect" ? "Disconnected from server." : `Fault: ${event.fault}${event.playerId ? ` (${playerName})` : ""}`}`;
    }
  }

  private testAutomationActionLogLines(runtime: TestRuntime, action: AutomationAction): string[] {
    const atMs = action.createdAtMs;
    const prefix = this.testLogPrefix(runtime, atMs);
    const stage = runtime.definition.stages.find((candidate) => candidate.id === action.stageId);
    const level = String(stage?.level ?? 0).padStart(2, "0");
    const referee = runtime.definition.refereeConnectionId;
    switch (action.kind) {
      case "ready": return [`${prefix} [${referee}, *ContestConsole]: Level ${level} - Get ready`];
      case "go": return [];
      case "bulletin": return [`${prefix} [Bulletin] *ContestConsole: ${action.message ?? "比赛流程通知"}`];
      case "notice": return [`${prefix} [Notice] (${referee}, *ContestConsole): ${action.message ?? "比赛流程通知"}`];
      case "announce": return [`${prefix} [Announcement] (${referee}, *ContestConsole): ${action.message ?? "比赛流程通知"}`];
      case "cheat-off": return runtime.definition.players.map((player) => `${prefix} (${player.connectionId}, ${player.displayName}) turned cheat off.`);
      case "force-next-restart": return [`${prefix} [${referee}, *ContestConsole]: The next countdown will restart the level.`];
    }
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

  private removeCompetitionDirectory(competitionId: string, mode: CompetitionMode): void {
    const base = resolve(this.options.dataRoot ?? process.cwd());
    const target = resolve(this.competitionDataRoot(competitionId, mode));
    const relativeTarget = relative(base, target);
    if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      throw new ServiceError("PATH_REJECTED", "比赛数据目录不在授权数据根目录内", 500);
    }
    rmSync(target, { recursive: true, force: true });
  }

  private toCommandAction(competitionId: string, action: CompetitionAction): CommandAction {
    const runtime = this.workRuntimes.get(competitionId);
    const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
    const currentStageId = runtime?.controller.snapshot().currentStageId;
    const stage = config.stages.find((candidate) => candidate.id === currentStageId) ?? config.stages[0];
    if (!stage) throw new ServiceError("STATE_CONFLICT", "比赛没有可执行动作的轮次", 409);
    switch (action.type) {
      case "notification": return { type: "notification", channel: action.channel, text: action.text };
      case "ready": return { type: "ready", map: String(stage.level), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "cheat-off": return { type: "cheat-off" };
      case "manual-go": return { type: "go", map: String(stage.level), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "kick": return { type: "kick", playerName: action.playerName, reason: "referee-kick" };
      case "raw-command": return { type: "raw", command: action.command };
      default: throw new ServiceError("CAPABILITY_UNSUPPORTED", `动作 ${action.type} 不需要或不支持 MockClient 命令`, 409);
    }
  }

  private describeAction(action: CompetitionAction): string {
    switch (action.type) {
      case "notification": return `${action.channel}: ${action.text}`;
      case "kick": return `kick ${action.playerName}`;
      case "raw-command": return action.command;
      case "participant-associate": return `${action.participantId} <- ${action.connectionId}`;
      case "participant-split": return action.connectionId;
      case "participant-edit": return action.participantId;
      case "player-alias-upsert": return `${action.playerId} -> ${action.displayName}`;
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
    for (const scenario of builtinBehaviorScenarios()) {
      if (!loaded.some((candidate) => candidate.id === scenario.id)) loaded.push(scenario);
    }
    return loaded.sort((left, right) => left.name.localeCompare(right.name));
  }
}
