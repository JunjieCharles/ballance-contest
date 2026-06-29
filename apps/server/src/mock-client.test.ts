import { describe, expect, it } from "vitest";
import { buildMockClientArguments } from "./mock-client.js";

describe("MockClient launch", () => {
  const options = { executable: "MockClient.exe", workingDirectory: "C:/mock", server: "1.bmmo.win", loginName: "*ContestConsole", uuid: "uuid", logPath: "C:/data/logs/mock.log" };
  it("uses an argument array with isolated log and fixed identity", () => {
    expect(buildMockClientArguments(options)).toEqual(["-s", "1.bmmo.win", "-n", "*ContestConsole", "-u", "uuid", "-l", "C:/data/logs/mock.log", "--auto-flush", "--no-sound-files"]);
  });
  it("rejects ports on preset servers", () => {
    expect(() => buildMockClientArguments({ ...options, server: "1.bmmo.win:26676" })).toThrow("must not include a port");
  });
});
