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
}

const formatDelay = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
};

export type AutomationActionKind = "announcement" | "ready" | "cheat-off" | "go" | "force-next-restart";

export interface AutomationAction {
  id: string;
  kind: AutomationActionKind;
  idempotencyKey: string;
  createdAtMs: number;
  stageId: string;
  map: string;
  mode: "sr" | "hs";
  message?: string;
  status: "pending" | "acknowledged" | "failed" | "uncertain";
}

export interface AutomationBlocker {
  code: "AUTOMATION_PAUSED" | "PARTICIPANT_OFFLINE" | "PARTICIPANT_CHEAT" | "COMMAND_UNCONFIRMED" | "INCIDENT_OPEN";
  severity: "warning" | "critical";
  autoRecoverable: boolean;
  participantId?: string;
  suggestion: string;
}

export interface AutomationResult {
  playerId: string;
  status: "finished" | "dnf";
  sourceId: string;
  receivedAtMs: number;
  reason?: string;
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
  stateVersion: number;
  automationEnabled: boolean;
  currentStageId: string;
  plannedReadyAtMs?: number;
  blockers: readonly AutomationBlocker[];
  waitingParticipants: readonly string[];
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
  incidentId: string;
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
  private readonly actions: AutomationAction[] = [];
  private readonly undeliveredActionIds = new Set<string>();
  private readonly attempts: MutableAttempt[] = [];
  private readonly incidents: MutableIncident[] = [];
  private readonly rejectedResults: RejectedResult[] = [];
  private readonly tokenService: RestartConfirmationTokens;
  private readonly policy: AutomationPolicy;
  private phase: AutomationPhase = "lobby";
  private stateVersion = 0;
  private automationEnabled = false;
  private stageIndex = 0;
  private plannedReadyAtMs: number | undefined;
  private readyAtMs: number | undefined;
  private waitDeadlineAtMs: number | undefined;
  private nextStagePending = false;
  private restartPending = false;
  private readyActionId: string | undefined;
  private cheatOffActionId: string | undefined;
  private forceRestartActionId: string | undefined;
  private goActionId: string | undefined;

  public constructor(private readonly configuration: AutomationConfiguration, private readonly clock: MonotonicClock) {
    if (configuration.stages.length === 0) throw new Error("At least one stage is required");
    if (configuration.participants.length === 0 && !configuration.dynamicParticipants) throw new Error("At least one participant is required");
    this.stages = configuration.stages.map((stage) => ({ ...stage }));
    this.participantIds = new Set(configuration.participants);
    if (this.participantIds.size !== configuration.participants.length) throw new Error("Participant IDs must be unique");
    this.policy = { ...defaults(this.participantIds.size), ...configuration.policy };
    if (this.policy.groupDisconnectThreshold < 1) throw new Error("Group disconnect threshold must be positive");
    this.tokenService = new RestartConfirmationTokens(configuration.confirmationSecret ?? randomUUID());
    for (const participantId of this.participantIds) {
      this.online.set(participantId, false);
      this.cheat.set(participantId, false);
    }
  }

