import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AttemptOrigin } from "@ballance/contracts";

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
  startProtectionEnabled: boolean;
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
  startProtectionExhaustedStageIds?: readonly string[] | undefined;
  initialSnapshot?: AutomationSnapshot | undefined;
  restoreParticipantState?: boolean;
  nonBlockingCommands?: boolean;
}

const formatDelay = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
};

export type AutomationActionKind = "bulletin" | "notice" | "announce" | "ready" | "cheat-off" | "go";

export interface AutomationAction {
  id: string;
  kind: AutomationActionKind;
  idempotencyKey: string;
  createdAtMs: number;
  notBeforeMs?: number;
  stageId: string;
  map: string;
  mapName?: string;
  mode: "sr" | "hs";
  message?: string;
  manual?: boolean;
  acknowledgedAtMs?: number;
  writtenAtMs?: number;
  isolated?: boolean;
  undelivered?: boolean;
  status: "pending" | "acknowledged" | "failed" | "uncertain" | "referee-confirmed" | "cancelled" | "sent-unconfirmed";
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
  origin?: AttemptOrigin;
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
  reason: "no-attempt" | "wrong-stage" | "duplicate" | "intake-closed" | "deadline-passed" | "pre-go";
}

export interface ForceResetStageResult {
  targetStageId: string;
  boundaryAtMs: number;
  voidedAttempts: readonly ControlledAttempt[];
}

export interface ForceNextStageResult {
  previousStageId: string;
  targetStageId: string;
  boundaryAtMs: number;
  closedAttempt?: ControlledAttempt;
}

export interface ExpectedCurrentStageInput {
  expectedCurrentStageId: string;
}

export interface ExpectedNextStageInput extends ExpectedCurrentStageInput {
  expectedTargetStageId: string;
}

export interface AutomationSnapshot {
  phase: AutomationPhase;
  pausedFromPhase?: Exclude<AutomationPhase, "paused">;
  stateVersion: number;
  automationEnabled: boolean;
  clockNowMs?: number;
  wallClockOriginMs?: number;
  currentStageId: string;
  plannedReadyAtMs?: number;
  plannedReadyStageId?: string;
  readyAtMs?: number;
  waitDeadlineAtMs?: number;
  nextStagePending?: boolean;
  restartPending?: boolean;
  lastCheatOffAcknowledgedAtMs?: number;
  countdownValue?: 3 | 2 | 1;
  blockers: readonly AutomationBlocker[];
  waitingParticipants: readonly string[];
  absentParticipants?: readonly string[];
  participantStates?: readonly AutomationParticipantState[];
  cheatWarningSent?: boolean;
  startProtectionUsedStageIds?: readonly string[];
  startProtectionExhaustedStageIds?: readonly string[];
  startProtectionEnabled?: boolean;
  startProtectionSensitiveStageId?: string;
  startProtectionUntilMs?: number;
  attempts: readonly ControlledAttempt[];
  incidents: readonly AutomationIncident[];
  rejectedResults: readonly RejectedResult[];
  actions: readonly AutomationAction[];
}

export interface CompetitionControllerCheckpoint {
  snapshot: AutomationSnapshot;
  consumedRestartConfirmationNonces: readonly string[];
}

export interface AutomationParticipantState {
  participantId: string;
  online: boolean;
  cheatEnabled: boolean;
  stableSinceMs?: number;
  cheatEnabledAfterCurrentOff?: boolean;
}

interface MutableAttempt extends Omit<ControlledAttempt, "origin" | "results"> {
  origin: AttemptOrigin;
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
  startProtectionEnabled: true,
  protectionWindowMs: 10_000,
  groupDisconnectThreshold: Math.max(2, Math.ceil(participantCount * 0.2)),
  preStartTimeoutPolicy: "allow-late"
});

