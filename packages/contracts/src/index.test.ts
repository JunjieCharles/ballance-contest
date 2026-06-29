import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "./index.js";

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
