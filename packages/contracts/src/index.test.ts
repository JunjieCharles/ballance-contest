import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  createDefaultCompetitionConfig,
  minimumScoringPlaceFor,
  spectatorLoginName,
  stageCommandTarget,
  stageDisplayName,
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

describe("competition configuration", () => {
  it("derives an immutable spectator login from the referee name", () => {
    expect(spectatorLoginName("ContestConsole")).toBe("*ContestConsole");
    expect(spectatorLoginName("** Referee ")).toBe("*Referee");
  });

  it("returns actionable publish issues", () => {
    const config = createDefaultCompetitionConfig("Small Contest");
    expect(validateCompetitionConfigForPublish(config)).toEqual([]);
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
    })).toEqual(["裁判名不能为空"]);
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