  private get stage(): AutomationStage {
    return this.stages[this.stageIndex] as AutomationStage;
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

    if (this.phase === "ready" || this.phase === "countdown" || this.phase === "preparing" || this.phase === "restart-preparing" || this.phase === "pre-start-wait") {
      if (!online) {
        this.waiting.add(participantId);
        this.waitDeadlineAtMs ??= this.clock.now() + this.policy.preStartWaitLimitMs;
        this.phase = "pre-start-wait";
        this.readyAtMs = undefined;
        this.readyActionId = undefined;
        this.cheatOffActionId = undefined;
        this.goActionId = undefined;
        this.queueAction("announcement", `等待 ${participantId} 重连`);
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
    const attempt = this.currentAttempt;
    if (enabled && attempt?.intakeOpen && (this.phase === "running" || this.phase === "tail-intake") && !attempt.results.some((result) => result.playerId === participantId)) {
      this.acceptResult(attempt, { playerId: participantId, status: "dnf", sourceId, receivedAtMs: this.clock.now(), reason: "cheat-enabled" });
      this.incidents.push({
        id: randomUUID(), type: "cheat-violation", severity: "high", createdAtMs: this.clock.now(), attemptId: attempt.id,
        participantIds: [participantId], recommendedRestart: false, status: "open", evidence: `cheat ${previous ? "on" : "off"} -> on`
      });
    }
    this.bump();
  }

  public observeCrash(participantId: string, evidence: string): void {
    this.assertParticipant(participantId);
    const attempt = this.currentAttempt;
    if (!attempt || !attempt.intakeOpen) return;
    if (this.clock.now() - attempt.goAtMs <= this.policy.protectionWindowMs) {
      this.openRestartIncident("protected-crash", [participantId], evidence);
      this.bump();
    }
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
    this.phase = "paused";
    this.bump();
  }

  public enable(plannedReadyAtMs = this.clock.now() + this.policy.announcementLeadMs): void {
    if (this.automationEnabled) return;
    this.automationEnabled = true;
    this.phase = "preparing";
    this.plannedReadyAtMs = plannedReadyAtMs;
    this.queueAction("announcement", `${this.stage.map.toUpperCase()} ${this.stage.mode.toUpperCase()} 将于计划时间开始`);
    this.bump();
  }

  public pause(): void {
    if (!this.automationEnabled) return;
    this.automationEnabled = false;
    this.phase = "paused";
    this.bump();
  }

  public tick(): void {
    const now = this.clock.now();
    const attempt = this.currentAttempt;
    if (attempt?.intakeOpen && now >= attempt.deadlineAtMs) this.closeAtDeadline(attempt);
    if (!this.automationEnabled) return;

    if (this.phase === "pre-start-wait") {
      const allStable = [...this.waiting].every((participantId) =>
        this.online.get(participantId) && now - (this.stableSince.get(participantId) ?? now) >= this.policy.reconnectStableMs);
      if (allStable) {
        this.waiting.clear();
        this.waitDeadlineAtMs = undefined;
        this.phase = this.restartPending ? "restart-preparing" : "preparing";
        this.plannedReadyAtMs = now;
      } else if (this.waitDeadlineAtMs !== undefined && now >= this.waitDeadlineAtMs) {
        for (const participantId of this.waiting) {
          if (this.policy.preStartTimeoutPolicy === "absent") this.absent.add(participantId);
        }
        this.waiting.clear();
        this.waitDeadlineAtMs = undefined;
        this.phase = this.restartPending ? "restart-preparing" : "preparing";
        this.plannedReadyAtMs = now;
      } else return;
    }

    if (this.phase === "tail-intake" && this.nextStagePending && this.plannedReadyAtMs !== undefined && now >= this.plannedReadyAtMs) {
      if (this.startBlockers().length > 0) return;
      this.enterReady(true);
      return;
    }
    if ((this.phase === "preparing" || this.phase === "restart-preparing") && this.plannedReadyAtMs !== undefined && now >= this.plannedReadyAtMs) {
      if (this.startBlockers().length > 0) return;
      this.enterReady(false);
      return;
    }
    if (this.phase !== "ready" || this.readyAtMs === undefined || now < this.readyAtMs + this.policy.readyBufferMs) return;
    if (this.startBlockers().length > 0 || !this.isAcknowledged(this.readyActionId) || !this.isAcknowledged(this.cheatOffActionId)) return;
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
      this.phase = "paused";
      this.bump();
      return;
    }
    if (action.kind === "go" && this.phase !== "running") this.startAttempt();
    this.bump();
  }

  public observeAuthoritativeGo(stageId = this.stage.id): void {
    const stageIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (stageIndex < 0) throw new Error("UNKNOWN_STAGE");
    const current = this.currentAttempt;
    if (current?.stageId === stageId && current.intakeOpen && this.phase === "running") return;
    if (current?.intakeOpen) this.closeIntake(current);
    this.stageIndex = stageIndex;
    this.startAttempt();
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
    if (attempt.results.some((result) => result.playerId === input.playerId || result.sourceId === input.sourceId)) return reject("duplicate");
    if (!attempt.intakeOpen) return reject("intake-closed");
    if (receivedAtMs > attempt.deadlineAtMs) return reject("deadline-passed");
    this.assertParticipant(input.playerId);
    this.acceptResult(attempt, {
      playerId: input.playerId, status: input.status, sourceId: input.sourceId, receivedAtMs,
      ...(input.reason === undefined ? {} : { reason: input.reason })
    });
    this.bump();
    return "accepted";
  }

  public reschedule(plannedReadyAtMs: number): void {
    if (!Number.isFinite(plannedReadyAtMs)) throw new Error("INVALID_READY_TIME");
    if (this.phase === "running" || this.phase === "tail-intake" || this.phase === "review") throw new Error("RESCHEDULE_NOT_AVAILABLE");
    this.automationEnabled = true;
    this.phase = this.restartPending ? "restart-preparing" : "preparing";
    this.plannedReadyAtMs = plannedReadyAtMs;
    this.bump();
  }

  public extendWait(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("INVALID_WAIT_EXTENSION");
    if (this.phase === "pre-start-wait" && this.waitDeadlineAtMs !== undefined) this.waitDeadlineAtMs += milliseconds;
    else if (this.plannedReadyAtMs !== undefined) this.plannedReadyAtMs += milliseconds;
    else throw new Error("WAIT_EXTENSION_NOT_AVAILABLE");
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
      this.plannedReadyAtMs = this.clock.now() + this.policy.intermissionMs;
      this.phase = "tail-intake";
    }
    this.bump();
  }

