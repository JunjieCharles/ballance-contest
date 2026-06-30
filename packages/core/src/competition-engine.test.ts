import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertScenarioDefinition, type ScenarioDefinition } from "@ballance/contracts";
import { describe, expect, it } from "vitest";
import { CompetitionEngine } from "./competition-engine.js";

const loadMain = (): ScenarioDefinition => assertScenarioDefinition(JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as unknown);

describe("CompetitionEngine", () => {
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

  it("rejects an unauthorized Go and never creates an attempt", () => {
    const definition = loadMain();
    const engine = new CompetitionEngine(definition);
    engine.apply({ atMs: 0, sourceId: "bad-go", type: "go", stageId: "s1", refereeConnectionId: "someone-else" });
    expect(engine.snapshot()).toMatchObject({ attempts: [], anomalies: [{ sourceId: "bad-go", code: "unauthorized-go" }] });
  });
});
