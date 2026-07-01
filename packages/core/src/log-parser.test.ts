import { describe, expect, it } from "vitest";
import { parseLogLine } from "./log-parser.js";

const context = { year: 2025, utcOffsetMinutes: 480 };

describe("parseLogLine", () => {
  it("parses authoritative Go and keeps source identity", () => {
    const parsed = parseLogLine("[06-29 11:20:28] [2717249041, *Referee]: Level 01 - Go!", { ...context, sourceId: "source-1" });
    expect(parsed.timestamp).toBe("2025-06-29T03:20:28.000Z");
    expect(parsed.event).toMatchObject({ type: "go", connectionId: "2717249041", refereeName: "*Referee", level: 1, sourceId: "source-1" });
  });

  it("parses finishes, DNF, login, disconnect and cheat", () => {
    expect(parseLogLine("[06-29 11:21:00] 2 player(s) online:", context).event)
      .toMatchObject({ type: "player-list-start", count: 2 });
    expect(parseLogLine("[06-29 11:21:00] (#12, Player) finished Level 01 in 2nd place (score: 1234; real time: 00:01:02.345).", context).event)
      .toMatchObject({ type: "finish", connectionId: "12", playerName: "Player", level: 1, serverPlace: 2, score: 1234, elapsedMs: 62_345 });
    expect(parseLogLine("[06-29 11:21:01] (#12, Player) did not finish Level 01 (furthest reach: sector 4).", context).event)
      .toMatchObject({ type: "dnf", furthestSector: 4 });
    expect(parseLogLine("[06-29 11:21:02] Player (#12) logged in with cheat mode off.", context).event)
      .toMatchObject({ type: "player-login", cheat: false });
    expect(parseLogLine("[06-29 11:21:02] Silent_Snow (#42) [CHEAT]", context).event)
      .toMatchObject({ type: "player-listed", connectionId: "42", playerName: "Silent_Snow", cheat: true });
    expect(parseLogLine("[06-29 11:21:03] Player (#12) disconnected.", context).event.type).toBe("player-disconnect");
    expect(parseLogLine("[06-29 11:21:04] (12, Player) turned cheat on.", context).event)
      .toMatchObject({ type: "cheat-changed", enabled: true });
  });

  it("parses the three player-facing notifications and the real 3/2/1 countdown", () => {
    expect(parseLogLine("[06-29 11:20:12] [Announcement] (2717249041, *Referee): READY!", context).event)
      .toMatchObject({ type: "notification", channel: "announce", refereeName: "*Referee", text: "READY!" });
    expect(parseLogLine("[06-29 11:20:13] [Notice] (2717249041, *Referee): wait Player", context).event)
      .toMatchObject({ type: "notification", channel: "notice", text: "wait Player" });
    expect(parseLogLine("[06-29 11:20:14] [Bulletin] *Referee: SR1, 20:10", context).event)
      .toMatchObject({ type: "notification", channel: "bulletin", text: "SR1, 20:10" });
    for (const value of [3, 2, 1] as const) {
      expect(parseLogLine(`[06-29 11:20:2${8 - value}] [2717249041, *Referee]: Level 01 - ${value}`, context).event)
        .toMatchObject({ type: "countdown", level: 1, value });
    }
  });

  it("identifies only the two known player warnings as scoring violations", () => {
    expect(parseLogLine("[06-29 11:20:14] [Warning] Hurts_LM just pressed the Reset hotkey at Level 01!", context).event)
      .toMatchObject({ type: "warning", playerName: "Hurts_LM", level: 1, violationCode: "reset-hotkey" });
    expect(parseLogLine("[06-29 11:20:15] [Warning] Fresh_Mush just restarted Level 01 when their ball is not controllable.", context).event)
      .toMatchObject({ type: "warning", playerName: "Fresh_Mush", level: 1, violationCode: "uncontrollable-restart" });
    expect(parseLogLine("[06-29 11:20:16] [Warning] Incompatible server version.", context).event)
      .toEqual(expect.objectContaining({ type: "warning", message: "Incompatible server version." }));
    expect(parseLogLine("[06-29 11:20:16] [Warning] Incompatible server version.", context).event)
      .not.toEqual(expect.objectContaining({ playerName: expect.any(String) }));
  });

  it("removes ANSI and preserves unknown data without changing state", () => {
    const parsed = parseLogLine("\u001b[31m[06-29 11:21:00] new upstream format\u001b[0m", context);
    expect(parsed.event).toMatchObject({ type: "unknown", text: "new upstream format" });
    expect(parsed.rawLine).not.toContain("\u001b");
  });
});