  public voidAttempt(attemptId: string): void {
    const attempt = this.attempts.find((candidate) => candidate.id === attemptId && !candidate.voided);
    if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
    attempt.voided = true;
    this.closeIntake(attempt);
    this.automationEnabled = false;
    this.phase = "paused";
    this.bump();
  }

  public restoreAttempt(attemptId: string): void {
    const attempt = this.attempts.find((candidate) => candidate.id === attemptId && candidate.voided);
    if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
    if (this.attempts.some((candidate) => candidate.id !== attemptId && candidate.stageId === attempt.stageId && !candidate.voided)) {
      throw new Error("ATTEMPT_RESTORE_CONFLICT");
    }
    attempt.voided = false;
    this.phase = "review";
    this.bump();
  }

  public issueRestartConfirmation(incidentId: string, ttlMs = 60_000): { token: string; impactHash: string; expiresAtMs: number } {
    const incident = this.incidents.find((candidate) => candidate.id === incidentId && candidate.status === "open");
    const attempt = this.currentAttempt;
    if (!incident?.recommendedRestart || !attempt || incident.attemptId !== attempt.id) throw new Error("RESTART_NOT_AVAILABLE");
    const impactHash = sha256({ attemptId: attempt.id, stageId: attempt.stageId, results: attempt.results });
    const expiresAtMs = this.clock.now() + ttlMs;
    const token = this.tokenService.issue({
      competitionId: this.configuration.competitionId, stageId: this.stage.id, attemptId: attempt.id,
      stateVersion: this.stateVersion, incidentId, impactHash, expiresAtMs, nonce: randomUUID()
    });
    return { token, impactHash, expiresAtMs };
  }

  public confirmRestart(input: { incidentId: string; impactHash: string; token: string; reason: string }): void {
    if (!input.reason.trim()) throw new Error("RESTART_REASON_REQUIRED");
    const incident = this.incidents.find((candidate) => candidate.id === input.incidentId && candidate.status === "open");
    const attempt = this.currentAttempt;
    if (!incident?.recommendedRestart || !attempt) throw new Error("RESTART_NOT_AVAILABLE");
    this.tokenService.consume(input.token, {
      competitionId: this.configuration.competitionId, stageId: this.stage.id, attemptId: attempt.id,
      stateVersion: this.stateVersion, incidentId: input.incidentId, impactHash: input.impactHash
    }, this.clock.now());
    attempt.voided = true;
    this.closeIntake(attempt);
    incident.status = "resolved";
    this.automationEnabled = true;
    this.phase = "restart-preparing";
    this.restartPending = true;
    this.plannedReadyAtMs = this.clock.now();
    this.readyActionId = undefined;
    this.cheatOffActionId = undefined;
    this.forceRestartActionId = undefined;
    this.goActionId = undefined;
    this.queueAction("announcement", `本轮将重赛：${input.reason.trim()}`);
    this.bump();
  }

  public drainActions(): readonly AutomationAction[] {
    const result = this.actions.filter((action) => this.undeliveredActionIds.delete(action.id));
    return result.map(cloneAction);
  }

