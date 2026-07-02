import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  capabilitiesFor,
  createDefaultCompetitionConfig,
  minimumScoringPlaceFor,
  stageDisplayName,
  stageMapKind,
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
  type RawClientLogLine,
  type RefereeActionId,
  type RuntimeSnapshot,
  type ScenarioDefinition,
  type StageConfig,
  type ScoreboardOverrideInput,
  type ScoreboardVersionView,
  type TestRunSnapshot,
  type TestScenarioSummary
} from "@ballance/contracts";
import {
  ScoreboardRevisionLedger,
  type AutomationAction,
  type AutomationSnapshot,
  type CompetitionController,
  type EngineSnapshot,
  type ScoreboardVersion
} from "@ballance/core";
import type { CreatedArchive } from "./archive.js";
import type { CommandAction, CommandRecord } from "./command-queue.js";
import { CompetitionAuditService } from "./competition-audit-service.js";
import { EventJournal } from "./event-journal.js";
import {
  automationView,
  commandView,
  plannedReadyAt,
  plannedStageStartAt,
  scoreboardView,
  simulatedCommand,
  stageDeadlineAt
} from "./runtime-shared.js";
import type { ServiceSnapshotPayload } from "./runtime-types.js";
import { ScoreboardService } from "./scoreboard-service.js";
import { RefereeActionService } from "./referee-action-service.js";
import { ServiceError } from "./service-error.js";
import type { OpenedDatabase } from "./storage/database.js";
import { TestRuntimeManager } from "./test-runtime-manager.js";
import { WorkRuntimeManager } from "./work-runtime-manager.js";

export { ServiceError } from "./service-error.js";
export { seededBehaviorRandom } from "./runtime-shared.js";

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

const migrateStageMap = (stage: StageConfig & { mapKind?: "official" | "custom" }): StageConfig => {
  if (stageMapKind(stage) === "custom") {
    return {
      ...stage,
      mapKind: "custom",
      mapHash: stage.mapHash?.trim().toLowerCase() ?? "",
      level: 0,
      label: stage.label.trim()
    };
  }
  const official: StageConfig = { ...stage, mapKind: "official", label: stageDisplayName({ ...stage, mapKind: "official" }) };
  delete official.mapHash;
  return official;
};

export class CompetitionService {
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly testRuntimeManager: TestRuntimeManager;
  private readonly workRuntimeManager: WorkRuntimeManager;
  private readonly scoreboardService: ScoreboardService;
  private readonly auditService: CompetitionAuditService;
  private readonly refereeActionService: RefereeActionService;
  private readonly idempotency = new Map<string, unknown>();
  private readonly confirmations = new Map<string, ConfirmationRecord>();

