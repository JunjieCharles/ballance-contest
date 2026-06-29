import { createHash, randomUUID } from "node:crypto";
import type { ScoreboardEntry, ScoreboardVersion, StageResult } from "./competition-engine.js";

export interface StageResultPatch {
  status?: "finished" | "dnf";
  place?: number;
  points?: number;
  score?: number;
  elapsedMs?: number;
  reason?: string;
  includeInTotal?: boolean;
}

export interface ScoreboardOverrideRequest {
  playerId: string;
  stageId?: string;
  displayName?: string;
  totalPoints?: number;
  stage?: StageResultPatch;
  rankPolicy?: "tie" | "shift";
  actor: string;
  reason: string;
  evidence?: string;
}

export interface ScoreboardOverrideRecord {
  id: string;
  baseScoreboardVersion: number;
  revisionVersion: number;
  playerId: string;
  stageId?: string;
  beforeValue: unknown;
  afterValue: unknown;
  actor: string;
  reason: string;
  evidence?: string;
  createdAt: string;
  reversesId?: string;
}

export interface RevisedScoreboardVersion {
  version: number;
  baseScoreboardVersion: number;
  triggerOverrideId: string;
  entries: readonly ScoreboardEntry[];
  deterministicHash: string;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
});

const copyResult = (result: StageResult): StageResult => ({ ...result });
const copyEntry = (entry: ScoreboardEntry): ScoreboardEntry => ({
  ...entry,
  placeCounts: [...entry.placeCounts],
  stages: Object.fromEntries(Object.entries(entry.stages).map(([stageId, result]) => [stageId, copyResult(result)]))
});