const READY_STEP_MS = 5_000;
const CHEAT_CONFIRMATION_BUFFER_MS = 10_000;
const READY_NOTICE_LEAD_MS = 60_000;
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

  public checkpoint(): readonly string[] {
    return [...this.consumed];
  }

  public restore(consumedNonces: readonly string[]): void {
    this.consumed.clear();
    for (const nonce of consumedNonces) this.consumed.add(nonce);
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
  private readonly startProtectionUsedStageIds = new Set<string>();
  private readonly startProtectionExhaustedStageIds = new Set<string>();
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
  private readonly cheatEnabledAfterCurrentOff = new Set<string>();
  private lastCheatOffAcknowledgedAtMs: number | undefined;
  private goActionId: string | undefined;
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
    for (const stageId of configuration.startProtectionExhaustedStageIds ?? configuration.startProtectionUsedStageIds ?? []) {
      if (this.stages.some((stage) => stage.id === stageId)) this.startProtectionExhaustedStageIds.add(stageId);
    }
    for (const stageId of configuration.startProtectionUsedStageIds ?? []) {
      if (this.stages.some((stage) => stage.id === stageId)) this.startProtectionUsedStageIds.add(stageId);
    }
    for (const participantId of this.participantIds) {
      this.online.set(participantId, false);
      this.cheat.set(participantId, false);
    }
    if (configuration.initialSnapshot) this.restoreSnapshot(configuration.initialSnapshot);
  }

  public updateMinimumScoringPlaces(minimumByStage: Readonly<Record<string, number>>): void {
    for (const stage of this.stages) {
      const minimum = minimumByStage[stage.id];
      if (minimum === undefined) continue;
      if (!Number.isInteger(minimum) || minimum < 1) throw new Error("INVALID_MINIMUM_SCORING_PLACE");
      stage.minimumScoringPlace = minimum;
    }
    const attempt = this.currentAttempt;
    if (attempt?.intakeOpen && !attempt.voided) this.evaluateStageCompletion(attempt);
  }

  public checkpoint(): CompetitionControllerCheckpoint {
    return {
      snapshot: this.snapshot(),
      consumedRestartConfirmationNonces: this.tokenService.checkpoint()
    };
  }

  public restore(checkpoint: CompetitionControllerCheckpoint): void {
    this.tokenService.restore(checkpoint.consumedRestartConfirmationNonces);
    this.restoreSnapshot(checkpoint.snapshot, true);
  }

  private restoreSnapshot(snapshot: AutomationSnapshot, forceParticipantState = false): void {
    const stageIndex = this.stages.findIndex((stage) => stage.id === snapshot.currentStageId);
    if (stageIndex < 0) throw new Error("RESTORE_STAGE_NOT_FOUND");
    this.participantIds.clear();
    for (const participantId of this.configuration.participants) this.participantIds.add(participantId);
    this.online.clear();
    this.cheat.clear();
    this.stableSince.clear();
    this.waiting.clear();
    this.absent.clear();
    this.startProtectionUsedStageIds.clear();
    this.startProtectionExhaustedStageIds.clear();
    this.actions.length = 0;
    this.undeliveredActionIds.clear();
    this.attempts.length = 0;
    this.incidents.length = 0;
    this.rejectedResults.length = 0;
    this.noticeActionId = undefined;
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.goActionId = undefined;
    this.lastCheatOffAcknowledgedAtMs = undefined;
    this.permissionDeniedEvidence = undefined;
    this.cheatEnabledAfterCurrentOff.clear();
    this.stageIndex = stageIndex;
    this.phase = snapshot.phase;
    this.pausedFromPhase = snapshot.pausedFromPhase;
    this.stateVersion = snapshot.stateVersion;
    this.automationEnabled = snapshot.automationEnabled;
    this.plannedReadyAtMs = snapshot.plannedReadyAtMs;
    this.plannedReadyStageIndex = snapshot.plannedReadyStageId === undefined
      ? undefined
      : this.stages.findIndex((stage) => stage.id === snapshot.plannedReadyStageId);
    if (this.plannedReadyStageIndex !== undefined && this.plannedReadyStageIndex < 0) throw new Error("RESTORE_READY_STAGE_NOT_FOUND");
    this.countdownValue = snapshot.countdownValue;
    this.readyAtMs = snapshot.readyAtMs;
    this.waitDeadlineAtMs = snapshot.waitDeadlineAtMs;
    this.startProtectionSensitiveStageId = snapshot.startProtectionSensitiveStageId;
    this.startProtectionUntilMs = snapshot.startProtectionUntilMs;
    this.startProtectionUsedStageIds.clear();
    this.startProtectionExhaustedStageIds.clear();
    for (const stageId of snapshot.startProtectionUsedStageIds ?? []) this.startProtectionUsedStageIds.add(stageId);
    // Older snapshots only recorded a fully consumed boolean protection.
    for (const stageId of snapshot.startProtectionExhaustedStageIds ?? snapshot.startProtectionUsedStageIds ?? []) this.startProtectionExhaustedStageIds.add(stageId);

    const restoredParticipants = new Set<string>([
      ...this.participantIds,
      ...snapshot.waitingParticipants,
      ...(snapshot.absentParticipants ?? []),
      ...(snapshot.participantStates ?? []).map((state) => state.participantId),
      ...snapshot.attempts.flatMap((attempt) => attempt.results.map((result) => result.playerId)),
      ...snapshot.incidents.flatMap((incident) => incident.participantIds)
    ]);
    for (const participantId of restoredParticipants) {
      this.participantIds.add(participantId);
      this.online.set(participantId, false);
      this.cheat.set(participantId, false);
    }
    this.waiting.clear();
    for (const participantId of snapshot.waitingParticipants) this.waiting.add(participantId);
    this.absent.clear();
    for (const participantId of snapshot.absentParticipants ?? []) this.absent.add(participantId);
    this.cheatWarningSent = snapshot.cheatWarningSent ?? false;
    this.cheatEnabledAfterCurrentOff.clear();
    if (forceParticipantState || this.configuration.restoreParticipantState) {
      for (const state of snapshot.participantStates ?? []) {
        this.online.set(state.participantId, state.online);
        this.cheat.set(state.participantId, state.cheatEnabled);
        if (state.stableSinceMs === undefined) this.stableSince.delete(state.participantId);
        else this.stableSince.set(state.participantId, state.stableSinceMs);
        if (state.cheatEnabledAfterCurrentOff) this.cheatEnabledAfterCurrentOff.add(state.participantId);
      }
    }
    this.attempts.push(...snapshot.attempts.map((attempt) => ({
      ...attempt,
      origin: attempt.origin ?? "authoritative-go",
      results: attempt.results.map((result) => ({ ...result }))
    })));
    this.incidents.push(...snapshot.incidents.map((incident) => ({ ...incident, participantIds: [...incident.participantIds] })));
    this.rejectedResults.push(...snapshot.rejectedResults.map((result) => ({ ...result })));
    this.actions.push(...snapshot.actions.map(cloneAction));
    for (const action of this.actions) {
      if (action.status === "pending" && action.undelivered) this.undeliveredActionIds.add(action.id);
      else if (action.undelivered) action.undelivered = false;
    }

    const effectivePhase = this.phase === "paused" ? this.pausedFromPhase : this.phase;
    this.restartPending = snapshot.restartPending ?? effectivePhase === "restart-preparing";
    this.nextStagePending = snapshot.nextStagePending ?? (this.plannedReadyStageIndex !== undefined && this.plannedReadyStageIndex !== this.stageIndex
      || effectivePhase === "tail-intake");
    if (snapshot.blockers.some((blocker) => blocker.code === "PERMISSION_DENIED")) this.permissionDeniedEvidence = "restored permission denial";

    const relevantStageId = snapshot.plannedReadyStageId ?? snapshot.currentStageId;
    const goIndexes: number[] = [];
    for (let index = 0; index < this.actions.length; index += 1) {
      const candidate = this.actions[index];
      if (candidate?.stageId === relevantStageId && candidate.kind === "go" && !candidate.isolated) goIndexes.push(index);
    }
    const latestGoIndex = goIndexes.at(-1) ?? -1;
    const previousGoIndex = goIndexes.at(-2) ?? -1;
    const cycleStart = effectivePhase === "running" || effectivePhase === "tail-intake" ? previousGoIndex + 1 : latestGoIndex + 1;
    const cycleActions = this.actions.slice(cycleStart).filter((action) => action.stageId === relevantStageId && !action.isolated);
    const latest = (kind: AutomationActionKind): AutomationAction | undefined =>
      [...cycleActions].reverse().find((action) => action.kind === kind);
    const readyActions = cycleActions.filter((action) => action.kind === "ready");
    this.readyActionIds.push(...readyActions.map((action) => action.id));
    this.readyActionId = readyActions.at(-1)?.id;
    this.noticeActionId = latest("notice")?.id;
    this.readyAnnouncementActionId = [...cycleActions].reverse().find((action) => action.kind === "announce" && action.message === "READY!")?.id;
    this.cheatOffActionId = latest("cheat-off")?.id;
    this.goActionId = latest("go")?.id;
    this.readyAtMs ??= readyActions[0]?.createdAtMs;
    this.lastCheatOffAcknowledgedAtMs = snapshot.lastCheatOffAcknowledgedAtMs ?? latest("cheat-off")?.acknowledgedAtMs;
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

  private effectivePhase(): AutomationPhase {
    return this.phase === "paused" || this.phase === "incident"
      ? this.pausedFromPhase ?? this.phase
      : this.phase;
  }

  private isResultIntakePhase(): boolean {
    const effectivePhase = this.effectivePhase();
    return effectivePhase === "running" || effectivePhase === "tail-intake";
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
    this.settleDueStageClosures(this.clock.now());
    this.assertParticipant(participantId);
    const previous = this.online.get(participantId);
    if (previous === online) return;
    this.online.set(participantId, online);
    if (online) this.stableSince.set(participantId, this.clock.now());
    else this.stableSince.delete(participantId);

    if (!online && this.isStartProtectionSensitive() && !this.hasProtectionIneligibleResult(participantId)) {
      if (!this.startProtectionUsedStageIds.has(this.stage.id)) {
        this.triggerStartProtection(participantId, `起跑敏感期掉线：${participantId}`);
      }
      this.bump();
      return;
    }
    this.bump();
  }

  public observeCheat(participantId: string, enabled: boolean, sourceId: string = randomUUID()): void {
    this.settleDueStageClosures(this.clock.now());
    this.assertParticipant(participantId);
    const previous = this.cheat.get(participantId) ?? false;
    if (previous === enabled) return;
    this.cheat.set(participantId, enabled);
    if (enabled && this.hasCurrentCheatOffConfirmation(this.commandTargetStage.id)) this.cheatEnabledAfterCurrentOff.add(participantId);
    if (!enabled) this.cheatEnabledAfterCurrentOff.delete(participantId);
    const attempt = this.currentAttempt;
    if (enabled && attempt?.intakeOpen && this.isResultIntakePhase() && !attempt.results.some((result) => result.playerId === participantId)) {
      this.acceptResult(attempt, { playerId: participantId, status: "excluded", sourceId, receivedAtMs: this.clock.now(), reason: "cheat-enabled" });
    }
    if (enabled && !this.isResultIntakePhase() && !this.cheatWarningSent && this.hasCurrentCheatOffConfirmation(this.stage.id)) {
      this.cheatWarningSent = true;
      this.queueAction("notice", "检测到有玩家开启了cheat，请在发令前及时关闭，发令后仍开启视作违规。");
    }
    this.bump();
  }

  public resetAllCheat(): void {
    for (const participantId of this.participantIds) this.cheat.set(participantId, false);
    this.cheatEnabledAfterCurrentOff.clear();
  }

  public observeViolation(participantId: string, sourceId: string, reason: string): void {
    this.settleDueStageClosures(this.clock.now());
    this.assertParticipant(participantId);
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || !this.isResultIntakePhase()) return;
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
    this.settleDueStageClosures(this.clock.now());
    this.assertParticipant(participantId);
    if (!this.isStartProtectionSensitive() || this.hasProtectionIneligibleResult(participantId)) return;
    if (!this.startProtectionExhaustedStageIds.has(this.stage.id)) this.triggerStartProtection(participantId, evidence);
    this.bump();
  }

  public setStartProtectionUsed(used: boolean): void {
    this.settleDueStageClosures(this.clock.now());
    if (!this.policy.startProtectionEnabled) throw new Error("START_PROTECTION_DISABLED");
    const changed = used
      ? !this.startProtectionExhaustedStageIds.has(this.stage.id)
      : this.startProtectionUsedStageIds.has(this.stage.id);
    if (!changed) return;
    if (used) {
      this.startProtectionUsedStageIds.add(this.stage.id);
      this.startProtectionExhaustedStageIds.add(this.stage.id);
    } else {
      this.startProtectionUsedStageIds.delete(this.stage.id);
      this.startProtectionExhaustedStageIds.delete(this.stage.id);
    }
    this.bump();
  }

  public observeServerDisconnect(evidence: string): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.incidents.some((incident) => incident.type === "server-disconnect" && incident.status === "open")) return;
    const attempt = this.currentAttempt;
    this.incidents.push({
      id: randomUUID(), type: "server-disconnect", severity: "critical", createdAtMs: this.clock.now(),
      ...(attempt ? { attemptId: attempt.id } : {}), participantIds: [], recommendedRestart: Boolean(attempt), status: "open", evidence
    });
    this.automationEnabled = false;
    if (this.phase !== "incident" && this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "incident";
    this.bump();
  }

  public observeServerConnected(): void {
    this.settleDueStageClosures(this.clock.now());
    let resolved = false;
    for (const incident of this.incidents) {
      if (incident.type === "server-disconnect" && incident.status === "open") {
        incident.status = "resolved";
        resolved = true;
      }
    }
    if (!resolved) return;
    if (this.phase === "incident") this.phase = "paused";
    this.bump();
  }

  public observeTimingDiscontinuity(evidence: string): void {
    this.settleDueStageClosures(this.clock.now());
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
    this.settleDueStageClosures(this.clock.now());
    this.permissionDeniedEvidence = evidence;
    this.automationEnabled = false;
    if (this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "paused";
    this.bump();
  }

  public enable(plannedReadyAtMs = this.clock.now() + this.policy.intermissionMs): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.automationEnabled) return;
    const remainingBlockers = this.startBlockers().filter((blocker) => blocker.code !== "INCIDENT_OPEN");
    if (remainingBlockers.length > 0) throw new Error("AUTOMATION_RESUME_BLOCKED");
    for (const incident of this.incidents) if (incident.status === "open") incident.status = "resolved";
    this.automationEnabled = true;
    if (this.pausedFromPhase) {
      const resumePhase = this.pausedFromPhase;
      if (this.phase === "paused" || this.phase === "incident") {
        if (resumePhase === "lobby") {
          this.phase = "preparing";
          this.planReady(this.stageIndex, plannedReadyAtMs);
        } else this.phase = resumePhase;
      }
      this.pausedFromPhase = undefined;
    } else {
      this.phase = "preparing";
      this.planReady(this.stageIndex, plannedReadyAtMs);
    }
    this.bump();
  }

  public startReadyFlow(): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.effectivePhase() === "running") throw new Error("READY_FLOW_NOT_AVAILABLE");
    const targetStageIndex = this.nextStagePending ? this.stageIndex + 1 : this.stageIndex;
    if (!this.stages[targetStageIndex] || ["countdown", "review", "incident"].includes(this.phase)) throw new Error("READY_FLOW_NOT_AVAILABLE");
    if (this.readyFlowBlockers().length > 0) throw new Error("READY_FLOW_BLOCKED");
    this.automationEnabled = true;
    this.pausedFromPhase = undefined;
    if (this.phase !== "tail-intake") this.phase = this.restartPending ? "restart-preparing" : "preparing";
    this.planReady(targetStageIndex, this.clock.now() + READY_NOTICE_LEAD_MS);
    this.queueDueReadyNotice();
    this.bump();
  }

  public pause(): void {
    this.settleDueStageClosures(this.clock.now());
    if (!this.automationEnabled && this.phase === "paused") return;
    this.automationEnabled = false;
    if (this.phase !== "paused") this.pausedFromPhase = this.phase;
    this.phase = "paused";
    this.bump();
  }

  public resolveUnconfirmedAction(actionId: string, status: "acknowledged" | "failed" | "uncertain" | "referee-confirmed"): void {
    this.settleDueStageClosures(this.clock.now());
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action || (action.status !== "failed" && action.status !== "uncertain")) throw new Error("AUTOMATION_ACTION_NOT_UNCONFIRMED");
    action.status = status;
    if (status === "acknowledged" || status === "referee-confirmed") {
      action.acknowledgedAtMs = this.clock.now();
      if (!action.isolated) {
        if (action.kind === "cheat-off") { this.lastCheatOffAcknowledgedAtMs = this.clock.now(); this.resetAllCheat(); }
        if (status === "acknowledged") this.permissionDeniedEvidence = undefined;
      }
    }
    if ((status === "acknowledged" || status === "referee-confirmed")
      && action.kind === "go"
      && !action.isolated
      && action.stageId === this.commandTargetStage.id) {
      this.startAttemptForStage(action.stageId);
    }
    this.bump();
  }

  public reconcileIsolatedActionOutcome(actionId: string, status: "failed" | "uncertain"): void {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action?.isolated || (action.status !== "cancelled" && action.status !== status)) {
      throw new Error("ISOLATED_ACTION_RECONCILE_NOT_AVAILABLE");
    }
    if (action.status === status) return;
    action.status = status;
    this.bump();
  }

  public tick(): void {
    const now = this.clock.now();
    this.settleDueStageClosures(now);
    if (this.automationEnabled) this.queueDueReadyNotice();
    if (!this.automationEnabled && this.phase !== "ready" && this.phase !== "countdown") return;

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
    if (!this.goActionId) {
      this.goActionId = this.queueAction("go").id;
      this.phase = "countdown";
      this.bump();
    }
  }

  public synchronizeStageBoundary(): void {
    this.settleDueStageClosures(this.clock.now());
  }

  public finish(): void {
    for (const attempt of this.attempts) if (attempt.intakeOpen) this.closeIntake(attempt);
    this.isolateUnfinishedActions();
    this.clearLaunchCycleState();
    this.automationEnabled = false;
    this.phase = "review";
    this.pausedFromPhase = undefined;
    this.bump();
  }

  public observeActionWritten(actionId: string): void {
    if (!this.configuration.nonBlockingCommands) return;
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action || action.status !== "pending" || action.isolated || action.writtenAtMs !== undefined) return;
    action.writtenAtMs = this.clock.now();
    if (action.kind !== "go") {
      action.status = "sent-unconfirmed";
      action.acknowledgedAtMs = action.writtenAtMs;
      if (action.kind === "cheat-off") {
        this.lastCheatOffAcknowledgedAtMs = action.writtenAtMs;
        this.resetAllCheat();
      }
    }
    this.bump();
  }

  public acknowledgeAction(actionId: string, status: "acknowledged" | "failed" | "uncertain" | "cancelled"): void {
    this.settleDueStageClosures(this.clock.now());
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action || (action.status !== "pending" && action.status !== "sent-unconfirmed")) return;
    if (status === "uncertain" && action.writtenAtMs !== undefined) {
      // The transport succeeded. Missing server evidence is advisory; the
      // planned countdown and subsequent Ready steps continue without a retry.
      this.settleWrittenGo(this.clock.now());
      return;
    }
    action.status = status;
    if (status !== "acknowledged") {
      if (this.configuration.nonBlockingCommands && status === "uncertain" && !this.permissionDeniedEvidence) {
        action.status = "sent-unconfirmed";
        action.acknowledgedAtMs ??= this.clock.now();
        this.bump();
        return;
      }
      this.automationEnabled = false;
      if (this.phase !== "paused") this.pausedFromPhase = this.phase;
      this.phase = "paused";
      this.bump();
      return;
    }
    action.acknowledgedAtMs ??= this.clock.now();
    // A successful unrelated command cannot clear a real permission failure.
    if (action.kind === "cheat-off" && action.writtenAtMs === undefined) { this.lastCheatOffAcknowledgedAtMs = this.clock.now(); this.resetAllCheat(); }
    if (action.kind === "go" && action.stageId === this.commandTargetStage.id) this.startAttemptForStage(action.stageId);
    this.bump();
  }

  public observeAuthoritativeGo(stageId = this.stage.id): void {
    this.settleDueStageClosures(this.clock.now());
    const stageIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex < 0) throw new Error("UNKNOWN_STAGE");
    if (stageId !== this.commandTargetStage.id) return;
    if (this.restartPending && !this.isAcknowledged(this.goActionId)) return;
    const current = this.currentAttempt;
    if (current?.stageId === stageId && current.intakeOpen && this.isResultIntakePhase()) return;
    this.startAttemptForStage(stageId);
    this.bump();
  }

  public observeCountdown(value: 3 | 2 | 1): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.currentAttempt?.intakeOpen && this.isResultIntakePhase()) return;
    const goAction = this.actions.find((action) => action.id === this.goActionId);
    if (!goAction
      || goAction.kind !== "go"
      || goAction.status !== "pending"
      || goAction.isolated
      || goAction.stageId !== this.commandTargetStage.id) return;
    this.countdownValue = value;
    if (this.phase !== "countdown") this.phase = "countdown";
    this.bump();
  }

  public recordResult(input: Omit<AutomationResult, "receivedAtMs"> & { stageId: string; receivedAtMs?: number }): "accepted" | RejectedResult["reason"] {
    this.settleDueStageClosures(this.clock.now());
    const receivedAtMs = input.receivedAtMs ?? this.clock.now();
    const currentAttempt = this.currentAttempt;
    const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === input.stageId && !candidate.voided);
    const reject = (reason: RejectedResult["reason"]): RejectedResult["reason"] => {
      this.rejectedResults.push({ stageId: input.stageId, playerId: input.playerId, sourceId: input.sourceId, receivedAtMs, reason });
      this.bump();
      return reason;
    };
    if (!attempt) return reject(currentAttempt ? "wrong-stage" : "no-attempt");
    if (receivedAtMs < attempt.goAtMs) return reject("pre-go");
    const existing = attempt.results.find((result) => result.playerId === input.playerId);
    if (existing?.status === "excluded" && input.status === "finished") {
      if (!attempt.intakeOpen) return reject("intake-closed");
      if (receivedAtMs > attempt.deadlineAtMs) return reject("deadline-passed");
      if (attempt !== currentAttempt || input.stageId !== this.stage.id || !this.isResultIntakePhase()) {
        return reject("wrong-stage");
      }
      if (existing.finishSourceId !== undefined
        || existing.sourceId === input.sourceId
        || attempt.results.some((result) => result.sourceId === input.sourceId || result.finishSourceId === input.sourceId)) {
        return reject("duplicate");
      }
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

  public recordExcludedFinishEvidence(input: {
    attemptId: string;
    stageId: string;
    playerId: string;
    exclusionSourceId: string;
    finishSourceId: string;
    receivedAtMs: number;
  }): "accepted" | RejectedResult["reason"] {
    this.settleDueStageClosures(this.clock.now());
    const reject = (reason: RejectedResult["reason"]): RejectedResult["reason"] => {
      this.rejectedResults.push({
        stageId: input.stageId,
        playerId: input.playerId,
        sourceId: input.finishSourceId,
        receivedAtMs: input.receivedAtMs,
        reason
      });
      this.bump();
      return reason;
    };
    const attempt = this.attempts.find((candidate) =>
      candidate.id === input.attemptId
      && candidate.stageId === input.stageId
      && !candidate.voided);
    if (!attempt) return reject("no-attempt");
    if (input.receivedAtMs < attempt.goAtMs) return reject("pre-go");
    if (input.receivedAtMs > attempt.deadlineAtMs) return reject("deadline-passed");
    if (!attempt.intakeOpen && attempt.intakeClosedAtMs !== input.receivedAtMs) return reject("intake-closed");
    const existing = attempt.results.find((result) =>
      result.playerId === input.playerId
      && result.status === "excluded"
      && result.sourceId === input.exclusionSourceId);
    const sameAtomicReceipt = existing?.receivedAtMs === input.receivedAtMs
      && this.clock.now() === input.receivedAtMs;
    if (!sameAtomicReceipt || !existing) return reject("wrong-stage");
    if (existing.finishSourceId !== undefined
      || existing.sourceId === input.finishSourceId
      || attempt.results.some((result) =>
        result.sourceId === input.finishSourceId || result.finishSourceId === input.finishSourceId)) {
      return reject("duplicate");
    }
    existing.finishSourceId = input.finishSourceId;
    this.bump();
    return "accepted";
  }

  public reschedule(plannedReadyAtMs: number): void {
    this.settleDueStageClosures(this.clock.now());
    if (!Number.isFinite(plannedReadyAtMs)) throw new Error("INVALID_READY_TIME");
    if (this.plannedReadyAtMs === undefined || this.plannedReadyStageIndex === undefined || this.phase === "ready" || this.phase === "countdown" || this.phase === "review") throw new Error("RESCHEDULE_NOT_AVAILABLE");
    if (this.phase !== "tail-intake") this.phase = this.restartPending ? "restart-preparing" : "preparing";
    this.planReady(this.plannedReadyStageIndex, plannedReadyAtMs);
    this.queueDueReadyNotice();
    this.bump();
  }

  public delayReady(milliseconds: number): void {
    this.settleDueStageClosures(this.clock.now());
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
    this.settleDueStageClosures(this.clock.now());
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("INVALID_DEADLINE_EXTENSION");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || (this.phase !== "running" && this.phase !== "tail-intake")) throw new Error("DEADLINE_EXTENSION_NOT_AVAILABLE");
    attempt.deadlineAtMs += milliseconds;
    this.queueAction("notice", `本关时限已延长 ${formatDelay(milliseconds)}`);
    this.bump();
  }

  public rescheduleStageDeadline(deadlineAtMs: number): void {
    this.settleDueStageClosures(this.clock.now());
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= this.clock.now()) throw new Error("INVALID_STAGE_DEADLINE");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen || (this.phase !== "running" && this.phase !== "tail-intake")) throw new Error("DEADLINE_RESCHEDULE_NOT_AVAILABLE");
    attempt.deadlineAtMs = deadlineAtMs;
    this.queueAction("notice", "本关最晚结束时间已改期");
    this.bump();
  }

  public manualReady(): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.effectivePhase() === "running") throw new Error("READY_NOT_AVAILABLE");
    if (["countdown", "running", "review", "incident"].includes(this.phase)) throw new Error("READY_NOT_AVAILABLE");
    if (this.readyFlowBlockers().some((blocker) => blocker.severity === "critical")) throw new Error("READY_BLOCKED");
    this.queueActionForStage("ready", this.commandTargetStage, undefined, true);
    this.bump();
  }

  public manualCheatOff(): void {
    this.settleDueStageClosures(this.clock.now());
    if (["review", "incident"].includes(this.phase)) throw new Error("CHEAT_OFF_NOT_AVAILABLE");
    this.queueActionForStage("cheat-off", this.commandTargetStage, undefined, true);
    this.bump();
  }

  public requestManualGo(): void {
    this.settleDueStageClosures(this.clock.now());
    if (this.effectivePhase() === "running") throw new Error("MANUAL_GO_NOT_AVAILABLE");
    if (["countdown", "running", "review", "incident"].includes(this.phase)) throw new Error("MANUAL_GO_NOT_AVAILABLE");
    const target = this.commandTargetStage;
    if (!this.hasCurrentCheatOffConfirmation(target.id)) throw new Error("MANUAL_GO_CHEAT_OFF_REQUIRED");
    if (this.actions.some((action) => action.status === "pending")) throw new Error("MANUAL_GO_COMMAND_PENDING");
    if (this.readyFlowBlockers().length > 0) throw new Error("MANUAL_GO_BLOCKED");
    this.goActionId = this.queueActionForStage("go", target, undefined, true).id;
    this.phase = "countdown";
    this.bump();
  }

  public markCurrentStageStarted(input: ExpectedCurrentStageInput): ControlledAttempt {
    const now = this.clock.now();
    this.settleDueStageClosures(now);
    this.assertExpectedCurrentStage(input.expectedCurrentStageId);
    if (this.phase === "review") throw new Error("MARK_STAGE_STARTED_NOT_AVAILABLE");
    for (const previous of this.attempts.filter(candidate => candidate.stageId === this.stage.id && !candidate.voided)) {
      previous.voided = true;
      this.closeIntake(previous, now);
    }
    this.isolateUnfinishedActions();
    this.clearOldCycleBlockers();
    this.clearLaunchCycleState();
    const attempt = this.startAttemptForStage(this.stage.id, {
      origin: "referee-marked-started",
      startedAtMs: now,
      announceStart: false,
      applyCheatExclusions: false
    });
    if (!attempt) throw new Error("MARK_STAGE_STARTED_ATTEMPT_EXISTS");
    this.automationEnabled = true;
    this.phase = "running";
    this.pausedFromPhase = undefined;
    this.nextStagePending = false;
    this.restartPending = false;
    this.bump();
    return cloneAttempt(attempt);
  }

  public forceResetCurrentStage(input: ExpectedCurrentStageInput): ForceResetStageResult {
    const now = this.clock.now();
    this.settleDueStageClosures(now);
    this.assertExpectedCurrentStage(input.expectedCurrentStageId);
    const targetStageId = this.stage.id;
    const voidedAttempts = this.attempts.filter((attempt) => attempt.stageId === targetStageId && !attempt.voided);
    for (const attempt of voidedAttempts) {
      attempt.voided = true;
      this.closeIntake(attempt, now);
    }
    this.isolateUnfinishedActions();
    this.clearOldCycleBlockers();
    this.clearLaunchCycleState();
    this.automationEnabled = true;
    this.phase = "preparing";
    this.pausedFromPhase = undefined;
    this.restartPending = true;
    this.nextStagePending = false;
    this.planReady(this.stageIndex, now + READY_NOTICE_LEAD_MS);
    this.queueDueReadyNotice();
    this.bump();
    return {
      targetStageId,
      boundaryAtMs: now,
      voidedAttempts: voidedAttempts.map(cloneAttempt)
    };
  }

  public forceAdvanceToNextStage(input: ExpectedNextStageInput): ForceNextStageResult {
    const now = this.clock.now();
    this.settleDueStageClosures(now);
    this.assertExpectedCurrentStage(input.expectedCurrentStageId);
    if (this.stageIndex >= this.stages.length - 1) {
      throw new Error("FORCE_NEXT_STAGE_NOT_AVAILABLE");
    }
    if (this.stages[this.stageIndex + 1]?.id !== input.expectedTargetStageId) throw new Error("ACTION_TARGET_CHANGED");
    const previousStageId = this.stage.id;
    const previousAttempt = this.currentAttempt;
    if (previousAttempt) this.closeIntake(previousAttempt, now);
    this.isolateUnfinishedActions();
    this.clearOldCycleBlockers();
    this.clearLaunchCycleState();
    this.stageIndex += 1;
    this.automationEnabled = true;
    this.phase = "preparing";
    this.pausedFromPhase = undefined;
    this.restartPending = false;
    this.nextStagePending = false;
    this.planReady(this.stageIndex, now + READY_NOTICE_LEAD_MS);
    this.queueDueReadyNotice();
    this.bump();
    return {
      previousStageId,
      targetStageId: this.stage.id,
      boundaryAtMs: now,
      ...(previousAttempt === undefined ? {} : { closedAttempt: cloneAttempt(previousAttempt) })
    };
  }

  public endStage(reason: string): void {
    this.settleDueStageClosures(this.clock.now());
    if (!reason.trim()) throw new Error("END_STAGE_REASON_REQUIRED");
    const attempt = this.currentAttempt;
    if (!attempt?.intakeOpen) throw new Error("END_STAGE_NOT_AVAILABLE");
    this.closeIntake(attempt);
    if (this.stageIndex === this.stages.length - 1) this.phase = "review";
    else {
      this.nextStagePending = true;
      this.setTailIntakePhase();
      this.planReady(this.stageIndex + 1, this.clock.now() + this.policy.intermissionMs);
    }
    this.bump();
  }

  public issueStageRestartConfirmation(stageId: string, ttlMs = 60_000): { token: string; impactHash: string; expiresAtMs: number } {
    this.settleDueStageClosures(this.clock.now());
    const attempt = this.currentAttempt;
    if (stageId !== this.stage.id) throw new Error("RESTART_NOT_AVAILABLE");
    const impactHash = sha256({
      stageId,
      phase: this.phase,
      attempt: attempt ? { id: attempt.id, results: attempt.results } : null,
      unresolvedActions: this.actions
        .filter((action) => !action.isolated && (action.status === "pending" || action.status === "failed" || action.status === "uncertain"))
        .map((action) => ({ id: action.id, status: action.status })),
      openIncidents: this.incidents.filter((incident) => incident.status === "open").map((incident) => incident.id),
      permissionDenied: Boolean(this.permissionDeniedEvidence)
    });
    const expiresAtMs = this.clock.now() + ttlMs;
    const token = this.tokenService.issue({
      competitionId: this.configuration.competitionId, stageId, attemptId: attempt?.id ?? "",
      stateVersion: this.stateVersion, targetId: stageId, impactHash, expiresAtMs, nonce: randomUUID()
    });
    return { token, impactHash, expiresAtMs };
  }

  public confirmStageRestart(input: { stageId: string; impactHash: string; token: string; reason: string }): void {
    this.settleDueStageClosures(this.clock.now());
    if (!input.reason.trim()) throw new Error("RESTART_REASON_REQUIRED");
    const attempt = this.currentAttempt;
    if (input.stageId !== this.stage.id) throw new Error("RESTART_NOT_AVAILABLE");
    this.tokenService.consume(input.token, {
      competitionId: this.configuration.competitionId, stageId: this.stage.id, attemptId: attempt?.id ?? "",
      stateVersion: this.stateVersion, targetId: this.stage.id, impactHash: input.impactHash
    }, this.clock.now());
    if (attempt) {
      attempt.voided = true;
      this.closeIntake(attempt);
    }
    this.isolateUnfinishedActions();
    this.clearOldCycleBlockers();
    this.clearLaunchCycleState();
    this.automationEnabled = true;
    this.pausedFromPhase = undefined;
    this.restartPending = true;
    this.nextStagePending = false;
    this.enterReady();
  }

  public drainActions(predicate: (action: AutomationAction) => boolean = () => true): readonly AutomationAction[] {
    this.settleDueStageClosures(this.clock.now());
    const result = this.actions.filter((action) => {
      if (!this.undeliveredActionIds.has(action.id) || (action.notBeforeMs !== undefined && this.clock.now() < action.notBeforeMs) || !predicate(action)) return false;
      this.undeliveredActionIds.delete(action.id);
      action.undelivered = false;
      return true;
    });
    return result.map(cloneAction);
  }

  public drainDispatchableActions(): readonly AutomationAction[] {
    return this.drainActions((action) => this.automationEnabled || action.manual === true);
  }

  public snapshot(): AutomationSnapshot {
    return {
      phase: this.phase,
      ...(this.pausedFromPhase === undefined ? {} : { pausedFromPhase: this.pausedFromPhase }),
      stateVersion: this.stateVersion,
      automationEnabled: this.automationEnabled,
      clockNowMs: this.clock.now(),
      wallClockOriginMs: this.wallClockOriginMs,
      currentStageId: this.stage.id,
      ...(this.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: this.plannedReadyAtMs }),
      ...(this.plannedReadyStage === undefined ? {} : { plannedReadyStageId: this.plannedReadyStage.id }),
      ...(this.readyAtMs === undefined ? {} : { readyAtMs: this.readyAtMs }),
      ...(this.waitDeadlineAtMs === undefined ? {} : { waitDeadlineAtMs: this.waitDeadlineAtMs }),
      nextStagePending: this.nextStagePending,
      restartPending: this.restartPending,
      ...(this.lastCheatOffAcknowledgedAtMs === undefined ? {} : { lastCheatOffAcknowledgedAtMs: this.lastCheatOffAcknowledgedAtMs }),
      ...(this.countdownValue === undefined ? {} : { countdownValue: this.countdownValue }),
      blockers: this.startBlockers(),
      waitingParticipants: [...this.waiting],
      absentParticipants: [...this.absent],
      participantStates: [...this.participantIds].map((participantId) => {
        const stableSinceMs = this.stableSince.get(participantId);
        return {
          participantId,
          online: this.online.get(participantId) ?? false,
          cheatEnabled: this.cheat.get(participantId) ?? false,
          ...(stableSinceMs === undefined ? {} : { stableSinceMs }),
          ...(this.cheatEnabledAfterCurrentOff.has(participantId) ? { cheatEnabledAfterCurrentOff: true } : {})
        };
      }),
      cheatWarningSent: this.cheatWarningSent,
      startProtectionEnabled: this.policy.startProtectionEnabled,
      startProtectionUsedStageIds: [...this.startProtectionUsedStageIds],
      startProtectionExhaustedStageIds: [...this.startProtectionExhaustedStageIds],
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
    if (targetStageIndex !== this.stageIndex) {
      const previous = this.currentAttempt;
      if (previous) this.closeIntake(previous);
      this.stageIndex = targetStageIndex;
      this.nextStagePending = false;
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
    const preserveTargetCheatOff = this.hasCurrentCheatOffConfirmation(targetStage.id);
    if (!preserveTargetCheatOff) {
      this.lastCheatOffAcknowledgedAtMs = undefined;
      this.cheatWarningSent = false;
      this.cheatEnabledAfterCurrentOff.clear();
    }
    const readyAction = this.queueAction("ready");
    this.readyActionIds.push(readyAction.id);
    this.readyActionId = readyAction.id;
    this.goActionId = undefined;
    this.bump();
  }

  private enterPlannedStagePreparationIfDue(now: number, effectiveAtMs = now): void {
    if (this.plannedReadyAtMs === undefined || this.plannedReadyStageIndex === undefined) return;
    if (now < this.plannedReadyAtMs - READY_NOTICE_LEAD_MS || this.plannedReadyStageIndex === this.stageIndex) return;
    const targetStage = this.stages[this.plannedReadyStageIndex];
    if (!targetStage) throw new Error("UNKNOWN_READY_STAGE");
    const previousStageId = this.stage.id;
    const preserveTargetCheatOff = this.hasCurrentCheatOffConfirmation(targetStage.id);
    this.cancelUndeliveredStageActions(previousStageId);
    const previousAttempt = this.currentAttempt;
    if (previousAttempt) this.closeIntake(previousAttempt, effectiveAtMs);
    this.stageIndex = this.plannedReadyStageIndex;
    this.nextStagePending = false;
    this.restartPending = false;
    if (this.phase === "paused" || this.phase === "incident") {
      this.pausedFromPhase = "preparing";
    } else this.phase = "preparing";
    this.waiting.clear();
    this.waitDeadlineAtMs = undefined;
    this.readyAtMs = undefined;
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    if (!preserveTargetCheatOff) this.lastCheatOffAcknowledgedAtMs = undefined;
    this.goActionId = undefined;
    this.countdownValue = undefined;
    if (!preserveTargetCheatOff) {
      this.cheatWarningSent = false;
      this.cheatEnabledAfterCurrentOff.clear();
    }
    this.startProtectionSensitiveStageId = undefined;
    this.startProtectionUntilMs = undefined;
    this.bump();
  }

  private settleDueStageClosures(now: number): void {
    this.settleWrittenGo(now);
    const attempt = this.currentAttempt;
    const boundaryAtMs = this.plannedReadyAtMs !== undefined
      && this.plannedReadyStageIndex !== undefined
      && this.plannedReadyStageIndex !== this.stageIndex
      ? this.plannedReadyAtMs - READY_NOTICE_LEAD_MS
      : undefined;
    if (boundaryAtMs !== undefined
      && now >= boundaryAtMs
      && (!attempt?.intakeOpen || boundaryAtMs <= attempt.deadlineAtMs)) {
      this.enterPlannedStagePreparationIfDue(now, boundaryAtMs);
      return;
    }
    if (attempt?.intakeOpen && now >= attempt.deadlineAtMs) this.closeAtDeadline(attempt, attempt.deadlineAtMs);
    if (boundaryAtMs !== undefined && now >= boundaryAtMs) {
      this.enterPlannedStagePreparationIfDue(now, boundaryAtMs);
    } else {
      this.enterPlannedStagePreparationIfDue(now);
    }
  }

  private settleWrittenGo(now: number): void {
    const action = this.actions.findLast((candidate) => candidate.kind === "go"
      && candidate.status === "pending" && candidate.writtenAtMs !== undefined && !candidate.isolated);
    if (!action || action.stageId !== this.commandTargetStage.id || now < action.writtenAtMs! + 3_000) return;
    action.status = "sent-unconfirmed";
    action.acknowledgedAtMs = action.writtenAtMs! + 3_000;
    this.startAttemptForStage(action.stageId, { origin: "command-sent", startedAtMs: action.acknowledgedAtMs });
    this.bump();
  }

  private startAttemptForStage(
    stageId: string,
    options: { origin?: AttemptOrigin; startedAtMs?: number; announceStart?: boolean; applyCheatExclusions?: boolean } = {}
  ): MutableAttempt | undefined {
    const targetStageIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (targetStageIndex < 0) throw new Error("UNKNOWN_STAGE");
    const existing = [...this.attempts].reverse().find((attempt) => attempt.stageId === stageId && !attempt.voided);
    if (existing) return undefined;
    const openAttempt = [...this.attempts].reverse().find((attempt) => attempt.intakeOpen && !attempt.voided);
    if (openAttempt) this.closeIntake(openAttempt);
    this.stageIndex = targetStageIndex;
    this.nextStagePending = false;
    this.plannedReadyAtMs = undefined;
    this.plannedReadyStageIndex = undefined;
    this.noticeActionId = undefined;
    const attemptNumber = this.attempts.filter((attempt) => attempt.stageId === this.stage.id).length + 1;
    const now = options.startedAtMs ?? this.clock.now();
    const attempt: MutableAttempt = {
      id: randomUUID(), stageId: this.stage.id, attemptNumber, origin: options.origin ?? "authoritative-go", goAtMs: now,
      deadlineAtMs: now + this.stage.timeLimitMs, intakeOpen: true, voided: false, results: []
    };
    this.attempts.push(attempt);
    this.phase = "running";
    this.startProtectionSensitiveStageId = this.stage.id;
    this.startProtectionUntilMs = now + this.policy.protectionWindowMs;
    this.countdownValue = undefined;
    this.cheatWarningSent = false;
    this.restartPending = false;
    if (options.applyCheatExclusions ?? true) {
      for (const participantId of this.participantIds) {
        if (this.cheat.get(participantId) && this.lastCheatOffAcknowledgedAtMs !== undefined && this.cheatEnabledAfterCurrentOff.has(participantId)) {
          this.acceptResult(attempt, { playerId: participantId, status: "excluded", sourceId: randomUUID(), receivedAtMs: now, reason: "cheat-enabled" });
        }
      }
    }
    if (options.announceStart ?? true) {
      const stageName = this.stage.displayName ?? `${this.stage.mode.toUpperCase()}${this.stage.map}`;
      const bulletin = this.queueActionForStage("bulletin", this.stage, `${stageName}已起跑`, false);
      bulletin.notBeforeMs = now + 1_000;
    }
    return attempt;
  }

  private acceptResult(attempt: MutableAttempt, result: AutomationResult): void {
    attempt.results.push(result);
    this.evaluateStageCompletion(attempt);
  }

  private evaluateStageCompletion(attempt: MutableAttempt): void {
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
      this.setTailIntakePhase();
      this.planReady(this.stageIndex + 1, this.clock.now() + this.policy.intermissionMs);
    }
  }

  private closeAtDeadline(attempt: MutableAttempt, effectiveAtMs = this.clock.now()): void {
    this.closeIntake(attempt, effectiveAtMs);
    this.queueAction("announce", `${this.stage.map.toUpperCase()} 比赛时间已到`);
    if (this.stageIndex === this.stages.length - 1) this.phase = "review";
    else {
      this.nextStagePending = true;
      this.setTailIntakePhase();
      if (this.plannedReadyAtMs === undefined) this.planReady(this.stageIndex + 1, this.clock.now() + READY_NOTICE_LEAD_MS);
    }
    this.bump();
  }

  private closeIntake(attempt: MutableAttempt, effectiveAtMs = this.clock.now()): void {
    if (!attempt.intakeOpen) return;
    attempt.intakeOpen = false;
    attempt.intakeClosedAtMs = effectiveAtMs;
  }

  private setTailIntakePhase(): void {
    if (this.phase === "paused" || this.phase === "incident") this.pausedFromPhase = "tail-intake";
    else this.phase = "tail-intake";
  }

  private isStartProtectionSensitive(): boolean {
    if (!this.policy.startProtectionEnabled) return false;
    if (this.startProtectionSensitiveStageId !== this.stage.id) return false;
    return this.startProtectionUntilMs === undefined || this.clock.now() <= this.startProtectionUntilMs;
  }

  private hasProtectionIneligibleResult(participantId: string): boolean {
    return this.currentAttempt?.results.some((result) =>
      result.playerId === participantId && (result.status === "dnf" || result.status === "excluded")) ?? false;
  }

  private triggerStartProtection(participantId: string, evidence: string): void {
    const now = this.clock.now();
    const attempt = this.currentAttempt;
    const postGo = Boolean(attempt?.intakeOpen && now <= attempt.goAtMs + this.policy.protectionWindowMs);
    const plannedReadyAtMs = now + READY_NOTICE_LEAD_MS;
    const stage = this.stage;
    if (this.startProtectionUsedStageIds.has(stage.id)) this.startProtectionExhaustedStageIds.add(stage.id);
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
    this.countdownValue = undefined;
    this.readyAtMs = undefined;
    this.waitDeadlineAtMs = undefined;
    this.waiting.clear();
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.goActionId = undefined;
    const protectionMessage = postGo
      ? `由于玩家 ${participantId} 起跑保护期掉线，当前尝试及成绩已作废，本关将在一分钟后重新发令，请做好准备。`
      : `由于玩家 ${participantId} 起跑保护期掉线，发令流程已中止，本关将在一分钟后重新发令，请做好准备。`;
    this.planReady(this.stageIndex, plannedReadyAtMs, protectionMessage);
    this.queueActionForStage("announce", stage, protectionMessage);
    this.queueDueReadyNotice();
  }

  private cancelPendingLaunchActions(stageId: string): void {
    for (const action of this.actions) {
      if (action.stageId !== stageId || action.status !== "pending"
        || !(["ready", "announce", "cheat-off", "go"].includes(action.kind) || action.kind === "bulletin" && action.notBeforeMs !== undefined)) continue;
      action.status = "cancelled";
      this.undeliveredActionIds.delete(action.id);
      action.undelivered = false;
    }
  }

  private isolateUnfinishedActions(predicate: (action: AutomationAction) => boolean = () => true): void {
    for (const action of this.actions) {
      if (!predicate(action) || !["pending", "failed", "uncertain", "sent-unconfirmed"].includes(action.status)) continue;
      this.undeliveredActionIds.delete(action.id);
      action.undelivered = false;
      action.isolated = true;
      if (action.status === "pending") action.status = "cancelled";
    }
  }

  private clearOldCycleBlockers(): void {
    for (const incident of this.incidents) {
      if (incident.status === "open") incident.status = "resolved";
    }
    this.permissionDeniedEvidence = undefined;
  }

  private clearLaunchCycleState(options: { preserveParticipantWaitState?: boolean; preserveStartProtection?: boolean } = {}): void {
    this.plannedReadyAtMs = undefined;
    this.plannedReadyStageIndex = undefined;
    this.noticeActionId = undefined;
    if (!options.preserveParticipantWaitState) {
      this.waiting.clear();
      this.absent.clear();
      this.waitDeadlineAtMs = undefined;
    }
    this.readyAtMs = undefined;
    this.readyActionId = undefined;
    this.readyActionIds.length = 0;
    this.readyAnnouncementActionId = undefined;
    this.cheatOffActionId = undefined;
    this.lastCheatOffAcknowledgedAtMs = undefined;
    this.goActionId = undefined;
    this.countdownValue = undefined;
    this.cheatWarningSent = false;
    this.cheatEnabledAfterCurrentOff.clear();
    if (!options.preserveStartProtection) {
      this.startProtectionSensitiveStageId = undefined;
      this.startProtectionUntilMs = undefined;
    }
  }

  private cancelUndeliveredStageActions(stageId: string): void {
    for (const action of this.actions) {
      const staleStageAction = action.stageId === stageId
        && action.status === "pending"
        && this.undeliveredActionIds.has(action.id)
        && (["bulletin", "notice", "ready", "cheat-off", "go"].includes(action.kind)
          || action.kind === "announce" && action.message === "READY!");
      if (!staleStageAction) continue;
      action.status = "cancelled";
      this.undeliveredActionIds.delete(action.id);
      action.undelivered = false;
    }
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
      undelivered: true,
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
    this.enterPlannedStagePreparationIfDue(this.clock.now());
  }

  private queueBulletin(stage: AutomationStage, plannedReadyAtMs: number, protectionMessage?: string): void {
    const name = stage.displayName ?? `${stage.mode.toUpperCase()}${stage.map}`;
    const protectionContext = protectionMessage ? `\n${protectionMessage}` : "";
    const suffix = this.startProtectionExhaustedStageIds.has(stage.id) ? START_PROTECTION_USED_SUFFIX
      : this.startProtectionUsedStageIds.has(stage.id) ? "\n本关起跑保护剩余 1 次，仅保护 fatal error。" : "";
    this.queueActionForStage("bulletin", stage, `${name} 将在 ${formatUtc8Time(this.wallClockOriginMs + plannedReadyAtMs)} 发令${protectionContext}${suffix}`);
  }

  private queueDueReadyNotice(): void {
    if (this.noticeActionId || this.plannedReadyAtMs === undefined || !this.plannedReadyStage) return;
    if (this.clock.now() < this.plannedReadyAtMs - READY_NOTICE_LEAD_MS) return;
    const stage = this.plannedReadyStage;
    const name = stage.displayName ?? `${stage.mode.toUpperCase()}${stage.map}`;
    const suffix = this.startProtectionExhaustedStageIds.has(stage.id) ? START_PROTECTION_USED_SUFFIX
      : this.startProtectionUsedStageIds.has(stage.id) ? "\n本关起跑保护剩余 1 次，仅保护 fatal error。" : "";
    this.noticeActionId = this.queueActionForStage(
      "notice",
      stage,
      `${name} 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。${suffix}`
    ).id;
  }

  private isAcknowledged(actionId: string | undefined): boolean {
    const status = actionId === undefined ? undefined : this.actions.find((action) => action.id === actionId)?.status;
    return status === "acknowledged" || status === "referee-confirmed" || status === "sent-unconfirmed";
  }

  private actionAcknowledgedAt(actionId: string | undefined): number | undefined {
    if (actionId === undefined) return undefined;
    const action = this.actions.find((candidate) => candidate.id === actionId);
    return this.isAcknowledged(actionId) ? action?.acknowledgedAtMs ?? action?.createdAtMs : undefined;
  }

  private hasCurrentCheatOffConfirmation(stageId: string): boolean {
    const stageActions = this.actions.filter((action) => action.stageId === stageId && !action.isolated);
    const previousGoIndex = stageActions.findLastIndex((action) => action.kind === "go" && this.isAcknowledged(action.id));
    return stageActions.slice(previousGoIndex + 1).some((action) => action.kind === "cheat-off" && this.isAcknowledged(action.id));
  }

  private readyFlowBlockers(): AutomationBlocker[] {
    return this.startBlockers().filter((blocker) => blocker.code !== "PARTICIPANT_CHEAT");
  }

  private startBlockers(): AutomationBlocker[] {
    const blockers: AutomationBlocker[] = [];
    if (this.permissionDeniedEvidence) blockers.push({ code: "PERMISSION_DENIED", severity: "critical", autoRecoverable: false, suggestion: "ContestConsole 权限不足；请在服务器修复权限后重新启动工作运行" });
    if (!this.configuration.nonBlockingCommands && this.actions.some((action) => !action.isolated && (action.status === "failed"
      || action.status === "uncertain" && ["ready", "cheat-off", "go"].includes(action.kind)))) {
      blockers.push({ code: "COMMAND_UNCONFIRMED", severity: "critical", autoRecoverable: false, suggestion: "核对服务器现场与命令审计，禁止自动补发" });
    }
    const openIncident = this.incidents.find((incident) => incident.status === "open");
    if (openIncident) blockers.push({
      code: "INCIDENT_OPEN",
      severity: "critical",
      autoRecoverable: false,
      suggestion: openIncident.type === "server-disconnect"
        ? "恢复 MockClient/服务器连接后继续当前阶段，或由裁判重赛本关"
        : openIncident.type === "timing-discontinuity"
          ? "核对现场与计划时间后恢复自动化；若 Go 结果不确定则先处置命令或重赛"
          : "裁判核对证据后继续或重赛本关"
    });
    return blockers;
  }

  private assertParticipant(participantId: string): void {
    if (!this.participantIds.has(participantId)) throw new Error(`Unknown participant: ${participantId}`);
  }

  private assertExpectedCurrentStage(expectedCurrentStageId: string): void {
    if (this.stage.id !== expectedCurrentStageId) throw new Error("ACTION_TARGET_CHANGED");
  }

  private bump(): void {
    this.stateVersion += 1;
  }
}
