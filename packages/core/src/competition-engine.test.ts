import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertScenarioDefinition, type ScenarioDefinition } from "@ballance/contracts";
import { describe, expect, it } from "vitest";
import { CompetitionEngine } from "./competition-engine.js";

const loadMain = (): ScenarioDefinition => assertScenarioDefinition(JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as unknown);

describe("CompetitionEngine", () => {
  it("restores attempts and scoreboard versions before accepting new results", () => {
    const definition = loadMain();
    const original = new CompetitionEngine(definition);
    original.apply({ atMs: 0, sourceId: "restore-go", type: "go", stageId: "s1", refereeConnectionId: definition.refereeConnectionId });
    original.apply({ atMs: 10, sourceId: "restore-p1", type: "finish", stageId: "s1", playerId: "p1", score: 10, elapsedMs: 10 });
    const persisted = original.snapshot();

    const restored = new CompetitionEngine(definition);
    restored.restore(persisted);
    restored.apply({ atMs: 20, sourceId: "restore-p2", type: "finish", stageId: "s1", playerId: "p2", score: 9, elapsedMs: 20 });
    const snapshot = restored.snapshot();
    expect(snapshot.attempts).toEqual(persisted.attempts);
    expect(snapshot.scoreboardVersions.slice(0, persisted.scoreboardVersions.length)).toEqual(persisted.scoreboardVersions);
    expect(snapshot.scoreboardVersions.at(-1)?.version).toBe(2);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "p1")?.stages.s1?.place).toBe(1);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "p2")?.stages.s1?.place).toBe(2);
  });

  it("adds an unknown player only when an effective result is accepted", () => {
    const base = loadMain();
    const stage = base.stages[0];
    if (!stage) throw new Error("missing stage fixture");
    const engine = new CompetitionEngine({ ...base, players: [], stages: [stage], events: [] });
    engine.apply({ atMs: 0, sourceId: "practice", type: "finish", stageId: "s1", playerId: "PracticeOnly", score: 1, elapsedMs: 1 });
    expect(engine.snapshot().currentScoreboard).toEqual([]);
    engine.apply({ atMs: 10, sourceId: "go", type: "go", stageId: "s1", refereeConnectionId: base.refereeConnectionId });
    engine.apply({ atMs: 20, sourceId: "finish", type: "finish", stageId: "s1", playerId: "Silent_Snow", score: 1, elapsedMs: 10 });
    expect(engine.snapshot().currentScoreboard).toMatchObject([{ playerId: "Silent_Snow", displayName: "Silent_Snow" }]);
  });

  it("runs the three-stage mixed scenario and versions every effective result", () => {
    const definition = loadMain();
    const engine = new CompetitionEngine(definition);
    for (const event of definition.events) engine.apply(event);
    const snapshot = engine.snapshot();
    expect(snapshot.attempts).toHaveLength(definition.expected.attempts);
    expect(snapshot.scoreboardVersions).toHaveLength(definition.expected.scoreboardVersions);
    expect(snapshot.anomalies).toContainEqual(expect.objectContaining({ sourceId: "practice-finish", code: "practice-result" }));
    expect(snapshot.currentScoreboard.map(({ playerId, points }) => [playerId, points])).toEqual([
      ["p1", 55], ["p3", 44], ["p2", 30], ["p4", 12], ["p5", 0]
    ]);
    const p1 = snapshot.currentScoreboard.find((entry) => entry.playerId === "p1");
    const p2 = snapshot.currentScoreboard.find((entry) => entry.playerId === "p2");
    const p3 = snapshot.currentScoreboard.find((entry) => entry.playerId === "p3");
    expect(p1?.stages.s2?.place).toBe(1);
    expect(p2?.stages.s2?.place).toBe(2);
    expect(p3?.stages.s2?.place).toBe(3);
  });

  it("is deterministic across complete reruns", () => {
    const definition = loadMain();
    const run = (): readonly string[] => {
      const engine = new CompetitionEngine(definition);
      for (const event of definition.events) engine.apply(event);
      return engine.snapshot().scoreboardVersions.map((version) => version.deterministicHash);
    };
    expect(run()).toEqual(run());
  });

  it("keeps a first finish when a later DNF arrives", () => {
    const base = loadMain();
    const scenario = assertScenarioDefinition({
      ...base,
      id: "finish-then-dnf",
      stages: [base.stages[0]],
      players: [base.players[0]],
      events: [
        { atMs: 0, sourceId: "go", type: "go", stageId: "s1", refereeConnectionId: "ref-1" },
        { atMs: 10, sourceId: "finish", type: "finish", stageId: "s1", playerId: "p1", score: 1, elapsedMs: 10 },
        { atMs: 20, sourceId: "dnf-after", type: "dnf", stageId: "s1", playerId: "p1", reason: "late-signal" }
      ],
      expected: { attempts: 1, scoreboardVersions: 1 }
    });
    const engine = new CompetitionEngine(scenario);
    for (const event of scenario.events) engine.apply(event);
    const snapshot = engine.snapshot();
    expect(snapshot.scoreboardVersions).toHaveLength(1);
    expect(snapshot.currentScoreboard[0]?.stages.s1?.status).toBe("finished");
    expect(snapshot.anomalies).toContainEqual(expect.objectContaining({ sourceId: "dnf-after", code: "post-completion-result" }));
  });

  it("keeps excluded evidence at zero points and lets later valid finishers move up", () => {
    const base = loadMain();
    const scenario = assertScenarioDefinition({
      ...base,
      id: "excluded-finish-evidence",
      stages: [base.stages[0]],
      players: base.players.slice(0, 2),
      events: [
        { atMs: 0, sourceId: "go", type: "go", stageId: "s1", refereeConnectionId: "ref-1" },
        { atMs: 10, sourceId: "p1-cheat", type: "exclude", stageId: "s1", playerId: "p1", reason: "cheat-enabled" },
        { atMs: 20, sourceId: "p1-finish", type: "finish", stageId: "s1", playerId: "p1", score: 999, elapsedMs: 20 },
        { atMs: 30, sourceId: "p2-finish", type: "finish", stageId: "s1", playerId: "p2", score: 800, elapsedMs: 30 }
      ],
      expected: { attempts: 1, scoreboardVersions: 3 }
    });
    const engine = new CompetitionEngine(scenario);
    for (const event of scenario.events) engine.apply(event);

    const p1 = engine.snapshot().currentScoreboard.find((entry) => entry.playerId === "p1")?.stages.s1;
    const p2 = engine.snapshot().currentScoreboard.find((entry) => entry.playerId === "p2")?.stages.s1;
    expect(p1).toMatchObject({ status: "excluded", place: 0, points: 0, sourceId: "p1-cheat", finishSourceId: "p1-finish", score: 999 });
    expect(p2).toMatchObject({ status: "finished", place: 1, points: 20 });
  });

  it("can exclude an already recorded finish without losing its source evidence", () => {
    const base = loadMain();
    const scenario = assertScenarioDefinition({
      ...base,
      id: "finish-then-excluded",
      stages: [base.stages[0]],
      players: [base.players[0]],
      events: [
        { atMs: 0, sourceId: "go", type: "go", stageId: "s1", refereeConnectionId: "ref-1" },
        { atMs: 10, sourceId: "finish", type: "finish", stageId: "s1", playerId: "p1", score: 999, elapsedMs: 10 },
        { atMs: 20, sourceId: "warning", type: "exclude", stageId: "s1", playerId: "p1", reason: "reset-hotkey" }
      ],
      expected: { attempts: 1, scoreboardVersions: 2 }
    });
    const engine = new CompetitionEngine(scenario);
    for (const event of scenario.events) engine.apply(event);
    expect(engine.snapshot().currentScoreboard[0]?.stages.s1).toMatchObject({
      status: "excluded", place: 0, points: 0, sourceId: "warning", finishSourceId: "finish", score: 999
    });
  });

  it("keeps voided attempt evidence but ranks only the latest valid attempt", () => {
    const base = loadMain();
    const stage = base.stages[0];
    if (!stage) throw new Error("missing stage fixture");
    const engine = new CompetitionEngine({ ...base, stages: [stage], players: base.players.slice(0, 2), events: [] });
    engine.apply({ atMs: 0, sourceId: "go-1", type: "go", stageId: stage.id, refereeConnectionId: base.refereeConnectionId });
    engine.apply({ atMs: 10, sourceId: "old-p1", type: "finish", stageId: stage.id, playerId: "p1", score: 100, elapsedMs: 10 });
    engine.apply({ atMs: 20, sourceId: "old-p2", type: "finish", stageId: stage.id, playerId: "p2", score: 90, elapsedMs: 20 });
    engine.voidAttempt(stage.id, 1, "void-attempt-1");

    expect(engine.snapshot().attempts[0]).toMatchObject({ attemptNumber: 1, voided: true, open: false });
    expect(engine.snapshot().currentScoreboard.every((entry) => entry.stages[stage.id] === undefined)).toBe(true);

    engine.apply({ atMs: 30, sourceId: "go-2", type: "go", stageId: stage.id, refereeConnectionId: base.refereeConnectionId });
    engine.apply({ atMs: 40, sourceId: "new-p2", type: "finish", stageId: stage.id, playerId: "p2", score: 80, elapsedMs: 10 });
    const snapshot = engine.snapshot();
    expect(snapshot.attempts).toMatchObject([
      { attemptNumber: 1, voided: true },
      { attemptNumber: 2, voided: false }
    ]);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "p1")?.stages[stage.id]).toBeUndefined();
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "p2")?.stages[stage.id]).toMatchObject({ sourceId: "new-p2", place: 1 });
  });

  it("rejects an unauthorized Go and never creates an attempt", () => {
    const definition = loadMain();
    const engine = new CompetitionEngine(definition);
    engine.apply({ atMs: 0, sourceId: "bad-go", type: "go", stageId: "s1", refereeConnectionId: "someone-else" });
    expect(engine.snapshot()).toMatchObject({ attempts: [], anomalies: [{ sourceId: "bad-go", code: "unauthorized-go" }] });
  });
});
