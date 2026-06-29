import { createHash, randomUUID } from "node:crypto";
import type { ScenarioDefinition, ScenarioEvent, ScenarioStage } from "@ballance/contracts";

export type ResultStatus = "finished" | "dnf";

export interface StageResult {
  playerId: string;
  status: ResultStatus;
  place: number;
  points: number;
  score?: number;
  elapsedMs?: number;
  reason?: string;
  sourceId: string;
}

export interface ScoreboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  points: number;
  placeCounts: readonly number[];
  change: number | null;
  stages: Readonly<Record<string, StageResult>>;
}

export interface ScoreboardVersion {
  id: string;
  version: number;
  triggerSourceId: string;
  stageId: string;
  entries: readonly ScoreboardEntry[];
  deterministicHash: string;
}

export interface AttemptState {
  id: string;
  stageId: string;
  attemptNumber: number;
  goSourceId: string;
  goAtMs: number;
  deadlineAtMs: number;
  open: boolean;
}

export interface EngineAnomaly {
  sourceId: string;
  code: "practice-result" | "unauthorized-go" | "post-completion-result" | "late-result" | "duplicate-event" | "unknown-stage";
  detail: string;
}

export interface EngineSnapshot {
  attempts: readonly AttemptState[];
  scoreboardVersions: readonly ScoreboardVersion[];
  anomalies: readonly EngineAnomaly[];
  currentScoreboard: readonly ScoreboardEntry[];
}

interface MutableStageResult extends Omit<StageResult, "place" | "points"> {
  finishSequence: number;
}

const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
});

const rankSorted = <T>(items: readonly T[], compare: (left: T, right: T) => number): Array<{ item: T; rank: number }> => {
  const sorted = [...items].sort(compare);
  let rank = 1;
  return sorted.map((item, index) => {
    if (index > 0 && compare(sorted[index - 1] as T, item) !== 0) rank = index + 1;
    return { item, rank };
  });
};

export class CompetitionEngine {
  private readonly stages = new Map<string, ScenarioStage>();
  private readonly playerNames = new Map<string, string>();
  private readonly seenSources = new Set<string>();
  private readonly attempts: AttemptState[] = [];
  private readonly results = new Map<string, Map<string, MutableStageResult>>();
  private readonly versions: ScoreboardVersion[] = [];
  private readonly anomalies: EngineAnomaly[] = [];
  private readonly baselines = new Map<string, Map<string, number>>();
  private finishSequence = 0;

  public constructor(private readonly scenario: ScenarioDefinition) {
    for (const stage of scenario.stages) this.stages.set(stage.id, stage);
    for (const player of scenario.players) this.playerNames.set(player.id, player.displayName);
  }

  public apply(event: ScenarioEvent): void {
    if (this.seenSources.has(event.sourceId)) {
      this.anomalies.push({ sourceId: event.sourceId, code: "duplicate-event", detail: "Duplicate source event ignored" });
      return;
    }
    this.seenSources.add(event.sourceId);
    if (event.type === "go") this.applyGo(event);
    else if (event.type === "finish" || event.type === "dnf") this.applyResult(event);
  }

  private applyGo(event: Extract<ScenarioEvent, { type: "go" }>): void {
    const stage = this.stages.get(event.stageId);
    if (!stage) {
      this.anomalies.push({ sourceId: event.sourceId, code: "unknown-stage", detail: event.stageId });
      return;
    }
    if (event.refereeConnectionId !== this.scenario.refereeConnectionId) {
      this.anomalies.push({ sourceId: event.sourceId, code: "unauthorized-go", detail: event.refereeConnectionId });
      return;
    }
    for (const attempt of this.attempts) attempt.open = false;
    const attemptNumber = this.attempts.filter((attempt) => attempt.stageId === event.stageId).length + 1;
    this.attempts.push({
      id: randomUUID(),
      stageId: event.stageId,
      attemptNumber,
      goSourceId: event.sourceId,
      goAtMs: event.atMs,
      deadlineAtMs: event.atMs + stage.timeLimitMs,
      open: true
    });
  }

