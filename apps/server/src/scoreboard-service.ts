import { createHash, randomUUID } from "node:crypto";
import {
  minimumScoringPlaceFor,
  type ActiveScoringView,
  type AttentionItem,
  type CompetitionConfig,
  type CompetitionLifecycleStatus,
  type CompetitionMode,
  type CompetitionSnapshot,
  type RuntimeSnapshot,
  type ScoreboardOverrideInput,
  type ScoreboardScoringUpdateInput,
  type ScoreboardVersionView,
  type StageConfig
} from "@ballance/contracts";
import { ScoreboardRevisionLedger, type ScoreboardEntry, type ScoreboardVersion } from "@ballance/core";
import type { EventJournal } from "./event-journal.js";
import type { ServiceSnapshotPayload } from "./runtime-types.js";
import { ServiceError } from "./service-error.js";
import type { OpenedDatabase } from "./storage/database.js";
import { scoreboardView } from "./runtime-shared.js";

interface ScoreboardOverrideContext {
  competition: { mode: CompetitionMode; stateVersion: number };
  config: CompetitionConfig;
  testStages: ReadonlyArray<Pick<StageConfig, "id" | "scoring">>;
  scoringByStage: Readonly<Record<string, readonly number[]>>;
  base(): ScoreboardVersion;
  existingVersions(): readonly ScoreboardVersionView[];
  payload(): ServiceSnapshotPayload;
  permissions: RuntimeSnapshot["scoreEditPermissions"];
  consumeConfirmation(
    token: string,
    impactHash: string,
    target: string,
    intent: "scoreboard-set-place" | "scoreboard-set-dnf",
    input: ScoreboardOverrideInput
  ): void;
  savePayload(payload: ServiceSnapshotPayload): void;
  rebaseActiveEngine(version: ScoreboardVersion): void;
  setNextVersion(nextVersion: number): void;
  bumpCompetitionVersion(): number;
  appendAttention(item: AttentionItem): void;
  journal: EventJournal;
}

interface ScoringUpdateContext {
  competition: { status: CompetitionLifecycleStatus; stateVersion: number };
  config: CompetitionConfig;
  activeScoring: ActiveScoringView;
  scoringByStage: Readonly<Record<string, readonly number[]>>;
  base(): ScoreboardVersion;
  existingVersions(): readonly ScoreboardVersionView[];
  payload(): ServiceSnapshotPayload;
  consumeConfirmation(token: string, impactHash: string, input: ScoreboardScoringUpdateInput): void;
  savePayload(payload: ServiceSnapshotPayload): void;
  rebaseActiveEngine(version: ScoreboardVersion, scoringByStage: Readonly<Record<string, readonly number[]>>): void;
  bumpCompetitionVersion(): number;
  appendAttention(item: AttentionItem): void;
  journal: EventJournal;
}

