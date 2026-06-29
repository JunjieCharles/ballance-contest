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
    scoringRules: [{ stage: "s1", rule: "20/15/12" }]
  });
};

describe("scoreboard exports", () => {
  it("exports one fixed scoreboard version to escaped HTML, TSV and CSV with test labels", () => {
    const bundle = exportBundle();
    expect(bundle.basename).toBe("测试赛_script__v15_20260629T120000Z");
    expect(bundle.html).toContain("测试数据 · 不得作为正式成绩");
    expect(bundle.html).toContain("测试赛&lt;script&gt;");
    expect(bundle.html).not.toContain("<h1>测试赛<script>");
    expect(bundle.tsv.split("\r\n")).toHaveLength(6);
    expect(bundle.tsv).toContain("测试数据\t1\tAlpha");
    expect(bundle.csv.startsWith("\ufeff")).toBe(true);
    expect(bundle.csv).toContain('"数据标记","排名","选手"');
  });

  it("creates an Open XML workbook with frozen headers, medal styles, DNF strike and a rules sheet", () => {
    const xlsx = exportBundle().xlsx;
    expect(xlsx.readUInt32LE(0)).toBe(0x04034b50);
    expect(xlsx.readUInt32LE(xlsx.length - 22)).toBe(0x06054b50);
    const content = xlsx.toString("utf8");
    expect(content).toContain('state="frozen"');
    expect(content).toContain('name="测试成绩"');
    expect(content).toContain('name="积分规则"');
    expect(content).toContain("FFFFD700");
    expect(content).toContain("<strike/>");
  });
});
