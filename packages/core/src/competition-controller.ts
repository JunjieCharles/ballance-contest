import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface MonotonicClock {
  now(): number;
}

export type AutomationPhase =
  | "lobby"
  | "preparing"
  | "ready"
  | "countdown"
  | "running"
  | "tail-intake"
  | "pre-start-wait"
  | "incident"
  | "restart-preparing"
  | "review"
  | "paused";

export interface AutomationStage {
  id: string;
  map: string;
  displayName?: string;
  mode: "sr" | "hs";
  timeLimitMs: number;
  minimumScoringPlace: number;
}

export interface AutomationPolicy {
  announcementLeadMs: number;
  readyBufferMs: number;
  reconnectStableMs: number;
  preStartWaitLimitMs: number;
  intermissionMs: number;
  protectionWindowMs: number;
  groupDisconnectThreshold: number;
  preStartTimeoutPolicy: "absent" | "allow-late";
}

export interface AutomationConfiguration {
  competitionId: string;
  participants: readonly string[];
  dynamicParticipants?: boolean;
  stages: readonly AutomationStage[];
  policy?: Partial<AutomationPolicy>;
  confirmationSecret?: string;
  wallClockOriginMs?: number;
  startProtectionUsedStageIds?: readonly string[] | undefined;
}

const formatDelay = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
};

export type AutomationActionKind = "bulletin" | "notice" | "announce" | "ready" | "cheat-off" | "go" | "force-next-restart";

export interface AutomationAction {
  id: string;
  kind: AutomationActionKind;
  idempotencyKey: string;
  createdAtMs: number;
  stageId: string;
  map: string;
  mapName?: string;
  mode: "sr" | "hs";
  message?: string;
  manual?: boolean;
  acknowledgedAtMs?: number;
  status: "pending" | "acknowledged" | "failed" | "uncertain" | "referee-confirmed" | "cancelled";
}

export interface AutomationBlocker {
  code: "AUTOMATION_PAUSED" | "PERMISSION_DENIED" | "PARTICIPANT_OFFLINE" | "PARTICIPANT_CHEAT" | "COMMAND_UNCONFIRMED" | "INCIDENT_OPEN";
  severity: "warning" | "critical";
  autoRecoverable: boolean;
  participantId?: string;
  suggestion: string;
}

export interface AutomationResult {
  playerId: string;
  status: "finished" | "dnf" | "excluded";
  sourceId: string;
  receivedAtMs: number;
  reason?: string;
  finishSourceId?: string;
}

export interface ControlledAttempt {
  id: string;
  stageId: string;
  attemptNumber: number;
  goAtMs: number;
  deadlineAtMs: number;
  intakeOpen: boolean;
  intakeClosedAtMs?: number;
  voided: boolean;
  results: readonly AutomationResult[];
}

export interface AutomationIncident {
  id: string;
  type: "protected-crash" | "group-disconnect" | "server-disconnect" | "cheat-violation" | "timing-discontinuity";
  severity: "high" | "critical";
  createdAtMs: number;
  attemptId?: string;
  participantIds: readonly string[];
  recommendedRestart: boolean;
  status: "open" | "resolved";
  evidence: string;
}

export interface RejectedResult {
  stageId: string;
  playerId: string;
  sourceId: string;
  receivedAtMs: number;
  reason: "no-attempt" | "wrong-stage" | "duplicate" | "intake-closed" | "deadline-passed";
}

export interface AutomationSnapshot {
  phase: AutomationPhase;
  pausedFromPhase?: Exclude<AutomationPhase, "paused">;
  stateVersion: number;
  automationEnabled: boolean;
  currentStageId: string;
  plannedReadyAtMs?: number;
  plannedReadyStageId?: string;
  countdownValue?: 3 | 2 | 1;
  blockers: readonly AutomationBlocker[];
  waitingParticipants: readonly string[];
  startProtectionUsedStageIds?: readonly string[];
  startProtectionSensitiveStageId?: string;
  startProtectionUntilMs?: number;
  attempts: readonly ControlledAttempt[];
  incidents: readonly AutomationIncident[];
  rejectedResults: readonly RejectedResult[];
  actions: readonly AutomationAction[];
}

interface MutableAttempt extends Omit<ControlledAttempt, "results"> {
  results: AutomationResult[];
}

interface MutableIncident extends Omit<AutomationIncident, "participantIds"> {
  participantIds: string[];
}

interface ConfirmationClaims {
  competitionId: string;
  stageId: string;
  attemptId: string;
  stateVersion: number;
  targetId: string;
  impactHash: string;
  expiresAtMs: number;
  nonce: string;
}

const defaults = (participantCount: number): AutomationPolicy => ({
  announcementLeadMs: 5 * 60_000,
  readyBufferMs: 15_000,
  reconnectStableMs: 15_000,
  preStartWaitLimitMs: 5 * 60_000,
  intermissionMs: 3 * 60_000,
  protectionWindowMs: 15_000,
  groupDisconnectThreshold: Math.max(2, Math.ceil(participantCount * 0.2)),
  preStartTimeoutPolicy: "allow-late"
});

const READY_STEP_MS = 5_000;
const CHEAT_CONFIRMATION_BUFFER_MS = 10_000;
const READY_NOTICE_LEAD_MS = 60_000;
const START_PROTECTION_DELAY_MS = 2 * 60_000;
const START_PROTECTION_USED_SUFFIX = "\n本关起跑保护已被使用，后续不再延时。";

const formatUtc8Time = (epochMs: number): string => {
  const utc8 = new Date(epochMs + 8 * 60 * 60_000);
  return `${String(utc8.getUTCHours()).padStart(2, "0")}:${String(utc8.getUTCMinutes()).padStart(2, "0")}`;
};

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const cloneAction = (action: AutomationAction): AutomationAction => ({ ...action });
const cloneAttempt = (attempt: MutableAttempt): ControlledAttempt => ({ ...attempt, results: attempt.results.map((result) => ({ ...result })) });
const cloneIncident = (incident: MutableIncident): AutomationIncident => ({ ...incident, participantIds: [...incident.participantIds] });

class RestartConfirmationTokens {
  private readonly consumed = new Set<string>();

  public constructor(private readonly secret: string) {}