const repriceEntries = (
  entries: readonly ScoreboardEntry[],
  scoringByStage: Readonly<Record<string, readonly number[]>>
): ScoreboardEntry[] => {
  const baselineRanks = new Map(entries.map((entry) => [
    entry.playerId,
    entry.change === null ? null : entry.rank + entry.change
  ]));
  const repriced = entries.map((entry) => {
    const stages = Object.fromEntries(Object.entries(entry.stages).map(([stageId, result]) => {
      const scoring = scoringByStage[stageId];
      return [stageId, result.status === "finished" && scoring
        ? { ...result, points: scoring[result.place - 1] ?? 0 }
        : { ...result }];
    }));
    return {
      ...entry,
      points: Object.values(stages).reduce((sum, result) => sum + result.points, 0),
      placeCounts: [...entry.placeCounts],
      stages
    };
  }).sort((left, right) => {
    if (left.points !== right.points) return right.points - left.points;
    for (let index = 0; index < Math.max(left.placeCounts.length, right.placeCounts.length); index += 1) {
      const difference = (right.placeCounts[index] ?? 0) - (left.placeCounts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return left.playerId.localeCompare(right.playerId);
  });
  let rank = 1;
  return repriced.map((entry, index) => {
    if (index > 0) {
      const previous = repriced[index - 1] as ScoreboardEntry;
      const tied = previous.points === entry.points
        && previous.placeCounts.every((count, place) => count === (entry.placeCounts[place] ?? 0));
      if (!tied) rank = index + 1;
    }
    const baselineRank = baselineRanks.get(entry.playerId);
    return { ...entry, rank, change: baselineRank === null || baselineRank === undefined ? null : baselineRank - rank };
  });
};

export class ScoreboardService {
  private readonly idempotency = new Map<string, ScoreboardVersionView>();

  public constructor(private readonly database?: OpenedDatabase) {}

  public storedVersions(competitionId: string): ScoreboardVersionView[] {
    if (!this.database) return [];
    return (this.database.sqlite.prepare("SELECT payload FROM scoreboard_versions WHERE competition_id=? ORDER BY version").all(competitionId) as Array<{ payload: string }>)
      .map((item) => scoreboardView(JSON.parse(item.payload) as ScoreboardVersion));
  }

  public saveVersions(competitionId: string, versions: readonly ScoreboardVersion[]): void {
    if (!this.database) return;
    for (const version of versions) {
      this.database.sqlite.prepare("INSERT OR IGNORE INTO scoreboard_versions(id,competition_id,version,trigger_event_id,payload,deterministic_hash,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(version.id, competitionId, version.version, version.triggerSourceId, JSON.stringify(version), version.deterministicHash, new Date().toISOString());
    }
  }

  public toVersion(view: ScoreboardVersionView, participantCount: number): ScoreboardVersion {
    const placeCountSize = Math.max(participantCount, view.entries.length);
    return {
      id: view.id,
      version: view.version,
      triggerSourceId: view.triggerSourceId,
      stageId: view.stageId,
      entries: view.entries.map((entry) => {
        const stages = entry.stages as ScoreboardEntry["stages"];
        const placeCounts = Array.from({ length: placeCountSize }, () => 0);
        for (const result of Object.values(stages)) {
          if (result.status === "finished") placeCounts[result.place - 1] = (placeCounts[result.place - 1] ?? 0) + 1;
        }
        return { ...entry, placeCounts, stages };
      }),
      deterministicHash: view.deterministicHash
    };
  }

  public overrideHistory(competitionId: string): CompetitionSnapshot["scoreboardOverrides"] {
    if (!this.database) return [];
    return (this.database.sqlite.prepare("SELECT id,target_type,target_id,before_value,after_value,reason,actor,created_at FROM overrides WHERE competition_id=? ORDER BY created_at DESC").all(competitionId) as Array<{
      id: string; target_type: string; target_id: string; before_value: string | null; after_value: string;
      reason: string; actor: string; created_at: string;
    }>).map((item) => ({
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

  public editPermissions(
    stages: readonly StageConfig[],
    status: CompetitionLifecycleStatus,
    currentStageId?: string
  ): RuntimeSnapshot["scoreEditPermissions"] {
    const ordered = [...stages].sort((left, right) => left.order - right.order);
    if (status === "finished" || status === "archived") return ordered.map((stage) => ({ stageId: stage.id, editable: true }));
    const currentOrder = ordered.find((stage) => stage.id === currentStageId)?.order;
    return ordered.map((stage) => {
      if (currentOrder !== undefined && stage.order < currentOrder) return { stageId: stage.id, editable: true };
      return {
        stageId: stage.id,
        editable: false,
        reason: stage.id === currentStageId
          ? "当前关仍由自动或现场成绩接收；进入下一关 Ready 前 1 分钟的准备阶段后才能修订"
          : "该关尚未进入可修订范围"
      };
    });
  }

  public assertEditAllowed(permissions: RuntimeSnapshot["scoreEditPermissions"], stageId: string): void {
    const permission = permissions.find((candidate) => candidate.stageId === stageId);
    if (!permission) throw new ServiceError("NOT_FOUND", "修订关卡不存在", 404);
    if (!permission.editable) throw new ServiceError("ACTION_UNAVAILABLE", permission.reason ?? "当前不能修订该关成绩", 409, permission);
  }

  public applyOverride(
    competitionId: string,
    input: ScoreboardOverrideInput & { expectedStateVersion: number; idempotencyKey: string },
    createContext: () => ScoreboardOverrideContext
  ): ScoreboardVersionView {
    const key = `${competitionId}:scoreboard-override:${input.idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old;
    const context = createContext();
    if (context.competition.stateVersion !== input.expectedStateVersion) {
      throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: context.competition.stateVersion });
    }
    const operation = (input as { operation?: string }).operation;
    if (operation !== "set-place" && operation !== "set-dnf") throw new ServiceError("VALIDATION_FAILED", "成绩修订只允许设置名次或设置 DNF", 400);
    const allowedKeys = new Set(["playerId", "stageId", "operation", "place", "rankPolicy", "confirmationToken", "impactHash", "expectedStateVersion", "idempotencyKey"]);
    if (Object.keys(input).some((keyName) => !allowedKeys.has(keyName))) {
      throw new ServiceError("VALIDATION_FAILED", "成绩修订不接受前端提交的得分、总分、原因或证据", 400);
    }
    this.assertEditAllowed(context.permissions, input.stageId);
    context.consumeConfirmation(
      input.confirmationToken,
      input.impactHash,
      `${input.playerId}:${input.stageId}`,
      input.operation === "set-place" ? "scoreboard-set-place" : "scoreboard-set-dnf",
      input
    );
    if (input.operation === "set-place" && (!Number.isInteger(input.place) || input.place < 1)) {
      throw new ServiceError("VALIDATION_FAILED", "名次必须是大于等于 1 的整数", 400);
    }
    const stageConfig = context.config.stages.find((stage) => stage.id === input.stageId)
      ?? context.testStages.find((stage) => stage.id === input.stageId);
    if (!stageConfig) throw new ServiceError("NOT_FOUND", "修订轮次不存在", 404);
    const base = context.base();
    const ledger = new ScoreboardRevisionLedger(
      base,
      context.scoringByStage
    );
    let revised: ReturnType<ScoreboardRevisionLedger["apply"]>;
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
    const versionNumber = Math.max(base.version, ...context.existingVersions().map((candidate) => candidate.version)) + 1;
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
    const payload = context.payload();
    context.savePayload({ ...payload, scoreboardRevisions: [...(payload.scoreboardRevisions ?? []), view] });
    this.saveVersions(competitionId, [version]);
    context.rebaseActiveEngine(version);
    context.setNextVersion(versionNumber + 1);
    if (this.database) {
      this.database.sqlite.prepare("INSERT INTO overrides(id,competition_id,target_type,target_id,before_value,after_value,reason,actor,reversed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          override.id,
          competitionId,
          "stage-result",
          `${input.playerId}:${input.stageId}`,
          JSON.stringify(override.beforeValue),
          JSON.stringify(override.afterValue),
          override.reason,
          override.actor,
          null,
          override.createdAt
        );
    }
    const stateVersion = context.bumpCompetitionVersion();
    this.idempotency.set(key, view);
    context.appendAttention({
      id: `scoreboard-override:${override.id}`,
      category: "result",
      severity: "info",
      title: "成绩修订已生成新版本",
      message: input.operation === "set-place" ? `${input.playerId} 在 ${input.stageId} 改为第 ${input.place} 名，关联名次已重算。` : `${input.playerId} 在 ${input.stageId} 改为 DNF，关联名次已重算。`,
      occurredAt: override.createdAt,
      stageId: input.stageId,
      participantIds: [input.playerId]
    });
    context.journal.append({ type: "scoreboard.override", competitionId, stateVersion, data: view });
    return view;
  }

  public updateScoring(
    competitionId: string,
    input: ScoreboardScoringUpdateInput & { expectedStateVersion: number; idempotencyKey: string },
    createContext: () => ScoringUpdateContext
  ): ScoreboardVersionView {
    const points = [...input.points];
    const context = createContext();
    if (context.competition.stateVersion !== input.expectedStateVersion) {
      throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: context.competition.stateVersion });
    }
    if (context.competition.status === "draft") throw new ServiceError("STATE_CONFLICT", "比赛发布后才能实时修改计分映射", 409);
    if (points.length === 0 || points.some((point) => !Number.isFinite(point))) {
      throw new ServiceError("VALIDATION_FAILED", "计分映射至少需要一个名次，且分数必须是有限数字", 400);
    }
    if (!context.config.scoring.allowNegative && points.some((point) => point < 0)) {
      throw new ServiceError("VALIDATION_FAILED", "当前比赛不允许负分", 400);
    }
    context.consumeConfirmation(input.confirmationToken, input.impactHash, { ...input, points });
    const scoringByStage = Object.fromEntries(Object.keys(context.scoringByStage).map((stageId) => [stageId, points]));
    const base = context.base();
    const versionNumber = Math.max(base.version, ...context.existingVersions().map((candidate) => candidate.version)) + 1;
    const overrideId = randomUUID();
    const entries = repriceEntries(base.entries, scoringByStage);
    const hashPayload = { version: versionNumber, baseVersion: base.version, triggerOverrideId: overrideId, scoringByStage, entries };
    const version: ScoreboardVersion = {
      id: randomUUID(),
      version: versionNumber,
      triggerSourceId: `scoring-override:${overrideId}`,
      stageId: base.stageId || context.config.stages[0]?.id || "scoring-config",
      entries,
      deterministicHash: createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex")
    };
    const view = scoreboardView(version);
    const updatedAt = new Date().toISOString();
    const activeScoring: ActiveScoringView = {
      source: "runtime-override",
      revision: context.activeScoring.revision + 1,
      points,
      minimumScoringPlace: minimumScoringPlaceFor(points),
      updatedAt
    };
    const payload = context.payload();
    context.savePayload({
      ...payload,
      runtimeScoring: activeScoring,
      scoreboardRevisions: [...(payload.scoreboardRevisions ?? []), view]
    });
    this.saveVersions(competitionId, [version]);
    context.rebaseActiveEngine(version, scoringByStage);
    if (this.database) {
      this.database.sqlite.prepare("INSERT INTO overrides(id,competition_id,target_type,target_id,before_value,after_value,reason,actor,reversed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          overrideId,
          competitionId,
          "scoring-config",
          "all-stages",
          JSON.stringify({ points: context.activeScoring.points }),
          JSON.stringify({ points }),
          "update-scoring-table",
          "local-referee",
          null,
          updatedAt
        );
    }
    const stateVersion = context.bumpCompetitionVersion();
    context.appendAttention({
      id: `scoreboard-scoring:${overrideId}`,
      category: "result",
      severity: "warning",
      title: "实时计分映射已更新",
      message: `第 1 至第 ${points.length} 名的分数映射已更新，全部关卡成绩和总榜已重算并生成榜单 v${versionNumber}。`,
      occurredAt: updatedAt
    });
    context.journal.append({ type: "scoreboard.scoring-updated", competitionId, stateVersion, data: { activeScoring, scoreboard: view } });
    return view;
  }
}
