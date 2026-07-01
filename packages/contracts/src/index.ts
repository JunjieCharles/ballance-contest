import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const CompetitionModeSchema = Type.Union([
  Type.Literal("work"),
  Type.Literal("test")
]);
export type CompetitionMode = Static<typeof CompetitionModeSchema>;

export const TestInputKindSchema = Type.Union([
  Type.Literal("simulation"),
  Type.Literal("static-log"),
  Type.Literal("growing-log")
]);
export type TestInputKind = Static<typeof TestInputKindSchema>;

export const CapabilitiesSchema = Type.Object({
  realProcess: Type.Boolean(),
  network: Type.Boolean(),
  realCommands: Type.Boolean(),
  automation: Type.Boolean(),
  virtualClock: Type.Boolean(),
  playback: Type.Boolean(),
  faultInjection: Type.Boolean(),
  scenarioFaults: Type.Boolean()
});
export type Capabilities = Static<typeof CapabilitiesSchema>;

export const capabilitiesFor = (mode: CompetitionMode): Capabilities =>
  mode === "work"
    ? {
        realProcess: true,
        network: true,
        realCommands: true,
        automation: true,
        virtualClock: false,
        playback: false,
        faultInjection: false,
        scenarioFaults: false
      }
    : {
        realProcess: false,
        network: false,
        realCommands: false,
        automation: true,
        virtualClock: true,
        playback: true,
        faultInjection: false,
        scenarioFaults: true
      };

export const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  version: Type.String(),
  now: Type.String(),
  modes: Type.Array(CompetitionModeSchema)
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const StageModeSchema = Type.Union([Type.Literal("SR"), Type.Literal("HS")]);
export type StageMode = Static<typeof StageModeSchema>;

export type CompetitionLifecycleStatus =
  | "draft"
  | "published"
  | "lobby"
  | "preparing"
  | "ready"
  | "countdown"
  | "running"
  | "tail-intake"
  | "review"
  | "finished"
  | "archived"
  | "paused";

export type ContestType = "small" | "large" | "custom";

export interface ParticipantView {
  id: string;
  displayName: string;
  role: "participant" | "staff" | "observer";
  connectionIds: readonly string[];
  online: boolean;
  currentStageStatus: "not-started" | "practice" | "waiting" | "running" | "finished" | "dnf" | "excluded" | "review";
  notes?: string;
}

export interface PlayerAlias {
  playerId: string;
  displayName: string;
}

export interface ScoringConfig {
  contestType: ContestType;
  points: readonly number[];
  minimumScoringPlace: number;
  allowNegative: boolean;
}

export interface StageConfig {
  id: string;
  order: number;
  label: string;
  level: number;
  mode: StageMode;
  timeLimitMs: number;
  scoring: readonly number[];
  minimumScoringPlace: number;
  plannedStartAt?: string;
}

export interface FlowPolicy {
  announcementLeadMs: number;
  delayLimitMs: number;
  reconnectStableMs: number;
  readyBufferMs: number;
  protectionWindowMs: number;
  intermissionMs: number;
  groupDisconnectThreshold: number;
}

export interface NotificationTemplates {
  bulletin: string;
  ready: string;
  delay: string;
  restart: string;
  stageComplete: string;
  nextStage: string;
  competitionComplete: string;
}

export interface CompetitionConfig {
  name: string;
  date: string;
  timezone: string;
  refereeName: string;
  server: string;
  contestType: ContestType;
  scoring: ScoringConfig;
  flow: FlowPolicy;
  notifications: NotificationTemplates;
  stages: readonly StageConfig[];
  playerAliases: readonly PlayerAlias[];
  participants: readonly ParticipantView[];
}

export const normalizeRefereeName = (value: string): string => value.trim().replace(/^\*+/, "").trim();

export const spectatorLoginName = (refereeName: string): string => `*${normalizeRefereeName(refereeName)}`;

