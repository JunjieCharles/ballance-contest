import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CONTEST_REFEREE_NAME,
  stageCommandTarget,
  stageDisplayName,
  stageMapKind,
  type ActionAvailability,
  type AttentionItem,
  type CommandRecordView,
  type CompetitionConfig,
  type ParticipantView,
  type RawClientLogLine,
  type RuntimeSnapshot,
  type ScenarioDefinition,
  type ScenarioEvent,
  type StageConfig,
  type WorkConnectionView,
  type WorkRecoveryStep
} from "@ballance/contracts";
import {
  CompetitionController,
  CompetitionEngine,
  parseLogLine,
  type AutomationAction,
  type AutomationSnapshot,
  type DomainEvent,
  type EngineSnapshot,
  type ScoreboardVersion
} from "@ballance/core";
import { WorkAutomationRuntime } from "./automation-runtime.js";
import { CommandQueue, type CommandAction, type CommandRecord } from "./command-queue.js";
import type { EventJournal } from "./event-journal.js";
import { ManagedMockClient, readMockClientVersion, resolveMockClientUuid, type CommandTransport } from "./mock-client.js";
import {
  automationPolicyFor,
  automationView,
  plannedReadyAt,
  plannedStageStartAt,
  serverLeaseKey,
  stageDeadlineAt,
  SystemMonotonicClock,
  utcOffsetMinutes
} from "./runtime-shared.js";
import type { ServiceSnapshotPayload } from "./runtime-types.js";
import { ServiceError } from "./service-error.js";

export interface WorkRuntime {
  competitionId: string;
  server: string;
  controller: CompetitionController;
  engine: CompetitionEngine;
  commands: CommandQueue;
  commandObservationGeneration: number;
  runtime: WorkAutomationRuntime;
  client?: ManagedMockClient;
  mockClientVersion?: string;
  initialListTimer?: ReturnType<typeof setTimeout>;
  listTimer?: ReturnType<typeof setInterval>;
  automationTimer?: ReturnType<typeof setInterval>;
  automationDispatching?: boolean;
  refereeConnectionId?: string;
  lastRefereeConnectionId?: string;
  listReconciliation?: ListReconciliation;
  mapEchoPrefixes: Map<string, string>;
  mapRegistration?: { processGeneration: number; connectionGeneration: number; promise: Promise<void> };
  mapRegistrationAttemptedProcessGeneration?: number;
  registeredMapsProcessGeneration?: number;
  participantStageId: string;
  connection: WorkConnectionView;
  connectionAttempt?: ConnectionAttempt;
  authenticationDelayTimer?: ReturnType<typeof setTimeout>;
  recovery?: { id: string; kind: "automatic" | "soft" | "hard"; promise: Promise<void> };
  listNoEchoRecovery?: { attempted: boolean };
  disposed?: boolean;
}

interface ListResult {
  expected: number;
  seen: number;
  onlinePlayerIds: Set<string>;
  refereeConnectionIds: Set<string>;
  refereeConnectionCount: number;
  listedPlayers: Map<string, ListedPlayer>;
}

interface ListedPlayer {
  playerName: string;
  connectionId: string;
  cheat: boolean;
  sourceId: string;
}

interface ListReconciliation {
  purpose: "authentication" | "participant";
  connectionGeneration: number;
  protocolStyle?: "legacy" | "modern";
  summarySeen?: boolean;
  expected?: number;
  seen: number;
  spectatorCount: number;
  connectionIds: Set<string>;
  onlinePlayerIds: Set<string>;
  refereeConnectionIds: Set<string>;
  refereeConnectionCount: number;
  listedPlayers: Map<string, ListedPlayer>;
  completion?: Promise<ListResult>;
  resolve?: (result: ListResult) => void;
  reject?: (error: Error) => void;
  settled?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  settleTimer?: ReturnType<typeof setTimeout>;
}

interface ConnectionAttempt {
  processGeneration: number;
  connectionGeneration: number;
  queueGeneration: number;
  previousRefereeConnectionId?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  settled: boolean;
  authenticationScheduled: boolean;
  mapRegistrationPromise?: Promise<void>;
}

export interface WorkRuntimeManagerDependencies {
  createClient?: (options: ConstructorParameters<typeof ManagedMockClient>[0]) => ManagedMockClient;
  authenticationRejectWindowMs?: number;
  connectionTimeoutMs?: number;
  gracefulStopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  recoveryCooldownMs?: number;
  commandTimeoutMs?: number | ((action: CommandAction) => number);
  listSettleDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkRuntimeHost {
  getCompetition(competitionId: string): { id: string; mode: "work" | "test"; status: string; stateVersion: number };
  getDraftConfig(competitionId: string): CompetitionConfig;
  getPublishedConfig(competitionId: string): CompetitionConfig | undefined;
  getOperationalConfig(competitionId: string): CompetitionConfig;
  getPayload(competitionId: string): ServiceSnapshotPayload;
  savePayload(competitionId: string, payload: ServiceSnapshotPayload): void;
  upsertConfig(competitionId: string, version: number, immutable: boolean, config: CompetitionConfig): void;
  assertActionAvailable(competitionId: string, action: "start-work", snapshot?: AutomationSnapshot): void;
  appendRawLog(competitionId: string, source: RawClientLogLine["source"], line: string, occurredAt?: string): void;
  appendAttention(competitionId: string, item: AttentionItem): void;
  recordAutomationAttention(competitionId: string, action: AutomationAction): void;
  recordExclusionAttention(competitionId: string, stageId: string, playerId: string, sourceId: string, reason: string): void;
  completeCompetitionOnReview(competitionId: string, snapshot: AutomationSnapshot): void;
  saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void;
  recordCommand(competitionId: string, record: CommandRecord): void;
  commandHistory(competitionId: string): CommandRecordView[];
  availableActionsFor(competitionId: string, snapshot?: AutomationSnapshot): ActionAvailability[];
  unconfirmedCommandsFor(competitionId: string, snapshot?: AutomationSnapshot): RuntimeSnapshot["unconfirmedCommands"];
  observationGapsFor(competitionId: string): RuntimeSnapshot["observationGaps"];
  prepareAutomationSnapshot(competitionId: string, targetWallClockOriginMs: number): AutomationSnapshot | undefined;
  restoredEngineSnapshot(competitionId: string, automation: AutomationSnapshot): EngineSnapshot | undefined;
  attentionItemsFor(competitionId: string, snapshot?: AutomationSnapshot): AttentionItem[];
  journal: EventJournal;
  dataRoot: string;
}

const serverWindowsRoot = (): string => resolve(process.cwd(), "server-windows");
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_AUTHENTICATION_REJECT_WINDOW_MS = 1_000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_LIST_SETTLE_DELAY_MS = 300;
export const DEFAULT_RECOVERY_COOLDOWN_MS = 20_000;

class StaleConnectionGenerationError extends Error {}
class MapRegistrationPermissionError extends Error {}
class MapRegistrationRequiresRestartError extends Error {}

export class WorkRuntimeManager {
  private readonly runtimes = new Map<string, WorkRuntime>();
  private readonly managedShutdowns = new WeakMap<ManagedMockClient, Promise<void>>();
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly host: WorkRuntimeHost,
    private readonly dependencies: WorkRuntimeManagerDependencies = {}
  ) {}

  public start(competitionId: string): RuntimeSnapshot {
    if (this.closePromise) throw new ServiceError("STATE_CONFLICT", "服务正在关闭，不能启动新的工作运行", 409);
    const competition = this.host.getCompetition(competitionId);
    if (competition.mode !== "work") throw new ServiceError("CAPABILITY_UNSUPPORTED", "测试模式不支持真实 MockClient", 409);
    const config = this.host.getOperationalConfig(competitionId);
    const existing = this.runtimes.get(competitionId);
    if (existing) return this.view(existing);
    this.host.assertActionAvailable(competitionId, "start-work");
    this.assertServerLeaseAvailable(competitionId, config.server);
    const executable = resolve(serverWindowsRoot(), "BallanceMMOMockClient.exe");
    if (!existsSync(executable)) throw new ServiceError("MOCK_CLIENT_MISSING", "未找到 BallanceMMOMockClient.exe", 500, { executable });
    const root = join(resolve(this.host.dataRoot), "work", competitionId);
    const logPath = join(root, "logs", "mockclient.log");
    mkdirSync(join(root, "logs"), { recursive: true });
    const mockClientVersion = readMockClientVersion(executable, serverWindowsRoot());
    const client = this.createManagedClient(config, executable, logPath);
    const runtime = this.makeRuntime(competitionId, config, client, mockClientVersion);
    this.runtimes.set(competitionId, runtime);
    const connectionAttempt = this.beginConnectionAttempt(runtime, client, true, "connecting");
    this.bindManagedClient(runtime, client, connectionAttempt.processGeneration);
    void connectionAttempt.promise.catch((error: unknown) => {
      if (this.runtimes.get(competitionId) !== runtime || runtime.connectionAttempt !== connectionAttempt || runtime.recovery) return;
      if (error instanceof MapRegistrationPermissionError) {
        this.markConnectionBlocked(runtime, error.message, "automatic");
        return;
      }
      this.handleUnexpectedDisconnect(runtime, error instanceof Error ? error.message : "比赛连接认证失败");
    });
    try {
      client.start();
    } catch (error) {
      this.rejectConnectionAttempt(runtime, error instanceof Error ? error : new Error(String(error)));
      this.runtimes.delete(competitionId);
      throw error;
    }
    this.startRealtime(runtime);
    this.saveSnapshot(runtime);
    this.host.journal.append({ type: "work.started", competitionId, data: { mockClientVersion } });
    return this.view(runtime);
  }

  public assertServerLeaseAvailable(competitionId: string, server: string): void {
    for (const [otherCompetitionId, running] of this.runtimes) {
      if (otherCompetitionId === competitionId) continue;
      if (serverLeaseKey(running.server) === serverLeaseKey(server)) {
        throw new ServiceError("STATE_CONFLICT", `服务器 ${server} 已有比赛连接`, 409, {
          server,
          blockingCompetitionId: otherCompetitionId
        });
      }
    }
  }

