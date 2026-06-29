import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScenarioDefinition } from "../../packages/contracts/src/index.js";
import { assertScenarioDefinition } from "../../packages/contracts/src/index.js";
import { CompetitionEngine } from "../../packages/core/src/index.js";
import { ScenarioRunner } from "../../packages/testkit/src/index.js";
import { describe, expect, it } from "vitest";

const loadScenario = (id: string): ScenarioDefinition =>
  assertScenarioDefinition(JSON.parse(readFileSync(resolve(`test/fixtures/scenarios/${id}/scenario.json`), "utf8")) as unknown);

const hashesFor = (definition: ScenarioDefinition): readonly string[] => {
  const engine = new CompetitionEngine(definition);
  new ScenarioRunner(definition).playAll((event) => engine.apply(event));
  return engine.snapshot().scoreboardVersions.map((version) => version.deterministicHash);
};

describe("NF-DETERMINISM-001 centralized fixtures", () => {
  it("replays every committed minimal scenario with stable scoreboard hashes", () => {
    for (const scenarioId of ["three-stage-main", "authority-practice-dnf", "tail-intake-window"]) {
      const definition = loadScenario(scenarioId);
      const first = hashesFor(definition);
      const second = hashesFor(definition);
      expect(first, scenarioId).toEqual(second);
      expect(first, scenarioId).toHaveLength(definition.expected.scoreboardVersions);
    }
  });
});
