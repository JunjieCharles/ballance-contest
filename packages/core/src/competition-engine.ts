import { createHash, randomUUID } from "node:crypto";
import type { ScenarioDefinition, ScenarioEvent, ScenarioStage } from "@ballance/contracts";

export type ResultStatus = "finished" | "dnf" | "excluded";

export interface StageResult {
  playerId: string;
  status: ResultStatus;
  place: number;
  points: number;
  score?: number;
  elapsedMs?: number;
  reason?: string;
  sourceId: string;
  finishSourceId?: string;
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
  voided: boolean;
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
  private nextScoreboardVersion = 1;

  public constructor(private readonly scenario: ScenarioDefinition) {
    for (const stage of scenario.stages) this.stages.set(stage.id, stage);
    for (const player of scenario.players) this.playerNames.set(player.id, player.displayName);
  }

  public registerPlayer(playerId: string, displayName = playerId): void {
    if (!playerId.trim()) throw new Error("PLAYER_ID_REQUIRED");
    this.playerNames.set(playerId, displayName.trim() || playerId);
  }

  public setNextScoreboardVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1) throw new Error("INVALID_SCOREBOARD_VERSION");
    this.nextScoreboardVersion = Math.max(this.nextScoreboardVersion, version);
  }

  public restore(snapshot: EngineSnapshot): void {
    this.seenSources.clear();
    this.attempts.length = 0;
    this.results.clear();
    this.versions.length = 0;
    this.anomalies.length = 0;
    this.baselines.clear();
    this.finishSequence = 0;
    this.nextScoreboardVersion = 1;

    this.attempts.push(...snapshot.attempts.map((attempt) => ({ ...attempt })));
    this.versions.push(...snapshot.scoreboardVersions.map((version) => ({ ...version, entries: version.entries.map((entry) => ({ ...entry, placeCounts: [...entry.placeCounts], stages: { ...entry.stages } })) })));
    this.anomalies.push(...snapshot.anomalies.map((anomaly) => ({ ...anomaly })));
    for (const attempt of this.attempts) this.seenSources.add(attempt.goSourceId);
    for (const version of this.versions) {
      this.seenSources.add(version.triggerSourceId);
      for (const entry of version.entries) this.playerNames.set(entry.playerId, entry.displayName);
    }

    const latestEntries = this.versions.at(-1)?.entries ?? snapshot.currentScoreboard;
    for (const stage of this.stages.values()) {
      const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === stage.id && !candidate.voided);
      if (!attempt) continue;
      const stageResults = new Map<string, MutableStageResult>();
      const ordered = latestEntries
        .map((entry) => entry.stages[stage.id])
        .filter((result): result is StageResult => result !== undefined)
        .sort((left, right) => (left.place || Number.MAX_SAFE_INTEGER) - (right.place || Number.MAX_SAFE_INTEGER));
      for (const result of ordered) {
        this.finishSequence += 1;
        stageResults.set(result.playerId, {
          playerId: result.playerId,
          status: result.status,
          sourceId: result.sourceId,
          finishSequence: this.finishSequence,
          ...(result.score === undefined ? {} : { score: result.score }),
          ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.finishSourceId === undefined ? {} : { finishSourceId: result.finishSourceId })
        });
        this.seenSources.add(result.sourceId);
        if (result.finishSourceId) this.seenSources.add(result.finishSourceId);
      }
      if (stageResults.size > 0) {
        this.results.set(attempt.id, stageResults);
        this.baselines.set(stage.id, this.rankBeforeStage(stage));
      }
    }
    this.nextScoreboardVersion = Math.max(1, ...this.versions.map((version) => version.version + 1));
  }

  public apply(event: ScenarioEvent): void {
    if (this.seenSources.has(event.sourceId)) {
      this.anomalies.push({ sourceId: event.sourceId, code: "duplicate-event", detail: "Duplicate source event ignored" });
      return;
    }
    this.seenSources.add(event.sourceId);
    if (event.type === "go") this.applyGo(event);
    else if (event.type === "finish" || event.type === "dnf" || event.type === "exclude") this.applyResult(event);
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
      open: true,
      voided: false
    });
  }

  private applyResult(event: Extract<ScenarioEvent, { type: "finish" | "dnf" | "exclude" }>): void {
    const stage = this.stages.get(event.stageId);
    if (!stage) {
      this.anomalies.push({ sourceId: event.sourceId, code: "unknown-stage", detail: event.stageId });
      return;
    }
    const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === event.stageId && candidate.open && !candidate.voided);
    if (!attempt) {
      this.anomalies.push({ sourceId: event.sourceId, code: "practice-result", detail: event.stageId });
      return;
    }
    if (event.atMs > attempt.deadlineAtMs) {
      this.anomalies.push({ sourceId: event.sourceId, code: "late-result", detail: event.stageId });
      return;
    }
    const stageResults = this.results.get(attempt.id) ?? new Map<string, MutableStageResult>();
    const existing = stageResults.get(event.playerId);
    if (existing?.status === "excluded" && event.type === "finish") {
      stageResults.set(event.playerId, {
        ...existing,
        score: event.score,
        elapsedMs: event.elapsedMs,
        finishSourceId: event.sourceId
      });
      this.results.set(attempt.id, stageResults);
      this.createScoreboardVersion(event.stageId, event.sourceId);
      return;
    }
    if (existing && event.type === "exclude" && existing.status === "finished") {
      stageResults.set(event.playerId, {
        ...existing,
        status: "excluded",
        reason: event.reason,
        sourceId: event.sourceId,
        finishSourceId: existing.sourceId
      });
      this.results.set(attempt.id, stageResults);
      this.createScoreboardVersion(event.stageId, event.sourceId);
      return;
    }
    if (existing) {
      this.anomalies.push({ sourceId: event.sourceId, code: "post-completion-result", detail: `${event.stageId}:${event.playerId}` });
      return;
    }
    if (!this.playerNames.has(event.playerId)) this.registerPlayer(event.playerId);
    this.finishSequence += 1;
    stageResults.set(event.playerId, event.type === "finish"
      ? { playerId: event.playerId, status: "finished", score: event.score, elapsedMs: event.elapsedMs, sourceId: event.sourceId, finishSequence: this.finishSequence }
      : { playerId: event.playerId, status: event.type === "dnf" ? "dnf" : "excluded", reason: event.reason, sourceId: event.sourceId, finishSequence: this.finishSequence });
    this.results.set(attempt.id, stageResults);
    if (event.type === "finish" && !this.baselines.has(event.stageId)) this.baselines.set(event.stageId, this.rankBeforeStage(stage));
    this.createScoreboardVersion(event.stageId, event.sourceId);
  }

  private rankedStageResults(stage: ScenarioStage): readonly StageResult[] {
    const attempt = [...this.attempts].reverse().find((candidate) => candidate.stageId === stage.id && !candidate.voided);
    const values = [...(attempt ? this.results.get(attempt.id)?.values() ?? [] : [])];
    values.sort((left, right) => {
      if (left.status !== right.status) return left.status === "finished" ? -1 : right.status === "finished" ? 1 : left.finishSequence - right.finishSequence;
      if (left.status !== "finished") return left.finishSequence - right.finishSequence;
      if (stage.mode === "HS" && left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      return left.finishSequence - right.finishSequence;
    });
    let finishedPlace = 0;
    return values.map((result) => ({
      playerId: result.playerId,
      status: result.status,
      place: result.status === "finished" ? ++finishedPlace : 0,
      points: result.status === "finished" ? (stage.scoring[finishedPlace - 1] ?? 0) : 0,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      sourceId: result.sourceId,
      ...(result.finishSourceId === undefined ? {} : { finishSourceId: result.finishSourceId })
    }));
  }

  public voidAttempt(stageId: string, attemptNumber: number, sourceId: string): void {
    const attempt = this.attempts.find((candidate) => candidate.stageId === stageId && candidate.attemptNumber === attemptNumber && !candidate.voided);
    if (!attempt) throw new Error("ATTEMPT_NOT_FOUND");
    attempt.open = false;
    attempt.voided = true;
    this.createScoreboardVersion(stageId, sourceId);
  }

  private buildScoreboard(excludeStageId?: string): readonly ScoreboardEntry[] {
    const aggregate = [...this.playerNames].map(([playerId, displayName]) => ({
      playerId,
      displayName,
      points: 0,
      placeCounts: Array.from({ length: this.playerNames.size }, () => 0),
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
    const version = this.nextScoreboardVersion;
    this.nextScoreboardVersion += 1;
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
