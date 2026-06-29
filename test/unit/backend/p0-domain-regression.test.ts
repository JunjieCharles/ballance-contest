import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScenarioDefinition } from "../../../packages/contracts/src/index.js";
import { assertScenarioDefinition } from "../../../packages/contracts/src/index.js";
import {
  CompetitionEngine,
  ParticipantRegistry,
  ScoreboardRevisionLedger,
  parseLogLine,
  stripAnsi,
  type EngineSnapshot
} from "../../../packages/core/src/index.js";
import { ScenarioRunner } from "../../../packages/testkit/src/index.js";
import { describe, expect, it } from "vitest";

const loadScenario = (id: string): ScenarioDefinition =>
  assertScenarioDefinition(JSON.parse(readFileSync(resolve(`test/fixtures/scenarios/${id}/scenario.json`), "utf8")) as unknown);

const runScenario = (definition: ScenarioDefinition): EngineSnapshot => {
  const engine = new CompetitionEngine(definition);
  new ScenarioRunner(definition).playAll((event) => engine.apply(event));
  return engine.snapshot();
};

describe("P0 centralized domain regression", () => {
  it("BE-GO-001/002/003/004 and BE-DNF-001: accepts only configured authority, excludes practice results and preserves first finish", () => {
    const scenario = loadScenario("authority-practice-dnf");
    const snapshot = runScenario(scenario);

    expect(snapshot.attempts).toHaveLength(scenario.expected.attempts);
    expect(snapshot.attempts[0]).toMatchObject({ stageId: "s1", goSourceId: "official-go", attemptNumber: 1 });
    expect(snapshot.scoreboardVersions).toHaveLength(scenario.expected.scoreboardVersions);
    expect(snapshot.anomalies.map((anomaly) => [anomaly.sourceId, anomaly.code])).toEqual([
      ["practice-finish-before-go", "practice-result"],
      ["outsider-go", "unauthorized-go"],
      ["p1-late-dnf", "post-completion-result"]
    ]);

    const alpha = snapshot.currentScoreboard.find((entry) => entry.playerId === "p1");
    expect(alpha?.stages.s1).toMatchObject({ status: "finished", sourceId: "p1-finish", points: 20 });
    expect(alpha?.stages.s1.sourceId).not.toBe("p1-late-dnf");
  });

  it("BE-SCORE-001/003/004 and NF-DETERMINISM-001: ranks mixed SR/HS stages and keeps per-event hashes stable", () => {
    const scenario = loadScenario("three-stage-main");
    const first = runScenario(scenario);
    const second = runScenario(scenario);

    expect(first.attempts).toHaveLength(scenario.expected.attempts);
    expect(first.scoreboardVersions).toHaveLength(scenario.expected.scoreboardVersions);
    expect(first.scoreboardVersions.map((version) => version.deterministicHash)).toEqual(second.scoreboardVersions.map((version) => version.deterministicHash));
    expect(first.currentScoreboard.map((entry) => ({ rank: entry.rank, name: entry.displayName, points: entry.points }))).toEqual([
      { rank: 1, name: "Alpha", points: 55 },
      { rank: 2, name: "Gamma", points: 44 },
      { rank: 3, name: "Beta", points: 30 },
      { rank: 4, name: "Delta", points: 12 },
      { rank: 5, name: "测试选手", points: 0 }
    ]);

    const hsTieVersion = first.scoreboardVersions.find((version) => version.triggerSourceId === "s2-f3");
    expect(hsTieVersion?.entries.find((entry) => entry.playerId === "p2")?.stages.s2).toMatchObject({ place: 2, points: 15, score: 1800 });
    expect(hsTieVersion?.entries.find((entry) => entry.playerId === "p3")?.stages.s2).toMatchObject({ place: 3, points: 12, score: 1800 });
  });

  it("BE-ID-001/002: keeps stable participants, reports case-insensitive conflicts and never auto-associates staff", () => {
    const registry = new ParticipantRegistry("competition-identity");
    const alpha = registry.addParticipant("Alpha", "participant-alpha");
    const duplicate = registry.addParticipant("alpha", "participant-alpha-shadow");

    expect(registry.observeConnection("101", "Alpha")).toEqual({ kind: "conflict", candidateParticipantIds: [alpha.id, duplicate.id] });
    expect(registry.associate("101", alpha.id)).toMatchObject({ participantId: alpha.id, role: "participant", historicalConnectionIds: ["101"] });
    registry.disconnect("101");
    expect(registry.observeConnection("201", "ALPHA")).toEqual({ kind: "conflict", candidateParticipantIds: [alpha.id, duplicate.id] });
    expect(registry.associate("201", alpha.id)).toMatchObject({ participantId: alpha.id, historicalConnectionIds: ["101", "201"] });
    expect(registry.observeConnection("900", "*Staff")).toEqual({ kind: "unmatched" });
    expect(registry.getConnection("900")).toMatchObject({ role: "staff", online: true });
  });

  it("BE-OVR-001/002: applies auditable scoreboard revisions and restores by appending a new version", () => {
    const base = runScenario(loadScenario("three-stage-main")).scoreboardVersions.at(-1);
    expect(base).toBeDefined();
    const ledger = new ScoreboardRevisionLedger(base!);
    const revised = ledger.apply({
      playerId: "p2",
      stageId: "s3",
      stage: { place: 1, points: 20 },
      rankPolicy: "shift",
      actor: "referee",
      reason: "录像复核确认成绩有效",
      evidence: "evidence://review/p2-s3"
    });

    expect(revised.version).toBe(1);
    expect(revised.entries.find((entry) => entry.playerId === "p2")?.stages.s3).toMatchObject({ place: 1, points: 20 });
    expect(base!.entries.find((entry) => entry.playerId === "p2")?.stages.s3).toMatchObject({ place: 4, points: 0 });
    const overrideId = ledger.history().overrides[0]?.id;
    expect(overrideId).toBeDefined();

    const restored = ledger.reverse(overrideId!, { actor: "referee", reason: "撤销复核覆盖" });
    expect(restored.version).toBe(2);
    expect(restored.entries.find((entry) => entry.playerId === "p2")?.stages.s3).toMatchObject({ place: 4, points: 0 });
    expect(ledger.history().overrides[1]).toMatchObject({ reversesId: overrideId });
  });

  it("BE-LOG-001/002/003: strips ANSI, parses known lines and preserves notification text without treating embedded time as a timestamp", () => {
    const parsedGo = parseLogLine("\u001b[32m[06-29 11:22:15] [101, ContestConsole]: Level 01 - Go!\u001b[0m", {
      year: 2026,
      utcOffsetMinutes: 480,
      sourceId: "go-line"
    });
    expect(stripAnsi(parsedGo.rawLine)).toBe("[06-29 11:22:15] [101, ContestConsole]: Level 01 - Go!");
    expect(parsedGo.event).toMatchObject({ type: "go", connectionId: "101", refereeName: "ContestConsole", level: 1 });

    const warning = parseLogLine("[06-29 11:23:02] [Warning] notification contains 20:18 but is not an event timestamp", {
      year: 2026,
      utcOffsetMinutes: 480,
      sourceId: "warning-line"
    });
    expect(warning.timestamp).toBe("2026-06-29T03:23:02.000Z");
    expect(warning.event).toMatchObject({ type: "warning", message: "notification contains 20:18 but is not an event timestamp" });
    expect(parseLogLine("unrecognised diagnostic line", { year: 2026, utcOffsetMinutes: 480 }).event).toMatchObject({ type: "unknown" });
  });
});