export const validateCompetitionConfigForPublish = (config: CompetitionConfig): string[] => {
  const issues: string[] = [];
  if (!config.name.trim()) issues.push("比赛名称不能为空");
  if (!normalizeRefereeName(config.refereeName)) issues.push("裁判名不能为空");
  if (!config.server.trim()) issues.push("服务器不能为空");
  if (["0.bmmo.win", "1.bmmo.win", "2.bmmo.win"].some((server) => config.server.startsWith(`${server}:`))) {
    issues.push("bmmo.win 预设服务器不得填写端口");
  }
  if (config.stages.length === 0) issues.push("至少需要一个轮次");
  if (config.scoring.points.length === 0) issues.push("计分表至少需要一个名次");
  if (config.scoring.points.some((point) => !Number.isFinite(point))) issues.push("计分必须是有限数字");
  if (!config.scoring.allowNegative && config.scoring.points.some((point) => point < 0)) issues.push("当前配置不允许负分");
  for (const stage of config.stages) {
    if (stage.level < 0 || stage.level > 13) issues.push(`${stage.label} 关卡号必须在 0..13`);
    if (stage.scoring.length === 0) issues.push(`${stage.label} 缺少计分规则`);
  }
  return issues;
};

export interface CompetitionRecordView {
  id: string;
  name: string;
  mode: CompetitionMode;
  status: CompetitionLifecycleStatus;
  stateVersion: number;
  capabilities: Capabilities;
  updatedAt: string;
  activeRunId?: string;
}

export interface CommandRecordView {
  id: string;
  actionType: string;
  status: "queued" | "sent" | "acknowledged" | "failed" | "timed_out" | "uncertain" | "simulated";
  createdAt: string;
  updatedAt: string;
  command?: string;
  responseLine?: string;
  simulated?: boolean;
}

export interface RuntimeSnapshot {
  phase: string;
  pausedFromPhase?: string;
  stateVersion: number;
  mode: CompetitionMode;
  automationEnabled: boolean;
  currentStageId?: string;
  plannedReadyAtMs?: number;
  plannedReadyAt?: string;
  plannedStageStartAt?: string;
  stageDeadlineAt?: string;
  countdownValue?: 3 | 2 | 1;
  virtualNowMs?: number;
  blockers: readonly { code: string; severity: "warning" | "critical"; suggestion: string; autoRecoverable: boolean; participantId?: string }[];
  waitingParticipants: readonly string[];
  attempts: readonly unknown[];
  incidents: readonly unknown[];
  rejectedResults: readonly unknown[];
  commands: readonly CommandRecordView[];
  availableActions: readonly ActionAvailability[];
  attentionItems: readonly AttentionItem[];
  scoreEditPermissions: readonly {
    stageId: string;
    editable: boolean;
    reason?: string;
  }[];
  unconfirmedAutomationActions: readonly {
    id: string;
    kind: string;
    stageId: string;
    status: "failed" | "uncertain";
  }[];
}

export type RefereeActionId =
  | "start-work" | "enable-automation" | "pause-automation" | "ready" | "cheat-off" | "manual-go"
  | "delay-ready" | "extend-stage-deadline" | "reschedule" | "reschedule-stage-deadline" | "end-stage" | "restart-stage"
  | "kick" | "raw-command" | "finish" | "archive" | "delete";

export interface ActionAvailability {
  action: RefereeActionId;
  enabled: boolean;
  label: string;
  effect: string;
  disabledReason?: string;
}

export interface AttentionItem {
  id: string;
  category: "flow" | "result" | "blocker" | "incident" | "command";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  occurredAt: string;
  stageId?: string;
  participantIds?: readonly string[];
  action?: RefereeActionId;
}

export interface ScoreboardVersionView {
  id: string;
  version: number;
  triggerSourceId: string;
  stageId: string;
  entries: readonly {
    rank: number;
    playerId: string;
    displayName: string;
    points: number;
    change: number | null;
    stages: Readonly<Record<string, unknown>>;
  }[];
  deterministicHash: string;
}

