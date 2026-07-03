import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  CONTEST_REFEREE_NAME,
  normalizeRefereeName,
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
  type StageConfig
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
import { CommandQueue, type CommandRecord } from "./command-queue.js";
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
  runtime: WorkAutomationRuntime;
  client?: ManagedMockClient;
  mockClientVersion?: string;
  initialListTimer?: ReturnType<typeof setTimeout>;
  listTimer?: ReturnType<typeof setInterval>;
  automationTimer?: ReturnType<typeof setInterval>;
  automationDispatching?: boolean;
  refereeConnectionId?: string;
  listReconciliation?: { expected?: number; seen: number; onlinePlayerIds: Set<string> };
  mapEchoPrefixes: Map<string, string>;
  customMapRegistration?: Promise<void>;
  customMapsRegistered?: boolean;
  connectionRecoveryState?: "automatic" | "manual" | "failed";
  connectionRecoveryTimer?: ReturnType<typeof setTimeout>;
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
const CONNECTION_RECOVERY_TIMEOUT_MS = 15_000;

export class WorkRuntimeManager {
  private readonly runtimes = new Map<string, WorkRuntime>();

  public constructor(private readonly host: WorkRuntimeHost) {}

  public start(competitionId: string): RuntimeSnapshot {
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
    this.bindManagedClient(runtime, client);
    try {
      client.start();
    } catch (error) {
      this.runtimes.delete(competitionId);
      throw error;
    }
    this.startParticipantReconciliation(runtime);
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

  public async restartClient(competitionId: string): Promise<RuntimeSnapshot> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
    this.clearConnectionRecoveryTimer(runtime);
    runtime.connectionRecoveryState = "manual";
    try {
      await this.replaceClient(runtime);
      this.scheduleConnectionRecoveryTimeout(runtime, "manual");
    } catch (error) {
      this.markConnectionRecoveryFailed(runtime, error instanceof Error ? error.message : "MockClient 启动失败", "manual");
      throw error;
    }
    this.saveSnapshot(runtime);
    this.host.journal.append({ type: "work.mock-client-restarted", competitionId, data: { server: runtime.server, source: "manual" } });
    return this.view(runtime);
  }

  private async replaceClient(runtime: WorkRuntime): Promise<void> {
    const competitionId = runtime.competitionId;
    if (runtime.client?.isRunning) {
      await runtime.client.stop().catch(() => undefined);
      if (runtime.client.isRunning) throw new ServiceError("STATE_CONFLICT", "旧 MockClient 尚未退出，不能启动第二个实例", 409);
    }
    const config = this.host.getOperationalConfig(competitionId);
    const executable = resolve(serverWindowsRoot(), "BallanceMMOMockClient.exe");
    if (!existsSync(executable)) throw new ServiceError("MOCK_CLIENT_MISSING", "未找到 BallanceMMOMockClient.exe", 500, { executable });
    const logPath = join(resolve(this.host.dataRoot), "work", competitionId, "logs", "mockclient.log");
    const client = this.createManagedClient(config, executable, logPath);
    runtime.client = client;
    runtime.commands.replaceTransport(client);
    delete runtime.refereeConnectionId;
    runtime.customMapsRegistered = false;
    delete runtime.customMapRegistration;
    this.bindManagedClient(runtime, client);
    client.start();
    if (runtime.initialListTimer) clearTimeout(runtime.initialListTimer);
    if (runtime.listTimer) clearInterval(runtime.listTimer);
    this.startParticipantReconciliation(runtime);
    this.startRealtime(runtime);
  }