  private applyResult(event: Extract<ScenarioEvent, { type: "finish" | "dnf" }>): void {
    const stage = this.stages.get(event.stageId);
    if (!stage) {
      this.anomalies.push({ sourceId: event.sourceId, code: "unknown-stage", detail: event.stageId });
      return;
    }
    const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === event.stageId && candidate.open);
    if (!attempt) {
      this.anomalies.push({ sourceId: event.sourceId, code: "practice-result", detail: event.stageId });
      return;
    }
    if (event.atMs > attempt.deadlineAtMs) {
      this.anomalies.push({ sourceId: event.sourceId, code: "late-result", detail: event.stageId });
      return;
    }
    const stageResults = this.results.get(event.stageId) ?? new Map<string, MutableStageResult>();
    if (stageResults.has(event.playerId)) {
      this.anomalies.push({ sourceId: event.sourceId, code: "post-completion-result", detail: `${event.stageId}:${event.playerId}` });
      return;
    }
    this.finishSequence += 1;
    stageResults.set(event.playerId, event.type === "finish"
      ? { playerId: event.playerId, status: "finished", score: event.score, elapsedMs: event.elapsedMs, sourceId: event.sourceId, finishSequence: this.finishSequence }
      : { playerId: event.playerId, status: "dnf", reason: event.reason, sourceId: event.sourceId, finishSequence: this.finishSequence });
    this.results.set(event.stageId, stageResults);
    if (event.type === "finish" && !this.baselines.has(event.stageId)) this.baselines.set(event.stageId, this.rankBeforeStage(stage));
    this.createScoreboardVersion(event.stageId, event.sourceId);
  }

  private rankedStageResults(stage: ScenarioStage): readonly StageResult[] {
    const values = [...(this.results.get(stage.id)?.values() ?? [])];
    values.sort((left, right) => {
      if (left.status !== right.status) return left.status === "finished" ? -1 : 1;
      if (left.status === "dnf") return left.finishSequence - right.finishSequence;
      if (stage.mode === "HS" && left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      return left.finishSequence - right.finishSequence;
    });
    return values.map((result, index) => ({
      playerId: result.playerId,
      status: result.status,
      place: index + 1,
      points: result.status === "finished" ? (stage.scoring[index] ?? 0) : 0,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      sourceId: result.sourceId
    }));
  }

  private buildScoreboard(excludeStageId?: string): readonly ScoreboardEntry[] {
    const aggregate = [...this.playerNames].map(([playerId, displayName]) => ({
      playerId,
      displayName,
      points: 0,
      placeCounts: Array.from({ length: this.scenario.players.length }, () => 0),
      stages: {} as Record<string, StageResult>
    }));
    const byPlayer = new Map(aggregate.map((entry) => [entry.playerId, entry]));
    for (const stage of [...this.stages.values()].sort((left, right) => left.order - right.order)) {
      if (stage.id === excludeStageId) continue;
      for (const result of this.rankedStageResults(stage)) {
        const entry = byPlayer.get(result.playerId);
        if (!entry) continue;
        entry.points += result.points;
        entry.stages[stage.id] = result;
        if (result.status === "finished") entry.placeCounts[result.place - 1] = (entry.placeCounts[result.place - 1] ?? 0) + 1;
      }
    }
    const compare = (left: typeof aggregate[number], right: typeof aggregate[number]): number => {
      if (left.points !== right.points) return right.points - left.points;
      for (let index = 0; index < left.placeCounts.length; index += 1) {
        const difference = (right.placeCounts[index] ?? 0) - (left.placeCounts[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    };
    const ranked = rankSorted(aggregate, compare);
    return ranked.map(({ item, rank }) => ({ ...item, rank, change: null }));
  }

  private rankBeforeStage(stage: ScenarioStage): Map<string, number> {
    if (stage.order === 1) return new Map();
    return new Map(this.buildScoreboard(stage.id).map((entry) => [entry.playerId, entry.rank]));
  }

  private createScoreboardVersion(stageId: string, sourceId: string): void {
    const baseline = this.baselines.get(stageId);
    const entries = this.buildScoreboard().map((entry) => ({ ...entry, change: baseline?.has(entry.playerId) ? (baseline.get(entry.playerId) as number) - entry.rank : null }));
    const version = this.versions.length + 1;
    const hashPayload = { version, triggerSourceId: sourceId, stageId, entries };
    this.versions.push({
      id: randomUUID(),
      version,
      triggerSourceId: sourceId,
      stageId,
      entries,
      deterministicHash: createHash("sha256").update(canonicalJson(hashPayload)).digest("hex")
    });
  }

  public snapshot(): EngineSnapshot {
    return {
      attempts: this.attempts.map((attempt) => ({ ...attempt })),
      scoreboardVersions: this.versions.map((version) => ({ ...version })),
      anomalies: this.anomalies.map((anomaly) => ({ ...anomaly })),
      currentScoreboard: this.versions.at(-1)?.entries ?? this.buildScoreboard()
    };
  }
}