  public constructor(
    public readonly journal = new EventJournal(),
    private readonly options: { database?: OpenedDatabase; dataRoot?: string } = {}
  ) {
    this.scoreboardService = new ScoreboardService(options.database);
    this.auditService = new CompetitionAuditService(options.database, this.journal, (competitionId) => {
      const runtime = this.workRuntimeManager.get(competitionId);
      if (runtime) this.workRuntimeManager.beginListReconciliation(runtime);
    });
    this.testRuntimeManager = new TestRuntimeManager({
      getCompetition: (competitionId) => this.get(competitionId),
      getDraftConfig: (competitionId) => this.getDraftConfig(competitionId),
      upsertConfig: (competitionId, version, immutable, config) => this.upsertConfig(competitionId, version, immutable, config),
      getPayload: (competitionId) => this.getPayload(competitionId),
      savePayload: (competitionId, payload) => this.savePayload(competitionId, payload),
      setActiveRun: (competitionId, runId) => {
        const record = this.competitions.get(competitionId);
        if (record) this.competitions.set(competitionId, { ...record, activeRunId: runId });
      },
      saveScoreboards: (competitionId, versions) => this.scoreboardService.saveVersions(competitionId, versions),
      storedScoreboardVersions: (competitionId) => this.scoreboardService.storedVersions(competitionId),
      appendRawLog: (competitionId, source, line, occurredAt) => this.appendRawLog(competitionId, source, line, occurredAt),
      appendAttention: (competitionId, item) => this.appendAttention(competitionId, item),
      recordAutomationAttention: (competitionId, action) => this.recordAutomationAttention(competitionId, action),
      completeCompetitionOnReview: (competitionId, snapshot) => this.completeCompetitionOnReview(competitionId, snapshot),
      commandHistory: (competitionId) => this.commandHistory(competitionId),
      availableActionsFor: (competitionId, snapshot) => this.availableActionsFor(competitionId, snapshot),
      attentionItemsFor: (competitionId, snapshot) => this.attentionItemsFor(competitionId, snapshot),
      scoreboardVersions: (competitionId) => this.snapshot(competitionId).scoreboardVersions,
      toScoreboardVersion: (competitionId, view) => this.scoreboardService.toVersion(view, this.getDraftConfig(competitionId).participants.length),
      journal: this.journal
    });
    this.workRuntimeManager = new WorkRuntimeManager({
      getCompetition: (competitionId) => this.get(competitionId),
      getDraftConfig: (competitionId) => this.getDraftConfig(competitionId),
      getPublishedConfig: (competitionId) => this.getPublishedConfig(competitionId),
      getOperationalConfig: (competitionId) => this.getOperationalWorkConfig(competitionId),
      getPayload: (competitionId) => this.getPayload(competitionId),
      savePayload: (competitionId, payload) => this.savePayload(competitionId, payload),
      upsertConfig: (competitionId, version, immutable, config) => this.upsertConfig(competitionId, version, immutable, config),
      assertActionAvailable: (competitionId, action, snapshot) => this.assertActionAvailable(competitionId, action, snapshot),
      appendRawLog: (competitionId, source, line, occurredAt) => this.appendRawLog(competitionId, source, line, occurredAt),
      appendAttention: (competitionId, item) => this.appendAttention(competitionId, item),
      recordAutomationAttention: (competitionId, action) => this.recordAutomationAttention(competitionId, action),
      recordExclusionAttention: (competitionId, stageId, playerId, sourceId, reason) => this.recordExclusionAttention(competitionId, stageId, playerId, sourceId, reason),
      completeCompetitionOnReview: (competitionId, snapshot) => this.completeCompetitionOnReview(competitionId, snapshot),
      saveScoreboards: (competitionId, versions) => this.scoreboardService.saveVersions(competitionId, versions),
      recordCommand: (competitionId, record) => this.recordCommand(competitionId, record),
      commandHistory: (competitionId) => this.commandHistory(competitionId),
      availableActionsFor: (competitionId, snapshot) => this.availableActionsFor(competitionId, snapshot),
      attentionItemsFor: (competitionId, snapshot) => this.attentionItemsFor(competitionId, snapshot),
      journal: this.journal,
      dataRoot: resolve(options.dataRoot ?? process.cwd())
    });
    this.refereeActionService = new RefereeActionService({
      getCompetition: (competitionId) => this.get(competitionId),
      getPayload: (competitionId) => this.getPayload(competitionId),
      getDraftConfig: (competitionId) => this.getDraftConfig(competitionId),
      getPublishedConfig: (competitionId) => this.getPublishedConfig(competitionId),
      upsertConfig: (competitionId, config) => this.upsertConfig(competitionId, 0, false, config),
      controllerFor: (competitionId) => this.controllerFor(competitionId),
      saveScoreboards: (competitionId, versions) => this.saveScoreboards(competitionId, versions),
      completeCompetitionOnReview: (competitionId, snapshot) => this.completeCompetitionOnReview(competitionId, snapshot),
      appendAttention: (competitionId, item) => this.appendAttention(competitionId, item),
      testRuntimeManager: this.testRuntimeManager,
      workRuntimeManager: this.workRuntimeManager
    });
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
    const workRuntime = this.workRuntimeManager.get(id);
    const persistedWorkAutomation = payload.work?.automation;
    const workAutomation = workRuntime?.controller.snapshot() ?? (persistedWorkAutomation
      ? competition.status === "finished" || competition.status === "archived"
        ? persistedWorkAutomation
        : {
            ...persistedWorkAutomation,
            phase: "paused" as const,
            automationEnabled: false,
            blockers: [
              ...persistedWorkAutomation.blockers.filter((blocker) => blocker.code !== "AUTOMATION_PAUSED"),
              { code: "AUTOMATION_PAUSED" as const, severity: "critical" as const, autoRecoverable: false, suggestion: "服务已重启；请核对服务器现场和不确定命令后重新启动工作运行。" }
            ]
          }
      : undefined);
    const workScoreboard = workRuntime?.engine.snapshot().scoreboardVersions.map(scoreboardView) ?? this.storedScoreboardVersions(id);
    const testScoreboard = testRun?.engine.scoreboardVersions ?? [];
    const scoreboardVersions = this.applyPlayerAliases(config, [
      ...(competition.mode === "test" ? testScoreboard : workScoreboard),
      ...((competition.mode === "work" && !workRuntime) ? [] : payload.scoreboardRevisions ?? [])
    ].sort((left, right) => left.version - right.version));
    const runtime = competition.mode === "test"
      ? testRun?.automation ?? automationView("test")
      : automationView(
          "work",
          workAutomation,
          this.commandHistory(id),
          workAutomation ? plannedStageStartAt(workAutomation, Date.now() - performance.now()) : undefined,
          workAutomation ? plannedReadyAt(workAutomation, Date.now() - performance.now()) : undefined,
          undefined,
          this.availableActionsFor(id, workAutomation),
          this.attentionItemsFor(id, workAutomation),
          workAutomation ? stageDeadlineAt(workAutomation, Date.now() - performance.now()) : undefined
        );
    return {
      competition,
      config,
      ...(this.getPublishedConfig(id) === undefined ? {} : { publishedConfig: this.getPublishedConfig(id) as CompetitionConfig }),
      runtime: { ...runtime, scoreEditPermissions: this.scoreEditPermissionsFor(id, competition.status, runtime.currentStageId) },
      scoreboardVersions,
      currentScoreboard: scoreboardVersions.at(-1)?.entries ?? [],
      scoreboardOverrides: this.scoreboardOverrideHistory(id),
      ...(testRun === undefined ? {} : { testRun }),
      archives: payload.archives ?? []
    };
  }

  public getRawClientLogs(competitionId: string, limit = 200): readonly RawClientLogLine[] {
    this.get(competitionId);
    return this.auditService.rawClientLogs(competitionId, limit);
  }

  public listTestScenarios(): readonly TestScenarioSummary[] {
    return this.testRuntimeManager.listScenarios();
  }

  public getTestScenario(id: string): ScenarioDefinition {
    return this.testRuntimeManager.getScenario(id);
  }

