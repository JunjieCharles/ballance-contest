import { describe, expect, it } from "vitest";
import { VirtualClock } from "./index.js";

describe("VirtualClock", () => {
  it("advances deterministically", () => {
    const clock = new VirtualClock(1_000);
    clock.advanceBy(250);
    expect(clock.now()).toBe(1_250);
  });

  it("rejects backwards and invalid movement", () => {
    const clock = new VirtualClock();
    expect(() => clock.advanceBy(-1)).toThrow(RangeError);
    expect(() => clock.advanceBy(Number.NaN)).toThrow(RangeError);
  });
});