  public snapshot(): AutomationSnapshot {
    return {
      phase: this.phase,
      stateVersion: this.stateVersion,
      automationEnabled: this.automationEnabled,
      currentStageId: this.stage.id,
      ...(this.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: this.plannedReadyAtMs }),
      blockers: this.startBlockers(),
      waitingParticipants: [...this.waiting],
      attempts: this.attempts.map(cloneAttempt),
      incidents: this.incidents.map(cloneIncident),
      rejectedResults: this.rejectedResults.map((result) => ({ ...result })),
      actions: this.actions.map(cloneAction)
    };
  }

  private enterReady(advanceStage: boolean): void {
    if (advanceStage) {
      const previous = this.currentAttempt;
      if (previous) this.closeIntake(previous);
      this.stageIndex += 1;
      this.nextStagePending = false;
    }
    this.phase = "ready";
    this.readyAtMs = this.clock.now();
    this.plannedReadyAtMs = undefined;
    this.readyActionId = this.queueAction("ready").id;
    this.cheatOffActionId = this.queueAction("cheat-off").id;
    this.goActionId = undefined;
    this.bump();
  }

  private startAttempt(): void {
    const attemptNumber = this.attempts.filter((attempt) => attempt.stageId === this.stage.id).length + 1;
    const now = this.clock.now();
    this.attempts.push({
      id: randomUUID(), stageId: this.stage.id, attemptNumber, goAtMs: now,
      deadlineAtMs: now + this.stage.timeLimitMs, intakeOpen: true, voided: false, results: []
    });
    this.phase = "running";
    this.restartPending = false;
    this.forceRestartActionId = undefined;
    this.disconnectedDuringAttempt.clear();
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
      this.plannedReadyAtMs = this.clock.now() + this.policy.intermissionMs;
      this.phase = "tail-intake";
      this.queueAction("announcement", `下一轮 Ready 计划在 ${formatDelay(this.policy.intermissionMs)}后执行`);
    }
  }

  private closeAtDeadline(attempt: MutableAttempt): void {
    for (const participantId of this.participantIds) {
      if (!this.absent.has(participantId) && !attempt.results.some((result) => result.playerId === participantId)) {
        attempt.results.push({ playerId: participantId, status: "dnf", sourceId: `deadline:${attempt.id}:${participantId}`, receivedAtMs: this.clock.now(), reason: "time-limit" });
      }
    }
    this.closeIntake(attempt);
    if (this.stageIndex === this.stages.length - 1) this.phase = "review";
    else {
      this.nextStagePending = true;
      this.plannedReadyAtMs ??= this.clock.now();
      this.phase = "tail-intake";
    }
    this.bump();
  }

  private closeIntake(attempt: MutableAttempt): void {
    if (!attempt.intakeOpen) return;
    attempt.intakeOpen = false;
    attempt.intakeClosedAtMs = this.clock.now();
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
    const action: AutomationAction = {
      id: randomUUID(), kind, idempotencyKey: `${this.configuration.competitionId}:${this.stage.id}:${kind}:${this.stateVersion + 1}`,
      createdAtMs: this.clock.now(), stageId: this.stage.id, map: this.stage.map, mode: this.stage.mode,
      ...(message === undefined ? {} : { message }), status: "pending"
    };
    this.actions.push(action);
    this.undeliveredActionIds.add(action.id);
    return action;
  }

  private isAcknowledged(actionId: string | undefined): boolean {
    return actionId !== undefined && this.actions.find((action) => action.id === actionId)?.status === "acknowledged";
  }

  private startBlockers(): AutomationBlocker[] {
    const blockers: AutomationBlocker[] = [];
    if (!this.automationEnabled) blockers.push({ code: "AUTOMATION_PAUSED", severity: "critical", autoRecoverable: false, suggestion: "由裁判核对现场后恢复自动化" });
    for (const participantId of this.participantIds) {
      if (this.absent.has(participantId)) continue;
      if (!this.online.get(participantId)) blockers.push({ code: "PARTICIPANT_OFFLINE", severity: "warning", autoRecoverable: true, participantId, suggestion: "等待选手重连并保持稳定在线" });
      if (this.cheat.get(participantId)) blockers.push({ code: "PARTICIPANT_CHEAT", severity: "critical", autoRecoverable: true, participantId, suggestion: "关闭该选手 cheat 后重新检查" });
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
