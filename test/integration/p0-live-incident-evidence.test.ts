import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readStaticLog } from "../../apps/server/src/log-source.js";
import { parseLogLine } from "../../packages/core/src/index.js";

interface IncidentExpectation {
  source: {
    archiveName: string;
    archiveSha256: string;
    manifestSha256: string;
    fixtureCanonicalLfSha256: string;
  };
  expectedSequence: Record<string, string>;
  authority: {
    automaticRefereeName: string;
    externalRefereeName: string;
    externalGoMustAdvanceState: boolean;
  };
}

const fixturePath = resolve("test/fixtures/logs/bfnr43-stage-drift.log");
const expectationPath = resolve("test/fixtures/logs/bfnr43-stage-drift.expected.json");
const expectation = JSON.parse(readFileSync(expectationPath, "utf8")) as IncidentExpectation;

describe("P0 BFNR43 incident evidence", () => {
  it("BE-FORENSIC-001: preserves the sanitized source and the observed stage-drift sequence", async () => {
    const before = statSync(fixturePath);
    const source = await readStaticLog(fixturePath);
    const after = statSync(fixturePath);

    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
    expect(source.invalidEncoding).toBe(false);
    const canonicalLfSha256 = createHash("sha256").update(source.lines.join("\n")).digest("hex");
    expect(canonicalLfSha256).toBe(expectation.source.fixtureCanonicalLfSha256);
    expect(expectation.source).toMatchObject({
      archiveName: "BFNR43.zip",
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const lines = source.lines.filter(Boolean);
    const position = (fragment: string): number => lines.findIndex((line) => line.includes(fragment));
    const sequence = [
      position("Player13) finished Level 06"),
      position("> list"),
      position("1002: A player with the same username"),
      position("[9001, *Operator]: Level 07 - Go!"),
      position("PlayerDNF) did not finish Level 07"),
      position("LEVEL 6 比赛时间已到"),
      position("[9002, *ContestConsole]: Level 07 - Get ready")
    ];
    expect(sequence.every((index) => index >= 0)).toBe(true);
    expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    expect(Object.values(expectation.expectedSequence)).toEqual([
      "20:47:27", "20:47:30", "20:51:14", "20:52:13", "20:52:36", "20:54:58", "20:55:09", "20:55:09"
    ]);
  });

  it("BE-GO-002: parses the operator Go as external evidence, not the fixed automatic referee", async () => {
    const source = await readStaticLog(fixturePath);
    const parsed = source.lines.filter(Boolean).map((line) => ({
      line,
      event: parseLogLine(line, { year: 2026, utcOffsetMinutes: 480 }).event
    }));
    const eventFor = (fragment: string) => {
      const entry = parsed.find((candidate) => candidate.line.includes(fragment));
      if (!entry) throw new Error(`Missing fixture line: ${fragment}`);
      return entry.event;
    };

    expect(eventFor("[9001, *Operator]: Level 07 - Go!")).toMatchObject({
      type: "go",
      connectionId: "9001",
      refereeName: expectation.authority.externalRefereeName,
      level: 7,
      mode: "sr"
    });
    expect(expectation.authority).toEqual({
      automaticRefereeName: "*ContestConsole",
      externalRefereeName: "*Operator",
      externalGoMustAdvanceState: false
    });
    expect(eventFor("[9002, *ContestConsole]: Level 07 - Get ready")).toMatchObject({
      type: "ready",
      connectionId: "9002",
      refereeName: expectation.authority.automaticRefereeName,
      level: 7,
      mode: "sr"
    });
    expect(eventFor("PlayerDNF) did not finish Level 07")).toMatchObject({ type: "dnf", level: 7 });
    expect(eventFor("[Announcement] (9002, *ContestConsole): LEVEL 6 比赛时间已到")).toMatchObject({
      type: "notification",
      channel: "announce",
      refereeName: "*ContestConsole"
    });
    expect(eventFor("1002: A player with the same username").rawLine).toContain("*ContestConsole");
  });
});
