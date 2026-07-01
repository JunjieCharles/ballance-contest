import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMockClientArguments, resolveMockClientUuid } from "./mock-client.js";

describe("MockClient launch", () => {
  const options = { executable: "MockClient.exe", workingDirectory: "C:/mock", server: "1.bmmo.win", refereeName: "ContestConsole", uuid: "uuid", logPath: "C:/data/logs/mock.log" };
  it("uses an argument array with isolated log and fixed identity", () => {
    expect(buildMockClientArguments(options)).toEqual(["-s", "1.bmmo.win", "-n", "*ContestConsole", "-u", "uuid", "-l", "C:/data/logs/mock.log", "--auto-flush", "--no-sound-files"]);
  });
  it("rejects ports on preset servers", () => {
    expect(() => buildMockClientArguments({ ...options, server: "1.bmmo.win:26676" })).toThrow("must not include a port");
  });
  it("always enforces the spectator marker", () => {
    expect(buildMockClientArguments({ ...options, refereeName: "**Referee" })[3]).toBe("*Referee");
  });

  it("reads a persisted UUID from a local file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-client-uuid-"));
    try {
      writeFileSync(join(dir, ".mock-client-uuid"), "3b9d4b57-5d8e-4f09-8f2d-1ce8d3c5f7a1\n");
      expect(resolveMockClientUuid(dir, "fallback-uuid")).toBe("3b9d4b57-5d8e-4f09-8f2d-1ce8d3c5f7a1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the generated UUID when no persisted file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-client-uuid-"));
    try {
      expect(resolveMockClientUuid(dir, "fallback-uuid")).toBe("fallback-uuid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
