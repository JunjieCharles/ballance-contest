import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertScenarioDefinition } from "@ballance/contracts";
import { describe, expect, it } from "vitest";
import { CompetitionEngine } from "./competition-engine.js";
import { ScoreboardRevisionLedger } from "./scoreboard-revisions.js";

const baseVersion = () => {
  const scenario = assertScenarioDefinition(JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as unknown);
  const engine = new CompetitionEngine(scenario);
  for (const event of scenario.events) engine.apply(event);
  return engine.snapshot().scoreboardVersions.at(-1) as NonNullable<ReturnType<typeof engine.snapshot>["scoreboardVersions"][number]>;
};

describe("ScoreboardRevisionLedger", () => {
  it("applies an auditable overlay, recalculates ranking and never mutates the source version", () => {
    const source = baseVersion();
    const sourceJson = JSON.stringify(source);
    const ledger = new ScoreboardRevisionLedger(source);
    const revised = ledger.apply({
      playerId: "p4", stageId: "s3", stage: { place: 1, points: 70 }, rankPolicy: "tie",
      actor: "referee", reason: "录像复核确认名次", evidence: "video:42"
    });

    expect(revised.entries[0]).toMatchObject({ playerId: "p4", points: 70, rank: 1 });
    expect(revised.deterministicHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.history().overrides[0]).toMatchObject({ actor: "referee", reason: "录像复核确认名次", evidence: "video:42" });
    expect(JSON.stringify(source)).toBe(sourceJson);
  });

  it("requires an explicit rank policy and reverses by appending a new record", () => {
    const source = baseVersion();
    const ledger = new ScoreboardRevisionLedger(source);
    expect(() => ledger.apply({ playerId: "p4", stageId: "s3", stage: { place: 1 }, actor: "referee", reason: "fix" })).toThrow("RANK_POLICY_REQUIRED");
    const applied = ledger.apply({ playerId: "p5", totalPoints: 100, actor: "referee", reason: "申诉复核" });
    const overrideId = ledger.history().overrides[0]?.id as string;
    const reversed = ledger.reverse(overrideId, { actor: "chief-referee", reason: "撤销错误修订" });

    expect(applied.entries[0]?.playerId).toBe("p5");
    expect(reversed.entries.find((entry) => entry.playerId === "p5")?.points).toBe(0);
    expect(ledger.history().overrides).toHaveLength(2);
    expect(ledger.history().overrides[1]).toMatchObject({ reversesId: overrideId, actor: "chief-referee" });
    expect(() => ledger.reverse(overrideId, { actor: "chief-referee", reason: "again" })).toThrow("OVERRIDE_ALREADY_REVERSED");
  });
});
