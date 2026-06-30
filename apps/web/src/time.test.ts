import { describe, expect, it } from "vitest";
import { toUtc8Input, utc8InputToIso } from "./time.js";

describe("UTC+8 datetime-local conversion", () => {
  it("shows UTC instants in UTC+8 and submits the entered wall time with an explicit offset", () => {
    expect(toUtc8Input(new Date("2026-06-30T21:23:00.000Z"))).toBe("2026-07-01T05:23");
    expect(utc8InputToIso("2026-07-01T05:23")).toBe("2026-06-30T21:23:00.000Z");
  });
});