  public issue(claims: ConfirmationClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  public consume(token: string, expected: Omit<ConfirmationClaims, "expiresAtMs" | "nonce">, nowMs: number): void {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) throw new Error("INVALID_CONFIRMATION_TOKEN");
    const actual = Buffer.from(signature, "base64url");
    const wanted = createHmac("sha256", this.secret).update(body).digest();
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("INVALID_CONFIRMATION_TOKEN");
    let claims: ConfirmationClaims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConfirmationClaims;
    } catch {
      throw new Error("INVALID_CONFIRMATION_TOKEN");
    }
    if (claims.expiresAtMs < nowMs) throw new Error("EXPIRED_CONFIRMATION_TOKEN");
    if (this.consumed.has(claims.nonce)) throw new Error("CONSUMED_CONFIRMATION_TOKEN");
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (claims[key] !== expected[key]) throw new Error("STALE_CONFIRMATION_TOKEN");
    }
    this.consumed.add(claims.nonce);
  }
}

export class CompetitionController {
  private readonly stages: AutomationStage[];
  private readonly participantIds: Set<string>;
  private readonly online = new Map<string, boolean>();
  private readonly cheat = new Map<string, boolean>();
  private readonly stableSince = new Map<string, number>();
  private readonly waiting = new Set<string>();
  private readonly absent = new Set<string>();
  private readonly disconnectedDuringAttempt = new Set<string>();
  private readonly startProtectionUsedStageIds = new Set<string>();
  private readonly ignoredProtectionOfflineParticipants = new Set<string>();
  private readonly actions: AutomationAction[] = [];
  private readonly undeliveredActionIds = new Set<string>();
  private readonly attempts: MutableAttempt[] = [];
  private readonly incidents: MutableIncident[] = [];
  private readonly rejectedResults: RejectedResult[] = [];
  private readonly tokenService: RestartConfirmationTokens;
  private readonly policy: AutomationPolicy;
  private phase: AutomationPhase = "lobby";
  private pausedFromPhase: Exclude<AutomationPhase, "paused"> | undefined;
  private stateVersion = 0;
  private automationEnabled = false;
  private stageIndex = 0;
  private plannedReadyAtMs: number | undefined;
  private plannedReadyStageIndex: number | undefined;
  private noticeActionId: string | undefined;
  private readyAtMs: number | undefined;
  private waitDeadlineAtMs: number | undefined;
  private nextStagePending = false;
  private restartPending = false;
  private readyActionId: string | undefined;
  private readonly readyActionIds: string[] = [];
  private readyAnnouncementActionId: string | undefined;
  private cheatOffActionId: string | undefined;
  private cheatWarningSent = false;
  private readonly cheatEnabledAtMs = new Map<string, number>();
  private lastCheatOffAcknowledgedAtMs: number | undefined;
  private forceRestartActionId: string | undefined;
  private goActionId: string | undefined;
  private manualFlow = false;
  private pendingManualGoStageId: string | undefined;
  private countdownValue: 3 | 2 | 1 | undefined;
  private permissionDeniedEvidence: string | undefined;
  private startProtectionSensitiveStageId: string | undefined;
  private startProtectionUntilMs: number | undefined;
  private readonly wallClockOriginMs: number;

  public constructor(private readonly configuration: AutomationConfiguration, private readonly clock: MonotonicClock) {
    if (configuration.stages.length === 0) throw new Error("At least one stage is required");
    if (configuration.participants.length === 0 && !configuration.dynamicParticipants) throw new Error("At least one participant is required");
    this.stages = configuration.stages.map((stage) => ({ ...stage }));
    this.participantIds = new Set(configuration.participants);
    if (this.participantIds.size !== configuration.participants.length) throw new Error("Participant IDs must be unique");
    this.policy = { ...defaults(this.participantIds.size), ...configuration.policy };
    this.wallClockOriginMs = configuration.wallClockOriginMs ?? 0;
    if (this.policy.groupDisconnectThreshold < 1) throw new Error("Group disconnect threshold must be positive");
    this.tokenService = new RestartConfirmationTokens(configuration.confirmationSecret ?? randomUUID());
    for (const stageId of configuration.startProtectionUsedStageIds ?? []) {
      if (this.stages.some((stage) => stage.id === stageId)) this.startProtectionUsedStageIds.add(stageId);
    }
    for (const participantId of this.participantIds) {
      this.online.set(participantId, false);
      this.cheat.set(participantId, false);
    }
  }

  private get stage(): AutomationStage {
    return this.stages[this.stageIndex] as AutomationStage;
  }

  private get plannedReadyStage(): AutomationStage | undefined {
    return this.plannedReadyStageIndex === undefined ? undefined : this.stages[this.plannedReadyStageIndex];
  }

  private get commandTargetStage(): AutomationStage {
    return this.plannedReadyStage ?? this.stage;
  }

  private get currentAttempt(): MutableAttempt | undefined {
    return [...this.attempts].reverse().find((attempt) => attempt.stageId === this.stage.id && !attempt.voided);
  }

  public registerParticipant(participantId: string): boolean {
    const normalized = participantId.trim();
    if (!normalized) throw new Error("PARTICIPANT_ID_REQUIRED");
    if (this.participantIds.has(normalized)) return false;
    if (!this.configuration.dynamicParticipants) throw new Error("DYNAMIC_PARTICIPANTS_DISABLED");
    this.participantIds.add(normalized);
    this.online.set(normalized, true);
    this.cheat.set(normalized, false);
    this.stableSince.set(normalized, this.clock.now());
    this.bump();
    return true;
  }

