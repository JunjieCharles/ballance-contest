import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  createScoreboardTable,
  createDefaultCompetitionConfig,
  minimumScoringPlaceFor,
  spectatorLoginName,
  stageCommandTarget,
  stageDisplayName,
  scoreboardTableToHtml,
  scoreboardTableToTsv,
  validateCompetitionConfigForPublish
} from "./index.js";

describe("capabilitiesFor", () => {
  it("isolates test mode from real side effects", () => {
    expect(capabilitiesFor("test")).toMatchObject({
      realProcess: false,
      network: false,
      realCommands: false,
      virtualClock: true,
      playback: true,
      faultInjection: false,
      scenarioFaults: true
    });
  });

  it("allows the work adapter capabilities", () => {
    expect(capabilitiesFor("work")).toMatchObject({
      realProcess: true,
      network: true,
      realCommands: true,
      virtualClock: false,
      playback: false,
      faultInjection: false
    });
  });
});

describe("shared scoreboard table", () => {
  it("uses the live table columns, cell text and semantic styles for copy and exports", () => {
    const table = createScoreboardTable([{ id: "s1", label: "SR1" }, { id: "s2", label: "决赛图" }], [
      {
        rank: 1, playerId: "p1", displayName: "Alpha & Beta", points: 20, change: 2,
        stages: {
          s1: { status: "finished", place: 1, points: 20 },
          s2: { status: "dnf", place: 0, points: 0 }
        }
      },
      {
        rank: 2, playerId: "p2", displayName: "Gamma", points: 0, change: -1,
        stages: { s1: { status: "excluded", place: 0, points: 0 } }
      }
    ]);
    expect(table.headers).toEqual(["变化", "名次", "总分", "选手", "SR1", "决赛图"]);
    expect(table.rows[0]?.cells).toEqual([
      { text: "▲2", style: "rank-up" },
      { text: "1", style: "plain" },
      { text: "20", style: "plain" },
      { text: "Alpha & Beta", style: "plain" },
      { text: "#1 / 20 分", style: "gold" },
      { text: "DNF", style: "dnf" }
    ]);
    expect(scoreboardTableToTsv(table)).toContain("变化\t名次\t总分\t选手\tSR1\t决赛图\r\n▲2\t1\t20\tAlpha & Beta\t#1 / 20 分\tDNF");
    expect(scoreboardTableToHtml(table)).toContain("Alpha &amp; Beta");
    expect(scoreboardTableToHtml(table)).toContain('data-style="gold"');
    expect(scoreboardTableToHtml(table)).toContain("text-decoration:line-through");
    expect(scoreboardTableToHtml(table)).toContain('data-style="excluded"');
  });
});

describe("competition configuration", () => {
  it("derives an immutable spectator login from the referee name", () => {
    expect(spectatorLoginName("ContestConsole")).toBe("*ContestConsole");
    expect(spectatorLoginName("** Referee ")).toBe("*Referee");
  });

  it("returns actionable publish issues", () => {
    const config = createDefaultCompetitionConfig("Small Contest");
    expect(validateCompetitionConfigForPublish(config)).toEqual([]);
    expect(config.flow.startProtectionEnabled).toBe(true);
    expect(config.scoring).toMatchObject({ contestType: "small", minimumScoringPlace: 12, points: { length: 12 } });
    expect(config.stages.every((stage) => stage.minimumScoringPlace === 12 && stage.scoring.length === 12)).toBe(true);
    expect(validateCompetitionConfigForPublish({
      ...config,
      refereeName: "",
      participants: [{
        id: "p1",
        displayName: "Alpha",
        role: "participant",
        connectionIds: [],
        online: false,
        currentStageStatus: "not-started"
      }]
    })).toEqual(["服务器控制身份固定为 ContestConsole"]);
  });

  it("derives the last scoring place from the configured rank-to-points table", () => {
    expect(minimumScoringPlaceFor([20, 10, 1])).toBe(3);
    expect(minimumScoringPlaceFor([10, 5, 0, 0])).toBe(2);
    expect(minimumScoringPlaceFor([0])).toBe(1);
  });

  it("validates and encodes official and custom map stages", () => {
    const config = createDefaultCompetitionConfig("Mixed maps");
    const official = config.stages[0]!;
    const custom = {
      ...official,
      id: "custom-final",
      label: "云端决赛图",
      level: 0,
      mode: "HS" as const,
      mapKind: "custom" as const,
      mapHash: "e90b2f535c8bf881e9cb83129fba241d"
    };
    expect(stageDisplayName(official)).toBe("SR1");
    expect(stageCommandTarget(official)).toBe("level 1");
    expect(stageDisplayName(custom)).toBe("云端决赛图");
    expect(stageCommandTarget(custom)).toBe("e90b2f535c8bf881e9cb83129fba241d 0");
    expect(validateCompetitionConfigForPublish({ ...config, stages: [official, custom] })).toEqual([]);
    expect(validateCompetitionConfigForPublish({ ...config, stages: [{ ...custom, label: "", mapHash: "not-md5", level: 2 }] }))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("名称不能为空"),
        expect.stringContaining("32 位十六进制 MD5"),
        expect.stringContaining("内部关卡号必须为 0")
      ]));
    expect(validateCompetitionConfigForPublish({
      ...config,
      stages: [custom, { ...custom, id: "collision", mapHash: "e90b2f535c8bf881e9cb000000000000" }]
    })).toContain("自制图哈希前缀 e90b2f535c8bf881e9cb.. 无法唯一匹配");
  });
});