export interface ScoreboardOverrideView {
  id: string;
  targetType: string;
  targetId: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string;
  actor: string;
  createdAt: string;
}

export interface RawClientLogLine {
  id: string;
  source: "mock-client" | "test-player" | "test-referee";
  occurredAt: string;
  rawLine: string;
}

export interface TestScenarioSummary {
  id: string;
  name: string;
  kind: "player-behavior" | "scripted-replay";
  randomSeed: number;
  players: number;
  stages: number;
  events: number;
  expectedScoreboardVersions: number;
  playerProfiles: readonly ScenarioPlayerProfile[];
  faults: number;
}

export interface TestRunSnapshot {
  runId: string;
  scenario: TestScenarioSummary;
  nextEventIndex: number;
  totalEvents: number;
  engine: {
    attempts: readonly unknown[];
    scoreboardVersions: readonly ScoreboardVersionView[];
    anomalies: readonly unknown[];
    currentScoreboard: ScoreboardVersionView["entries"];
  };
  automation: RuntimeSnapshot;
}

export interface CompetitionSnapshot {
  competition: CompetitionRecordView;
  config: CompetitionConfig;
  publishedConfig?: CompetitionConfig;
  runtime: RuntimeSnapshot;
  scoreboardVersions: readonly ScoreboardVersionView[];
  currentScoreboard: ScoreboardVersionView["entries"];
  scoreboardOverrides: readonly ScoreboardOverrideView[];
  testRun?: TestRunSnapshot;
  archives: readonly { version: number; directory: string; packagePath: string; manifestHash: string; createdAt: string }[];
}

export type ConfirmationKind = "restart-stage" | "manual-action" | "manual-go" | "scoreboard-override" | "automation-command-resolution" | "high-risk";

export interface ConfirmationSummary {
  token: string;
  kind: ConfirmationKind;
  expiresAt: string;
  target: string;
  stateVersion: number;
  impactHash: string;
  summary: string;
  effect: {
    title: string;
    target: string;
    currentPhase: string;
    consequences: readonly string[];
    irreversible: boolean;
    affectedPlayers?: readonly {
      playerId: string;
      displayName: string;
      beforePlace: number | null;
      afterPlace: number | null;
      beforePoints: number;
      afterPoints: number;
    }[];
  };
}

interface ScoreboardAdjudicationBase {
  playerId: string;
  stageId: string;
  confirmationToken: string;
  impactHash: string;
}

export type ScoreboardAdjudicationInput =
  | (ScoreboardAdjudicationBase & { operation: "set-place"; place: number; rankPolicy?: "tie" | "shift" })
  | (ScoreboardAdjudicationBase & { operation: "set-dnf"; rankPolicy?: "tie" | "shift" });

export type ScoreboardOverrideInput = ScoreboardAdjudicationInput;

export type NotificationChannel = "bulletin" | "notice" | "announce";

export type CompetitionAction =
  | { type: "notification"; channel: NotificationChannel; text: string }
  | { type: "ready" }
  | { type: "cheat-off" }
  | { type: "manual-go"; confirmationToken: string; impactHash: string }
  | { type: "reschedule"; plannedReadyAt: string; confirmationToken: string; impactHash: string }
  | { type: "reschedule-stage-deadline"; deadlineAt: string; confirmationToken: string; impactHash: string }
  | { type: "delay-ready"; milliseconds: number; confirmationToken: string; impactHash: string }
  | { type: "extend-stage-deadline"; milliseconds: number; confirmationToken: string; impactHash: string }
  | { type: "end-stage"; confirmationToken: string; impactHash: string }
  | { type: "restart-stage"; attemptId: string; confirmationToken: string; impactHash: string }
  | { type: "participant-associate"; participantId: string; connectionId: string }
  | { type: "participant-split"; connectionId: string }
  | { type: "participant-edit"; participantId: string; displayName?: string; notes?: string }
  | { type: "player-alias-upsert"; playerId: string; displayName: string }
  | {
      type: "resolve-automation-command";
      actionId: string;
      resolution: "confirm-executed" | "resend";
      confirmationToken: string;
      impactHash: string;
    }
  | ({ type: "scoreboard-override" } & ScoreboardOverrideInput)
  | { type: "kick"; playerName: string; confirmationToken: string; impactHash: string }
  | { type: "raw-command"; command: string; confirmationToken: string; impactHash: string };