  public observeConnection(participantId: string, online: boolean): void {
    this.assertParticipant(participantId);
    const previous = this.online.get(participantId);
    if (previous === online) return;
    this.online.set(participantId, online);
    if (online) this.stableSince.set(participantId, this.clock.now());
    else this.stableSince.delete(participantId);

    if (online) this.ignoredProtectionOfflineParticipants.delete(participantId);
    if (!online && this.isStartProtectionSensitive()) {
      this.ignoredProtectionOfflineParticipants.add(participantId);
      if (!this.startProtectionUsedStageIds.has(this.stage.id)) {
        this.triggerStartProtection(participantId, `起跑敏感期掉线：${participantId}`);
      }
      this.bump();
      return;
    }

    if (this.phase === "ready" || this.phase === "countdown" || this.phase === "preparing" || this.phase === "restart-preparing" || this.phase === "pre-start-wait") {
      if (!online) {
        this.waiting.add(participantId);
        this.waitDeadlineAtMs ??= this.clock.now() + this.policy.preStartWaitLimitMs;
        this.phase = "pre-start-wait";
        this.readyAtMs = undefined;
        this.plannedReadyAtMs = undefined;
        this.plannedReadyStageIndex = undefined;
        this.noticeActionId = undefined;
        this.readyActionId = undefined;
        this.readyActionIds.length = 0;
        this.readyAnnouncementActionId = undefined;
        this.cheatOffActionId = undefined;
        this.goActionId = undefined;
        this.queueAction("notice", `等待 ${participantId} 重连`);
      }
    } else if ((this.phase === "running" || this.phase === "tail-intake") && !online) {
      this.disconnectedDuringAttempt.add(participantId);
      if (this.disconnectedDuringAttempt.size >= this.policy.groupDisconnectThreshold) {
        this.openRestartIncident("group-disconnect", [...this.disconnectedDuringAttempt], "参赛者掉线数量达到群体异常阈值");
      }
    }
    this.bump();
  }

  public observeCheat(participantId: string, enabled: boolean, sourceId: string = randomUUID()): void {
    this.assertParticipant(participantId);
    const previous = this.cheat.get(participantId) ?? false;
    if (previous === enabled) return;
    this.cheat.set(participantId, enabled);
    if (enabled) this.cheatEnabledAtMs.set(participantId, this.clock.now());
    const attempt = this.currentAttempt;
    if (enabled && attempt?.intakeOpen && (this.phase === "running" || this.phase === "tail-intake") && !attempt.results.some((result) => result.playerId === participantId)) {
      this.acceptResult(attempt, { playerId: participantId, status: "excluded", sourceId, receivedAtMs: this.clock.now(), reason: "cheat-enabled" });
    }
    if (enabled && this.phase !== "running" && this.phase !== "tail-intake" && !this.cheatWarningSent && this.hasCurrentCheatOffConfirmation(this.stage.id)) {
      this.cheatWarningSent = true;
      this.queueAction("notice", "检测到有玩家开启了cheat，请在发令前及时关闭，发令后仍开启视作违规。");
    }
    this.bump();
  }

