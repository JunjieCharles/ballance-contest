import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertScenarioDefinition } from "@ballance/contracts";
import { CompetitionEngine } from "@ballance/core";
import { describe, expect, it } from "vitest";
import { createScoreboardExports } from "./scoreboard-export.js";

const exportBundle = () => {
  const scenario = assertScenarioDefinition(JSON.parse(readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8")) as unknown);
  const engine = new CompetitionEngine(scenario);
  for (const event of scenario.events) engine.apply(event);
  const version = engine.snapshot().scoreboardVersions.at(-1) as NonNullable<ReturnType<typeof engine.snapshot>["scoreboardVersions"][number]>;
  return createScoreboardExports({
    competitionName: "测试赛<script>", mode: "test", version: version.version,
    generatedAt: "2026-06-29T12:00:00.000Z", entries: version.entries,
    stages: scenario.stages.map((stage) => ({ id: stage.id, label: `${stage.mode}${stage.level}` }))
  });
};

describe("scoreboard exports", () => {
  it("exports CSV from the same per-stage table model without mode or combined-result columns", () => {
    const bundle = exportBundle();
    expect(bundle.basename).toBe("测试赛_script__test_v15_20260629T120000Z");
    expect(bundle.table.headers).toEqual(["变化", "名次", "总分", "选手", "SR1", "HS2", "SR13"]);
    expect(bundle.table.rows[0]?.cells.map((cell) => cell.text)).toHaveLength(bundle.table.headers.length);
    expect(bundle.csv.startsWith("\ufeff")).toBe(true);
    expect(bundle.csv.split("\r\n")).toHaveLength(6);
    expect(bundle.csv).toContain('"变化","名次","总分","选手","SR1","HS2","SR13"');
    expect(bundle.csv).toContain('"#1 / 20 分"');
    expect(bundle.csv).toContain('"DNF"');
    expect(bundle.csv).not.toContain("数据标记");
    expect(bundle.csv).not.toContain("轮次结果");
  });

  it("creates an Open XML workbook with the same cells, frozen headers and per-stage styles", () => {
    const bundle = exportBundle();
    const xlsx = bundle.xlsx;
    expect(xlsx.readUInt32LE(0)).toBe(0x04034b50);
    expect(xlsx.readUInt32LE(xlsx.length - 22)).toBe(0x06054b50);
    const content = xlsx.toString("utf8");
    expect(content).toContain('state="frozen"');
    expect(content).toContain('name="测试成绩"');
    expect(content).not.toContain('name="计分规则"');
    expect(content).toContain("FFFFB700");
    expect(content).toContain("FFFFF0F1");
    expect(content).toContain("<strike/>");
    for (const header of bundle.table.headers) expect(content).toContain(`>${header}<`);
    for (const cell of bundle.table.rows[0]?.cells ?? []) expect(content).toContain(`>${cell.text}<`);
  });

  it("uses valid Excel column references after column Z", () => {
    const stages = Array.from({ length: 26 }, (_value, index) => ({ id: `s${index + 1}`, label: `S${index + 1}` }));
    const bundle = createScoreboardExports({
      competitionName: "Wide", mode: "work", version: 1, generatedAt: "2026-06-29T12:00:00.000Z", stages,
      entries: [{ rank: 1, playerId: "p1", displayName: "Alpha", points: 0, change: null, stages: {} }]
    });
    expect(bundle.xlsx.toString("utf8")).toContain('<c r="AD1"');
    expect(bundle.basename).toContain("_work_v1_");
    expect(bundle.xlsx.toString("utf8")).toContain('name="工作成绩"');
  });
});