const rankEntries = (entries: readonly ScoreboardEntry[]): ScoreboardEntry[] => {
  const sorted = entries.map(copyEntry).sort((left, right) => {
    if (left.points !== right.points) return right.points - left.points;
    for (let index = 0; index < Math.max(left.placeCounts.length, right.placeCounts.length); index += 1) {
      const difference = (right.placeCounts[index] ?? 0) - (left.placeCounts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return left.playerId.localeCompare(right.playerId);
  });
  let rank = 1;
  return sorted.map((entry, index) => {
    if (index > 0) {
      const previous = sorted[index - 1] as ScoreboardEntry;
      const tied = previous.points === entry.points && previous.placeCounts.every((count, place) => count === (entry.placeCounts[place] ?? 0));
      if (!tied) rank = index + 1;
    }
    return { ...entry, rank };
  });
};

export class ScoreboardRevisionLedger {
  private readonly baseEntries: readonly ScoreboardEntry[];
  private readonly records: ScoreboardOverrideRecord[] = [];
  private readonly versions: RevisedScoreboardVersion[] = [];

  public constructor(private readonly base: ScoreboardVersion) {
    this.baseEntries = base.entries.map(copyEntry);
  }

  public apply(request: ScoreboardOverrideRequest): RevisedScoreboardVersion {
    if (!request.actor.trim()) throw new Error("OVERRIDE_ACTOR_REQUIRED");
    if (!request.reason.trim()) throw new Error("OVERRIDE_REASON_REQUIRED");
    if (request.stage?.place !== undefined && !request.rankPolicy) throw new Error("RANK_POLICY_REQUIRED");
    const entries = this.currentEntries();
    const entry = entries.find((candidate) => candidate.playerId === request.playerId);
    if (!entry) throw new Error("OVERRIDE_TARGET_NOT_FOUND");
    const beforeValue = this.capture(entry, request.stageId);
    this.applyRequest(entries, entry, request);
    const ranked = rankEntries(entries);
    const updated = ranked.find((candidate) => candidate.playerId === request.playerId) as ScoreboardEntry;
    const record: ScoreboardOverrideRecord = {
      id: randomUUID(), baseScoreboardVersion: this.base.version, revisionVersion: this.versions.length + 1,
      playerId: request.playerId,
      ...(request.stageId === undefined ? {} : { stageId: request.stageId }),
      beforeValue, afterValue: this.capture(updated, request.stageId), actor: request.actor.trim(), reason: request.reason.trim(),
      ...(request.evidence === undefined ? {} : { evidence: request.evidence }), createdAt: new Date().toISOString()
    };
    return this.appendVersion(record, ranked);
  }

  public reverse(overrideId: string, input: { actor: string; reason: string }): RevisedScoreboardVersion {
    if (!input.actor.trim()) throw new Error("OVERRIDE_ACTOR_REQUIRED");
    if (!input.reason.trim()) throw new Error("OVERRIDE_REASON_REQUIRED");
    const original = this.records.find((record) => record.id === overrideId);
    if (!original) throw new Error("OVERRIDE_NOT_FOUND");
    if (this.records.some((record) => record.reversesId === overrideId)) throw new Error("OVERRIDE_ALREADY_REVERSED");
    const entries = this.currentEntries();
    const entry = entries.find((candidate) => candidate.playerId === original.playerId);
    if (!entry) throw new Error("OVERRIDE_TARGET_NOT_FOUND");
    const beforeValue = this.capture(entry, original.stageId);
    this.restore(entry, original.stageId, original.beforeValue);
    const ranked = rankEntries(entries);
    const record: ScoreboardOverrideRecord = {
      id: randomUUID(), baseScoreboardVersion: this.base.version, revisionVersion: this.versions.length + 1,
      playerId: original.playerId, ...(original.stageId === undefined ? {} : { stageId: original.stageId }),
      beforeValue, afterValue: original.beforeValue, actor: input.actor.trim(), reason: input.reason.trim(),
      createdAt: new Date().toISOString(), reversesId: overrideId
    };
    return this.appendVersion(record, ranked);
  }

  public history(): { overrides: readonly ScoreboardOverrideRecord[]; versions: readonly RevisedScoreboardVersion[] } {
    return {
      overrides: this.records.map((record) => ({ ...record })),
      versions: this.versions.map((version) => ({ ...version, entries: version.entries.map(copyEntry) }))
    };
  }

  private currentEntries(): ScoreboardEntry[] {
    return (this.versions.at(-1)?.entries ?? this.baseEntries).map(copyEntry);
  }

  private applyRequest(entries: ScoreboardEntry[], entry: ScoreboardEntry, request: ScoreboardOverrideRequest): void {
    if (request.displayName !== undefined) (entry as { displayName: string }).displayName = request.displayName;
    if (request.stageId !== undefined && request.stage !== undefined) {
      const current = entry.stages[request.stageId];
      if (!current) throw new Error("OVERRIDE_STAGE_RESULT_NOT_FOUND");
      const patch = request.stage;
      if (patch.place !== undefined && patch.place !== current.place && request.rankPolicy === "shift") {
        for (const candidate of entries) {
          const result = candidate.stages[request.stageId];
          if (result && candidate.playerId !== entry.playerId && result.place >= patch.place) {
            (candidate.stages as Record<string, StageResult>)[request.stageId] = { ...result, place: result.place + 1 };
          }
        }
      }
      const merged = { ...current, ...patch } as StageResult & { includeInTotal?: boolean };
      delete merged.includeInTotal;
      if (patch.includeInTotal === false) merged.points = 0;
      (entry.stages as Record<string, StageResult>)[request.stageId] = merged;
      this.recalculate(entry);
    }
    if (request.totalPoints !== undefined) (entry as { points: number }).points = request.totalPoints;
  }

  private recalculate(entry: ScoreboardEntry): void {
    const stages = Object.values(entry.stages);
    (entry as { points: number }).points = stages.reduce((sum, result) => sum + result.points, 0);
    const counts = Array.from({ length: entry.placeCounts.length }, () => 0);
    for (const result of stages) if (result.status === "finished") counts[result.place - 1] = (counts[result.place - 1] ?? 0) + 1;
    (entry as { placeCounts: readonly number[] }).placeCounts = counts;
  }

  private capture(entry: ScoreboardEntry, stageId?: string): unknown {
    return stageId === undefined
      ? { displayName: entry.displayName, points: entry.points }
      : entry.stages[stageId] ? copyResult(entry.stages[stageId] as StageResult) : null;
  }

  private restore(entry: ScoreboardEntry, stageId: string | undefined, value: unknown): void {
    if (stageId === undefined) {
      const previous = value as { displayName: string; points: number };
      (entry as { displayName: string }).displayName = previous.displayName;
      (entry as { points: number }).points = previous.points;
      return;
    }
    if (!value) delete (entry.stages as Record<string, StageResult>)[stageId];
    else (entry.stages as Record<string, StageResult>)[stageId] = copyResult(value as StageResult);
    this.recalculate(entry);
  }

  private appendVersion(record: ScoreboardOverrideRecord, entries: readonly ScoreboardEntry[]): RevisedScoreboardVersion {
    this.records.push(record);
    const payload = { version: record.revisionVersion, baseScoreboardVersion: this.base.version, triggerOverrideId: record.id, entries };
    const version: RevisedScoreboardVersion = { ...payload, deterministicHash: createHash("sha256").update(canonical(payload)).digest("hex") };
    this.versions.push(version);
    return { ...version, entries: version.entries.map(copyEntry) };
  }
}