export const SMALL_SCORING = [20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 1] as const;
export const LARGE_SCORING = [30, 24, 21, 18, 16, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1] as const;

export const minimumScoringPlaceFor = (points: readonly number[]): number => {
  const lastScoringIndex = points.findLastIndex((point) => point !== 0);
  return Math.max(1, lastScoringIndex + 1);
};

export const defaultFlowPolicy = (): FlowPolicy => ({
  announcementLeadMs: 5 * 60_000,
  delayLimitMs: 5 * 60_000,
  reconnectStableMs: 15_000,
  readyBufferMs: 15_000,
  protectionWindowMs: 15_000,
  intermissionMs: 3 * 60_000,
  groupDisconnectThreshold: 2
});

export const defaultNotifications = (): NotificationTemplates => ({
  bulletin: "{stage} {mode} 将于 {time} 开始，请选手准备。",
  ready: "READY!",
  delay: "等待 {player} 重连，剩余 {remaining}。",
  restart: "本轮因 {reason} 重赛，请等待裁判重新发令。",
  stageComplete: "{stage} 已进入成绩接收/结算。",
  nextStage: "下一轮 {stage} Ready 计划于 {time}。",
  competitionComplete: "比赛结束，成绩进入复核。"
});

export const defaultSrStages = (scoring: readonly number[] = SMALL_SCORING, minimumScoringPlace = minimumScoringPlaceFor(scoring)): StageConfig[] =>
  Array.from({ length: 13 }, (_unused, index) => {
    const level = index + 1;
    return {
      id: `sr-${level}`,
      order: level,
      label: `SR ${level}`,
      level,
      mode: "SR" as const,
      timeLimitMs: level === 13 ? 15 * 60_000 : 10 * 60_000,
      scoring,
      minimumScoringPlace
    };
  });

export const defaultHsStages = (scoring: readonly number[] = SMALL_SCORING, minimumScoringPlace = minimumScoringPlaceFor(scoring)): StageConfig[] =>
  Array.from({ length: 13 }, (_unused, index) => {
    const level = index + 1;
    return {
      id: `hs-${level}`,
      order: level,
      label: `HS ${level}`,
      level,
      mode: "HS" as const,
      timeLimitMs: level === 12 || level === 13 ? 15 * 60_000 : 10 * 60_000,
      scoring,
      minimumScoringPlace
    };
  });

export const createDefaultCompetitionConfig = (name: string): CompetitionConfig => {
  const scoring: ScoringConfig = { contestType: "small", points: SMALL_SCORING, minimumScoringPlace: minimumScoringPlaceFor(SMALL_SCORING), allowNegative: false };
  const now = new Date();
  return {
    name,
    date: now.toISOString().slice(0, 10),
    timezone: "Asia/Shanghai",
    refereeName: "ContestConsole",
    server: "1.bmmo.win",
    contestType: "small",
    scoring,
    flow: defaultFlowPolicy(),
    notifications: defaultNotifications(),
    stages: defaultSrStages(scoring.points, scoring.minimumScoringPlace),
    playerAliases: [],
    participants: []
  };
};

export const ScenarioPlayerProfileSchema = Type.Union([
  Type.Literal("normal"),
  Type.Literal("expert"),
  Type.Literal("struggler"),
  Type.Literal("disruptor")
]);
export type ScenarioPlayerProfile = Static<typeof ScenarioPlayerProfileSchema>;

export const ScenarioPlayerSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  connectionId: Type.String({ minLength: 1 }),
  profile: Type.Optional(ScenarioPlayerProfileSchema)
});