  public createTestRunFromScenario(competitionId: string, scenarioId: string): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    return this.testRuntimeManager.createFromScenario(competitionId, scenarioId);
  }

  public createTestRun(competitionId: string, input: unknown): { runId: string; snapshot: EngineSnapshot; run: TestRunSnapshot } {
    return this.testRuntimeManager.create(competitionId, input);
  }

  public advanceTestRun(competitionId: string, runId: string, all: boolean): EngineSnapshot {
    return this.testRuntimeManager.advance(competitionId, runId, all);
  }

  public actTestPlayers(competitionId: string, runId: string): TestRunSnapshot {
    return this.testRuntimeManager.actPlayers(competitionId, runId);
  }

  public resetTestRun(competitionId: string, runId: string): EngineSnapshot {
    return this.testRuntimeManager.reset(competitionId, runId);
  }

  public startTestAutomation(competitionId: string, runId: string, readyInMs = 0): AutomationSnapshot {
    return this.testRuntimeManager.startAutomation(competitionId, runId, readyInMs);
  }

  public advanceTestAutomation(competitionId: string, runId: string, milliseconds: number): AutomationSnapshot {
    return this.testRuntimeManager.advanceAutomation(competitionId, runId, milliseconds);
  }

  public getTestAutomation(competitionId: string, runId: string): AutomationSnapshot {
    return this.testRuntimeManager.automationSnapshot(competitionId, runId);
  }

  public getTestRunSnapshot(competitionId: string, runId: string): TestRunSnapshot {
    return this.testRuntimeManager.snapshot(competitionId, runId);
  }

  public getTestScoreboardVersion(competitionId: string, runId: string, version?: number): {
    competition: CompetitionRecord;
    definition: ScenarioDefinition;
    scoreboard: ScoreboardVersion;
    automation: AutomationSnapshot;
  } {
    return this.testRuntimeManager.scoreboardVersion(competitionId, runId, version) as {
      competition: CompetitionRecord;
      definition: ScenarioDefinition;
      scoreboard: ScoreboardVersion;
      automation: AutomationSnapshot;
    };
  }

  public getLatestScoreboard(id: string, version?: number): ScoreboardVersion {
    const snapshot = this.snapshot(id);
    const selected = version === undefined ? snapshot.scoreboardVersions.at(-1) : snapshot.scoreboardVersions.find((candidate) => candidate.version === version);
    if (!selected) throw new ServiceError("NOT_FOUND", "榜单版本不存在", 404);
    return this.toScoreboardVersion(id, selected);
  }

  public startWorkMode(competitionId: string): RuntimeSnapshot {
    return this.workRuntimeManager.start(competitionId);
  }

  public async enableAutomation(competitionId: string, input: {
    runId?: string;
    readyInMs?: number;
    expectedStateVersion?: number;
    idempotencyKey?: string;
    confirmationToken?: string;
    impactHash?: string;
  }): Promise<RuntimeSnapshot> {
    const competition = this.get(competitionId);
    const idempotencyKey = input.idempotencyKey ? `${competitionId}:automation-enable:${input.idempotencyKey}` : undefined;
    const old = idempotencyKey ? this.idempotency.get(idempotencyKey) : undefined;
    if (old) return old as RuntimeSnapshot;
    if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== competition.stateVersion) {
      throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: competition.stateVersion });
    }
    const controller = competition.mode === "test"
      ? (() => {
          const runId = input.runId ?? this.getPayload(competitionId).activeRunId;
          return runId ? this.testRuntimeManager.getRuntime(competitionId, runId).automation : undefined;
        })()
      : this.workRuntimeManager.get(competitionId)?.controller;
    const unresolved = controller?.snapshot().actions.filter((action) => action.status === "failed" || action.status === "uncertain") ?? [];
    if (unresolved.length > 0) {
      throw new ServiceError("ACTION_UNAVAILABLE", "请先逐条确认已执行或执行重发，再恢复自动化", 409, { actionIds: unresolved.map((action) => action.id) });
    }
    if (competition.mode === "test") {
      const runId = input.runId ?? this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      this.assertActionAvailable(competitionId, "enable-automation", this.testRuntimeManager.getRuntime(competitionId, runId).automation.snapshot());
      const readyInMs = input.readyInMs ?? this.getDraftConfig(competitionId).flow.intermissionMs;
      this.startTestAutomation(competitionId, runId, readyInMs);
      const runtime = this.testRuntimeManager.getRuntime(competitionId, runId);
      this.testRuntimeManager.startRealtime(runtime);
      const result = this.getTestRunSnapshot(competitionId, runId).automation;
      if (idempotencyKey) this.idempotency.set(idempotencyKey, result);
      return result;
    }
    const runtime = this.workRuntimeManager.get(competitionId);
    this.assertActionAvailable(competitionId, "enable-automation", runtime?.controller.snapshot());
    if (!runtime) throw new ServiceError("NOT_FOUND", "请先启动工作运行", 404);
    const runtimeSnapshot = runtime.controller.snapshot();
    const initialReadyInMs = input.readyInMs ?? this.getDraftConfig(competitionId).flow.intermissionMs;
    runtime.controller.enable(runtimeSnapshot.plannedReadyAtMs ?? performance.now() + initialReadyInMs);
    await runtime.runtime.dispatch();
    for (const action of runtime.controller.snapshot().actions.filter((candidate) => candidate.status === "acknowledged")) this.recordAutomationAttention(competitionId, action);
    this.workRuntimeManager.register(competitionId, runtime);
    this.workRuntimeManager.startRealtime(runtime);
    this.workRuntimeManager.saveSnapshot(runtime);
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    const result = automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin), plannedReadyAt(snapshot, origin), undefined,
      this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
    if (idempotencyKey) this.idempotency.set(idempotencyKey, result);
    return result;
  }

  public pauseAutomation(competitionId: string): RuntimeSnapshot {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      this.assertActionAvailable(competitionId, "pause-automation", this.testRuntimeManager.getRuntime(competitionId, runId).automation.snapshot());
      const runtime = this.testRuntimeManager.getRuntime(competitionId, runId);
      runtime.automation.pause();
      this.testRuntimeManager.persist(runtime);
      const snapshot = runtime.automation.snapshot();
      const origin = Date.parse(runtime.createdAt);
      return automationView("test", snapshot, [simulatedCommand("automation-pause")], plannedStageStartAt(snapshot, origin), plannedReadyAt(snapshot, origin), runtime.automationClock.now(),
        this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
    }
    const runtime = this.workRuntimeManager.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
    this.assertActionAvailable(competitionId, "pause-automation", runtime.controller.snapshot());
    runtime.controller.pause();
    this.workRuntimeManager.saveSnapshot(runtime);
    const snapshot = runtime.controller.snapshot();
    const origin = Date.now() - performance.now();
    return automationView("work", snapshot, this.commandHistory(competitionId), plannedStageStartAt(snapshot, origin), plannedReadyAt(snapshot, origin), undefined,
      this.availableActionsFor(competitionId, snapshot), this.attentionItemsFor(competitionId, snapshot), stageDeadlineAt(snapshot, origin));
  }

  public createConfirmation(
    competitionId: string,
    input: {
      kind: ConfirmationSummary["kind"];
      target?: string;
      playerId?: string;
      stageId?: string;
      operation?: "set-place" | "set-dnf";
      place?: number;
      rankPolicy?: "tie" | "shift";
      actionId?: string;
      resolution?: "confirm-executed" | "resend";
    }
  ): ConfirmationSummary {
    const competition = this.get(competitionId);
    const runtimeSnapshot = this.runtimeAutomationSnapshot(competitionId);
    const expiresAtMs = Date.now() + 60_000;
    const token = randomUUID();
    const target = input.target ?? (input.kind === "scoreboard-override" && input.playerId && input.stageId ? `${input.playerId}:${input.stageId}` : competition.id);
    let impactHash = createHash("sha256").update(JSON.stringify({ competitionId, target, stateVersion: competition.stateVersion, kind: input.kind, playerId: input.playerId, stageId: input.stageId, operation: input.operation, place: input.place, rankPolicy: input.rankPolicy })).digest("hex");
    let runtimeToken: string | undefined;
    const unresolvedAutomationAction = input.kind === "automation-command-resolution"
      ? runtimeSnapshot?.actions.find((action) => action.id === input.actionId && (action.status === "failed" || action.status === "uncertain"))
      : undefined;
    if (input.kind === "automation-command-resolution") {
      if (!unresolvedAutomationAction || !input.resolution || target !== unresolvedAutomationAction.id) {
        throw new ServiceError("CONFIRMATION_UNAVAILABLE", "目标流程命令已变化或不再需要处置", 409);
      }
      impactHash = createHash("sha256").update(JSON.stringify({
        competitionId,
        target,
        stateVersion: competition.stateVersion,
        kind: input.kind,
        resolution: input.resolution,
        action: {
          id: unresolvedAutomationAction.id,
          kind: unresolvedAutomationAction.kind,
          stageId: unresolvedAutomationAction.stageId,
          status: unresolvedAutomationAction.status,
          idempotencyKey: unresolvedAutomationAction.idempotencyKey
        }
      })).digest("hex");
    }
    if (input.kind === "restart-stage") {
      try {
        const issued = this.controllerFor(competitionId).issueStageRestartConfirmation(target);
        impactHash = issued.impactHash;
        runtimeToken = issued.token;
      } catch (error) {
        throw new ServiceError("CONFIRMATION_UNAVAILABLE", error instanceof Error ? error.message : "当前关不能重赛", 409);
      }
    }
    if (input.kind === "scoreboard-override" && input.stageId) {
      this.scoreboardService.assertEditAllowed(this.scoreEditPermissionsFor(competitionId), input.stageId);
    }
    const scorePreview = input.kind === "scoreboard-override" && input.playerId && input.stageId && input.operation
      ? (() => {
          const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
          const activeTestRunId = competition.mode === "test" ? this.getPayload(competitionId).activeRunId : undefined;
          const testStages = activeTestRunId ? this.testRuntimeManager.getRuntime(competitionId, activeTestRunId).definition.stages : [];
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
      : input.kind === "automation-command-resolution"
        ? {
            title: input.resolution === "resend" ? "确认执行重发" : "确认命令已执行",
            consequences: input.resolution === "resend"
              ? ["生成新的命令审计记录并等待新回显", "原 uncertain/timed_out 记录不会被覆盖", "本次为裁判显式重发，不会继续自动重试"]
              : ["原 uncertain/timed_out 记录保持不变", "流程动作标记为裁判已现场核对", "不会发送任何新命令"],
            irreversible: input.resolution === "resend"
          }
      : input.kind === "restart-stage"
        ? { title: "确认重赛本关", consequences: ["当前尝试将作废并立即退出有效榜单，但原始证据永久保留", "发送重赛通知并重新执行 Ready ×3、READY、关闭 cheat 和 3/2/1/Go", "只有新 Go 才创建新尝试"], irreversible: false }
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
    if (input.action.type === "resolve-automation-command") {
      const resolutionAction = input.action;
      const controller = this.controllerFor(competitionId);
      const unresolved = controller.snapshot().actions.find((action) =>
        action.id === resolutionAction.actionId && (action.status === "failed" || action.status === "uncertain"));
      if (!unresolved) throw new ServiceError("ACTION_UNAVAILABLE", "目标流程命令已变化或已完成处置", 409);
      const currentImpactHash = createHash("sha256").update(JSON.stringify({
        competitionId,
        target: unresolved.id,
        stateVersion: competition.stateVersion,
        kind: "automation-command-resolution",
        resolution: resolutionAction.resolution,
        action: {
          id: unresolved.id,
          kind: unresolved.kind,
          stageId: unresolved.stageId,
          status: unresolved.status,
          idempotencyKey: unresolved.idempotencyKey
        }
      })).digest("hex");
      if (currentImpactHash !== resolutionAction.impactHash) throw new ServiceError("CONFIRMATION_STALE", "目标流程命令已变化，请重新确认", 409);
      this.consumeConfirmation(
        competitionId,
        "automation-command-resolution",
        resolutionAction.confirmationToken,
        resolutionAction.impactHash,
        resolutionAction.actionId
      );
      let view: CommandRecordView;
      if (resolutionAction.resolution === "confirm-executed") {
        controller.resolveUnconfirmedAction(unresolved.id, "referee-confirmed");
        view = this.refereeActionService.localActionRecord("automation-command-confirmed", `裁判确认 ${unresolved.kind} 已执行`, competition.mode === "test");
        this.recordCommandView(competitionId, input.idempotencyKey, view);
      } else if (competition.mode === "test") {
        controller.resolveUnconfirmedAction(unresolved.id, "acknowledged");
        view = simulatedCommand("automation-command-resend", `重新发送 ${unresolved.kind}`);
        this.recordCommandView(competitionId, input.idempotencyKey, view);
      } else {
        const runtime = this.workRuntimeManager.get(competitionId);
        if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
        const record = await runtime.commands.enqueue(this.refereeActionService.toAutomationCommand(unresolved), `${input.idempotencyKey}:resend`);
        const resolvedStatus = record.status === "acknowledged" ? "acknowledged" : record.status === "uncertain" ? "uncertain" : "failed";
        controller.resolveUnconfirmedAction(unresolved.id, resolvedStatus);
        view = commandView(record);
      }
      if (competition.mode === "test") {
        const runId = this.getPayload(competitionId).activeRunId;
        if (runId) this.testRuntimeManager.persist(this.testRuntimeManager.getRuntime(competitionId, runId));
      } else {
        const runtime = this.workRuntimeManager.get(competitionId);
        if (runtime) this.workRuntimeManager.saveSnapshot(runtime);
      }
      this.appendAttention(competitionId, {
        id: `automation-command-resolution:${unresolved.id}:${randomUUID()}`,
        category: "command",
        severity: view.status === "acknowledged" || view.status === "simulated" ? "info" : "warning",
        title: resolutionAction.resolution === "resend" ? "流程命令已由裁判执行重发" : "流程命令已确认执行",
        message: resolutionAction.resolution === "resend"
          ? `${unresolved.kind} 已生成新的命令审计记录；原记录保持 ${unresolved.status}。`
          : `${unresolved.kind} 已由裁判现场核对；未发送新命令。`,
        occurredAt: new Date().toISOString(),
        stageId: unresolved.stageId
      });
      this.bumpCompetitionVersion(competitionId);
      this.idempotency.set(key, view);
      this.journal.append({ type: "automation.command-resolved", competitionId, stateVersion: this.get(competitionId).stateVersion, data: { actionId: unresolved.id, resolution: resolutionAction.resolution, result: view } });
      return view;
    }
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
    const handledLocally = await this.refereeActionService.applyLocal(competitionId, input.action, confirmation);
    let view: CommandRecordView;
    if (handledLocally) {
      view = this.refereeActionService.localActionRecord(input.action.type, this.refereeActionService.describe(input.action), competition.mode === "test");
      this.recordCommandView(competitionId, input.idempotencyKey, view);
    } else if (competition.mode === "test") {
      view = simulatedCommand(input.action.type, this.refereeActionService.describe(input.action));
      this.recordCommandView(competitionId, input.idempotencyKey, view);
    } else {
      const runtime = this.workRuntimeManager.get(competitionId);
      if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
      const command = this.refereeActionService.toCommandAction(competitionId, input.action);
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
    return this.scoreboardService.applyOverride(competitionId, input, () => {
      const competition = this.get(competitionId);
      const config = this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId);
      const activeTestRunId = competition.mode === "test" ? this.getPayload(competitionId).activeRunId : undefined;
      const testRuntime = activeTestRunId ? this.testRuntimeManager.getRuntime(competitionId, activeTestRunId) : undefined;
      return {
        competition,
        config,
        testStages: testRuntime?.definition.stages ?? [],
        base: () => this.getLatestScoreboard(competitionId),
        existingVersions: () => this.snapshot(competitionId).scoreboardVersions,
        payload: () => this.getPayload(competitionId),
        permissions: this.scoreEditPermissionsFor(competitionId),
        consumeConfirmation: (token, impactHash, target) => {
          this.consumeConfirmation(competitionId, "scoreboard-override", token, impactHash, target);
        },
        savePayload: (payload) => this.savePayload(competitionId, payload),
        setNextVersion: (nextVersion) => {
          if (testRuntime) testRuntime.engine.setNextScoreboardVersion(nextVersion);
          else this.workRuntimeManager.get(competitionId)?.engine.setNextScoreboardVersion(nextVersion);
        },
        bumpCompetitionVersion: () => this.bumpCompetitionVersion(competitionId).stateVersion,
        appendAttention: (item) => this.appendAttention(competitionId, item),
        journal: this.journal
      };
    });
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
    const runtime = this.workRuntimeManager.get(competitionId);
    runtime?.controller.pause();
    await this.workRuntimeManager.remove(competitionId);
    this.testRuntimeManager.removeCompetition(competitionId);
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
    await this.workRuntimeManager.remove(competitionId);
    this.testRuntimeManager.removeCompetition(competitionId);
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
    this.auditService.removeCompetition(competitionId);
    for (const mode of ["work", "test"] as const) this.removeCompetitionDirectory(competitionId, mode);
    const result = { id: competitionId };
    this.idempotency.set(key, result);
    this.journal.append({ type: "competition.deleted", competitionId, data: { reason: "competition-deleted-by-referee" } });
    return result;
  }

  public close(): void {
    this.testRuntimeManager.close();
    this.workRuntimeManager.close();
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
    const config = JSON.parse(payload) as CompetitionConfig & { loginName?: string };
    delete config.loginName;
    return {
      ...config,
      refereeName: "ContestConsole",
      playerAliases: config.playerAliases ?? [],
      stages: config.stages.map((stage) => migrateStageMap(stage))
    };
  }

  private normalizeConfig(config: CompetitionConfig): CompetitionConfig {
    const name = config.name.trim();
    if (!name) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    const refereeName = "ContestConsole";
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
    const stages = [...config.stages].sort((left, right) => left.order - right.order).map((stage, index) => {
      const mapped = migrateStageMap(stage);
      return {
        ...mapped,
        order: index + 1,
        scoring: mapped.scoring.length > 0 ? mapped.scoring : scoring.points,
        minimumScoringPlace: minimumScoringPlaceFor(mapped.scoring.length > 0 ? mapped.scoring : scoring.points)
      };
    });
    return { ...config, name, server: config.server.trim(), refereeName, contestType: scoring.contestType, scoring, stages };
  }

  private completeCompetitionOnReview(competitionId: string, snapshot: AutomationSnapshot): void {
    if (snapshot.phase !== "review") return;
    const current = this.get(competitionId);
    if (current.status !== "published") return;
    const updated = { ...current, status: "finished" as const, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.withDatabase((database) => {
      database.sqlite.transaction(() => {
        database.sqlite.prepare("UPDATE competitions SET status=?,state_version=?,updated_at=? WHERE id=? AND status=? AND state_version=?")
          .run(updated.status, updated.stateVersion, updated.updatedAt, competitionId, current.status, current.stateVersion);
      })();
    });
    this.competitions.set(competitionId, updated);
    const workRuntime = this.workRuntimeManager.get(competitionId);
    if (workRuntime) {
      this.workRuntimeManager.saveSnapshot(workRuntime);
      void this.workRuntimeManager.remove(competitionId);
    }
    const runId = this.getPayload(competitionId).activeRunId;
    if (runId) this.testRuntimeManager.stopRealtime(runId);
    this.appendAttention(competitionId, {
      id: `competition-finished:auto-review:${updated.stateVersion}`,
      category: "flow",
      severity: "info",
      title: "比赛已结束",
      message: "比赛进入复核阶段，已自动标记为结束，可直接归档或删除。",
      occurredAt: updated.updatedAt,
      action: "archive"
    });
    this.journal.append({ type: "competition.finished", competitionId, stateVersion: updated.stateVersion, data: { reason: "competition-auto-finished-on-review" } });
  }

  private storedScoreboardVersions(competitionId: string): ScoreboardVersionView[] {
    return this.scoreboardService.storedVersions(competitionId);
  }

  private recoverSentCommands(competitionId: string): void {
    if (!this.options.database) return;
    const payload = this.getPayload(competitionId);
    let recoveredAutomation = payload.work?.automation;
    const sent = rows<{ id: string; payload: string }>(this.options.database, "SELECT id,payload FROM command_audits WHERE competition_id=? AND status='sent'", competitionId);
    for (const item of sent) {
      const stored = JSON.parse(item.payload) as CommandRecord;
      const matchingAction = recoveredAutomation?.actions.find((action) => action.idempotencyKey === stored.idempotencyKey && action.kind === "go");
      const authoritativeAttempt = matchingAction && recoveredAutomation?.attempts.find((attempt) =>
        attempt.stageId === matchingAction.stageId && !attempt.voided && attempt.goAtMs >= matchingAction.createdAtMs);
      if (stored.action.type === "go" && recoveredAutomation && matchingAction && authoritativeAttempt) {
        const acknowledged: CommandRecord = {
          ...stored,
          status: "acknowledged",
          responseLine: "由持久化权威 Go 与尝试记录恢复确认",
          updatedAt: new Date().toISOString()
        };
        this.options.database.sqlite.prepare("UPDATE command_audits SET status='acknowledged',payload=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(acknowledged), acknowledged.updatedAt, item.id);
        const currentAutomation = recoveredAutomation;
        recoveredAutomation = {
          ...currentAutomation,
          actions: currentAutomation.actions.map((action) => action.id === matchingAction.id ? { ...action, status: "acknowledged" as const } : action)
        };
        continue;
      }
      if (stored.action.type === "set-map" || stored.action.type === "set-official-map") {
        const acknowledged: CommandRecord = {
          ...stored,
          status: "acknowledged",
          responseLine: "setmap 无服务端回显；恢复时自动确认",
          updatedAt: new Date().toISOString()
        };
        this.options.database.sqlite.prepare("UPDATE command_audits SET status='acknowledged',payload=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(acknowledged), acknowledged.updatedAt, item.id);
        continue;
      }
      const recovered: CommandRecord = { ...stored, status: "uncertain", updatedAt: new Date().toISOString() };
      this.options.database.sqlite.prepare("UPDATE command_audits SET status='uncertain',payload=?,updated_at=? WHERE id=?").run(JSON.stringify(recovered), recovered.updatedAt, item.id);
      this.appendAttention(competitionId, {
        id: `recovered-command:${item.id}`,
        category: "command",
        severity: "warning",
        title: "命令结果待核实",
        message: `${recovered.command}；不会自动重试，请裁判核对现场。`,
        occurredAt: recovered.updatedAt
      });
    }
    if (recoveredAutomation && payload.work) this.savePayload(competitionId, { ...payload, work: { ...payload.work, automation: recoveredAutomation } });
  }

  private saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void {
    this.scoreboardService.saveVersions(competitionId, versions);
  }

  private controllerFor(competitionId: string): CompetitionController {
    const competition = this.get(competitionId);
    if (competition.mode === "test") {
      const runId = this.getPayload(competitionId).activeRunId ?? competition.activeRunId;
      if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
      return this.testRuntimeManager.getRuntime(competitionId, runId).automation;
    }
    const runtime = this.workRuntimeManager.get(competitionId);
    if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
    return runtime.controller;
  }

  private runtimeAutomationSnapshot(competitionId: string): AutomationSnapshot | undefined {
    const competition = this.get(competitionId);
    if (competition.mode === "work") return this.workRuntimeManager.get(competitionId)?.controller.snapshot();
    const runId = this.getPayload(competitionId).activeRunId ?? competition.activeRunId;
    return runId ? this.testRuntimeManager.getRuntime(competitionId, runId).automation.snapshot() : undefined;
  }

  private consumeActionConfirmation(competitionId: string, action: CompetitionAction): ConfirmationRecord | undefined {
    switch (action.type) {
      case "manual-go":
        return this.consumeConfirmation(competitionId, "manual-go", action.confirmationToken, action.impactHash, competitionId);
      case "start-ready-flow":
      case "reschedule":
      case "reschedule-stage-deadline":
      case "delay-ready":
      case "extend-stage-deadline":
      case "end-stage":
        return this.consumeConfirmation(competitionId, "manual-action", action.confirmationToken, action.impactHash, competitionId);
      case "restart-stage":
        return this.consumeConfirmation(competitionId, "restart-stage", action.confirmationToken, action.impactHash, action.attemptId);
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

  private availableActionsFor(competitionId: string, snapshot?: AutomationSnapshot): ActionAvailability[] {
    const competition = this.get(competitionId);
    const refereeActionsUnlocked = competition.status !== "draft";
    const phase = snapshot?.phase ?? competition.status;
    const blockers = snapshot?.blockers.filter((blocker) => blocker.code !== "AUTOMATION_PAUSED") ?? [];
    const hasBlockingIssue = blockers.some((blocker) => blocker.severity === "critical" || blocker.code === "PARTICIPANT_OFFLINE");
    const hasReadyFlowBlockingIssue = blockers.some((blocker) => blocker.code !== "PARTICIPANT_CHEAT" && (blocker.severity === "critical" || blocker.code === "PARTICIPANT_OFFLINE"));
    const hasUnconfirmedAutomationActions = snapshot?.actions.some((action) => action.status === "failed" || action.status === "uncertain") ?? false;
    const openAttempt = snapshot?.attempts.findLast((attempt) => attempt.intakeOpen && !attempt.voided);
    const currentAttempt = snapshot?.attempts.findLast((attempt) => attempt.stageId === snapshot.currentStageId && !attempt.voided);
    const restartPhase = phase === "running" || phase === "tail-intake" || phase === "incident"
      || phase === "paused" && (snapshot?.pausedFromPhase === "running" || snapshot?.pausedFromPhase === "tail-intake");
    const commandTargetStageId = snapshot?.plannedReadyStageId ?? snapshot?.currentStageId;
    const targetStageActions = snapshot?.actions.filter((action) => action.stageId === commandTargetStageId) ?? [];
    const previousGoIndex = targetStageActions.findLastIndex((action) => action.kind === "go" && (action.status === "acknowledged" || action.status === "referee-confirmed"));
    const cheatOffConfirmed = targetStageActions.slice(previousGoIndex + 1).some((action) => action.kind === "cheat-off" && action.status === "acknowledged");
    const hasPendingCommands = snapshot?.actions.some((action) => action.status === "pending") ?? false;
    const hasRuntime = competition.mode === "work"
      ? this.workRuntimeManager.has(competitionId)
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
      descriptor(
        "enable-automation",
        phase === "paused" || snapshot?.pausedFromPhase ? "恢复自动化" : "启动自动化",
        phase === "paused" || snapshot?.pausedFromPhase
          ? "从暂停前阶段继续；未确认命令必须先由裁判核对，且不会自动重发。"
          : "按轮间准备时长规划首轮 Ready，并由状态机推进后续流程。",
        refereeActionsUnlocked && hasRuntime && !snapshot?.automationEnabled && !["review", "incident"].includes(phase) && !hasUnconfirmedAutomationActions,
        !refereeActionsUnlocked ? "请先发布比赛配置" : !hasRuntime ? "请先启动运行" : snapshot?.automationEnabled ? "自动化已经启用" : phase === "incident" ? "请先处理当前事故" : hasUnconfirmedAutomationActions ? "请先逐条确认已执行或执行重发" : "比赛已进入复核"
      ),
      descriptor("pause-automation", "暂停自动化", "停止自动推进；已经发出的真实命令不会自动撤回。", refereeActionsUnlocked && Boolean(snapshot?.automationEnabled),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "自动化当前未启用"),
      descriptor("start-ready-flow", "进入 Ready+发令流程", "立即发布本关预告，把目标关第一条 Ready 设为 1 分钟后，并自动完成 Ready、READY!、关闭 cheat 和发令。",
        refereeActionsUnlocked && hasRuntime && ["lobby", "preparing", "paused", "restart-preparing", "tail-intake"].includes(phase) && !hasReadyFlowBlockingIssue,
        !refereeActionsUnlocked ? "请先发布比赛配置" : !hasRuntime ? "请先启动运行" : !["lobby", "preparing", "paused", "restart-preparing", "tail-intake"].includes(phase) ? `当前阶段 ${phase} 不能进入发令流程` : "存在离线、权限、事故或不确定命令"),
      descriptor("ready", "手动 Ready", "只向计划目标关发送一次 Ready；不改变阶段、计划时间、Bulletin 或自动流程进度。",
        refereeActionsUnlocked && hasRuntime && !["countdown", "running", "review", "incident"].includes(phase) && !hasReadyFlowBlockingIssue,
        !refereeActionsUnlocked ? "请先发布比赛配置" : !hasRuntime ? "请先启动运行" : "当前阶段或流程阻断不允许发送手动 Ready"),
      descriptor("cheat-off", "关闭 cheat", "只发送一次关闭 cheat 命令；成功回显将作为目标关手动发令的前置证据，不改变计划。", refereeActionsUnlocked && hasRuntime && !["review", "incident"].includes(phase) && !hasUnconfirmedAutomationActions,
        !refereeActionsUnlocked ? "请先发布比赛配置" : !hasRuntime ? "请先启动运行" : "当前阶段不可发送"),
      descriptor("manual-go", "手动发令", phase === "restart-preparing"
        ? "先执行本次重发令所需的一次 forcenextrestart，确认后立即触发真实 3/2/1；只有权威 Go 后才创建尝试和设置本关时间。"
        : "不等待计划时间并立即触发真实 3/2/1；只有权威 Go 回显后才创建尝试和设置本关时间。",
        refereeActionsUnlocked && hasRuntime && !["countdown", "running", "review", "incident"].includes(phase) && cheatOffConfirmed && !hasPendingCommands && !hasBlockingIssue,
        !refereeActionsUnlocked ? "请先发布比赛配置" : !hasRuntime ? "请先启动运行" : !cheatOffConfirmed ? "目标关尚无关闭 cheat 成功回显" : hasPendingCommands ? "仍有命令等待回显" : "存在离线、cheat、权限或未决命令阻断"),
      descriptor("delay-ready", "Ready 延后 1 分钟", "将下一次已安排的 Ready 时间顺延 1 分钟。", refereeActionsUnlocked && snapshot?.plannedReadyAtMs !== undefined && ["preparing", "pre-start-wait", "tail-intake", "restart-preparing"].includes(phase),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "当前没有可延后的 Ready 计划"),
      descriptor("reschedule", "Ready 改期", "把下一次 Ready 改到指定时间，不改变本关时限。", refereeActionsUnlocked && snapshot?.plannedReadyAtMs !== undefined && ["preparing", "pre-start-wait", "tail-intake", "restart-preparing"].includes(phase),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "当前没有可改期的 Ready 计划"),
      descriptor("extend-stage-deadline", "本关时限延长 1 分钟", "立即把当前关卡最晚结束时间顺延 1 分钟。", refereeActionsUnlocked && Boolean(openAttempt) && ["running", "tail-intake"].includes(phase),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "当前没有开放的成绩接收窗口"),
      descriptor("reschedule-stage-deadline", "关卡时限改期", "把当前关卡最晚结束时间改到指定时间，不改变下一次 Ready。", refereeActionsUnlocked && Boolean(openAttempt) && ["running", "tail-intake"].includes(phase),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "当前没有开放的成绩接收窗口"),
      descriptor("end-stage", "提前结束本关", "关闭成绩窗口，未完成且未排除的选手记为 DNF。", refereeActionsUnlocked && Boolean(openAttempt) && ["running", "tail-intake"].includes(phase),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "当前没有可结束的开放关卡"),
      descriptor("restart-stage", "重赛本关", "作废当前尝试并退出有效榜单，保留证据、发送通知并重新执行完整 Ready 与倒数。", competition.status === "published" && Boolean(currentAttempt) && restartPhase,
        competition.status !== "published" ? "比赛已结束，不能再重赛" : !currentAttempt ? "本关尚未 Go，不能重赛" : "下一关已进入 Ready 或当前阶段不能重赛"),
      descriptor("kick", "Kick 玩家", "从服务器移除目标玩家；结果不确定时不会自动重试。", refereeActionsUnlocked && competition.mode === "work" && hasRuntime,
        !refereeActionsUnlocked ? "请先发布比赛配置" : competition.mode !== "work" ? "测试模式不发送真实 Kick" : "请先启动工作运行"),
      descriptor("raw-command", "发送原始命令", "原样发送一条 MockClient 命令；结果不确定时不会自动重试。", refereeActionsUnlocked && competition.mode === "work" && hasRuntime,
        !refereeActionsUnlocked ? "请先发布比赛配置" : competition.mode !== "work" ? "测试模式不发送真实命令" : "请先启动工作运行"),
      descriptor("finish", "结束比赛", "停止运行并固定比赛为已结束状态，之后可归档。", refereeActionsUnlocked && !["finished", "archived"].includes(competition.status),
        !refereeActionsUnlocked ? "请先发布比赛配置" : "比赛已经结束"),
      descriptor("archive", "生成归档", "基于明确榜单版本生成不可变归档。", ["finished", "archived"].includes(competition.status), "请先结束比赛"),
      descriptor("delete", "删除比赛", "删除该比赛的配置、运行、审计与本地数据目录。", true, "")
    ];
  }

  private scoreEditPermissionsFor(
    competitionId: string,
    status = this.get(competitionId).status,
    currentStageId = this.runtimeAutomationSnapshot(competitionId)?.currentStageId
  ): RuntimeSnapshot["scoreEditPermissions"] {
    const stages = (this.getPublishedConfig(competitionId) ?? this.getDraftConfig(competitionId)).stages;
    return this.scoreboardService.editPermissions(stages, status, currentStageId);
  }

  private assertActionAvailable(competitionId: string, action: RefereeActionId, snapshot?: AutomationSnapshot): void {
    const availability = this.availableActionsFor(competitionId, snapshot).find((candidate) => candidate.action === action);
    if (!availability?.enabled) throw new ServiceError("ACTION_UNAVAILABLE", availability?.disabledReason ?? "当前状态不能执行该动作", 409, availability);
  }

  private actionIdFor(action: CompetitionAction): RefereeActionId | undefined {
    switch (action.type) {
      case "start-ready-flow": case "ready": case "cheat-off": case "manual-go": case "reschedule": case "reschedule-stage-deadline": case "delay-ready":
      case "extend-stage-deadline": case "end-stage": case "restart-stage": case "kick": case "raw-command":
        return action.type;
      default: return undefined;
    }
  }

  private appendAttention(competitionId: string, item: AttentionItem): void {
    this.auditService.appendAttention(competitionId, item);
  }

  private attentionItemsFor(competitionId: string, snapshot?: AutomationSnapshot): AttentionItem[] {
    return this.auditService.attentionItems(competitionId, snapshot);
  }

  private recordAutomationAttention(competitionId: string, action: AutomationAction): void {
    this.auditService.recordAutomationAttention(competitionId, action);
  }

  private recordExclusionAttention(competitionId: string, stageId: string, playerId: string, sourceId: string, reason: string): void {
    this.auditService.recordExclusionAttention(competitionId, stageId, playerId, sourceId, reason);
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
    return this.scoreboardService.toVersion(view, this.getDraftConfig(competitionId).participants.length);
  }

  private recordCommand(competitionId: string, record: CommandRecord): void {
    this.auditService.recordCommand(competitionId, record);
  }

  private recordCommandView(competitionId: string, idempotencyKey: string, record: CommandRecordView): void {
    this.auditService.recordCommandView(competitionId, idempotencyKey, record);
  }

  private commandHistory(competitionId: string): CommandRecordView[] {
    return this.auditService.commandHistory(competitionId);
  }

  private scoreboardOverrideHistory(competitionId: string): CompetitionSnapshot["scoreboardOverrides"] {
    return this.scoreboardService.overrideHistory(competitionId);
  }

  private appendRawLog(competitionId: string, source: RawClientLogLine["source"], rawLine: string, occurredAt = new Date().toISOString()): void {
    this.auditService.appendRawLog(competitionId, source, rawLine, occurredAt);
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
    return this.refereeActionService.toCommandAction(competitionId, action);
  }
  private competitionDataRoot(competitionId: string, mode: CompetitionMode): string {
    return join(resolve(this.options.dataRoot ?? process.cwd()), mode, competitionId);
  }

}