  public observeViolation(participantId: string, sourceId: string, reason: string): void {
    this.assertParticipant(participantId);
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || (this.phase !== "running" && this.phase !== "tail-intake")) return;
    const existing = attempt.results.find((result) => result.playerId === participantId);
    if (existing?.status === "dnf" || existing?.status === "excluded") return;
    if (existing?.status === "finished") {
      existing.status = "excluded";
      existing.reason = reason;
      existing.finishSourceId = existing.sourceId;
      existing.sourceId = sourceId;
    } else {
      this.acceptResult(attempt, { playerId: participantId, status: "excluded", sourceId, receivedAtMs: this.clock.now(), reason });
    }
    this.bump();
  }

  public observeCrash(participantId: string, evidence: string): void {
    this.assertParticipant(participantId);
    if (!this.isStartProtectionSensitive()) return;
    if (!this.startProtectionUsedStageIds.has(this.stage.id)) this.triggerStartProtection(participantId, evidence);
    this.bump();
  }

  public observeServerDisconnect(evidence: string): void {
    const attempt = this.currentAttempt;
    this.incidents.push({
      id: randomUUID(), type: "server-disconnect", severity: "critical", createdAtMs: this.clock.now(),
      ...(attempt ? { attemptId: attempt.id } : {}), participantIds: [], recommendedRestart: Boolean(attempt), status: "open", evidence
    });
    this.automationEnabled = false;
    this.phase = "incident";
    this.bump();
  }

  public observeTimingDiscontinuity(evidence: string): void {
    const attempt = this.currentAttempt;
    this.incidents.push({
      id: randomUUID(), type: "timing-discontinuity", severity: "critical", createdAtMs: this.clock.now(),
      ...(attempt ? { attemptId: attempt.id } : {}), participantIds: [], recommendedRestart: false, status: "open", evidence
    });
    this.automationEnabled = false;
    if (this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "paused";
    this.bump();
  }

  public observePermissionDenied(evidence: string): void {
    this.permissionDeniedEvidence = evidence;
    this.automationEnabled = false;
    if (this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "paused";
    this.bump();
  }

  public enable(plannedReadyAtMs = this.clock.now() + this.policy.intermissionMs): void {
    if (this.automationEnabled) return;
    this.automationEnabled = true;
    if (this.pausedFromPhase) {
      if (this.phase === "paused") this.phase = this.pausedFromPhase;
      this.pausedFromPhase = undefined;
    } else {
      this.phase = "preparing";
      this.manualFlow = false;
      this.planReady(this.stageIndex, plannedReadyAtMs);
    }
    this.bump();
  }

  public startReadyFlow(): void {
    const targetStageIndex = this.nextStagePending ? this.stageIndex + 1 : this.stageIndex;
    if (!this.stages[targetStageIndex] || ["countdown", "review", "incident"].includes(this.phase)) throw new Error("READY_FLOW_NOT_AVAILABLE");
    if (this.readyFlowBlockers(false).length > 0) throw new Error("READY_FLOW_BLOCKED");
    this.automationEnabled = true;
    this.pausedFromPhase = undefined;
    if (this.phase !== "tail-intake") this.phase = this.restartPending ? "restart-preparing" : "preparing";
    this.manualFlow = false;
    this.planReady(targetStageIndex, this.clock.now() + READY_NOTICE_LEAD_MS);
    this.queueDueReadyNotice();
    this.bump();
  }

  public pause(): void {
    if (!this.automationEnabled && this.phase === "paused") return;
    this.automationEnabled = false;
    if (this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "paused";
    this.bump();
  }

  public resolveUnconfirmedAction(actionId: string, status: "acknowledged" | "failed" | "uncertain" | "referee-confirmed"): void {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action || (action.status !== "failed" && action.status !== "uncertain")) throw new Error("AUTOMATION_ACTION_NOT_UNCONFIRMED");
    action.status = status;
    if (status === "acknowledged" || status === "referee-confirmed") {
      action.acknowledgedAtMs = this.clock.now();
      if (action.kind === "cheat-off") this.lastCheatOffAcknowledgedAtMs = this.clock.now();
    }
    if ((status === "acknowledged" || status === "referee-confirmed") && action.kind === "go") this.startAttemptForStage(action.stageId);
    this.bump();
  }

  public tick(): void {
    const now = this.clock.now();
    const attempt = this.currentAttempt;
    if (attempt?.intakeOpen && now >= attempt.deadlineAtMs) this.closeAtDeadline(attempt);
    if (this.automationEnabled) this.queueDueReadyNotice();
    if (!this.automationEnabled && this.phase !== "ready" && this.phase !== "countdown") return;

    if (this.pendingManualGoStageId && this.isAcknowledged(this.forceRestartActionId)) {
      const target = this.stages.find((stage) => stage.id === this.pendingManualGoStageId);
      if (!target || this.startBlockers(false).length > 0) return;
      this.goActionId = this.queueActionForStage("go", target, undefined, true).id;
      this.pendingManualGoStageId = undefined;
      this.phase = "countdown";
      this.bump();
      return;
    }

    if (this.phase === "pre-start-wait") {
      const allStable = [...this.waiting].every((participantId) =>
        this.online.get(participantId) && now - (this.stableSince.get(participantId) ?? now) >= this.policy.reconnectStableMs);
      if (allStable) {
        this.waiting.clear();
        this.waitDeadlineAtMs = undefined;
        this.phase = this.restartPending ? "restart-preparing" : "preparing";
        this.planReady(this.stageIndex, now + READY_NOTICE_LEAD_MS);
      } else if (this.waitDeadlineAtMs !== undefined && now >= this.waitDeadlineAtMs) {
        for (const participantId of this.waiting) {
          if (this.policy.preStartTimeoutPolicy === "absent") this.absent.add(participantId);
        }
        this.waiting.clear();
        this.waitDeadlineAtMs = undefined;
        this.phase = this.restartPending ? "restart-preparing" : "preparing";
        this.planReady(this.stageIndex, now + READY_NOTICE_LEAD_MS);
      } else return;
    }

    if (this.phase === "tail-intake" && this.nextStagePending && this.plannedReadyAtMs !== undefined && now >= this.plannedReadyAtMs) {
      if (this.readyFlowBlockers().length > 0) return;
      this.enterReady();
      return;
    }
    if ((this.phase === "preparing" || this.phase === "restart-preparing") && this.plannedReadyAtMs !== undefined && now >= this.plannedReadyAtMs) {
      if (this.restartPending && !this.isAcknowledged(this.forceRestartActionId)) {
        if (!this.forceRestartActionId) this.forceRestartActionId = this.queueAction("force-next-restart").id;
        return;
      }
      if (this.readyFlowBlockers().length > 0) return;
      this.enterReady();
      return;
    }
    if (this.phase !== "ready" || this.readyAtMs === undefined) return;
    const previousReadyId = this.readyActionIds.at(-1);
    const previousReadyAcknowledgedAt = this.actionAcknowledgedAt(previousReadyId);
    const nextReadyAtMs = Math.max(
      this.readyAtMs + this.readyActionIds.length * READY_STEP_MS,
      previousReadyAcknowledgedAt === undefined ? 0 : previousReadyAcknowledgedAt + READY_STEP_MS
    );
    if (this.readyActionIds.length < 3 && now >= nextReadyAtMs && this.readyActionIds.every((id) => this.isAcknowledged(id))) {
      const action = this.queueAction("ready");
      this.readyActionIds.push(action.id);
      this.readyActionId = action.id;
      this.bump();
      return;
    }
    if (this.readyActionIds.length < 3 || !this.readyActionIds.every((id) => this.isAcknowledged(id))) return;
    if (!this.readyAnnouncementActionId) {
      const lastReadyAcknowledgedAt = this.actionAcknowledgedAt(this.readyActionIds.at(-1));
      if (lastReadyAcknowledgedAt === undefined || now < Math.max(this.readyAtMs + 3 * READY_STEP_MS, lastReadyAcknowledgedAt + READY_STEP_MS)) return;
      this.readyAnnouncementActionId = this.queueAction("announce", "READY!").id;
      this.bump();
      return;
    }
    if (!this.isAcknowledged(this.readyAnnouncementActionId)) return;
    if (!this.cheatOffActionId) {
      const announcementAcknowledgedAt = this.actionAcknowledgedAt(this.readyAnnouncementActionId);
      if (announcementAcknowledgedAt === undefined || now < Math.max(this.readyAtMs + 4 * READY_STEP_MS, announcementAcknowledgedAt + READY_STEP_MS)) return;
      this.cheatOffActionId = this.queueAction("cheat-off").id;
      this.bump();
      return;
    }
    const cheatAcknowledgedAt = this.actionAcknowledgedAt(this.cheatOffActionId);
    if (cheatAcknowledgedAt === undefined || now < cheatAcknowledgedAt + CHEAT_CONFIRMATION_BUFFER_MS) return;
    if (this.readyFlowBlockers().length > 0) return;
    if (this.restartPending && !this.isAcknowledged(this.forceRestartActionId)) {
      if (!this.forceRestartActionId) this.forceRestartActionId = this.queueAction("force-next-restart").id;
      return;
    }
    if (!this.goActionId) {
      this.goActionId = this.queueAction("go").id;
      this.phase = "countdown";
      this.bump();
    }
  }

  public acknowledgeAction(actionId: string, status: "acknowledged" | "failed" | "uncertain"): void {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action || action.status !== "pending") return;
    action.status = status;
    if (status !== "acknowledged") {
      this.automationEnabled = false;
      if (this.phase !== "paused") this.pausedFromPhase = this.phase;
      this.phase = "paused";
      this.bump();
      return;
    }
    action.acknowledgedAtMs = this.clock.now();
    if (action.kind === "cheat-off") this.lastCheatOffAcknowledgedAtMs = this.clock.now();
    if (action.kind === "go") this.startAttemptForStage(action.stageId);
    this.bump();
  }

  public observeAuthoritativeGo(stageId = this.stage.id): void {
    const stageIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex < 0) throw new Error("UNKNOWN_STAGE");
    const current = this.currentAttempt;
    if (current?.stageId === stageId && current.intakeOpen && this.phase === "running") return;
    this.startAttemptForStage(stageId);
    this.bump();
  }

  public observeCountdown(value: 3 | 2 | 1): void {
    this.countdownValue = value;
    if (this.phase !== "countdown") this.phase = "countdown";
    this.bump();
  }

  public recordResult(input: Omit<AutomationResult, "receivedAtMs"> & { stageId: string; receivedAtMs?: number }): "accepted" | RejectedResult["reason"] {
    const receivedAtMs = input.receivedAtMs ?? this.clock.now();
    const currentAttempt = this.currentAttempt;
    const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === input.stageId && !candidate.voided);
    const reject = (reason: RejectedResult["reason"]): RejectedResult["reason"] => {
      this.rejectedResults.push({ stageId: input.stageId, playerId: input.playerId, sourceId: input.sourceId, receivedAtMs, reason });
      this.bump();
      return reason;
    };
    if (!attempt) return reject(currentAttempt ? "wrong-stage" : "no-attempt");
    const existing = attempt.results.find((result) => result.playerId === input.playerId);
    if (existing?.status === "excluded" && input.status === "finished") {
      existing.finishSourceId = input.sourceId;
      this.bump();
      return "accepted";
    }
    if (existing || attempt.results.some((result) => result.sourceId === input.sourceId)) return reject("duplicate");
    if (!attempt.intakeOpen) return reject("intake-closed");
    if (receivedAtMs > attempt.deadlineAtMs) return reject("deadline-passed");
    this.assertParticipant(input.playerId);
    this.acceptResult(attempt, {
      playerId: input.playerId, status: input.status, sourceId: input.sourceId, receivedAtMs,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.finishSourceId === undefined ? {} : { finishSourceId: input.finishSourceId })
    });
    this.bump();
    return "accepted";
  }

  public reschedule(plannedReadyAtMs: number): void {
    if (!Number.isFinite(plannedReadyAtMs)) throw new Error("INVALID_READY_TIME");
    if (this.plannedReadyAtMs === undefined || this.plannedReadyStageIndex === undefined || this.phase === "ready" || this.phase === "countdown" || this.phase === "review") throw new Error("RESCHEDULE_NOT_AVAILABLE");
    if (this.phase !== "tail-intake") this.phase = this.restartPending ? "restart-preparing" : "preparing";
    this.planReady(this.plannedReadyStageIndex, plannedReadyAtMs);
    this.queueDueReadyNotice();
    this.bump();
  }

  public delayReady(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("INVALID_WAIT_EXTENSION");
    if (this.phase === "pre-start-wait" && this.waitDeadlineAtMs !== undefined) this.waitDeadlineAtMs += milliseconds;
    else if (this.plannedReadyAtMs !== undefined && this.plannedReadyStageIndex !== undefined) {
      this.planReady(this.plannedReadyStageIndex, this.plannedReadyAtMs + milliseconds);
      this.queueDueReadyNotice();
    }
    else throw new Error("WAIT_EXTENSION_NOT_AVAILABLE");
    this.bump();
  }

  public extendWait(milliseconds: number): void { this.delayReady(milliseconds); }

  public extendStageDeadline(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("INVALID_DEADLINE_EXTENSION");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || (this.phase !== "running" && this.phase !== "tail-intake")) throw new Error("DEADLINE_EXTENSION_NOT_AVAILABLE");
    attempt.deadlineAtMs += milliseconds;
    this.queueAction("notice", `本关时限已延长 ${formatDelay(milliseconds)}`);
    this.bump();
  }

  public rescheduleStageDeadline(deadlineAtMs: number): void {
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= this.clock.now()) throw new Error("INVALID_STAGE_DEADLINE");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || (this.phase !== "running" && this.phase !== "tail-intake")) throw new Error("DEADLINE_RESCHEDULE_NOT_AVAILABLE");
    attempt.deadlineAtMs = deadlineAtMs;
    this.queueAction("notice", "本关最晚结束时间已改期");
    this.bump();
  }

  public manualReady(): void {
    if (["countdown", "running", "review", "incident"].includes(this.phase)) throw new Error("READY_NOT_AVAILABLE");
    if (this.readyFlowBlockers(false).some((blocker) => blocker.severity === "critical")) throw new Error("READY_BLOCKED");
    this.queueActionForStage("ready", this.commandTargetStage, undefined, true);
    this.bump();
  }

  public manualCheatOff(): void {
    if (["review", "incident"].includes(this.phase)) throw new Error("CHEAT_OFF_NOT_AVAILABLE");
    this.queueActionForStage("cheat-off", this.commandTargetStage, undefined, true);
    this.bump();
  }

  public requestManualGo(): void {
    if (["countdown", "running", "review", "incident"].includes(this.phase)) throw new Error("MANUAL_GO_NOT_AVAILABLE");
    const target = this.commandTargetStage;
    if (!this.hasCurrentCheatOffConfirmation(target.id)) throw new Error("MANUAL_GO_CHEAT_OFF_REQUIRED");
    if (this.actions.some((action) => action.status === "pending")) throw new Error("MANUAL_GO_COMMAND_PENDING");
    if (this.readyFlowBlockers(false).length > 0) throw new Error("MANUAL_GO_BLOCKED");
    this.manualFlow = true;
    if (this.restartPending && !this.isAcknowledged(this.forceRestartActionId)) {
      this.pendingManualGoStageId = target.id;
      this.forceRestartActionId ??= this.queueActionForStage("force-next-restart", target, undefined, true).id;
      this.bump();
      return;
    }
    this.goActionId = this.queueActionForStage("go", target, undefined, true).id;
    this.phase = "countdown";
    this.bump();
  }

  public endStage(reason: string): void {
    if (!reason.trim()) throw new Error("END_STAGE_REASON_REQUIRED");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen) throw new Error("END_STAGE_NOT_AVAILABLE");
    for (const participantId of this.participantIds) {
      if (!this.absent.has(participantId) && !attempt.results.some((result) => result.playerId === participantId)) {
        attempt.results.push({
          playerId: participantId,
          status: "dnf",
          sourceId: `manual-end:${attempt.id}:${participantId}`,
          receivedAtMs: this.clock.now(),
          reason: reason.trim()
        });
      }
    }
    this.closeIntake(attempt);
    if (this.stageIndex === this.stages.length - 1) this.phase = "review";
    else {
      this.nextStagePending = true;
      this.phase = "tail-intake";
      this.planReady(this.stageIndex + 1, this.clock.now() + this.policy.intermissionMs);
    }
    this.bump();
  }

  public issueStageRestartConfirmation(attemptId: string, ttlMs = 60_000): { token: string; impactHash: string; expiresAtMs: number } {
    const attempt = this.currentAttempt;
    if (!attempt || attempt.id !== attemptId || !this.stageRestartAvailable()) throw new Error("RESTART_NOT_AVAILABLE");
    const impactHash = sha256({ attemptId: attempt.id, stageId: attempt.stageId, results: attempt.results });
    const expiresAtMs = this.clock.now() + ttlMs;
    const token = this.tokenService.issue({
      competitionId: this.configuration.competitionId, stageId: this.stage.id, attemptId: attempt.id,
      stateVersion: this.stateVersion, targetId: attempt.id, impactHash, expiresAtMs, nonce: randomUUID()
    });
    return { token, impactHash, expiresAtMs };
  }

  public confirmStageRestart(input: { attemptId: string; impactHash: string; token: string; reason: string }): void {
    if (!input.reason.trim()) throw new Error("RESTART_REASON_REQUIRED");
    const attempt = this.currentAttempt;
    if (!attempt || attempt.id !== input.attemptId || !this.stageRestartAvailable()) throw new Error("RESTART_NOT_AVAILABLE");
    this.tokenService.consume(input.token, {
      competitionId: this.configuration.competitionId, stageId: this.stage.id, attemptId: attempt.id,
      stateVersion: this.stateVersion, targetId: attempt.id, impactHash: input.impactHash
    }, this.clock.now());
    attempt.voided = true;
    this.closeIntake(attempt);
    for (const incident of this.incidents) if (incident.attemptId === attempt.id && incident.status === "open") incident.status = "resolved";
    this.automationEnabled = true;
    this.pausedFromPhase = undefined;
    this.phase = "restart-preparing";
    this.restartPending = true;
    this.nextStagePending = false;
    this.planReady(this.stageIndex, this.clock.now() + READY_NOTICE_LEAD_MS);
    this.queueDueReadyNotice();
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.forceRestartActionId = undefined;
    this.goActionId = undefined;
    this.queueAction("announce", `本轮将重赛：${input.reason.trim()}`);
    this.bump();
  }

  private stageRestartAvailable(): boolean {
    const effectivePhase = this.phase === "paused" ? this.pausedFromPhase : this.phase;
    return effectivePhase === "running" || effectivePhase === "tail-intake" || this.phase === "incident";
  }

  public drainActions(): readonly AutomationAction[] {
    const result = this.actions.filter((action) => this.undeliveredActionIds.delete(action.id));
    return result.map(cloneAction);
  }

  public snapshot(): AutomationSnapshot {
    return {
      phase: this.phase,
      ...(this.pausedFromPhase === undefined ? {} : { pausedFromPhase: this.pausedFromPhase }),
      stateVersion: this.stateVersion,
      automationEnabled: this.automationEnabled,
      currentStageId: this.stage.id,
      ...(this.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: this.plannedReadyAtMs }),
      ...(this.plannedReadyStage === undefined ? {} : { plannedReadyStageId: this.plannedReadyStage.id }),
      ...(this.countdownValue === undefined ? {} : { countdownValue: this.countdownValue }),
      blockers: this.startBlockers(!this.manualFlow),
      waitingParticipants: [...this.waiting],
      startProtectionUsedStageIds: [...this.startProtectionUsedStageIds],
      ...(this.startProtectionSensitiveStageId === undefined ? {} : { startProtectionSensitiveStageId: this.startProtectionSensitiveStageId }),
      ...(this.startProtectionUntilMs === undefined ? {} : { startProtectionUntilMs: this.startProtectionUntilMs }),
      attempts: this.attempts.map(cloneAttempt),
      incidents: this.incidents.map(cloneIncident),
      rejectedResults: this.rejectedResults.map((result) => ({ ...result })),
      actions: this.actions.map(cloneAction)
    };
  }

  private enterReady(): void {
    const targetStageIndex = this.plannedReadyStageIndex ?? this.stageIndex;
    const targetStage = this.stages[targetStageIndex];
    if (!targetStage) throw new Error("UNKNOWN_READY_STAGE");
    const scheduledReadyAtMs = this.plannedReadyAtMs;
    if (scheduledReadyAtMs !== undefined && this.clock.now() > scheduledReadyAtMs) this.queueBulletin(targetStage, this.clock.now());
    if (targetStageIndex !== this.stageIndex) {
      const previous = this.currentAttempt;
      if (previous) this.closeIntake(previous);
      this.stageIndex = targetStageIndex;
      this.nextStagePending = false;
      this.ignoredProtectionOfflineParticipants.clear();
    }
    this.phase = "ready";
    this.readyAtMs = this.clock.now();
    this.startProtectionSensitiveStageId = targetStage.id;
    this.startProtectionUntilMs = undefined;
    this.plannedReadyAtMs = undefined;
    this.plannedReadyStageIndex = undefined;
    this.noticeActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.lastCheatOffAcknowledgedAtMs = undefined;
    const readyAction = this.queueAction("ready");
    this.readyActionIds.push(readyAction.id);
    this.readyActionId = readyAction.id;
    this.goActionId = undefined;
    this.bump();
  }

  private startAttemptForStage(stageId: string): void {
    const targetStageIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (targetStageIndex < 0) throw new Error("UNKNOWN_STAGE");
    const existing = [...this.attempts].reverse().find((attempt) => attempt.stageId === stageId && !attempt.voided);
    if (existing?.intakeOpen && this.stageIndex === targetStageIndex && this.phase === "running") return;
    const openAttempt = [...this.attempts].reverse().find((attempt) => attempt.intakeOpen && !attempt.voided);
    if (openAttempt) this.closeIntake(openAttempt);
    this.stageIndex = targetStageIndex;
    this.nextStagePending = false;
    this.plannedReadyAtMs = undefined;
    this.plannedReadyStageIndex = undefined;
    this.noticeActionId = undefined;
    const attemptNumber = this.attempts.filter((attempt) => attempt.stageId === this.stage.id).length + 1;
    const now = this.clock.now();
    this.attempts.push({
      id: randomUUID(), stageId: this.stage.id, attemptNumber, goAtMs: now,
      deadlineAtMs: now + this.stage.timeLimitMs, intakeOpen: true, voided: false, results: []
    });
    this.phase = "running";
    this.startProtectionSensitiveStageId = this.stage.id;
    this.startProtectionUntilMs = now + this.policy.protectionWindowMs;
    this.countdownValue = undefined;
    this.manualFlow = false;
    this.cheatWarningSent = false;
    this.pendingManualGoStageId = undefined;
    this.restartPending = false;
    this.forceRestartActionId = undefined;
    this.disconnectedDuringAttempt.clear();
    for (const participantId of this.participantIds) {
      if (this.cheat.get(participantId) && this.lastCheatOffAcknowledgedAtMs !== undefined && (this.cheatEnabledAtMs.get(participantId) ?? 0) > this.lastCheatOffAcknowledgedAtMs) {
        this.acceptResult(this.attempts[this.attempts.length - 1]!, { playerId: participantId, status: "excluded", sourceId: randomUUID(), receivedAtMs: now, reason: "cheat-enabled" });
      }
    }
    const stageName = this.stage.displayName ?? `${this.stage.mode.toUpperCase()}${this.stage.map}`;
    this.queueActionForStage("bulletin", this.stage, `${stageName}已起跑`, false);
  }

  private acceptResult(attempt: MutableAttempt, result: AutomationResult): void {
    attempt.results.push(result);
    const finished = attempt.results.filter((candidate) => candidate.status === "finished").length;
    const activeCount = this.participantIds.size - this.absent.size;
    if (this.stageIndex === this.stages.length - 1) {
      if (!this.configuration.dynamicParticipants && attempt.results.length >= activeCount) {
        this.closeIntake(attempt);
        this.phase = "review";
      }
      return;
    }
    const allKnownParticipantsCompleted = !this.configuration.dynamicParticipants && attempt.results.length >= activeCount;
    if (!this.nextStagePending && (finished >= this.stage.minimumScoringPlace || allKnownParticipantsCompleted)) {
      this.nextStagePending = true;
      this.phase = "tail-intake";
      this.planReady(this.stageIndex + 1, this.clock.now() + this.policy.intermissionMs);
    }
  }

  private closeAtDeadline(attempt: MutableAttempt): void {
    for (const participantId of this.participantIds) {
      if (!this.absent.has(participantId) && !attempt.results.some((result) => result.playerId === participantId)) {
        attempt.results.push({ playerId: participantId, status: "dnf", sourceId: `deadline:${attempt.id}:${participantId}`, receivedAtMs: this.clock.now(), reason: "time-limit" });
      }
    }
    this.closeIntake(attempt);
    this.queueAction("announce", `${this.stage.map.toUpperCase()} 比赛时间已到`);
    if (this.stageIndex === this.stages.length - 1) this.phase = "review";
    else {
      this.nextStagePending = true;
      if (this.plannedReadyAtMs === undefined) this.planReady(this.stageIndex + 1, this.clock.now() + READY_NOTICE_LEAD_MS);
      this.phase = "tail-intake";
    }
    this.bump();
  }

  private closeIntake(attempt: MutableAttempt): void {
    if (!attempt.intakeOpen) return;
    attempt.intakeOpen = false;
    attempt.intakeClosedAtMs = this.clock.now();
  }

  private isStartProtectionSensitive(): boolean {
    if (this.startProtectionSensitiveStageId !== this.stage.id) return false;
    return this.startProtectionUntilMs === undefined || this.clock.now() <= this.startProtectionUntilMs;
  }

  private triggerStartProtection(participantId: string, evidence: string): void {
    const now = this.clock.now();
    const attempt = this.currentAttempt;
    const postGo = Boolean(attempt?.intakeOpen && now <= attempt.goAtMs + this.policy.protectionWindowMs);
    const plannedReadyAtMs = now + START_PROTECTION_DELAY_MS;
    const stage = this.stage;
    const name = stage.displayName ?? `${stage.mode.toUpperCase()}${stage.map}`;
    const readyTime = formatUtc8Time(this.wallClockOriginMs + plannedReadyAtMs);
    const eventText = "掉线";
    this.startProtectionUsedStageIds.add(stage.id);
    this.cancelPendingLaunchActions(stage.id);
    this.incidents.push({
      id: randomUUID(),
      type: "protected-crash",
      severity: "critical",
      createdAtMs: now,
      ...(attempt ? { attemptId: attempt.id } : {}),
      participantIds: [participantId],
      recommendedRestart: false,
      status: "resolved",
      evidence
    });
    if (postGo && attempt) {
      attempt.voided = true;
      this.closeIntake(attempt);
    }
    this.automationEnabled = true;
    this.pausedFromPhase = undefined;
    this.phase = "restart-preparing";
    this.restartPending = true;
    this.nextStagePending = false;
    this.manualFlow = false;
    this.pendingManualGoStageId = undefined;
    this.countdownValue = undefined;
    this.readyAtMs = undefined;
    this.waitDeadlineAtMs = undefined;
    this.waiting.clear();
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.forceRestartActionId = undefined;
    this.goActionId = undefined;
    const message = postGo
      ? `${name}：玩家 ${participantId} 在起跑保护期${eventText}，当前尝试及成绩已作废，第一条 Ready 改至 ${readyTime}。`
      : `${name}：玩家 ${participantId} 在起跑敏感期${eventText}，发令流程已中止，第一条 Ready 改至 ${readyTime}。`;
    const protectionMessage = postGo
      ? `由于玩家 ${participantId} 起跑保护期${eventText}，本关重赛`
      : `由于玩家 ${participantId} 起跑保护期${eventText}，发令时间延迟`;
    this.queueActionForStage(postGo ? "announce" : "notice", stage, message);
    this.planReady(this.stageIndex, plannedReadyAtMs, protectionMessage);
  }

  private cancelPendingLaunchActions(stageId: string): void {
    for (const action of this.actions) {
      if (action.stageId !== stageId || action.status !== "pending"
        || !["ready", "announce", "cheat-off", "go", "force-next-restart"].includes(action.kind)) continue;
      action.status = "cancelled";
      this.undeliveredActionIds.delete(action.id);
    }
  }

  private openRestartIncident(type: "protected-crash" | "group-disconnect", participantIds: string[], evidence: string): void {
    const attempt = this.currentAttempt;
    if (!attempt || this.incidents.some((incident) => incident.status === "open" && incident.type === type && incident.attemptId === attempt.id)) return;
    this.incidents.push({
      id: randomUUID(), type, severity: "critical", createdAtMs: this.clock.now(), attemptId: attempt.id,
      participantIds, recommendedRestart: true, status: "open", evidence
    });
    this.automationEnabled = false;
    this.phase = "incident";
  }

  private queueAction(kind: AutomationActionKind, message?: string): AutomationAction {
    return this.queueActionForStage(kind, this.stage, message, false);
  }

  private queueActionForStage(kind: AutomationActionKind, stage: AutomationStage, message?: string, manual = false): AutomationAction {
    const action: AutomationAction = {
      id: randomUUID(), kind, idempotencyKey: `${this.configuration.competitionId}:${stage.id}:${kind}:${this.stateVersion + 1}`,
      createdAtMs: this.clock.now(), stageId: stage.id, map: stage.map, mode: stage.mode,
      ...(stage.displayName === undefined ? {} : { mapName: stage.displayName }),
      ...(message === undefined ? {} : { message }),
      ...(manual ? { manual: true } : {}),
      status: "pending"
    };
    this.actions.push(action);
    this.undeliveredActionIds.add(action.id);
    return action;
  }

  private planReady(stageIndex: number, plannedReadyAtMs: number, protectionMessage?: string): void {
    const target = this.stages[stageIndex];
    if (!target || !Number.isFinite(plannedReadyAtMs)) throw new Error("INVALID_READY_PLAN");
    this.plannedReadyAtMs = plannedReadyAtMs;
    this.plannedReadyStageIndex = stageIndex;
    this.noticeActionId = undefined;
    this.queueBulletin(target, plannedReadyAtMs, protectionMessage);
  }

  private queueBulletin(stage: AutomationStage, plannedReadyAtMs: number, protectionMessage?: string): void {
    const name = stage.displayName ?? `${stage.mode.toUpperCase()}${stage.map}`;
    const protectionContext = protectionMessage ? `\n${protectionMessage}` : "";
    const suffix = this.startProtectionUsedStageIds.has(stage.id) ? START_PROTECTION_USED_SUFFIX : "";
    this.queueActionForStage("bulletin", stage, `${name} 将在 ${formatUtc8Time(this.wallClockOriginMs + plannedReadyAtMs)} 发令${protectionContext}${suffix}`);
  }

  private queueDueReadyNotice(): void {
    if (this.noticeActionId || this.plannedReadyAtMs === undefined || !this.plannedReadyStage) return;
    if (this.clock.now() < this.plannedReadyAtMs - READY_NOTICE_LEAD_MS) return;
    const stage = this.plannedReadyStage;
    const name = stage.displayName ?? `${stage.mode.toUpperCase()}${stage.map}`;
    const suffix = this.startProtectionUsedStageIds.has(stage.id) ? START_PROTECTION_USED_SUFFIX : "";
    this.noticeActionId = this.queueActionForStage(
      "notice",
      stage,
      `${name} 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。${suffix}`
    ).id;
  }

  private isAcknowledged(actionId: string | undefined): boolean {
    const status = actionId === undefined ? undefined : this.actions.find((action) => action.id === actionId)?.status;
    return status === "acknowledged" || status === "referee-confirmed";
  }

  private actionAcknowledgedAt(actionId: string | undefined): number | undefined {
    if (actionId === undefined) return undefined;
    const action = this.actions.find((candidate) => candidate.id === actionId);
    return this.isAcknowledged(actionId) ? action?.acknowledgedAtMs ?? action?.createdAtMs : undefined;
  }

  private hasCurrentCheatOffConfirmation(stageId: string): boolean {
    const stageActions = this.actions.filter((action) => action.stageId === stageId);
    const previousGoIndex = stageActions.findLastIndex((action) => action.kind === "go" && this.isAcknowledged(action.id));
    return stageActions.slice(previousGoIndex + 1).some((action) => action.kind === "cheat-off" && this.isAcknowledged(action.id));
  }

  private readyFlowBlockers(includeAutomation = true): AutomationBlocker[] {
    return this.startBlockers(includeAutomation).filter((blocker) => blocker.code !== "PARTICIPANT_CHEAT");
  }

  private startBlockers(includeAutomation = true): AutomationBlocker[] {
    const blockers: AutomationBlocker[] = [];
    if (this.permissionDeniedEvidence) blockers.push({ code: "PERMISSION_DENIED", severity: "critical", autoRecoverable: false, suggestion: "ContestConsole 权限不足；请在服务器修复权限后重新启动工作运行" });
    if (includeAutomation && !this.automationEnabled) blockers.push({ code: "AUTOMATION_PAUSED", severity: "critical", autoRecoverable: false, suggestion: "由裁判核对现场后恢复自动化" });
    for (const participantId of this.participantIds) {
      if (this.absent.has(participantId)) continue;
      if (!this.online.get(participantId) && !this.ignoredProtectionOfflineParticipants.has(participantId)) blockers.push({ code: "PARTICIPANT_OFFLINE", severity: "warning", autoRecoverable: true, participantId, suggestion: "等待选手重连并保持稳定在线" });
    }
    if (this.actions.some((action) => action.status === "failed" || action.status === "uncertain")) blockers.push({ code: "COMMAND_UNCONFIRMED", severity: "critical", autoRecoverable: false, suggestion: "核对服务器现场与命令审计，禁止自动补发" });
    if (this.incidents.some((incident) => incident.status === "open" && incident.recommendedRestart)) blockers.push({ code: "INCIDENT_OPEN", severity: "critical", autoRecoverable: false, suggestion: "裁判选择继续或使用短时确认令牌重赛" });
    return blockers;
  }

  private assertParticipant(participantId: string): void {
    if (!this.participantIds.has(participantId)) throw new Error(`Unknown participant: ${participantId}`);
  }

  private bump(): void {
    this.stateVersion += 1;
  }
}
