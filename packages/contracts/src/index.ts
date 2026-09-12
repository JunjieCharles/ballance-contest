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
export type StageMapKind = "official" | "custom";

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
  mapKind: StageMapKind;
  mapHash?: string;
  timeLimitMs: number;
  scoring: readonly number[];
  minimumScoringPlace: number;
  plannedStartAt?: string;
}

export const CUSTOM_MAP_HASH_PATTERN = /^[0-9a-f]{32}$/i;

export const stageMapKind = (stage: { mapKind?: StageMapKind }): StageMapKind => stage.mapKind === "custom" ? "custom" : "official";

export const stageDisplayName = (stage: Pick<StageConfig, "label" | "level" | "mode"> & { mapKind?: StageMapKind }): string =>
  stageMapKind(stage) === "custom" ? stage.label.trim() : `${stage.mode}${stage.level}`;

export const stageCommandTarget = (stage: Pick<StageConfig, "level"> & { mapKind?: StageMapKind; mapHash?: string }): string => {
  if (stageMapKind(stage) === "official") return `level ${stage.level}`;
  const mapHash = stage.mapHash?.trim().toLowerCase() ?? "";
  if (!CUSTOM_MAP_HASH_PATTERN.test(mapHash)) throw new Error("INVALID_CUSTOM_MAP_HASH");
  return `${mapHash} 0`;
};

export type ScoreboardTableCellStyle = "plain" | "rank-up" | "rank-down" | "gold" | "silver" | "bronze" | "dnf" | "excluded";

export interface ScoreboardTableCell {
  text: string;
  style: ScoreboardTableCellStyle;
}

export interface ScoreboardTableRow {
  playerId: string;
  cells: readonly ScoreboardTableCell[];
}

export interface ScoreboardTableModel {
  headers: readonly string[];
  rows: readonly ScoreboardTableRow[];
}

export interface ScoreboardTableEntry {
  rank: number;
  playerId: string;
  displayName: string;
  points: number;
  change: number | null;
  stages: Readonly<Record<string, unknown>>;
}

const tableTextCell = (value: string): string => value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
const scoreboardCell = (text: string, style: ScoreboardTableCellStyle = "plain"): ScoreboardTableCell => ({ text: tableTextCell(text), style });

const stageResultCell = (value: unknown): ScoreboardTableCell => {
  if (!value || typeof value !== "object") return scoreboardCell("—");
  const result = value as { status?: string; place?: number; points?: number };
  if (result.status === "dnf") return scoreboardCell("DNF", "dnf");
  if (result.status === "excluded") return scoreboardCell("排除 · 0 分", "excluded");
  if (result.status !== "finished" || !Number.isInteger(result.place)) return scoreboardCell("—");
  const style = result.place === 1 ? "gold" : result.place === 2 ? "silver" : result.place === 3 ? "bronze" : "plain";
  return scoreboardCell(`#${result.place} / ${result.points ?? 0} 分`, style);
};

export const createScoreboardTable = (
  stages: readonly { id: string; label: string }[],
  entries: readonly ScoreboardTableEntry[]
): ScoreboardTableModel => ({
  headers: ["变化", "名次", "总分", "选手", ...stages.map((stage) => tableTextCell(stage.label))],
  rows: entries.map((entry) => ({
    playerId: entry.playerId,
    cells: [
      scoreboardCell(entry.change === null ? "—" : entry.change > 0 ? `▲${entry.change}` : entry.change < 0 ? `▼${Math.abs(entry.change)}` : "=", entry.change === null || entry.change === 0 ? "plain" : entry.change > 0 ? "rank-up" : "rank-down"),
      scoreboardCell(String(entry.rank)),
      scoreboardCell(String(entry.points)),
      scoreboardCell(entry.displayName),
      ...stages.map((stage) => stageResultCell(entry.stages[stage.id]))
    ]
  }))
});

const tableHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const clipboardCellStyle: Record<ScoreboardTableCellStyle, string> = {
  plain: "",
  "rank-up": "color:#b51f2c;font-weight:700",
  "rank-down": "color:#1d7a43;font-weight:700",
  gold: "background:#ffb700",
  silver: "background:#ffe1b2",
  bronze: "background:#fff2cc",
  dnf: "color:#727a84;text-decoration:line-through",
  excluded: "color:#8a2935;background:#fff0f1;text-decoration:line-through"
};

export const scoreboardTableToTsv = (table: ScoreboardTableModel): string =>
  [table.headers, ...table.rows.map((row) => row.cells.map((cell) => cell.text))]
    .map((row) => row.map(tableTextCell).join("\t"))
    .join("\r\n");

export const scoreboardTableToHtml = (table: ScoreboardTableModel): string => {
  const base = "border:1px solid #b8c2cc;padding:6px 8px;text-align:left";
  const headers = table.headers.map((header) => `<th style="${base};background:#eef1f4;font-weight:700">${tableHtml(header)}</th>`).join("");
  const rows = table.rows.map((row) => `<tr>${row.cells.map((cell) => `<td data-style="${cell.style}" style="${base};${clipboardCellStyle[cell.style]}">${tableHtml(cell.text)}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
};

export interface FlowPolicy {
  announcementLeadMs: number;
  delayLimitMs: number;
  reconnectStableMs: number;
  readyBufferMs: number;
  startProtectionEnabled: boolean;
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

export const CONTEST_REFEREE_NAME = "ContestConsole";

export const normalizeRefereeName = (value: string): string => value.trim().replace(/^\*+/, "").trim();

export const spectatorLoginName = (refereeName: string): string => `*${normalizeRefereeName(refereeName)}`;

export const validateCompetitionConfigForPublish = (config: CompetitionConfig): string[] => {
  const issues: string[] = [];
  if (!config.name.trim()) issues.push("比赛名称不能为空");
  if (normalizeRefereeName(config.refereeName) !== CONTEST_REFEREE_NAME) issues.push(`服务器控制身份固定为 ${CONTEST_REFEREE_NAME}`);
  if (config.stages.length === 0) issues.push("至少需要一个轮次");
  if (config.scoring.points.length === 0) issues.push("计分表至少需要一个名次");
  if (config.scoring.points.some((point) => !Number.isFinite(point))) issues.push("计分必须是有限数字");
  if (!config.scoring.allowNegative && config.scoring.points.some((point) => point < 0)) issues.push("当前配置不允许负分");
  const customHashes = new Set<string>();
  for (const stage of config.stages) {
    const displayName = stageDisplayName(stage);
    if (stageMapKind(stage) === "custom") {
      const mapHash = stage.mapHash?.trim().toLowerCase() ?? "";
      if (!stage.label.trim()) issues.push(`第 ${stage.order} 关的自制图名称不能为空`);
      if (!CUSTOM_MAP_HASH_PATTERN.test(mapHash)) issues.push(`${displayName || `第 ${stage.order} 关`} 的哈希必须是 32 位十六进制 MD5`);
      else customHashes.add(mapHash);
      if (stage.level !== 0) issues.push(`${displayName || `第 ${stage.order} 关`} 的内部关卡号必须为 0`);
    } else if (stage.level < 0 || stage.level > 13) issues.push(`${displayName} 关卡号必须在 0..13`);
    if (stage.scoring.length === 0) issues.push(`${displayName} 缺少计分规则`);
  }
  const distinctHashes = [...customHashes];
  for (const hash of distinctHashes) {
    if (distinctHashes.some((candidate) => candidate !== hash && candidate.startsWith(hash.slice(0, 20)))) {
      issues.push(`自制图哈希前缀 ${hash.slice(0, 20)}.. 无法唯一匹配`);
      break;
    }
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
  status: "queued" | "sent" | "acknowledged" | "failed" | "timed_out" | "uncertain" | "cancelled" | "simulated";
  createdAt: string;
  updatedAt: string;
  command?: string;
  responseLine?: string;
  simulated?: boolean;
  generation?: number;
}

export type WorkConnectionStatus = "connecting" | "authenticating" | "healthy" | "suspect" | "recovering" | "blocked";

export type WorkRecoveryStep =
  | "soft-reconnect"
  | "verify-soft-connection"
  | "graceful-stop"
  | "force-stop"
  | "cooldown"
  | "restart"
  | "verify-restarted-connection"
  | "register-maps";

export interface WorkConnectionView {
  status: WorkConnectionStatus;
  processGeneration: number;
  connectionGeneration: number;
  refereeConnectionId?: string;
  recoveryStep?: WorkRecoveryStep;
  recoveryStartedAt?: string;
  cooldownUntil?: string;
  recentServerEvidence?: {
    kind: "connected" | "authentication-failed" | "list-verified" | "disconnected" | "process-exited";
    occurredAt: string;
    detail: string;
    processGeneration: number;
    connectionGeneration: number;
  };
}

export interface RuntimeSnapshot {
  phase: string;
  pausedFromPhase?: string;
  stateVersion: number;
  mode: CompetitionMode;
  workConnection?: WorkConnectionView;
  automationEnabled: boolean;
  currentStageId?: string;
  plannedReadyAtMs?: number;
  plannedReadyStageId?: string;
  plannedReadyAt?: string;
  currentStageReadyAt?: string;
  nextStageReadyAt?: string;
  startProtectionEnabled: boolean;
  startProtectionUsed: boolean;
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
  unconfirmedCommands: readonly {
    id: string;
    actionType: string;
    status: "failed" | "uncertain";
    command: string;
    createdAt: string;
  }[];
  observationGaps: readonly {
    id: string;
    code: string;
    detail: string;
    createdAt: string;
  }[];
}

export type RefereeActionId =
  | "start-work" | "disconnect-work" | "reconnect-work" | "restart-work" | "enable-automation" | "pause-automation" | "notification" | "start-ready-flow" | "ready" | "cheat-off" | "manual-go"
  | "delay-ready" | "extend-stage-deadline" | "reschedule" | "reschedule-stage-deadline" | "end-stage" | "restart-stage" | "set-start-protection"
  | "mark-stage-started" | "force-reset-stage" | "force-next-stage"
  | "kick" | "raw-command" | "finish" | "archive" | "delete";

export interface ActionAvailability {
  action: RefereeActionId;
  enabled: boolean;
  label: string;
  effect: string;
  targetStageId?: string;
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

export interface ActiveScoringView {
  source: "published" | "runtime-override";
  revision: number;
  points: readonly number[];
  minimumScoringPlace: number;
  updatedAt?: string;
}

export interface ScoreboardScoringUpdateInput {
  points: readonly number[];
  confirmationToken: string;
  impactHash: string;
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
  connectionSettings?: { server: string; locked: boolean };
  competition: CompetitionRecordView;
  config: CompetitionConfig;
  publishedConfig?: CompetitionConfig;
  runtime: RuntimeSnapshot;
  scoreboardVersions: readonly ScoreboardVersionView[];
  currentScoreboard: ScoreboardVersionView["entries"];
  scoreboardOverrides: readonly ScoreboardOverrideView[];
  activeScoring: ActiveScoringView;
  testRun?: TestRunSnapshot;
  archives: readonly { version: number; directory: string; packagePath: string; manifestHash: string; createdAt: string }[];
}

export type ConfirmationKind = "restart-stage" | "manual-action" | "manual-go" | "scoreboard-override" | "automation-command-resolution" | "command-resolution" | "observation-gap-resolution" | "high-risk";

export type ConfirmationIntent =
  | "disconnect-work" | "reconnect-work" | "restart-work" | "start-ready-flow" | "ready" | "manual-go" | "delay-ready" | "extend-stage-deadline"
  | "reschedule" | "reschedule-stage-deadline" | "end-stage" | "restart-stage" | "set-start-protection"
  | "mark-stage-started" | "force-reset-stage" | "force-next-stage"
  | "kick" | "raw-command" | "finish" | "finish-and-archive" | "delete"
  | "scoreboard-set-place" | "scoreboard-set-dnf" | "scoreboard-update-scoring";

export interface ConfirmationSummary {
  token: string;
  kind: ConfirmationKind;
  expiresAt: string;
  target: string;
  stateVersion: number;
  runtimeStateVersion?: number;
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

export type NotificationChannel = "bulletin" | "notice" | "announce" | "s";
export type AttemptOrigin = "authoritative-go" | "referee-marked-started" | "command-sent";

export type CompetitionAction =
  | { type: "notification"; channel: NotificationChannel; text: string }
  | { type: "disconnect-work"; confirmationToken: string; impactHash: string }
  | { type: "reconnect-work"; confirmationToken: string; impactHash: string }
  | { type: "restart-work"; confirmationToken: string; impactHash: string }
  | { type: "start-ready-flow"; confirmationToken: string; impactHash: string }
  | { type: "ready"; confirmationToken: string; impactHash: string }
  | { type: "cheat-off" }
  | { type: "manual-go"; confirmationToken: string; impactHash: string }
  | { type: "reschedule"; plannedReadyAt: string; confirmationToken: string; impactHash: string }
  | { type: "reschedule-stage-deadline"; deadlineAt: string; confirmationToken: string; impactHash: string }
  | { type: "delay-ready"; milliseconds: number; confirmationToken: string; impactHash: string }
  | { type: "extend-stage-deadline"; milliseconds: number; confirmationToken: string; impactHash: string }
  | { type: "end-stage"; confirmationToken: string; impactHash: string }
  | { type: "restart-stage"; stageId: string; confirmationToken: string; impactHash: string }
  | { type: "mark-stage-started"; stageId: string; confirmationToken: string; impactHash: string }
  | { type: "force-reset-stage"; stageId: string; confirmationToken: string; impactHash: string }
  | { type: "force-next-stage"; stageId: string; confirmationToken: string; impactHash: string }
  | { type: "set-start-protection"; used: boolean; confirmationToken: string; impactHash: string }
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
  | {
      type: "resolve-command";
      commandId: string;
      resolution: "confirm-executed" | "dismiss-failed" | "resend";
      confirmationToken: string;
      impactHash: string;
    }
  | {
      type: "resolve-observation-gap";
      gapId: string;
      resolution: "continue";
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
  announcementLeadMs: 60_000,
  delayLimitMs: 5 * 60_000,
  reconnectStableMs: 15_000,
  readyBufferMs: 30_000,
  startProtectionEnabled: true,
  protectionWindowMs: 10_000,
  intermissionMs: 3 * 60_000,
  groupDisconnectThreshold: 2
});

export const defaultNotifications = (): NotificationTemplates => ({
  bulletin: "{stage} 将在 {time} 发令",
  ready: "READY!",
  delay: "{player} 触发起跑保护，新的 Ready 时间为 {time}。",
  restart: "本轮因 {reason} 重赛，请等待裁判重新发令。",
  stageComplete: "{stage} 已进入成绩接收/结算。",
  nextStage: "{stage} 将在 {time} 发令",
  competitionComplete: "比赛结束，成绩进入复核。"
});

export const defaultSrStages = (scoring: readonly number[] = SMALL_SCORING, minimumScoringPlace = minimumScoringPlaceFor(scoring)): StageConfig[] =>
  Array.from({ length: 13 }, (_unused, index) => {
    const level = index + 1;
    return {
      id: `sr-${level}`,
      order: level,
      label: `SR${level}`,
      level,
      mode: "SR" as const,
      mapKind: "official" as const,
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
      label: `HS${level}`,
      level,
      mode: "HS" as const,
      mapKind: "official" as const,
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
    refereeName: CONTEST_REFEREE_NAME,
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
  mapKind: Type.Optional(Type.Union([Type.Literal("official"), Type.Literal("custom")])),
  mapHash: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
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