  public view(runtime: WorkRuntime): RuntimeSnapshot {
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.host.commandHistory(runtime.competitionId), plannedStageStartAt(snapshot, origin), plannedReadyAt(snapshot, origin), undefined,
      this.host.availableActionsFor(runtime.competitionId, snapshot), this.host.attentionItemsFor(runtime.competitionId, snapshot), stageDeadlineAt(snapshot, origin),
      this.host.unconfirmedCommandsFor(runtime.competitionId, snapshot), this.host.observationGapsFor(runtime.competitionId));
  }

  public get(competitionId: string): WorkRuntime | undefined { return this.runtimes.get(competitionId); }
  public has(competitionId: string): boolean { return this.runtimes.has(competitionId); }
  public entries(): IterableIterator<[string, WorkRuntime]> { return this.runtimes.entries(); }

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
      (action) => action.type === "go" ? 15_000 : 10_000,
      (record) => this.host.recordCommand(competitionId, record)
    );
    const engine = new CompetitionEngine(definition);
    const restoredEngine = initialSnapshot ? this.host.restoredEngineSnapshot(competitionId, initialSnapshot) : undefined;
    if (restoredEngine) engine.restore(restoredEngine);
    const runtime: WorkRuntime = {
      competitionId,
      server: config.server,
      controller,
      engine,
      commands,
      runtime: new WorkAutomationRuntime(controller, commands),
      mapEchoPrefixes: new Map(Object.entries(this.host.getPayload(competitionId).work?.mapEchoPrefixes ?? {})),
      ...(mockClientVersion === undefined ? {} : { mockClientVersion }),
      ...(transport instanceof ManagedMockClient ? { client: transport } : {})
    };
    return runtime;
  }

  public register(competitionId: string, runtime: WorkRuntime): void { this.runtimes.set(competitionId, runtime); }

  private createManagedClient(config: CompetitionConfig, executable: string, logPath: string): ManagedMockClient {
    return new ManagedMockClient({
      executable,
      workingDirectory: serverWindowsRoot(),
      server: config.server,
      refereeName: config.refereeName,
      uuid: resolveMockClientUuid(serverWindowsRoot(), randomUUID()),
      logPath
    });
  }

  private bindManagedClient(runtime: WorkRuntime, client: ManagedMockClient): void {
    client.onLine((line) => {
      runtime.commands.observeLine(line);
      this.ingestLine(runtime, line);
    });
    client.onExit((info) => {
      if (info.expected || this.runtimes.get(runtime.competitionId) !== runtime || runtime.client !== client) return;
      const evidence = `MockClient 进程意外退出（code=${info.code ?? "null"}, signal=${info.signal ?? "none"}）`;
      if (runtime.connectionRecoveryState === "automatic" || runtime.connectionRecoveryState === "manual") {
        this.markConnectionRecoveryFailed(runtime, evidence, runtime.connectionRecoveryState);
      } else if (runtime.connectionRecoveryState !== "failed") {
        this.handleUnexpectedDisconnect(runtime, evidence);
      }
      this.host.journal.append({ type: "work.mock-client-exited", competitionId: runtime.competitionId, data: info });
    });
  }

  private handleUnexpectedDisconnect(runtime: WorkRuntime, evidence: string): void {
    runtime.controller.observeServerDisconnect(evidence);
    if (runtime.connectionRecoveryState) {
      this.saveSnapshot(runtime);
      return;
    }
    runtime.connectionRecoveryState = "automatic";
    this.host.appendAttention(runtime.competitionId, {
      id: `connection-auto-restart:${Date.now()}`,
      category: "incident",
      severity: "warning",
      title: "连接中断，正在自动恢复",
      message: "已冻结后续发令并自动重启一次比赛连接；若 15 秒内仍未连接，将开放人工重新连接。",
      occurredAt: new Date().toISOString()
    });
    this.saveSnapshot(runtime);
    void this.replaceClient(runtime).then(() => {
      if (runtime.connectionRecoveryState === "automatic") this.scheduleConnectionRecoveryTimeout(runtime, "automatic");
      this.host.journal.append({ type: "work.mock-client-restarted", competitionId: runtime.competitionId, data: { server: runtime.server, source: "automatic" } });
    }).catch((error: unknown) => {
      this.markConnectionRecoveryFailed(runtime, error instanceof Error ? error.message : "MockClient 自动重启失败", "automatic");
    });
  }

  private scheduleConnectionRecoveryTimeout(runtime: WorkRuntime, source: "automatic" | "manual"): void {
    this.clearConnectionRecoveryTimer(runtime);
    runtime.connectionRecoveryTimer = setTimeout(() => {
      if (runtime.connectionRecoveryState !== source) return;
      this.markConnectionRecoveryFailed(runtime, "15 秒内未观察到 Connected to server OK", source);
    }, CONNECTION_RECOVERY_TIMEOUT_MS);
    runtime.connectionRecoveryTimer.unref?.();
  }

  private markConnectionRecoveryFailed(runtime: WorkRuntime, detail: string, source: "automatic" | "manual"): void {
    if (runtime.connectionRecoveryState === "failed") return;
    this.clearConnectionRecoveryTimer(runtime);
    runtime.connectionRecoveryState = "failed";
    runtime.controller.observeServerDisconnect(detail);
    this.host.appendAttention(runtime.competitionId, {
      id: `connection-recovery-failed:${Date.now()}`,
      category: "incident",
      severity: "critical",
      title: source === "automatic" ? "自动恢复连接失败" : "重新连接失败",
      message: `${detail}；请使用“重新连接比赛服务器”再次尝试。`,
      occurredAt: new Date().toISOString(),
      action: "restart-work"
    });
    this.saveSnapshot(runtime);
  }

  private clearConnectionRecoveryTimer(runtime: WorkRuntime): void {
    if (!runtime.connectionRecoveryTimer) return;
    clearTimeout(runtime.connectionRecoveryTimer);
    delete runtime.connectionRecoveryTimer;
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
      const records = await runtime.runtime.dispatch();
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
    const requestList = () => { void runtime.commands.enqueue({ type: "list" }, `participant-list:${runtime.competitionId}:${Date.now()}`); };
    runtime.initialListTimer = setTimeout(requestList, 1_000);
    runtime.initialListTimer.unref?.();
    runtime.listTimer = setInterval(requestList, 30_000);
    runtime.listTimer.unref?.();
  }

  public beginListReconciliation(runtime: WorkRuntime, expected?: number): void {
    runtime.listReconciliation = { ...(expected === undefined ? {} : { expected }), seen: 0, onlinePlayerIds: new Set() };
    if (expected === 0) this.finishListReconciliation(runtime);
  }

  public saveSnapshot(runtime: WorkRuntime): void {
    const payload = this.host.getPayload(runtime.competitionId);
    this.host.savePayload(runtime.competitionId, {
      ...payload,
      work: {
        started: true,
        ...(runtime.mockClientVersion === undefined ? {} : { mockClientVersion: runtime.mockClientVersion }),
        automation: runtime.controller.snapshot(),
        engine: runtime.engine.snapshot(),
        mapEchoPrefixes: Object.fromEntries(runtime.mapEchoPrefixes)
      }
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

  public async remove(competitionId: string): Promise<void> {
    const runtime = this.runtimes.get(competitionId);
    if (!runtime) return;
    this.stopRealtime(runtime);
    if (runtime.initialListTimer) clearTimeout(runtime.initialListTimer);
    if (runtime.listTimer) clearInterval(runtime.listTimer);
    this.clearConnectionRecoveryTimer(runtime);
    await runtime.client?.stop().catch(() => undefined);
    this.runtimes.delete(competitionId);
  }

  public close(): void {
    for (const runtime of this.runtimes.values()) {
      this.stopRealtime(runtime);
      if (runtime.initialListTimer) clearTimeout(runtime.initialListTimer);
      if (runtime.listTimer) clearInterval(runtime.listTimer);
      this.clearConnectionRecoveryTimer(runtime);
      void runtime.client?.stop().catch(() => undefined);
    }
  }

  // Log ingestion, participant reconciliation and event attribution are kept together below.

  public ingestLine(runtime: WorkRuntime, line: string): void {
    const config = this.host.getPublishedConfig(runtime.competitionId);
    if (!config) return;
    this.host.appendRawLog(runtime.competitionId, "mock-client", line);
    const parsed = parseLogLine(line, { year: Number(config.date.slice(0, 4)), utcOffsetMinutes: utcOffsetMinutes(config.timezone) });
    if (parsed.event.type === "connected") {
      delete runtime.refereeConnectionId;
      runtime.commands.setRefereeConnectionId(undefined);
      runtime.controller.observeServerConnected();
      if (runtime.connectionRecoveryState) {
        this.clearConnectionRecoveryTimer(runtime);
        delete runtime.connectionRecoveryState;
        this.host.appendAttention(runtime.competitionId, {
          id: `connection-recovered:${parsed.sourceId}`,
          category: "incident",
          severity: "info",
          title: "比赛服务器连接已恢复",
          message: "自动化保持暂停；请核对现场后再恢复发令。",
          occurredAt: parsed.event.occurredAt
        });
      }
      void this.registerPublishedCustomMaps(runtime, config).catch(() => undefined);
    }
    if (parsed.event.type === "server-disconnected") this.handleUnexpectedDisconnect(runtime, "MockClient 与比赛服务器断开连接");
    if (parsed.event.type === "permission-denied") runtime.controller.observePermissionDenied(parsed.event.message);
    if (parsed.event.type === "fatal-error") this.handleFatalError(runtime, parsed.event);
    this.observeRefereeConnection(runtime, parsed.event);
    const before = runtime.controller.snapshot();
    const currentStage = config.stages.find((candidate) => candidate.id === before.currentStageId);
    this.bindOfficialMapEcho(runtime, config, parsed.event, before);
    const eventStage = this.resolveEventStage(runtime, config, parsed.event, before.currentStageId);
    if ((parsed.event.type === "finish" || parsed.event.type === "dnf")
      && (before.phase === "running" || before.phase === "tail-intake")
      && currentStage && eventStage?.id !== currentStage.id) {
      this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
      this.saveSnapshot(runtime);
      return;
    }
    if (parsed.event.type === "player-list-start") this.beginListReconciliation(runtime, parsed.event.count);
    if (parsed.event.type === "player-list-summary") this.completeListReconciliation(runtime, parsed.event.clients, parsed.event.players, parsed.event.spectators);
    if (parsed.event.type === "countdown" && this.isLocalRefereeEvent(runtime, parsed.event) && eventStage?.id === currentStage?.id) {
      runtime.controller.observeCountdown(parsed.event.value);
    }
    if (parsed.event.type === "warning") this.handleWarning(runtime, config, parsed.event);
    if (parsed.event.type === "unknown" && typeof (parsed.event as { text?: string }).text === "string" && /toggled cheat off globally/i.test((parsed.event as { text?: string }).text ?? "")) runtime.controller.resetAllCheat();
    const event = this.domainToScenarioEvent(runtime, config, parsed.event, eventStage);
    if (event) {
      if ("playerId" in event) {
        runtime.controller.registerParticipant(event.playerId);
        const participant = this.host.getDraftConfig(runtime.competitionId).participants.find((candidate) => candidate.id === event.playerId);
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
        this.host.recordExclusionAttention(runtime.competitionId, event.stageId, event.playerId, event.sourceId, event.reason);
      } else if (event.type === "cheat") {
        const snapshotBeforeCheat = runtime.controller.snapshot();
        const activeAttempt = [...snapshotBeforeCheat.attempts].reverse().find((candidate) => candidate.stageId === snapshotBeforeCheat.currentStageId && candidate.intakeOpen);
        const playerAlreadyCompleted = activeAttempt?.results.some((result) => result.playerId === event.playerId) ?? false;
        if (!playerAlreadyCompleted) {
          runtime.controller.observeCheat(event.playerId, event.enabled, event.sourceId);
          const snapshot = runtime.controller.snapshot();
          const excludedByThisEvent = snapshot.attempts.some((attempt) => attempt.results.some((result) =>
            result.playerId === event.playerId && result.status === "excluded" && result.sourceId === event.sourceId));
          if (event.enabled && excludedByThisEvent && (snapshot.phase === "running" || snapshot.phase === "tail-intake")) {
            const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
            runtime.engine.apply({ atMs: Date.parse(parsed.event.occurredAt), sourceId: `${event.sourceId}:excluded`, type: "exclude", stageId: snapshot.currentStageId, playerId: event.playerId, reason: "cheat-enabled" });
            if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
              this.host.recordExclusionAttention(runtime.competitionId, snapshot.currentStageId, event.playerId, event.sourceId, "开启 cheat");
            }
          }
        }
      }
      if (event.type === "finish" && parsed.event.type === "finish" && parsed.event.cheat) {
        const exclusionSourceId = `${event.sourceId}:cheat-finish`;
        const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
        runtime.engine.apply({ atMs: event.atMs, sourceId: exclusionSourceId, type: "exclude", stageId: event.stageId, playerId: event.playerId, reason: "cheat-finish" });
        runtime.controller.observeViolation(event.playerId, exclusionSourceId, "cheat-finish");
        this.observeParticipant(runtime.competitionId, parsed.event.playerName, parsed.event.connectionId, true, "excluded");
        if (runtime.engine.snapshot().scoreboardVersions.length > versionCount) {
          this.host.recordExclusionAttention(runtime.competitionId, event.stageId, event.playerId, exclusionSourceId, "[CHEAT] 完赛");
        }
      }
      if (event.type === "login" && (parsed.event.type === "player-login" || parsed.event.type === "player-listed") && parsed.event.cheat) {
        const snapshot = runtime.controller.snapshot();
        const activeAttempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === snapshot.currentStageId && candidate.intakeOpen);
        if (!activeAttempt?.results.some((result) => result.playerId === event.playerId)) runtime.controller.observeCheat(event.playerId, true, `${event.sourceId}:cheat-login`);
      }
      this.host.saveScoreboards(runtime.competitionId, runtime.engine.snapshot().scoreboardVersions);
    }
    this.mirrorSystemResults(runtime);
    this.mirrorVoidedAttempts(runtime);
    if (parsed.event.type === "player-listed") this.recordListParticipant(runtime, parsed.event.playerName);
    this.host.completeCompetitionOnReview(runtime.competitionId, runtime.controller.snapshot());
    this.host.journal.append({ type: "work.log", competitionId: runtime.competitionId, data: parsed });
    this.saveSnapshot(runtime);
  }

  public registerPublishedCustomMaps(runtime: WorkRuntime, config = this.host.getOperationalConfig(runtime.competitionId)): Promise<void> {
    if (runtime.customMapsRegistered) return Promise.resolve();
    if (runtime.customMapRegistration) return runtime.customMapRegistration;
    runtime.customMapRegistration = (async () => {
      for (const stage of [...config.stages].sort((left, right) => left.order - right.order)) {
        if (stageMapKind(stage) === "official") {
          const label = `Level_${String(stage.level).padStart(2, "0")}`;
          const record = await runtime.commands.enqueue({
            type: "set-official-map",
            level: stage.level,
            displayName: label
          }, `official-map:${runtime.competitionId}:${stage.id}:${stage.level}`);
          if (record.status !== "acknowledged") throw new Error(`Official map registration failed for ${label}`);
        }
        if (stageMapKind(stage) === "custom" && stage.mapHash) {
          const record = await runtime.commands.enqueue({
            type: "set-map",
            mapHash: stage.mapHash,
            displayName: stageDisplayName(stage)
          }, `custom-map:${runtime.competitionId}:${stage.id}:${stage.mapHash.toLowerCase()}`);
          if (record.status !== "acknowledged") throw new Error(`Custom map registration failed for ${stageDisplayName(stage)}`);
        }
      }
      // Verify all registrations via listmap
      const expectedNames = [...config.stages]
        .sort((left, right) => left.order - right.order)
        .map((stage) => {
          if (stageMapKind(stage) === "official") return `Level_${String(stage.level).padStart(2, "0")}`;
          return stageDisplayName(stage);
        });
      const listmapRecord = await runtime.commands.enqueue(
        { type: "listmap" },
        `listmap:${runtime.competitionId}:${Date.now()}`
      );
      if (listmapRecord.status !== "acknowledged") {
        this.host.appendAttention(runtime.competitionId, {
          id: `map-verification:${Date.now()}`,
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
            id: `map-verification:${Date.now()}`,
            category: "command",
            severity: "warning",
            title: "地图注册验证未通过",
            message: `listmap 未找到: ${missing.join(", ")}。请手动核对。`,
            occurredAt: new Date().toISOString()
          });
        }
      }
      runtime.customMapsRegistered = true;
    })().catch((error) => {
      delete runtime.customMapRegistration;
      runtime.controller.pause();
      this.host.appendAttention(runtime.competitionId, {
        id: `custom-map-registration:${Date.now()}`,
        category: "command",
        severity: "critical",
        title: "自制图映射发送失败",
        message: error instanceof Error ? error.message : "MockClient 未接受自制图映射命令。",
        occurredAt: new Date().toISOString()
      });
      throw error;
    });
    return runtime.customMapRegistration;
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
    if ((snapshot.phase !== "running" && snapshot.phase !== "tail-intake") || stage?.level !== event.level) return;
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
    const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
    runtime.engine.apply({ atMs: Date.parse(event.occurredAt), sourceId, type: "exclude", stageId: stage.id, playerId: participant.id, reason: event.violationCode });
    runtime.controller.observeViolation(participant.id, sourceId, event.violationCode);
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
    const matchingAction = [...snapshot.actions].reverse().find((action) => action.kind === actionKind && action.status === "pending");
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
        stageMapKind(candidate) === "custom" && stageDisplayName(candidate) === event.mapDisplayName);
      return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    const prefix = event.mapHashPrefix?.toLowerCase();
    if (!prefix) return undefined;
    if (event.mapKind === "custom") {
      const hashes = [...new Set(config.stages.filter((candidate) => stageMapKind(candidate) === "custom" && candidate.mapHash?.toLowerCase().startsWith(prefix)).map((candidate) => candidate.mapHash?.toLowerCase() ?? ""))];
      if (hashes.length !== 1) return undefined;
      const candidates = config.stages.filter((candidate) => candidate.mapHash?.toLowerCase() === hashes[0]);
      return candidates.find((candidate) => candidate.id === preferredStageId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    }
    const candidates = config.stages.filter((candidate) => runtime.mapEchoPrefixes.get(candidate.id) === prefix);
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

  private observeRefereeConnection(runtime: WorkRuntime, event: DomainEvent): void {
    if (event.type === "player-listed") {
      if (normalizeRefereeName(event.playerName) === CONTEST_REFEREE_NAME) {
        runtime.refereeConnectionId = event.connectionId;
        runtime.commands.setRefereeConnectionId(event.connectionId);
      }
      return;
    }
    if ((event.type === "ready" || event.type === "countdown" || event.type === "go" || event.type === "notification")
      && event.connectionId && normalizeRefereeName(event.refereeName) === CONTEST_REFEREE_NAME
      && runtime.refereeConnectionId === undefined) {
      runtime.refereeConnectionId = event.connectionId;
      runtime.commands.setRefereeConnectionId(event.connectionId);
    }
  }

  private isLocalRefereeEvent(
    runtime: WorkRuntime,
    event: Extract<DomainEvent, { type: "ready" | "countdown" | "go" }>
  ): boolean {
    return normalizeRefereeName(event.refereeName) === CONTEST_REFEREE_NAME
      && runtime.refereeConnectionId !== undefined
      && event.connectionId === runtime.refereeConnectionId;
  }

  private recordListParticipant(runtime: WorkRuntime, rawName: string): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation) return;
    reconciliation.seen += 1;
    const playerId = rawName.trim();
    if (playerId && !playerId.startsWith("*")) reconciliation.onlinePlayerIds.add(playerId.toLocaleLowerCase("en-US"));
    if (reconciliation.expected !== undefined && reconciliation.seen >= reconciliation.expected) this.finishListReconciliation(runtime);
  }

  private completeListReconciliation(runtime: WorkRuntime, clients: number, players: number, spectators: number): void {
    const reconciliation = runtime.listReconciliation ?? { seen: 0, onlinePlayerIds: new Set<string>() };
    runtime.listReconciliation = reconciliation;
    reconciliation.expected = clients;
    if (reconciliation.seen !== clients || reconciliation.onlinePlayerIds.size !== players) {
      this.host.appendAttention(runtime.competitionId, {
        id: `participant-list-mismatch:${Date.now()}`,
        category: "command",
        severity: "warning",
        title: "在线名单汇总需要复核",
        message: `list 汇总为 ${clients} 个连接、${players} 名玩家、${spectators} 名旁观者；已解析 ${reconciliation.seen} 个连接。`,
        occurredAt: new Date().toISOString()
      });
    }
    this.finishListReconciliation(runtime);
  }

  private finishListReconciliation(runtime: WorkRuntime): void {
    const reconciliation = runtime.listReconciliation;
    if (!reconciliation) return;
    const config = this.host.getDraftConfig(runtime.competitionId);
    const participants = config.participants.map((participant) => {
      const online = reconciliation.onlinePlayerIds.has(participant.id.toLocaleLowerCase("en-US"));
      if (participant.online !== online) runtime.controller.observeConnection(participant.id, online);
      return participant.online === online ? participant : { ...participant, online };
    });
    this.host.upsertConfig(runtime.competitionId, 0, false, { ...config, participants });
    delete runtime.listReconciliation;
    this.host.journal.append({ type: "participants.reconciled", competitionId: runtime.competitionId, data: { online: [...reconciliation.onlinePlayerIds] } });
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