export const ScenarioStageSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  order: Type.Integer({ minimum: 1 }),
  level: Type.Integer({ minimum: 0, maximum: 13 }),
  mode: StageModeSchema,
  timeLimitMs: Type.Integer({ minimum: 1 }),
  scoring: Type.Array(Type.Number(), { minItems: 1 }),
  minimumScoringPlace: Type.Integer({ minimum: 1 })
});
export type ScenarioStage = Static<typeof ScenarioStageSchema>;

const ScenarioEventBase = {
  atMs: Type.Integer({ minimum: 0 }),
  sourceId: Type.String({ minLength: 1 })
};

export const ScenarioEventSchema = Type.Union([
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("login"), playerId: Type.String(), connectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("disconnect"), playerId: Type.String(), connectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("ready"), stageId: Type.String(), refereeConnectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("go"), stageId: Type.String(), refereeConnectionId: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("finish"), stageId: Type.String(), playerId: Type.String(), score: Type.Number(), elapsedMs: Type.Integer({ minimum: 0 }) }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("dnf"), stageId: Type.String(), playerId: Type.String(), reason: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("exclude"), stageId: Type.String(), playerId: Type.String(), reason: Type.String() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("cheat"), playerId: Type.String(), enabled: Type.Boolean() }),
  Type.Object({ ...ScenarioEventBase, type: Type.Literal("warning"), playerId: Type.Optional(Type.String()), message: Type.String() }),
  Type.Object({
    ...ScenarioEventBase,
    type: Type.Literal("fault"),
    fault: Type.Union([
      Type.Literal("process-exit"), Type.Literal("server-disconnect"), Type.Literal("clock-jump"),
      Type.Literal("participant-disconnect"), Type.Literal("player-crash")
    ]),
    playerId: Type.Optional(Type.String()),
    milliseconds: Type.Optional(Type.Integer({ minimum: 0 }))
  })
]);
export type ScenarioEvent = Static<typeof ScenarioEventSchema>;

export const ScenarioFaultPlanSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  fault: Type.Union([
    Type.Literal("process-exit"), Type.Literal("server-disconnect"), Type.Literal("clock-jump"),
    Type.Literal("participant-disconnect"), Type.Literal("player-crash"), Type.Literal("warning")
  ]),
  trigger: Type.Union([Type.Literal("ready"), Type.Literal("running")]),
  stageOrder: Type.Integer({ minimum: 1 }),
  offsetMs: Type.Integer({ minimum: 0 }),
  playerId: Type.Optional(Type.String()),
  recoverAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
  message: Type.Optional(Type.String())
});
export type ScenarioFaultPlan = Static<typeof ScenarioFaultPlanSchema>;

export const ScenarioDefinitionSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Optional(Type.Union([Type.Literal("player-behavior"), Type.Literal("scripted-replay")])),
  randomSeed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  year: Type.Integer({ minimum: 2000, maximum: 9999 }),
  timezone: Type.String({ minLength: 1 }),
  refereeConnectionId: Type.String({ minLength: 1 }),
  players: Type.Array(ScenarioPlayerSchema, { minItems: 1 }),
  stages: Type.Array(ScenarioStageSchema),
  events: Type.Array(ScenarioEventSchema),
  faultPlan: Type.Optional(Type.Array(ScenarioFaultPlanSchema)),
  expected: Type.Object({
    attempts: Type.Integer({ minimum: 0 }),
    scoreboardVersions: Type.Integer({ minimum: 0 })
  })
});
export type ScenarioDefinition = Static<typeof ScenarioDefinitionSchema>;

export const assertScenarioDefinition = (value: unknown): ScenarioDefinition => {
  if (!Value.Check(ScenarioDefinitionSchema, value)) {
    const first = [...Value.Errors(ScenarioDefinitionSchema, value)][0];
    throw new TypeError(`Invalid scenario at ${first?.path ?? "/"}: ${first?.message ?? "unknown error"}`);
  }
  return value;
};
