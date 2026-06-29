import { performance } from "node:perf_hooks";
import { assertScenarioDefinition } from "@ballance/contracts";
import { CompetitionEngine } from "@ballance/core";
import { describe, expect, it } from "vitest";

const buildEightHourScenario = () => {
  const players = Array.from({ length: 30 }, (_, index) => ({ id: `p${index + 1}`, displayName: `Player ${String(index + 1).padStart(2, "0")}`, connectionId: String(100 + index) }));
  const stages = Array.from({ length: 30 }, (_, index) => ({
    id: `s${index + 1}`, order: index + 1, level: (index % 13) + 1, mode: index % 2 === 0 ? "SR" as const : "HS" as const,
    timeLimitMs: 15 * 60_000, scoring: Array.from({ length: 15 }, (_value, place) => 20 - place), minimumScoringPlace: 15
  }));
  const events: Array<Record<string, unknown>> = players.map((player) => ({ atMs: 0, sourceId: `login-${player.id}`, type: "login", playerId: player.id, connectionId: player.connectionId }));
  for (const [stageIndex, stage] of stages.entries()) {
    const stageStart = stageIndex * 16 * 60_000;
    events.push({ atMs: stageStart, sourceId: `go-${stage.id}`, type: "go", stageId: stage.id, refereeConnectionId: "ref-load" });
    for (const [playerIndex, player] of players.entries()) {
      events.push({
        atMs: stageStart + 1_000 + playerIndex * 250,
        sourceId: `finish-${stage.id}-${player.id}`,
        type: "finish", stageId: stage.id, playerId: player.id,
        score: stage.mode === "HS" ? 10_000 - playerIndex : 1_000 - playerIndex,
        elapsedMs: 1_000 + playerIndex * 250
      });
    }
  }
  events.push({ atMs: 8 * 60 * 60_000, sourceId: "eight-hour-checkpoint", type: "warning", message: "virtual endurance checkpoint" });
  return assertScenarioDefinition({
    schemaVersion: 1, id: "scale-30x30x8h", name: "30 人 30 轮 8 小时虚拟长时", year: 2026,
    timezone: "Asia/Shanghai", refereeConnectionId: "ref-load", players, stages, events,
    expected: { attempts: 30, scoreboardVersions: 900 }
  });
};

describe("30 × 30 × 8 hour virtual endurance", () => {
  it("keeps every attempt and intermediate scoreboard version deterministic", () => {
    const scenario = buildEightHourScenario();
    const started = performance.now();
    const engine = new CompetitionEngine(scenario);
    for (const event of scenario.events) engine.apply(event);
    const elapsedMs = performance.now() - started;
    const snapshot = engine.snapshot();

    expect(scenario.events.at(-1)?.atMs).toBe(28_800_000);
    expect(snapshot.attempts).toHaveLength(30);
    expect(snapshot.scoreboardVersions).toHaveLength(900);
    expect(snapshot.currentScoreboard).toHaveLength(30);
    expect(new Set(snapshot.scoreboardVersions.map((version) => version.deterministicHash)).size).toBe(900);
    expect(elapsedMs).toBeLessThan(8_000);
  }, 10_000);
});
