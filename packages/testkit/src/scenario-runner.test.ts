import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScenarioRunner } from "./scenario-runner.js";

describe("ScenarioRunner", () => {
  it("validates, orders, advances and deterministically resets the main scenario", () => {
    const scenario = JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as unknown;
    const runner = new ScenarioRunner(scenario);
    const first = runner.playAll();
    expect(first).toHaveLength(25);
    expect(first.at(-1)?.atMs).toBe(8_800);
    expect(runner.clock.now()).toBe(8_800);
    runner.reset();
    expect(runner.clock.now()).toBe(0);
    expect(runner.playAll()).toEqual(first);
  });

  it("rejects incomplete scenario definitions", () => {
    expect(() => new ScenarioRunner({ schemaVersion: 1 })).toThrow("Invalid scenario");
  });
});