  public async reconnectClient(competitionId: string): Promise<RuntimeSnapshot> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
    await runtime.connectionAttempt?.mapRegistrationPromise;
    const disconnectFirst = runtime.connection.status === "healthy";
    await this.runRecovery(runtime, "soft", async () => this.performSoftReconnect(runtime, disconnectFirst));
    this.host.journal.append({ type: "work.mock-client-reconnected", competitionId, data: { server: runtime.server, source: "manual" } });
    return this.view(runtime);
  }

  public async restartClient(competitionId: string): Promise<RuntimeSnapshot> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
    await this.runRecovery(runtime, "hard", async () => this.performHardRestart(runtime));
    this.host.journal.append({ type: "work.mock-client-restarted", competitionId, data: { server: runtime.server, source: "manual" } });
    return this.view(runtime);
  }

  public view(runtime: WorkRuntime): RuntimeSnapshot {
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.host.commandHistory(runtime.competitionId), plannedStageStartAt(snapshot, origin), plannedReadyAt(snapshot, origin), undefined,
      this.host.availableActionsFor(runtime.competitionId, snapshot), this.host.attentionItemsFor(runtime.competitionId, snapshot), stageDeadlineAt(snapshot, origin),
      this.host.unconfirmedCommandsFor(runtime.competitionId, snapshot), this.host.observationGapsFor(runtime.competitionId), runtime.connection);
  }

  public get(competitionId: string): WorkRuntime | undefined { return this.runtimes.get(competitionId); }
  public has(competitionId: string): boolean { return this.runtimes.has(competitionId); }
  public entries(): IterableIterator<[string, WorkRuntime]> { return this.runtimes.entries(); }

  public requireHealthy(competitionId: string): WorkRuntime {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
    if (runtime.connection.status !== "healthy") {
      throw new ServiceError("ACTION_UNAVAILABLE", `比赛连接当前为 ${runtime.connection.status}，仅 healthy 状态允许发送现场命令`, 409, {
        connection: runtime.connection
      });
    }
    if (!this.businessCommandsReady(runtime)) {
      throw new ServiceError("ACTION_UNAVAILABLE", "比赛连接身份已确认，正在完成当前 MockClient 进程的地图注册；完成前普通现场命令保持冻结", 409, {
        connection: runtime.connection
      });
    }
    return runtime;
  }

  public businessCommandsReady(runtime: WorkRuntime): boolean {
    return runtime.connection.status === "healthy"
      && (runtime.client === undefined
        || runtime.registeredMapsProcessGeneration === runtime.connection.processGeneration)
      && runtime.mapRegistration === undefined;
  }

  public makeRuntime(competitionId: string, config: CompetitionConfig, transport: CommandTransport, mockClientVersion?: string): WorkRuntime {
    const definition = this.configToScenarioDefinition(config);
    const wallClockOriginMs = Date.now() - performance.now();
    const initialSnapshot = this.host.getPayload(competitionId).work?.started
      ? this.host.prepareAutomationSnapshot(competitionId, wallClockOriginMs)
      : undefined;
    const controller = new CompetitionController({
      competitionId,
      participants: definition.players.map((player) => player.id),
      dynamicParticipants: true,
      stages: definition.stages.map((stage) => {
        const configured = config.stages.find((candidate) => candidate.id === stage.id) as StageConfig;
        return {
          id: stage.id,
          map: stageCommandTarget(configured),
          displayName: stageDisplayName(configured),
          mode: stage.mode.toLowerCase() as "sr" | "hs",
          timeLimitMs: stage.timeLimitMs,
          minimumScoringPlace: stage.minimumScoringPlace
        };
      }),
      policy: automationPolicyFor(config),
      wallClockOriginMs,
      ...(this.host.getPayload(competitionId).work?.automation?.startProtectionUsedStageIds === undefined
        ? {}
        : { startProtectionUsedStageIds: this.host.getPayload(competitionId).work?.automation?.startProtectionUsedStageIds }),
      ...(initialSnapshot === undefined ? {} : { initialSnapshot })
    }, new SystemMonotonicClock());
    if (initialSnapshot && !["review", "lobby"].includes(initialSnapshot.phase)) controller.pause();
    const commands = new CommandQueue(
      transport,
      this.dependencies.commandTimeoutMs ?? ((action) => action.type === "go" ? 15_000 : 10_000),
      (record) => this.host.recordCommand(competitionId, record)
    );
    const engine = new CompetitionEngine(definition);
    const restoredEngine = initialSnapshot ? this.host.restoredEngineSnapshot(competitionId, initialSnapshot) : undefined;
    if (restoredEngine) engine.restore(restoredEngine);
    const persistedConnection = this.host.getPayload(competitionId).work?.connection;
    const runtime: WorkRuntime = {
      competitionId,
      server: config.server,
      controller,
      engine,
      commands,
      commandObservationGeneration: commands.generation,
      runtime: new WorkAutomationRuntime(controller, commands),
      connection: transport instanceof ManagedMockClient
        ? {
            status: "connecting",
            processGeneration: persistedConnection?.processGeneration ?? 0,
            connectionGeneration: persistedConnection?.connectionGeneration ?? 0
          }
        : {
            status: "healthy",
            processGeneration: persistedConnection?.processGeneration ?? 0,
            connectionGeneration: persistedConnection?.connectionGeneration ?? 0,
            ...(persistedConnection?.refereeConnectionId === undefined ? {} : { refereeConnectionId: persistedConnection.refereeConnectionId })
          },
      mapEchoPrefixes: new Map(Object.entries(this.host.getPayload(competitionId).work?.mapEchoPrefixes ?? {})),
      participantStageId: this.host.getPayload(competitionId).work?.participantStageId ?? controller.snapshot().currentStageId,
      ...(persistedConnection?.refereeConnectionId === undefined ? {} : { lastRefereeConnectionId: persistedConnection.refereeConnectionId }),
      ...(mockClientVersion === undefined ? {} : { mockClientVersion }),
      ...(transport instanceof ManagedMockClient ? { client: transport } : {})
    };
    this.mirrorClosedAttempts(runtime);
    return runtime;
  }

  public register(competitionId: string, runtime: WorkRuntime): void { this.runtimes.set(competitionId, runtime); }

  private createManagedClient(config: CompetitionConfig, executable: string, logPath: string): ManagedMockClient {
    const options = {
      executable,
      workingDirectory: serverWindowsRoot(),
      server: config.server,
      refereeName: config.refereeName,
      uuid: resolveMockClientUuid(serverWindowsRoot(), randomUUID()),
      logPath
    };
    return this.dependencies.createClient?.(options) ?? new ManagedMockClient(options);
  }

  private beginConnectionAttempt(
    runtime: WorkRuntime,
    client: ManagedMockClient,
    processChanged: boolean,
    status: "connecting" | "recovering",
    recoveryStep?: WorkRecoveryStep
  ): ConnectionAttempt {
    const previousRefereeConnectionId = runtime.refereeConnectionId
      ?? runtime.connection.refereeConnectionId
      ?? runtime.lastRefereeConnectionId;
    this.rejectConnectionAttempt(runtime, new Error("比赛连接代已切换"));
    this.stopParticipantReconciliation(runtime);
    const queueGeneration = runtime.commands.advanceGeneration(client);
    delete runtime.refereeConnectionId;
    runtime.commands.setRefereeConnectionId(undefined, queueGeneration);
    const processGeneration = runtime.connection.processGeneration + (processChanged ? 1 : 0);
    const connectionGeneration = runtime.connection.connectionGeneration + 1;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromiseValue, rejectPromiseValue) => {
      resolvePromise = resolvePromiseValue;
      rejectPromise = rejectPromiseValue;
    });
    void promise.catch(() => undefined);
    const attempt = {
      processGeneration,
      connectionGeneration,
      queueGeneration,
      ...(previousRefereeConnectionId === undefined ? {} : { previousRefereeConnectionId }),
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      settled: false,
      authenticationScheduled: false
    } satisfies ConnectionAttempt;
    attempt.timeout = setTimeout(() => {
      if (runtime.connectionAttempt !== attempt) return;
      this.rejectConnectionAttempt(runtime, new Error("比赛连接未在限定时间内完成认证"));
    }, this.dependencies.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS);
    runtime.connectionAttempt = attempt;
    runtime.connection = {
      status,
      processGeneration,
      connectionGeneration,
      ...(recoveryStep === undefined ? {} : { recoveryStep }),
      ...(runtime.connection.recoveryStartedAt === undefined ? {} : { recoveryStartedAt: runtime.connection.recoveryStartedAt }),
      ...(runtime.connection.recentServerEvidence === undefined ? {} : { recentServerEvidence: runtime.connection.recentServerEvidence })
    };
    this.publishConnectionState(runtime);
    return attempt;
  }

  private resolveConnectionAttempt(runtime: WorkRuntime): void {
    const attempt = runtime.connectionAttempt;
    if (!attempt || attempt.settled) return;
    attempt.settled = true;
    clearTimeout(attempt.timeout);
    if (runtime.authenticationDelayTimer) clearTimeout(runtime.authenticationDelayTimer);
    delete runtime.authenticationDelayTimer;
    attempt.resolve();
  }

  private rejectConnectionAttempt(runtime: WorkRuntime, error: Error): void {
    const attempt = runtime.connectionAttempt;
    if (!attempt || attempt.settled) return;
    attempt.settled = true;
    clearTimeout(attempt.timeout);
    if (runtime.authenticationDelayTimer) clearTimeout(runtime.authenticationDelayTimer);
    delete runtime.authenticationDelayTimer;
    if (runtime.listReconciliation?.purpose === "authentication" && !runtime.listReconciliation.settled) {
      if (runtime.listReconciliation.timeout) clearTimeout(runtime.listReconciliation.timeout);
      if (runtime.listReconciliation.settleTimer) clearTimeout(runtime.listReconciliation.settleTimer);
      runtime.listReconciliation.settled = true;
      runtime.listReconciliation.reject?.(error);
      delete runtime.listReconciliation;
    }
    attempt.reject(error);
  }

  private bindManagedClient(runtime: WorkRuntime, client: ManagedMockClient, processGeneration: number): void {
    client.onLine((line) => {
      if (this.runtimes.get(runtime.competitionId) !== runtime || runtime.client !== client
        || runtime.connection.processGeneration !== processGeneration) return;
      const observedCommand = runtime.commands.observeLine(line, runtime.commandObservationGeneration);
      this.ingestLine(runtime, line, observedCommand);
    });
    client.onExit((info) => {
      if (this.runtimes.get(runtime.competitionId) !== runtime || runtime.client !== client
        || runtime.connection.processGeneration !== processGeneration) return;
      const evidence = `MockClient 进程意外退出（code=${info.code ?? "null"}, signal=${info.signal ?? "none"}）`;
      this.host.journal.append({ type: "work.mock-client-exited", competitionId: runtime.competitionId, data: info });
      if (info.expected) return;
      this.setRecentConnectionEvidence(runtime, "process-exited", evidence);
      this.rejectConnectionAttempt(runtime, new Error(evidence));
      if (!runtime.recovery && runtime.connection.status !== "blocked") this.handleUnexpectedDisconnect(runtime, evidence);
    });
  }

  private handleUnexpectedDisconnect(runtime: WorkRuntime, evidence: string): void {
    runtime.controller.observeServerDisconnect(evidence);
    this.stopParticipantReconciliation(runtime);
    if (runtime.connection.status !== "blocked") runtime.connection.status = "suspect";
    delete runtime.connection.refereeConnectionId;
    delete runtime.refereeConnectionId;
    runtime.commands.setRefereeConnectionId(undefined);
    this.setRecentConnectionEvidence(runtime, "disconnected", evidence);
    if (runtime.recovery || runtime.connection.status === "blocked") return;
    this.host.appendAttention(runtime.competitionId, {
      id: `connection-auto-restart:${Date.now()}`,
      category: "incident",
      severity: "warning",
      title: "连接中断，正在自动恢复",
      message: "已冻结普通命令，正在依次尝试软重连、停止旧 MockClient、必要时核验并强制关闭、冷却后重启；整套流程只执行一次。",
      occurredAt: new Date().toISOString()
    });
    void this.runRecovery(runtime, "automatic", async () => {
      try {
        await this.performSoftReconnect(runtime);
      } catch (error) {
        if (error instanceof MapRegistrationPermissionError) throw error;
        await this.performHardRestart(runtime);
      }
    }).catch(() => undefined);
  }

  private async runRecovery(
    runtime: WorkRuntime,
    kind: "automatic" | "soft" | "hard",
    operation: () => Promise<void>
  ): Promise<void> {
    if (runtime.recovery) throw new ServiceError("STATE_CONFLICT", "比赛连接恢复正在进行", 409);
    this.stopParticipantReconciliation(runtime);
    runtime.commands.advanceGeneration();
    runtime.commands.setRefereeConnectionId(undefined);
    delete runtime.refereeConnectionId;
    delete runtime.connection.refereeConnectionId;
    runtime.controller.observeServerDisconnect(kind === "automatic" ? "比赛连接异常，正在自动恢复" : "裁判正在恢复比赛连接");
    runtime.connection.status = "recovering";
    runtime.connection.recoveryStartedAt = new Date().toISOString();
    const recovery: NonNullable<WorkRuntime["recovery"]> = { id: randomUUID(), kind, promise: Promise.resolve() };
    runtime.recovery = recovery;
    recovery.promise = (async () => {
      try {
        await operation();
        this.assertActiveRuntime(runtime);
        if (runtime.connection.status !== "healthy") throw new Error("连接恢复流程结束但认证状态不是 healthy");
        this.host.appendAttention(runtime.competitionId, {
          id: `connection-recovered:${recovery.id}`,
          category: "incident",
          severity: "info",
          title: "比赛服务器连接已恢复",
          message: "新连接已通过登录拒绝观察和显式 list 身份核验；自动化保持暂停，请核对现场后再恢复发令。",
          occurredAt: new Date().toISOString()
        });
      } catch (error) {
        if (!runtime.disposed && this.runtimes.get(runtime.competitionId) === runtime) {
          this.markConnectionBlocked(runtime, error instanceof Error ? error.message : "比赛连接恢复失败", kind);
        }
        throw error;
      } finally {
        if (runtime.recovery === recovery) delete runtime.recovery;
        if (!runtime.disposed && this.runtimes.get(runtime.competitionId) === runtime) this.saveSnapshot(runtime);
      }
    })();
    return recovery.promise;
  }

  private async performSoftReconnect(runtime: WorkRuntime, disconnectFirst = false): Promise<void> {
    const client = runtime.client;
    if (!client?.isRunning) throw new Error("旧 MockClient 已退出，无法执行软重连");
    const attempt = this.beginConnectionAttempt(runtime, client, false, "recovering", "soft-reconnect");
    if (disconnectFirst) {
      const evidence = await client.disconnectForReconnect();
      this.assertActiveRuntime(runtime);
      this.host.journal.append({
        type: "work.mock-client-soft-disconnected",
        competitionId: runtime.competitionId,
        data: {
          server: runtime.server,
          processGeneration: attempt.processGeneration,
          connectionGeneration: attempt.connectionGeneration,
          evidence
        }
      });
    }
    let reconnectWriteError: unknown;
    try {
      await client.reconnect();
    } catch (error) {
      reconnectWriteError = error;
    }
    this.assertActiveRuntime(runtime);
    if (!attempt.settled
      && runtime.connection.status === "recovering"
      && runtime.connection.recoveryStep === "soft-reconnect") {
      this.setRecoveryStep(runtime, "verify-soft-connection");
    }
    try {
      await attempt.promise;
      if (!attempt.mapRegistrationPromise) throw new Error("连接身份已确认，但当前进程代没有建立地图注册任务");
      await attempt.mapRegistrationPromise;
    } catch (error) {
      this.rejectConnectionAttempt(runtime, error instanceof Error ? error : new Error(String(error)));
      throw attempt.mapRegistrationPromise ? error : reconnectWriteError ?? error;
    }
  }

  private async performHardRestart(runtime: WorkRuntime): Promise<void> {
    this.stopParticipantReconciliation(runtime);
    runtime.commands.advanceGeneration();
    delete runtime.refereeConnectionId;
    delete runtime.connection.refereeConnectionId;
    const oldClient = runtime.client;
    if (oldClient?.isRunning) {
      this.setRecoveryStep(runtime, "graceful-stop");
      await this.stopManagedClient(oldClient, () => {
        if (!runtime.disposed && this.runtimes.get(runtime.competitionId) === runtime) {
          this.setRecoveryStep(runtime, "force-stop");
        }
      });
      this.assertActiveRuntime(runtime);
    }

    const cooldownMs = this.dependencies.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS;
    this.setRecoveryStep(runtime, "cooldown");
    runtime.connection.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    this.publishConnectionState(runtime);
    await (this.dependencies.sleep?.(cooldownMs) ?? new Promise<void>((resolveDelay) => setTimeout(resolveDelay, cooldownMs)));
    this.assertActiveRuntime(runtime);
    delete runtime.connection.cooldownUntil;

    const competitionId = runtime.competitionId;
    const config = this.host.getOperationalConfig(competitionId);
    const executable = resolve(serverWindowsRoot(), "BallanceMMOMockClient.exe");
    if (!existsSync(executable)) throw new ServiceError("MOCK_CLIENT_MISSING", "未找到 BallanceMMOMockClient.exe", 500, { executable });
    const logPath = join(resolve(this.host.dataRoot), "work", competitionId, "logs", "mockclient.log");
    const client = this.createManagedClient(config, executable, logPath);
    runtime.client = client;
    const attempt = this.beginConnectionAttempt(runtime, client, true, "recovering", "restart");
    this.bindManagedClient(runtime, client, attempt.processGeneration);
    try {
      client.start();
      this.setRecoveryStep(runtime, "verify-restarted-connection");
      await attempt.promise;
      if (!attempt.mapRegistrationPromise) throw new Error("重启后的连接身份已确认，但当前进程代没有建立地图注册任务");
      await attempt.mapRegistrationPromise;
    } catch (error) {
      this.rejectConnectionAttempt(runtime, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private markConnectionBlocked(runtime: WorkRuntime, detail: string, source: "automatic" | "soft" | "hard"): void {
    if (runtime.disposed || this.runtimes.get(runtime.competitionId) !== runtime) return;
    this.rejectConnectionAttempt(runtime, new Error(detail));
    runtime.commands.advanceGeneration();
    runtime.commands.setRefereeConnectionId(undefined);
    delete runtime.refereeConnectionId;
    delete runtime.connection.refereeConnectionId;
    runtime.connection.status = "blocked";
    delete runtime.connection.recoveryStep;
    delete runtime.connection.cooldownUntil;
    runtime.controller.observeServerDisconnect(detail);
    this.host.appendAttention(runtime.competitionId, {
      id: `connection-recovery-failed:${Date.now()}`,
      category: "incident",
      severity: "critical",
      title: source === "automatic" ? "自动恢复连接失败" : source === "soft" ? "软重新连接失败" : "重启 MockClient 失败",
      message: `${detail}；自动流程不会循环重试，请由裁判选择软重新连接或重启 MockClient。`,
      occurredAt: new Date().toISOString(),
      action: "restart-work"
    });
    this.publishConnectionState(runtime);
  }

  private setRecoveryStep(runtime: WorkRuntime, step: WorkRecoveryStep): void {
    runtime.connection.status = "recovering";
    runtime.connection.recoveryStep = step;
    this.publishConnectionState(runtime);
  }

  private setRecentConnectionEvidence(runtime: WorkRuntime, kind: NonNullable<WorkConnectionView["recentServerEvidence"]>["kind"], detail: string, occurredAt = new Date().toISOString()): void {
    runtime.connection.recentServerEvidence = {
      kind,
      occurredAt,
      detail,
      processGeneration: runtime.connection.processGeneration,
      connectionGeneration: runtime.connection.connectionGeneration
    };
    this.publishConnectionState(runtime);
  }

  private assertActiveRuntime(runtime: WorkRuntime): void {
    if (runtime.disposed || this.runtimes.get(runtime.competitionId) !== runtime) {
      throw new StaleConnectionGenerationError("工作运行已停止");
    }
  }

  private publishConnectionState(runtime: WorkRuntime): void {
    if (runtime.disposed || this.runtimes.get(runtime.competitionId) !== runtime) return;
    this.saveSnapshot(runtime);
    this.host.journal.append({ type: "work.connection-state", competitionId: runtime.competitionId, data: runtime.connection });
  }

  public startRealtime(runtime: WorkRuntime): void {
    if (runtime.automationTimer) return;
    runtime.automationTimer = setInterval(() => { void this.tickRealtime(runtime); }, 500);
    runtime.automationTimer.unref?.();
  }

  public stopRealtime(runtime: WorkRuntime): void {
    if (!runtime.automationTimer) return;
    clearInterval(runtime.automationTimer);
    delete runtime.automationTimer;
  }

  public async tickRealtime(runtime: WorkRuntime): Promise<void> {
    if (runtime.automationDispatching || this.runtimes.get(runtime.competitionId) !== runtime) return;
    runtime.automationDispatching = true;
    const before = runtime.controller.snapshot().stateVersion;
    try {
      runtime.controller.tick();
      this.mirrorSystemResults(runtime);
      this.mirrorVoidedAttempts(runtime);
      this.mirrorClosedAttempts(runtime);
      const records = this.businessCommandsReady(runtime) ? await runtime.runtime.dispatch() : [];
      const snapshot = runtime.controller.snapshot();
      this.host.completeCompetitionOnReview(runtime.competitionId, snapshot);
      for (const action of snapshot.actions.filter((candidate) => candidate.status === "acknowledged")) {
        this.host.recordAutomationAttention(runtime.competitionId, action);
      }
      this.saveSnapshot(runtime);
      if (snapshot.stateVersion !== before || records.length > 0) {
        this.host.journal.append({ type: "work.automation-progress", competitionId: runtime.competitionId, data: { phase: snapshot.phase } });
      }
    } catch (error) {
      runtime.controller.pause();
      this.saveSnapshot(runtime);
      this.stopRealtime(runtime);
      this.host.journal.append({ type: "work.automation-error", competitionId: runtime.competitionId, data: { message: error instanceof Error ? error.message : "unknown" } });
    } finally {
      runtime.automationDispatching = false;
    }
  }

  public startParticipantReconciliation(runtime: WorkRuntime): void {
    this.stopParticipantReconciliation(runtime);
    const requestList = () => { void this.requestParticipantList(runtime); };
    runtime.initialListTimer = setTimeout(requestList, 1_000);
    runtime.initialListTimer.unref?.();
    runtime.listTimer = setInterval(requestList, 30_000);
    runtime.listTimer.unref?.();
  }

  public async reconcileParticipantsNow(competitionId: string): Promise<void> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
    await runtime.connectionAttempt?.mapRegistrationPromise;
    await this.requestParticipantList(runtime);
  }

  private stopParticipantReconciliation(runtime: WorkRuntime): void {
    if (runtime.initialListTimer) clearTimeout(runtime.initialListTimer);
    if (runtime.listTimer) clearInterval(runtime.listTimer);
    delete runtime.initialListTimer;
    delete runtime.listTimer;
    const reconciliation = runtime.listReconciliation;
    if (reconciliation?.purpose !== "participant") return;
    if (reconciliation.timeout) clearTimeout(reconciliation.timeout);
    if (reconciliation.settleTimer) clearTimeout(reconciliation.settleTimer);
    if (!reconciliation.settled) {
      reconciliation.settled = true;
      reconciliation.reject?.(new Error("在线名单对账已停止"));
    }
    delete runtime.listReconciliation;
  }

  private async requestParticipantList(runtime: WorkRuntime): Promise<void> {
    if (this.runtimes.get(runtime.competitionId) !== runtime || !this.businessCommandsReady(runtime)
      || runtime.listReconciliation) return;
    let reconciliation: ListReconciliation | undefined;
    const connectionGeneration = runtime.connection.connectionGeneration;
    const record = await runtime.commands.enqueue(
      { type: "list" },
      `participant-list:${runtime.competitionId}:${connectionGeneration}:${Date.now()}`,
      () => {
        reconciliation = this.beginListReconciliation(runtime, undefined, "participant", connectionGeneration);
        void reconciliation.completion?.catch(() => undefined);
      }
    );
    if (this.runtimes.get(runtime.competitionId) !== runtime) return;
    if (record.status === "acknowledged" && reconciliation) {
      try {
        await reconciliation.completion as ListResult;
        if (runtime.connection.status !== "healthy" || runtime.connection.connectionGeneration !== connectionGeneration) return;
        delete runtime.listNoEchoRecovery;
      } catch {
        this.handleParticipantListNoEcho(runtime, record);
      }
      return;
    }
    const currentReconciliation = runtime.listReconciliation as ListReconciliation | undefined;
    if (currentReconciliation?.purpose === "participant"
      && currentReconciliation.connectionGeneration === connectionGeneration) {
      this.rejectListReconciliation(runtime, currentReconciliation, new Error(`participant list command ended as ${record.status}`));
    }
    if (record.status === "timed_out") this.handleParticipantListNoEcho(runtime, record);
  }

  private handleParticipantListNoEcho(runtime: WorkRuntime, record: CommandRecord): void {
    if (runtime.recovery) return;
    if (runtime.listNoEchoRecovery?.attempted) {
      this.markConnectionBlocked(runtime, "自动恢复后下一次定期 list 仍未观察到服务器名单完整回显", "automatic");
      return;
    }
    runtime.listNoEchoRecovery = { attempted: true };
    this.host.appendAttention(runtime.competitionId, {
      id: `participant-list-no-echo:${record.id}`,
      category: "incident",
      severity: "warning",
      title: "list 无回显，正在自动重连",
      message: "在线名单对账命令没有完整服务器回显；已冻结后续发令，并按软重连、必要时重启 MockClient 的顺序自动恢复一次。",
      occurredAt: record.updatedAt
    });
    this.handleUnexpectedDisconnect(runtime, "list 命令等待服务器名单完整回显超时");
  }

  public beginListReconciliation(
    runtime: WorkRuntime,
    expected?: number,
    purpose: ListReconciliation["purpose"] = "participant",
    connectionGeneration = runtime.connection.connectionGeneration
  ): ListReconciliation {
    const previous = runtime.listReconciliation;
    if (previous && !previous.settled) {
      this.rejectListReconciliation(runtime, previous, new Error("新的 list 对账已替换旧窗口"));
    }
    let resolveCompletion!: (result: ListResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<ListResult>((resolveResult, rejectResult) => {
      resolveCompletion = resolveResult;
      rejectCompletion = rejectResult;
    });
    void completion.catch(() => undefined);
    const reconciliation: ListReconciliation = {
      purpose,
      connectionGeneration,
      ...(expected === undefined ? {} : { expected, protocolStyle: "legacy" as const }),
      seen: 0,
      spectatorCount: 0,
      connectionIds: new Set(),
      onlinePlayerIds: new Set(),
      refereeConnectionIds: new Set(),
      refereeConnectionCount: 0,
      listedPlayers: new Map(),
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      settled: false
    };
    reconciliation.timeout = setTimeout(() => {
      if (runtime.listReconciliation !== reconciliation || reconciliation.settled) return;
      this.rejectListReconciliation(runtime, reconciliation, new Error("list 服务器回显未在限定时间内完整收口"));
    }, this.dependencies.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS);
    runtime.listReconciliation = reconciliation;
    if (expected === 0) {
      reconciliation.protocolStyle = "legacy";
      this.scheduleListCompletion(runtime, reconciliation);
    }
    return reconciliation;
  }

  public saveSnapshot(runtime: WorkRuntime): void {
    const settled = this.settleStageBoundary(runtime);
    this.persistSnapshot(runtime, settled.after);
    if (settled.controllerChanged) this.recordStageBoundary(runtime, settled.before, settled.after);
  }

  private persistSnapshot(runtime: WorkRuntime, automation: AutomationSnapshot): void {
    this.synchronizeParticipantStageStatuses(runtime, automation.currentStageId);
    const payload = this.host.getPayload(runtime.competitionId);
    this.host.savePayload(runtime.competitionId, {
      ...payload,
      work: {
        started: true,
        ...(runtime.mockClientVersion === undefined ? {} : { mockClientVersion: runtime.mockClientVersion }),
        participantStageId: runtime.participantStageId,
        automation,
        engine: runtime.engine.snapshot(),
        mapEchoPrefixes: Object.fromEntries(runtime.mapEchoPrefixes),
        connection: runtime.connection
      }
    });
  }

  public synchronizeStageBoundary(runtime: WorkRuntime): AutomationSnapshot {
    const settled = this.settleStageBoundary(runtime);
    if (settled.controllerChanged || settled.engineChanged) {
      this.persistSnapshot(runtime, settled.after);
    }
    if (settled.controllerChanged) this.recordStageBoundary(runtime, settled.before, settled.after);
    return settled.after;
  }

  private settleStageBoundary(runtime: WorkRuntime): {
    before: AutomationSnapshot;
    after: AutomationSnapshot;
    controllerChanged: boolean;
    engineChanged: boolean;
  } {
    const before = runtime.controller.snapshot();
    runtime.controller.synchronizeStageBoundary();
    const engineChanged = this.mirrorClosedAttempts(runtime);
    const after = runtime.controller.snapshot();
    return {
      before,
      after,
      controllerChanged: after.stateVersion !== before.stateVersion,
      engineChanged
    };
  }

  private recordStageBoundary(
    runtime: WorkRuntime,
    before: AutomationSnapshot,
    after: AutomationSnapshot
  ): void {
    const stageChanged = before.currentStageId !== after.currentStageId;
    this.host.journal.append({
      type: stageChanged ? "work.stage-boundary" : "work.stage-deadline",
      competitionId: runtime.competitionId,
      data: {
        previousStageId: before.currentStageId,
        currentStageId: after.currentStageId,
        stageChanged,
        stateVersion: after.stateVersion
      }
    });
  }

  private synchronizeParticipantStageStatuses(runtime: WorkRuntime, currentStageId: string): void {
    if (runtime.participantStageId === currentStageId) return;
    const previousStageId = runtime.participantStageId;
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
    runtime.participantStageId = currentStageId;
    this.host.journal.append({
      type: "participants.stage-reset",
      competitionId: runtime.competitionId,
      data: { previousStageId, currentStageId, resetCount }
    });
  }

  public mirrorSystemResults(runtime: WorkRuntime): void {
    const engineSnapshot = runtime.engine.snapshot();
    const engineSources = new Set(engineSnapshot.currentScoreboard.flatMap((entry) =>
      Object.values(entry.stages).flatMap((result) => result.finishSourceId ? [result.sourceId, result.finishSourceId] : [result.sourceId])));
    let changed = false;
    for (const attempt of runtime.controller.snapshot().attempts) {
      const engineAttempt = engineSnapshot.attempts.find((candidate) => candidate.stageId === attempt.stageId
        && candidate.attemptNumber === attempt.attemptNumber && candidate.open && !candidate.voided);
      if (!engineAttempt) continue;
      for (const result of attempt.results) {
        if (engineSources.has(result.sourceId)
          || result.status === "excluded" && engineSources.has(`${result.sourceId}:excluded`)) continue;
        const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
        if (result.status === "dnf" && result.sourceId.match(/^(deadline|manual-end):/)) {
          runtime.engine.apply({ atMs: engineAttempt.deadlineAtMs, sourceId: result.sourceId, type: "dnf", stageId: attempt.stageId, playerId: result.playerId, reason: result.reason ?? "time-limit" });
        } else if (result.status === "excluded") {
          runtime.engine.apply({ atMs: engineAttempt.goAtMs, sourceId: result.sourceId, type: "exclude", stageId: attempt.stageId, playerId: result.playerId, reason: result.reason ?? "excluded" });
        } else continue;
        if (runtime.engine.snapshot().scoreboardVersions.length === versionCount) continue;
        if (result.status === "excluded") this.host.recordExclusionAttention(runtime.competitionId, attempt.stageId, result.playerId, result.sourceId, result.reason ?? "违规");
        engineSources.add(result.sourceId);
        changed = true;
        if (result.status === "dnf") {
          this.host.appendAttention(runtime.competitionId, {
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
    }
    if (changed) this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
  }

  public mirrorVoidedAttempts(runtime: WorkRuntime): void {
    const engineAttempts = runtime.engine.snapshot().attempts;
    let changed = false;
    for (const attempt of runtime.controller.snapshot().attempts) {
      if (!attempt.voided) continue;
      const engineAttempt = engineAttempts.find((candidate) =>
        candidate.stageId === attempt.stageId && candidate.attemptNumber === attempt.attemptNumber && !candidate.voided);
      if (!engineAttempt) continue;
      runtime.engine.voidAttempt(attempt.stageId, attempt.attemptNumber, `start-protection:${attempt.id}`);
      changed = true;
    }
    if (changed) this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
  }

  public mirrorClosedAttempts(runtime: WorkRuntime): boolean {
    const engineAttempts = runtime.engine.snapshot().attempts;
    let changed = false;
    for (const attempt of runtime.controller.snapshot().attempts) {
      if (attempt.intakeOpen || attempt.voided) continue;
      const engineAttempt = engineAttempts.find((candidate) =>
        candidate.stageId === attempt.stageId
        && candidate.attemptNumber === attempt.attemptNumber
        && candidate.open
        && !candidate.voided);
      if (!engineAttempt) continue;
      runtime.engine.closeAttempt(attempt.stageId, attempt.attemptNumber);
      changed = true;
    }
    return changed;
  }

  public async remove(competitionId: string): Promise<void> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) return;
    this.stopRealtime(runtime);
    this.stopParticipantReconciliation(runtime);
    runtime.disposed = true;
    this.rejectConnectionAttempt(runtime, new Error("工作运行已停止"));
    runtime.commands.advanceGeneration();
    try {
      if (runtime.client) await this.stopManagedClient(runtime.client);
    } catch (error) {
      this.host.journal.append({
        type: "work.mock-client-stop-failed",
        competitionId: runtime.competitionId,
        data: { message: error instanceof Error ? error.message : String(error), source: "remove" }
      });
      runtime.disposed = false;
      this.markConnectionBlocked(runtime, `停止受管 MockClient 失败：${error instanceof Error ? error.message : String(error)}`, "hard");
      this.startRealtime(runtime);
      throw error;
    }
    if (this.runtimes.get(competitionId) === runtime) this.runtimes.delete(competitionId);
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const runtimes = [...this.runtimes.values()];
    for (const runtime of runtimes) {
      this.stopRealtime(runtime);
      this.stopParticipantReconciliation(runtime);
      runtime.disposed = true;
      this.rejectConnectionAttempt(runtime, new Error("服务正在关闭"));
      runtime.commands.advanceGeneration();
    }
    const closing = (async (): Promise<void> => {
      const failures: unknown[] = [];
      await Promise.all(runtimes.map(async (runtime) => {
        try {
          if (runtime.client) await this.stopManagedClient(runtime.client);
          if (this.runtimes.get(runtime.competitionId) === runtime) this.runtimes.delete(runtime.competitionId);
        } catch (error) {
          failures.push(error);
          this.host.journal.append({
            type: "work.mock-client-stop-failed",
            competitionId: runtime.competitionId,
            data: { message: error instanceof Error ? error.message : String(error), source: "service-close" }
          });
          runtime.disposed = false;
          this.markConnectionBlocked(runtime, `关闭服务时停止受管 MockClient 失败：${error instanceof Error ? error.message : String(error)}`, "hard");
          this.startRealtime(runtime);
        }
      }));
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to stop ${failures.length} managed MockClient process(es)`);
      }
    })();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }

  private stopManagedClient(client: ManagedMockClient, onForceStop?: () => void): Promise<void> {
    const existing = this.managedShutdowns.get(client);
    if (existing) return existing;
    const shutdown = (async (): Promise<void> => {
      if (!client.isRunning) return;
      const processRef = client.captureProcess();
      try {
        await client.stop(this.dependencies.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS);
      } catch (error) {
        if (!client.isRunning) return;
        if (!processRef || !client.isCurrentProcess(processRef)) {
          throw new Error("MockClient graceful stop failed and the managed process identity cannot be verified", { cause: error });
        }
        onForceStop?.();
        await client.forceStopOwnedProcessTree(processRef, this.dependencies.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS);
      }
      if (client.isRunning) throw new Error("MockClient process tree remained running after managed shutdown");
    })();
    this.managedShutdowns.set(client, shutdown);
    void shutdown.then(
      () => { if (this.managedShutdowns.get(client) === shutdown) this.managedShutdowns.delete(client); },
      () => { if (this.managedShutdowns.get(client) === shutdown) this.managedShutdowns.delete(client); }
    );
    return shutdown;
  }

  private observeConnected(runtime: WorkRuntime, occurredAt: string): void {
    let current = runtime.connectionAttempt;
    if (!current || current.settled) {
      if (runtime.disposed || !runtime.client?.isRunning) return;
      if (runtime.connection.status === "blocked") {
        this.setRecentConnectionEvidence(
          runtime,
          "connected",
          "阻断状态收到 Connected；仅保留传输层证据，不自动启动认证或恢复",
          occurredAt
        );
        return;
      }
      if (runtime.connection.status !== "healthy") return;
      runtime.controller.observeServerDisconnect("healthy connection emitted a new Connected line and must be re-authenticated");
      this.stopParticipantReconciliation(runtime);
      const nextAttempt = this.beginConnectionAttempt(runtime, runtime.client, false, "connecting");
      void nextAttempt.promise.catch((error: unknown) => {
        if (!runtime.recovery && runtime.connection.status !== "blocked" && runtime.connectionAttempt === nextAttempt) {
          if (error instanceof MapRegistrationPermissionError) {
            this.markConnectionBlocked(runtime, error.message, "automatic");
            return;
          }
          this.handleUnexpectedDisconnect(runtime, error instanceof Error ? error.message : "比赛连接认证失败");
        }
      });
      current = nextAttempt;
    }
    if (current.settled) return;
    runtime.commandObservationGeneration = current.queueGeneration;
    runtime.connection.status = "authenticating";
    if (!runtime.recovery) {
      delete runtime.connection.recoveryStep;
    } else if (runtime.connection.recoveryStep === "restart" || runtime.connection.recoveryStep === "verify-restarted-connection") {
      runtime.connection.recoveryStep = "verify-restarted-connection";
    } else {
      runtime.connection.recoveryStep = "verify-soft-connection";
    }
    this.setRecentConnectionEvidence(runtime, "connected", "Connected 仅表示传输层建立，正在等待登录拒绝观察窗与显式 list 核验", occurredAt);
    if (current.authenticationScheduled) return;
    current.authenticationScheduled = true;
    const processGeneration = current.processGeneration;
    const connectionGeneration = current.connectionGeneration;
    runtime.authenticationDelayTimer = setTimeout(() => {
      delete runtime.authenticationDelayTimer;
      void this.authenticateConnection(runtime, processGeneration, connectionGeneration).catch((error: unknown) => {
        if (runtime.connectionAttempt !== current
          || current.processGeneration !== processGeneration
          || current.connectionGeneration !== connectionGeneration) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!current.settled) {
          this.rejectConnectionAttempt(runtime, failure);
          return;
        }
        if (runtime.disposed || this.runtimes.get(runtime.competitionId) !== runtime
          || runtime.recovery || runtime.connection.status === "blocked") return;
        if (failure instanceof MapRegistrationPermissionError) {
          this.markConnectionBlocked(runtime, failure.message, "automatic");
          return;
        }
        this.handleUnexpectedDisconnect(runtime, failure.message);
      });
    }, this.dependencies.authenticationRejectWindowMs ?? DEFAULT_AUTHENTICATION_REJECT_WINDOW_MS);
  }

  private async authenticateConnection(runtime: WorkRuntime, processGeneration: number, connectionGeneration: number): Promise<void> {
    const attempt = runtime.connectionAttempt;
    if (!attempt || attempt.settled || attempt.processGeneration !== processGeneration || attempt.connectionGeneration !== connectionGeneration) {
      throw new Error("认证流程所属连接代已经失效");
    }
    let reconciliation: ListReconciliation | undefined;
    const record = await runtime.commands.enqueue(
      { type: "list" },
      `authentication-list:${runtime.competitionId}:${processGeneration}:${connectionGeneration}`,
      () => {
        reconciliation = this.beginListReconciliation(runtime, undefined, "authentication", connectionGeneration);
        void reconciliation.completion?.catch(() => undefined);
      }
    );
    if (record.status !== "acknowledged") throw new Error(`authentication list was not acknowledged (${record.status})`);
    if (!reconciliation) throw new Error("authentication list observation window was not opened");
    const list = await reconciliation.completion as ListResult;
    if (record.status !== "acknowledged") throw new Error(`认证 list 未完整确认（${record.status}）`);
    if (runtime.connectionAttempt !== attempt || attempt.settled || runtime.commands.generation !== attempt.queueGeneration) {
      throw new Error("认证 list 完成时连接代已经失效");
    }
    if (list.seen !== list.expected) throw new Error(`认证 list 未完整收口：期望 ${list.expected} 行，实际 ${list.seen} 行`);
    if (list.refereeConnectionCount !== 1 || list.refereeConnectionIds.size !== 1) {
      throw new Error(`认证 list 必须且只能包含一个 *ContestConsole，实际 ${list.refereeConnectionIds.size} 个`);
    }
    const refereeConnectionId = [...list.refereeConnectionIds][0] as string;
    if (attempt.previousRefereeConnectionId === refereeConnectionId) {
      throw new Error(`authentication list returned stale referee connection ID ${refereeConnectionId}`);
    }
    if (!runtime.commands.setRefereeConnectionId(refereeConnectionId, attempt.queueGeneration)) {
      throw new Error("认证 list 的连接代已过期，拒绝提交裁判身份");
    }
    runtime.refereeConnectionId = refereeConnectionId;
    runtime.lastRefereeConnectionId = refereeConnectionId;
    runtime.connection.refereeConnectionId = refereeConnectionId;
    this.setRecentConnectionEvidence(runtime, "list-verified", `显式 list 已确认 *ContestConsole 连接 ID ${refereeConnectionId}`);
    this.applyListParticipants(runtime, list);
    runtime.controller.observeServerConnected();
    const recentServerEvidence = runtime.connection.recentServerEvidence;
    runtime.connection = {
      status: "healthy",
      processGeneration,
      connectionGeneration,
      refereeConnectionId,
      recoveryStep: "register-maps",
      ...(recentServerEvidence === undefined ? {} : { recentServerEvidence })
    };
    const mapRegistrationPromise = Promise.resolve().then(() => this.registerPublishedCustomMaps(
      runtime,
      this.host.getOperationalConfig(runtime.competitionId),
      processGeneration,
      connectionGeneration
    ));
    attempt.mapRegistrationPromise = mapRegistrationPromise;
    this.resolveConnectionAttempt(runtime);
    this.publishConnectionState(runtime);
    await mapRegistrationPromise;
    if (runtime.connectionAttempt !== attempt
      || runtime.commands.generation !== attempt.queueGeneration
      || runtime.connection.processGeneration !== processGeneration
      || runtime.connection.connectionGeneration !== connectionGeneration) {
      throw new StaleConnectionGenerationError("地图注册完成时连接代已经失效");
    }
    if (runtime.connection.recoveryStep === "register-maps") delete runtime.connection.recoveryStep;
    this.startParticipantReconciliation(runtime);
    this.publishConnectionState(runtime);
  }

  // Log ingestion, participant reconciliation and event attribution are kept together below.

  public ingestLine(runtime: WorkRuntime, line: string, observedCommand?: CommandRecord): void {
    const config = this.host.getPublishedConfig(runtime.competitionId);
    if (!config) return;
    this.host.appendRawLog(runtime.competitionId, "mock-client", line);
    const parsed = parseLogLine(line, { year: Number(config.date.slice(0, 4)), utcOffsetMinutes: utcOffsetMinutes(config.timezone) });
    if (parsed.event.type === "connected") {
      this.observeConnected(runtime, parsed.event.occurredAt);
    }
    if (parsed.event.type === "authentication-failed") {
      const detail = parsed.event.code === undefined ? parsed.event.message : `${parsed.event.code}: ${parsed.event.message}`;
      this.setRecentConnectionEvidence(runtime, "authentication-failed", detail, parsed.event.occurredAt);
      this.rejectConnectionAttempt(runtime, new Error(detail));
      if (!runtime.recovery) this.handleUnexpectedDisconnect(runtime, detail);
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (parsed.event.type === "server-disconnected") {
      const detail = "MockClient 与比赛服务器断开连接";
      this.setRecentConnectionEvidence(runtime, "disconnected", detail, parsed.event.occurredAt);
      const awaitingSoftReconnectBoundary = runtime.recovery !== undefined
        && runtime.connection.status === "recovering"
        && (runtime.connection.recoveryStep === "soft-reconnect"
          || runtime.connection.recoveryStep === "verify-soft-connection")
        && runtime.connectionAttempt !== undefined
        && !runtime.connectionAttempt.settled;
      if (!awaitingSoftReconnectBoundary) {
        this.rejectConnectionAttempt(runtime, new Error(detail));
        if (!runtime.recovery) this.handleUnexpectedDisconnect(runtime, detail);
      }
    }
    if (parsed.event.type === "permission-denied" && observedCommand?.status === "failed") {
      runtime.controller.observePermissionDenied(parsed.event.message);
    }
    if (parsed.event.type === "fatal-error") this.handleFatalError(runtime, parsed.event);
    const before = this.synchronizeStageBoundary(runtime);
    const currentStage = config.stages.find((candidate) => candidate.id === before.currentStageId);
    this.bindOfficialMapEcho(runtime, config, parsed.event, before);
    const eventStage = this.resolveEventStage(runtime, config, parsed.event, before.currentStageId);
    const effectivePhase = (before.phase === "paused" || before.phase === "incident") && before.pausedFromPhase
      ? before.pausedFromPhase
      : before.phase;
    const openCurrentAttempt = before.attempts.findLast((attempt) =>
      attempt.stageId === before.currentStageId && attempt.intakeOpen && !attempt.voided);
    if ((parsed.event.type === "finish" || parsed.event.type === "dnf")
      && (!openCurrentAttempt
        || effectivePhase !== "running" && effectivePhase !== "tail-intake"
        || !currentStage
        || eventStage?.id !== currentStage.id)) {
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (parsed.event.type === "player-list-start") this.observeListStart(runtime, parsed.event.count);
    if (parsed.event.type === "player-list-summary") this.completeListReconciliation(runtime, parsed.event.clients, parsed.event.players, parsed.event.spectators);
    if (parsed.event.type === "player-listed") this.recordListParticipant(runtime, parsed.event);
    if (parsed.event.type === "player-list-start" || parsed.event.type === "player-list-summary" || parsed.event.type === "player-listed") {
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    const resultEvidenceWhileBlocked = ["finish", "dnf", "warning", "cheat-changed"].includes(parsed.event.type);
    if (runtime.connection.status !== "healthy" && parsed.event.type !== "connected" && !resultEvidenceWhileBlocked) {
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (parsed.event.type === "countdown" && this.isLocalRefereeEvent(runtime, parsed.event) && eventStage?.id === currentStage?.id) {
      runtime.controller.observeCountdown(parsed.event.value);
    }
    if (parsed.event.type === "warning") this.handleWarning(runtime, config, parsed.event);
    if (parsed.event.type === "unknown" && typeof (parsed.event as { text?: string }).text === "string" && /toggled cheat off globally/i.test((parsed.event as { text?: string }).text ?? "")) runtime.controller.resetAllCheat();
    const event = this.domainToScenarioEvent(runtime, config, parsed.event, eventStage);
    const confirmsCurrentGo = observedCommand?.status === "acknowledged" && observedCommand.action.type === "go";
    if (event?.type === "go" && before.restartPending && !confirmsCurrentGo) {
      this.host.appendAttention(runtime.competitionId, {
        id: `ignored-pre-restart-go:${event.sourceId}`,
        category: "command",
        severity: "warning",
        title: "已忽略旧发令周期的 Go 回显",
        message: "强制重赛后尚未发送并确认新的 Go；该迟到回显仅保留为原始证据，不会创建尝试或进入榜单。",
        occurredAt: parsed.event.occurredAt,
        stageId: before.currentStageId
      });
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (event?.type === "go" && event.stageId !== (before.plannedReadyStageId ?? before.currentStageId)) {
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (event) {
      let resultAccepted = true;
      const scoreboardVersionCountBeforeEvent = runtime.engine.snapshot().scoreboardVersions.length;
      if ("playerId" in event) {
        runtime.controller.registerParticipant(event.playerId);
        const participant = this.host.getDraftConfig(runtime.competitionId).participants.find((candidate) => candidate.id === event.playerId);
        runtime.engine.registerPlayer(event.playerId, participant?.displayName ?? event.playerId);
      }
      if (event.type === "finish") {
        const cheatFinish = parsed.event.type === "finish" && parsed.event.cheat;
        const exclusionSourceId = `${event.sourceId}:cheat-finish`;
        resultAccepted = runtime.controller.recordResult({
          stageId: event.stageId,
          playerId: event.playerId,
          status: cheatFinish ? "excluded" : "finished",
          sourceId: cheatFinish ? exclusionSourceId : event.sourceId,
          receivedAtMs: performance.now(),
          ...(cheatFinish ? { reason: "cheat-finish", finishSourceId: event.sourceId } : {})
        }) === "accepted";
        if (resultAccepted) {
          runtime.engine.apply(event);
          if (cheatFinish && parsed.event.type === "finish") {
            const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
            runtime.engine.apply({
              atMs: event.atMs,
              sourceId: exclusionSourceId,
              type: "exclude",
              stageId: event.stageId,
              playerId: event.playerId,
              reason: "cheat-finish"
            });
            this.observeParticipant(runtime.competitionId, parsed.event.playerName, parsed.event.connectionId, true, "excluded");
            if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
              this.host.recordExclusionAttention(
                runtime.competitionId,
                event.stageId,
                event.playerId,
                exclusionSourceId,
                "[CHEAT] 完赛"
              );
            }
          }
        }
      } else if (event.type === "dnf") {
        resultAccepted = runtime.controller.recordResult({
          stageId: event.stageId,
          playerId: event.playerId,
          status: "dnf",
          sourceId: event.sourceId,
          reason: event.reason,
          receivedAtMs: performance.now()
        }) === "accepted";
        if (resultAccepted) runtime.engine.apply(event);
      } else if (event.type === "exclude") {
        runtime.controller.observeViolation(event.playerId, event.sourceId, event.reason);
        resultAccepted = runtime.controller.snapshot().attempts.some((attempt) =>
          attempt.id === openCurrentAttempt?.id
          && attempt.results.some((result) =>
            result.playerId === event.playerId
            && result.status === "excluded"
            && result.sourceId === event.sourceId));
        if (resultAccepted) runtime.engine.apply(event);
      } else if (event.type === "go") {
        const controllerHasAttempt = before.attempts.some((attempt) =>
          attempt.stageId === event.stageId && !attempt.voided);
        const engineHasAttempt = runtime.engine.snapshot().attempts.some((attempt) =>
          attempt.stageId === event.stageId && !attempt.voided);
        if (!controllerHasAttempt) runtime.controller.observeAuthoritativeGo(event.stageId);
        if (!engineHasAttempt) runtime.engine.apply(event);
      } else {
        runtime.engine.apply(event);
      }
      if (event.type === "login") runtime.controller.observeConnection(event.playerId, true);
      else if (event.type === "disconnect") runtime.controller.observeConnection(event.playerId, false);
      else if (event.type === "exclude") {
        if (resultAccepted && runtime.engine.snapshot().scoreboardVersions.length > scoreboardVersionCountBeforeEvent) {
          this.host.recordExclusionAttention(runtime.competitionId, event.stageId, event.playerId, event.sourceId, event.reason);
        }
      } else if (event.type === "cheat") {
        const snapshotBeforeCheat = runtime.controller.snapshot();
        const activeAttempt = [...snapshotBeforeCheat.attempts].reverse().find((candidate) => candidate.stageId === snapshotBeforeCheat.currentStageId && candidate.intakeOpen);
        const playerAlreadyCompleted = activeAttempt?.results.some((result) => result.playerId === event.playerId) ?? false;
        if (!playerAlreadyCompleted) {
          runtime.controller.observeCheat(event.playerId, event.enabled, event.sourceId);
          const snapshot = runtime.controller.snapshot();
          const excludedByThisEvent = snapshot.attempts.some((attempt) => attempt.id === activeAttempt?.id
            && attempt.results.some((result) =>
              result.playerId === event.playerId && result.status === "excluded" && result.sourceId === event.sourceId));
          if (event.enabled && excludedByThisEvent) {
            const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
            const stageId = activeAttempt?.stageId;
            if (!stageId) throw new Error("CHEAT_EXCLUSION_ATTEMPT_MISSING");
            runtime.engine.apply({ atMs: Date.parse(parsed.event.occurredAt), sourceId: `${event.sourceId}:excluded`, type: "exclude", stageId, playerId: event.playerId, reason: "cheat-enabled" });
            if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
              this.host.recordExclusionAttention(runtime.competitionId, stageId, event.playerId, event.sourceId, "开启 cheat");
            }
          }
        }
      }
      if (event.type === "login" && parsed.event.type === "player-login" && parsed.event.cheat) {
        const snapshot = runtime.controller.snapshot();
        const activeAttempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === snapshot.currentStageId && candidate.intakeOpen);
        if (!activeAttempt?.results.some((result) => result.playerId === event.playerId)) runtime.controller.observeCheat(event.playerId, true, `${event.sourceId}:cheat-login`);
      }
      this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    }
    this.mirrorSystemResults(runtime);
    this.mirrorVoidedAttempts(runtime);
    this.mirrorClosedAttempts(runtime);
    this.host.completeCompetitionOnReview(runtime.competitionId, runtime.controller.snapshot());
    this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
    this.saveSnapshot(runtime);
  }

  public registerPublishedCustomMaps(
    runtime: WorkRuntime,
    config = this.host.getOperationalConfig(runtime.competitionId),
    processGeneration = runtime.connection.processGeneration,
    connectionGeneration = runtime.connection.connectionGeneration
  ): Promise<void> {
    if (runtime.registeredMapsProcessGeneration === processGeneration) return Promise.resolve();
    const existing = runtime.mapRegistration;
    if (existing?.processGeneration === processGeneration) return existing.promise;
    if (runtime.mapRegistrationAttemptedProcessGeneration === processGeneration) {
      throw new MapRegistrationRequiresRestartError("Map registration was already attempted for this MockClient process; restart is required before retrying");
    }
    runtime.mapRegistrationAttemptedProcessGeneration = processGeneration;
    const queueGeneration = runtime.commands.generation;
    const registration = {
      processGeneration,
      connectionGeneration,
      promise: Promise.resolve()
    };
    const assertCurrent = (): void => {
      const registeredRuntime = this.runtimes.get(runtime.competitionId);
      if (registeredRuntime !== undefined && registeredRuntime !== runtime) throw new StaleConnectionGenerationError("地图注册所属运行已失效");
      if (runtime.mapRegistration !== registration
        || runtime.connection.processGeneration !== processGeneration
        || runtime.connection.connectionGeneration !== connectionGeneration
        || runtime.commands.generation !== queueGeneration) {
        throw new StaleConnectionGenerationError("地图注册所属连接代已失效");
      }
    };
    registration.promise = Promise.resolve().then(async () => {
      for (const stage of [...config.stages].sort((left, right) => left.order - right.order)) {
        assertCurrent();
        if (stageMapKind(stage) === "official") {
          const label = `Level_${String(stage.level).padStart(2, "0")}`;
          const record = await runtime.commands.enqueue({
            type: "set-official-map",
            level: stage.level,
            displayName: label
          }, `official-map:${runtime.competitionId}:p${processGeneration}:c${connectionGeneration}:${stage.id}:${stage.level}`);
          assertCurrent();
          if (record.status !== "acknowledged") {
            if (record.status === "failed" && /permission/i.test(record.responseLine ?? "")) {
              throw new MapRegistrationPermissionError(`ContestConsole cannot register ${label}: permission denied`);
            }
            throw new MapRegistrationRequiresRestartError(`Official map registration became uncertain for ${label} (${record.status})`);
          }
        }
        if (stageMapKind(stage) === "custom" && stage.mapHash) {
          const record = await runtime.commands.enqueue({
            type: "set-map",
            mapHash: stage.mapHash,
            displayName: stageDisplayName(stage)
          }, `custom-map:${runtime.competitionId}:p${processGeneration}:c${connectionGeneration}:${stage.id}:${stage.mapHash.toLowerCase()}`);
          assertCurrent();
          if (record.status !== "acknowledged") {
            if (record.status === "failed" && /permission/i.test(record.responseLine ?? "")) {
              throw new MapRegistrationPermissionError(`ContestConsole cannot register ${stageDisplayName(stage)}: permission denied`);
            }
            throw new MapRegistrationRequiresRestartError(`Custom map registration became uncertain for ${stageDisplayName(stage)} (${record.status})`);
          }
        }
      }
      const expectedNames = [...config.stages]
        .sort((left, right) => left.order - right.order)
        .map((stage) => stageMapKind(stage) === "official"
          ? `Level_${String(stage.level).padStart(2, "0")}`
          : stageDisplayName(stage));
      assertCurrent();
      const listmapRecord = await runtime.commands.enqueue(
        { type: "listmap" },
        `listmap:${runtime.competitionId}:p${processGeneration}:c${connectionGeneration}`
      );
      assertCurrent();
      if (listmapRecord.status !== "acknowledged") {
        this.host.appendAttention(runtime.competitionId, {
          id: `map-verification:${processGeneration}:${connectionGeneration}`,
          category: "command",
          severity: "warning",
          title: "无法验证 setmap 结果",
          message: "listmap 命令未成功；请手动核对地图注册状态。",
          occurredAt: new Date().toISOString()
        });
      } else {
        let seenNames: string[] = [];
        try { seenNames = JSON.parse(listmapRecord.responseLine ?? "[]") as string[]; } catch { /* ignore */ }
        const missing = expectedNames.filter(
          (name) => !seenNames.some((seen) => seen === name || seen.startsWith(`${name}/`))
        );
        if (missing.length > 0) {
          this.host.appendAttention(runtime.competitionId, {
            id: `map-verification:${processGeneration}:${connectionGeneration}`,
            category: "command",
            severity: "warning",
            title: "地图注册验证未通过",
            message: `listmap 未找到: ${missing.join(", ")}。请手动核对。`,
            occurredAt: new Date().toISOString()
          });
        }
      }
      assertCurrent();
      runtime.registeredMapsProcessGeneration = processGeneration;
    }).catch((error: unknown) => {
      if (error instanceof StaleConnectionGenerationError) throw error;
      runtime.controller.pause();
      this.host.appendAttention(runtime.competitionId, {
        id: `custom-map-registration:${processGeneration}:${connectionGeneration}`,
        category: "command",
        severity: "critical",
        title: "地图映射发送失败",
        message: error instanceof Error ? error.message : "MockClient 未接受地图映射命令。",
        occurredAt: new Date().toISOString()
      });
      throw error;
    }).finally(() => {
      if (runtime.mapRegistration === registration) delete runtime.mapRegistration;
    });
    runtime.mapRegistration = registration;
    return registration.promise;
  }

  private handleWarning(runtime: WorkRuntime, config: CompetitionConfig, event: Extract<DomainEvent, { type: "warning" }>): void {
    if (!event.playerName || event.level === undefined || !event.violationCode) {
      this.host.appendAttention(runtime.competitionId, {
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
    const effectivePhase = (snapshot.phase === "paused" || snapshot.phase === "incident") && snapshot.pausedFromPhase
      ? snapshot.pausedFromPhase
      : snapshot.phase;
    const activeAttempt = snapshot.attempts.findLast((attempt) =>
      attempt.stageId === snapshot.currentStageId && attempt.intakeOpen && !attempt.voided);
    if (!activeAttempt || (effectivePhase !== "running" && effectivePhase !== "tail-intake") || stage?.level !== event.level) return;
    const participant = this.host.getDraftConfig(runtime.competitionId).participants.find((candidate) =>
      candidate.id.toLocaleLowerCase("en-US") === event.playerName?.trim().toLocaleLowerCase("en-US"));
    if (!stage || !participant) {
      this.host.appendAttention(runtime.competitionId, {
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
    runtime.controller.observeViolation(participant.id, sourceId, event.violationCode);
    const excluded = runtime.controller.snapshot().attempts.some((attempt) => attempt.id === activeAttempt.id
      && attempt.results.some((result) =>
        result.playerId === participant.id && result.status === "excluded" && result.sourceId === sourceId));
    if (!excluded) return;
    const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
    runtime.engine.apply({ atMs: Date.parse(event.occurredAt), sourceId, type: "exclude", stageId: stage.id, playerId: participant.id, reason: event.violationCode });
    this.observeParticipant(runtime.competitionId, participant.id, participant.connectionIds.at(-1) ?? participant.id, true, "excluded");
    if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
      this.host.recordExclusionAttention(runtime.competitionId, stage.id, participant.id, sourceId, event.message);
    }
    this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
  }

  private handleFatalError(runtime: WorkRuntime, event: Extract<DomainEvent, { type: "fatal-error" }>): void {
    const config = this.host.getDraftConfig(runtime.competitionId);
    const existing = config.participants.find((participant) =>
      participant.id.toLocaleLowerCase("en-US") === event.playerName.trim().toLocaleLowerCase("en-US"));
    const participant = this.observeParticipant(
      runtime.competitionId,
      event.playerName,
      existing?.connectionIds.at(-1) ?? event.playerName,
      false
    );
    if (!participant) return;
    runtime.controller.registerParticipant(participant.id);
    runtime.engine.registerPlayer(participant.id, participant.displayName);
    runtime.controller.observeCrash(participant.id, event.message);
    runtime.controller.observeConnection(participant.id, false);
  }

  private bindOfficialMapEcho(runtime: WorkRuntime, config: CompetitionConfig, event: DomainEvent, snapshot: AutomationSnapshot): void {
    if ((event.type !== "ready" && event.type !== "countdown" && event.type !== "go")
      || event.mapKind !== "official" || !event.mapHashPrefix
      || !this.isLocalRefereeEvent(runtime, event)) return;
    const actionKind = event.type === "ready" ? "ready" : "go";
    const matchingAction = [...snapshot.actions].reverse().find((action) => action.kind === actionKind && action.status === "pending"
      && (event.mode === undefined || action.mode === event.mode));
    if (!matchingAction) return;
    const targetStage = config.stages.find((stage) => stage.id === matchingAction.stageId);
    if (targetStage && stageMapKind(targetStage) === "official") runtime.mapEchoPrefixes.set(targetStage.id, event.mapHashPrefix.toLowerCase());
  }

  private resolveEventStage(runtime: WorkRuntime, config: CompetitionConfig, event: DomainEvent, preferredStageId?: string): StageConfig | undefined {
    if (event.type !== "ready" && event.type !== "countdown" && event.type !== "go" && event.type !== "finish" && event.type !== "dnf") return undefined;
    const modeMatches = (candidate: StageConfig): boolean => event.mode === undefined || candidate.mode.toLowerCase() === event.mode;
    if (event.mapKind === "official" && event.level !== undefined) {
      const candidates = config.stages.filter((candidate) => stageMapKind(candidate) === "official" && candidate.level === event.level && modeMatches(candidate));
      return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    if (event.mapKind === "custom" && event.mapDisplayName) {
      const candidates = config.stages.filter((candidate) =>
        stageMapKind(candidate) === "custom" && stageDisplayName(candidate) === event.mapDisplayName && modeMatches(candidate));
      return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    const prefix = event.mapHashPrefix?.toLowerCase();
    if (!prefix) return undefined;
    if (event.mapKind === "custom") {
      const hashes = [...new Set(config.stages.filter((candidate) => stageMapKind(candidate) === "custom" && candidate.mapHash?.toLowerCase().startsWith(prefix)).map((candidate) => candidate.mapHash?.toLowerCase() ?? ""))];
      if (hashes.length !== 1) return undefined;
      const candidates = config.stages.filter((candidate) => candidate.mapHash?.toLowerCase() === hashes[0] && modeMatches(candidate));
      return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    const candidates = config.stages.filter((candidate) => runtime.mapEchoPrefixes.get(candidate.id) === prefix && modeMatches(candidate));
    return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  }

  private domainToScenarioEvent(runtime: WorkRuntime, config: CompetitionConfig, event: DomainEvent, stage?: StageConfig): ScenarioEvent | undefined {
    const competitionId = runtime.competitionId;
    switch (event.type) {
      case "player-login":
      case "player-listed": {
        const participant = this.observeParticipant(competitionId, event.playerName, event.connectionId, true);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "login", playerId: participant.id, connectionId: event.connectionId } : undefined;
      }
      case "player-disconnect": {
        const participant = this.observeParticipant(competitionId, event.playerName, event.connectionId, false);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "disconnect", playerId: participant.id, connectionId: event.connectionId } : undefined;
      }
      case "go":
        if (!stage || !this.isLocalRefereeEvent(runtime, event)) return undefined;
        return { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "go", stageId: stage.id, refereeConnectionId: "work-referee" };
      case "finish": {
        if (!stage) return undefined;
        const participant = this.observeParticipant(competitionId, event.playerName, event.connectionId, true, "finished");
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "finish", stageId: stage.id, playerId: participant.id, score: event.score, elapsedMs: event.elapsedMs } : undefined;
      }
      case "dnf": {
        if (!stage) return undefined;
        const participant = this.observeParticipant(competitionId, event.playerName, event.connectionId, true, event.cheat ? "excluded" : "dnf");
        return participant ? event.cheat
          ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "exclude", stageId: stage.id, playerId: participant.id, reason: "cheat-dnf" }
          : { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "dnf", stageId: stage.id, playerId: participant.id, reason: "dnf" }
          : undefined;
      }
      case "cheat-changed": {
        const participant = this.observeParticipant(competitionId, event.playerName, event.connectionId, true);
        return participant ? { atMs: Date.parse(event.occurredAt), sourceId: event.sourceId, type: "cheat", playerId: participant.id, enabled: event.enabled } : undefined;
      }
      default: return undefined;
    }
  }

  private isLocalRefereeEvent(
    runtime: WorkRuntime,
    event: Extract<DomainEvent, { type: "ready" | "countdown" | "go" }>
  ): boolean {
    return event.refereeName.trim() === `*${CONTEST_REFEREE_NAME}`
      && runtime.refereeConnectionId !== undefined
      && event.connectionId === runtime.refereeConnectionId;
  }

  private observeListStart(runtime: WorkRuntime, expected: number): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation || reconciliation.settled
      || reconciliation.connectionGeneration !== runtime.connection.connectionGeneration) return;
    if (reconciliation.protocolStyle === "modern" || reconciliation.protocolStyle === "legacy") {
      this.rejectListReconciliation(runtime, reconciliation, new Error("list returned overlapping or mixed response batches"));
      return;
    }
    if (!Number.isSafeInteger(expected) || expected < 0 || reconciliation.seen > 0) {
      this.rejectListReconciliation(runtime, reconciliation, new Error("legacy list header is invalid or arrived after client rows"));
      return;
    }
    reconciliation.protocolStyle = "legacy";
    reconciliation.expected = expected;
    if (expected === 0) this.scheduleListCompletion(runtime, reconciliation);
  }

  private recordListParticipant(runtime: WorkRuntime, event: Extract<DomainEvent, { type: "player-listed" }>): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation || reconciliation.settled
      || reconciliation.connectionGeneration !== runtime.connection.connectionGeneration) return;
    if (reconciliation.summarySeen) {
      this.rejectListReconciliation(runtime, reconciliation, new Error("list returned a client row after its summary"));
      return;
    }
    if (reconciliation.connectionIds.has(event.connectionId)) {
      this.rejectListReconciliation(runtime, reconciliation, new Error(`list repeated connection ID ${event.connectionId}`));
      return;
    }
    reconciliation.connectionIds.add(event.connectionId);
    reconciliation.seen += 1;
    const playerId = event.playerName.trim();
    if (playerId === `*${CONTEST_REFEREE_NAME}`) {
      if (reconciliation.refereeConnectionCount > 0) {
        this.rejectListReconciliation(runtime, reconciliation, new Error("list returned more than one exact *ContestConsole identity"));
        return;
      }
      reconciliation.refereeConnectionCount += 1;
      reconciliation.refereeConnectionIds.add(event.connectionId);
    }
    if (playerId && !playerId.startsWith("*")) {
      const normalizedPlayerId = playerId.toLocaleLowerCase("en-US");
      if (reconciliation.listedPlayers.has(normalizedPlayerId)) {
        this.rejectListReconciliation(runtime, reconciliation, new Error(`list repeated player identity ${playerId}`));
        return;
      }
      reconciliation.onlinePlayerIds.add(normalizedPlayerId);
      reconciliation.listedPlayers.set(normalizedPlayerId, {
        playerName: playerId,
        connectionId: event.connectionId,
        cheat: event.cheat,
        sourceId: event.sourceId
      });
    } else {
      reconciliation.spectatorCount += 1;
    }
    if (reconciliation.expected !== undefined && reconciliation.seen > reconciliation.expected) {
      this.rejectListReconciliation(runtime, reconciliation, new Error(`list returned more rows than announced (${reconciliation.seen}/${reconciliation.expected})`));
    } else if (reconciliation.expected !== undefined && reconciliation.seen === reconciliation.expected) {
      this.scheduleListCompletion(runtime, reconciliation);
    }
  }

  private completeListReconciliation(runtime: WorkRuntime, clients: number, players: number, spectators: number): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation || reconciliation.settled
      || reconciliation.connectionGeneration !== runtime.connection.connectionGeneration) return;
    if (reconciliation.protocolStyle === "legacy" || reconciliation.summarySeen) {
      this.rejectListReconciliation(runtime, reconciliation, new Error("list returned overlapping, repeated, or mixed summaries"));
      return;
    }
    reconciliation.protocolStyle = "modern";
    reconciliation.summarySeen = true;
    reconciliation.expected = clients;
    if (!Number.isSafeInteger(clients) || !Number.isSafeInteger(players) || !Number.isSafeInteger(spectators)
      || clients < 0 || players < 0 || spectators < 0
      || clients !== players + spectators
      || reconciliation.seen !== clients
      || reconciliation.onlinePlayerIds.size !== players
      || reconciliation.spectatorCount !== spectators) {
      this.host.appendAttention(runtime.competitionId, {
        id: `participant-list-mismatch:${Date.now()}`,
        category: "command",
        severity: "warning",
        title: "在线名单汇总需要复核",
        message: `list 汇总为 ${clients} 个连接、${players} 名玩家、${spectators} 名旁观者；已解析 ${reconciliation.seen} 个连接。`,
        occurredAt: new Date().toISOString()
      });
      this.rejectListReconciliation(runtime, reconciliation, new Error(
        `list summary mismatch: ${clients} clients/${players} players/${spectators} spectators, parsed ${reconciliation.seen} clients/${reconciliation.onlinePlayerIds.size} players`
      ));
      return;
    }
    this.scheduleListCompletion(runtime, reconciliation);
  }

  private scheduleListCompletion(runtime: WorkRuntime, reconciliation: ListReconciliation): void {
    if (runtime.listReconciliation !== reconciliation || reconciliation.settled || reconciliation.settleTimer) return;
    reconciliation.settleTimer = setTimeout(() => {
      if (runtime.listReconciliation !== reconciliation || reconciliation.settled) return;
      delete reconciliation.settleTimer;
      this.finishListReconciliation(runtime);
    }, this.dependencies.listSettleDelayMs ?? DEFAULT_LIST_SETTLE_DELAY_MS);
  }

  private rejectListReconciliation(runtime: WorkRuntime, reconciliation: ListReconciliation, error: Error): void {
    if (runtime.listReconciliation !== reconciliation || reconciliation.settled) return;
    reconciliation.settled = true;
    if (reconciliation.timeout) clearTimeout(reconciliation.timeout);
    if (reconciliation.settleTimer) clearTimeout(reconciliation.settleTimer);
    delete runtime.listReconciliation;
    reconciliation.reject?.(error);
  }

  private finishListReconciliation(runtime: WorkRuntime): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation || reconciliation.settled || reconciliation.expected === undefined) return;
    reconciliation.settled = true;
    if (reconciliation.timeout) clearTimeout(reconciliation.timeout);
    if (reconciliation.settleTimer) clearTimeout(reconciliation.settleTimer);
    delete runtime.listReconciliation;
    const result: ListResult = {
      expected: reconciliation.expected,
      seen: reconciliation.seen,
      onlinePlayerIds: reconciliation.onlinePlayerIds,
      refereeConnectionIds: reconciliation.refereeConnectionIds,
      refereeConnectionCount: reconciliation.refereeConnectionCount,
      listedPlayers: reconciliation.listedPlayers
    };
    if (reconciliation.purpose === "participant") this.applyListParticipants(runtime, result);
    reconciliation.resolve?.(result);
  }

  private applyListParticipants(runtime: WorkRuntime, list: ListResult): void {
    const config = this.host.getDraftConfig(runtime.competitionId);
    const knownIds = new Set(config.participants.map((participant) => participant.id.toLocaleLowerCase("en-US")));
    const participants = config.participants.map((participant) => {
      const normalizedPlayerId = participant.id.toLocaleLowerCase("en-US");
      const listed = list.listedPlayers.get(normalizedPlayerId);
      const online = listed !== undefined;
      if (participant.online !== online) runtime.controller.observeConnection(participant.id, online);
      if (!listed) return participant.online === online ? participant : { ...participant, online };
      return {
        ...participant,
        connectionIds: [...new Set([...participant.connectionIds, listed.connectionId])],
        online
      };
    });
    for (const [normalizedPlayerId, listed] of list.listedPlayers) {
      if (knownIds.has(normalizedPlayerId)) continue;
      const alias = config.playerAliases.find((candidate) => candidate.playerId.toLocaleLowerCase("en-US") === normalizedPlayerId);
      const participant: ParticipantView = {
        id: listed.playerName,
        displayName: alias?.displayName ?? listed.playerName,
        role: "participant",
        connectionIds: [listed.connectionId],
        online: true,
        currentStageStatus: "waiting"
      };
      participants.push(participant);
      runtime.controller.registerParticipant(participant.id);
      runtime.controller.observeConnection(participant.id, true);
      runtime.engine.registerPlayer(participant.id, participant.displayName);
      this.host.journal.append({ type: "participant.registered", competitionId: runtime.competitionId, data: participant });
    }
    for (const participant of participants) {
      runtime.controller.registerParticipant(participant.id);
      runtime.engine.registerPlayer(participant.id, participant.displayName);
      const listed = list.listedPlayers.get(participant.id.toLocaleLowerCase("en-US"));
      if (listed?.cheat) runtime.controller.observeCheat(participant.id, true, `${listed.sourceId}:cheat-list`);
    }
    this.host.upsertConfig(runtime.competitionId, 0, false, { ...config, participants });
    this.host.journal.append({ type: "participants.reconciled", competitionId: runtime.competitionId, data: { online: [...list.onlinePlayerIds] } });
    this.saveSnapshot(runtime);
  }

  private observeParticipant(competitionId: string, rawName: string, connectionId: string, online: boolean, stageStatus?: ParticipantView["currentStageStatus"]): ParticipantView | undefined {
    const playerId = rawName.trim();
    if (!playerId || playerId.startsWith("*")) return undefined;
    const config = this.host.getDraftConfig(competitionId);
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
    this.host.upsertConfig(competitionId, 0, false, { ...config, participants });
    if (!existing) this.host.journal.append({ type: "participant.registered", competitionId, data: participant });
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
        mapKind: stage.mapKind,
        ...(stage.mapHash === undefined ? {} : { mapHash: stage.mapHash }),
        displayName: stageDisplayName(stage),
        timeLimitMs: stage.timeLimitMs,
        scoring: [...stage.scoring],
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      events: [],
      expected: { attempts: 0, scoreboardVersions: 0 }
    };
  }
}
