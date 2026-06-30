import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  createDefaultCompetitionConfig,
  spectatorLoginName,
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
      faultInjection: true
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
});
