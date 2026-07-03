import { describe, expect, it } from "vitest";
import { CommandQueue } from "./command-queue.js";
import type { CommandTransport } from "./mock-client.js";

class FakeTransport implements CommandTransport {
  public readonly writes: string[] = [];
  public onWrite?: (command: string) => void;
  public async write(command: string): Promise<void> { this.writes.push(command); this.onWrite?.(command); }
}

describe("CommandQueue", () => {
  it("serializes commands, waits for matching echoes and returns idempotent results", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = (command) => setTimeout(() => queue.observeLine(command === "list" ? "2 player(s) online:" : "[7, *ContestConsole]: Level 01 - Go!"), 0);
    const first = queue.enqueue({ type: "list" }, "same");
    const second = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go");
    expect((await first).status).toBe("acknowledged");
    expect((await second).status).toBe("acknowledged");
    expect((await queue.enqueue({ type: "list" }, "same")).id).toBe((await first).id);
    expect(transport.writes).toEqual(["list", "countdown level 1 sr"]);
  });

  it("observes a synchronous echo produced while stdin is still being written", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 5);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => queue.observeLine("[7, *ContestConsole]: Level 01 - Go!");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "sync-go")).status).toBe("acknowledged");
  });

  it("routes later commands to a replacement MockClient transport", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const queue = new CommandQueue(first, 20);
    first.onWrite = () => queue.observeLine("1 player(s) online:");
    expect((await queue.enqueue({ type: "list" }, "before-restart")).status).toBe("acknowledged");
    queue.replaceTransport(second);
    second.onWrite = () => queue.observeLine("1 player(s) online:");
    expect((await queue.enqueue({ type: "list" }, "after-restart")).status).toBe("acknowledged");
    expect(first.writes).toEqual(["list"]);
    expect(second.writes).toEqual(["list"]);
  });

  it("fails the pending command immediately when the server reports missing permission", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => queue.observeLine("[07-02 10:00:00] Action failed: you don't have the permission to run this action.");
    const result = await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "denied-go");
    expect(result).toMatchObject({ status: "failed", responseLine: expect.stringContaining("don't have the permission") });
  });

  it("writes custom map names once with the required hidden level zero", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    const result = await queue.enqueue({ type: "set-map", mapHash: "E90B2F535C8BF881E9CB83129FBA241D", displayName: "Contest Map With Spaces" }, "set-map");
    expect(result.status).toBe("acknowledged");
    expect(transport.writes).toEqual(["setmap e90b2f535c8bf881e9cb83129fba241d 0 Contest Map With Spaces"]);
  });

  it("keeps setmap pending long enough to capture an asynchronous permission failure", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => setTimeout(() => queue.observeLine("Action failed: you don't have the permission to run this action."), 0);
    expect((await queue.enqueue({
      type: "set-map",
      mapHash: "e90b2f535c8bf881e9cb83129fba241d",
      displayName: "Contest Map With Spaces"
    }, "set-map-denied")).status).toBe("failed");
  });

  it("sends setmap for official maps with zero-padded level label", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    const result = await queue.enqueue({ type: "set-official-map", level: 3, displayName: "Level_03" }, "official-map");
    expect(result.status).toBe("acknowledged");
    expect(transport.writes).toEqual(["setmap level 3 Level_03"]);
  });

  it("matches official map echo after setmap registration with Level_0N format", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: Level_03 - Go!"), 0);
    expect((await queue.enqueue({ type: "go", map: "level 3", mode: "sr" }, "level3-with-underscore-go")).status).toBe("acknowledged");
  });

  it("accepts the live server's starred official Ready echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("2355344013");
    transport.onWrite = () => setTimeout(() => queue.observeLine("[07-02 20:32:49] [2355344013, *ContestConsole]: Level 01* - Get ready"), 0);
    expect((await queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "starred-ready")).status).toBe("acknowledged");
  });

  it("accepts official HS echoes only from ContestConsole and with the HS marker", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("3642659740");
    transport.onWrite = (command) => {
      const value = command.endsWith(" 4") ? "Get ready" : "Go!";
      setTimeout(() => queue.observeLine(`[3210244510, Player]: Level 01 <HS> - ${value}`), 0);
      setTimeout(() => queue.observeLine(`[3642659740, *ContestConsole]: Level 01 - ${value}`), 1);
      setTimeout(() => queue.observeLine(`[3642659740, *ContestConsole]: Level 01 <HS> - ${value}`), 2);
    };
    expect((await queue.enqueue({ type: "ready", map: "level 1", mode: "hs" }, "hs-ready")).responseLine)
      .toContain("*ContestConsole]: Level 01 <HS> - Get ready");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "hs" }, "hs-go")).responseLine)
      .toContain("*ContestConsole]: Level 01 <HS> - Go!");
  });

  it("does not let another player's Ready or Go acknowledge referee commands", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("2760557282");
    transport.onWrite = (command) => {
      const value = command.endsWith(" 4") ? "Get ready" : "Go!";
      setTimeout(() => queue.observeLine(`[3210244510, liangzhichao]: Level 02 - ${value}`), 0);
      setTimeout(() => queue.observeLine(`[9999999999, *ContestConsole]: Level 02 - ${value}`), 1);
      setTimeout(() => queue.observeLine(`[2760557282, *ContestConsole]: Level 02 - ${value}`), 2);
    };
    expect((await queue.enqueue({ type: "ready", map: "level 2", mode: "sr" }, "referee-ready")).responseLine)
      .toContain("*ContestConsole");
    expect((await queue.enqueue({ type: "go", map: "level 2", mode: "sr" }, "referee-go")).responseLine)
      .toContain("*ContestConsole");
  });

  it("confirms cheat off only from the global ContestConsole echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("2760557282");
    transport.onWrite = () => {
      setTimeout(() => queue.observeLine("(1026234650, Aleph) turned cheat off."), 0);
      setTimeout(() => queue.observeLine("(#9999999999, *ContestConsole) toggled cheat off globally!"), 1);
      setTimeout(() => queue.observeLine("(#2760557282, *ContestConsole) toggled cheat off globally!"), 2);
    };
    expect((await queue.enqueue({ type: "cheat-off" }, "global-cheat-off")).responseLine)
      .toBe("(#2760557282, *ContestConsole) toggled cheat off globally!");
  });

  it("waits for authoritative Go instead of acknowledging at 3/2/1", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => {
      for (const [delay, value] of [[0, "3"], [1, "2"], [2, "1"], [3, "Go!"]] as const) {
        setTimeout(() => queue.observeLine(`[7, *ContestConsole]: Level 01 - ${value}`), delay);
      }
    };
    const result = await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "authoritative-go-only");
    expect(result).toMatchObject({ status: "acknowledged", responseLine: expect.stringMatching(/Go!$/) });
  });

  it("acknowledges list from the current trailing summary format", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = (command) => setTimeout(() => {
      if (command === "list") {
        queue.observeLine("3598759654: *ContestConsole     0ms");
        queue.observeLine("1 client(s) online: 0 player(s), 1 spectator(s).");
      } else {
        queue.observeLine("[3598759654, *ContestConsole]: Level 01 - Go!");
      }
    }, 0);
    expect((await queue.enqueue({ type: "list" }, "current-list")).status).toBe("acknowledged");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go-after-list")).status).toBe("acknowledged");
  });

  it("does not accept an identity-bearing echo before the current local connection ID is known", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 20);
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: Level 01 - Go!"), 0);
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go-without-current-id")).status).toBe("uncertain");
  });

  it("encodes custom maps with hidden level zero and requires their quoted hash prefix", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    transport.onWrite = (command) => setTimeout(() => {
      queue.observeLine(`[7, *ContestConsole]: "ffffffffffffffffffff.." <HS> - ${command.endsWith(" 4") ? "Get ready" : "Go!"}`);
      queue.observeLine(`[7, *ContestConsole]: "${hash.slice(0, 20)}.." <HS> - ${command.endsWith(" 4") ? "Get ready" : "Go!"}`);
    }, 0);
    expect((await queue.enqueue({ type: "ready", map: `${hash} 0`, mode: "hs" }, "custom-ready")).status).toBe("acknowledged");
    expect((await queue.enqueue({ type: "go", map: `${hash} 0`, mode: "hs" }, "custom-go")).status).toBe("acknowledged");
    expect(transport.writes).toEqual([
      `countdown ${hash} 0 hs 4`,
      `countdown ${hash} 0 hs`
    ]);
  });

  it("accepts the published custom map name echoed after setmap registration", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: \"Contest Map With Spaces\" <HS> - Get ready"), 0);
    expect((await queue.enqueue({ type: "ready", map: `${hash} 0`, mapName: "Contest Map With Spaces", mode: "hs" }, "named-custom-ready")).status)
      .toBe("acknowledged");
  });

  it("accepts the live server's unquoted official-map hash echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: a364b408fffaab434480.. - Go!"), 0);
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "official-hash-go")).status).toBe("acknowledged");
  });

  it("collects listmap entries and returns them as JSON in responseLine", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => {
      setTimeout(() => queue.observeLine("[07-02 17:40:48] a364b408fffaab4344806b427e37f1a7: Level_01"), 0);
      setTimeout(() => queue.observeLine("[07-02 17:40:48] ed2b0da16a05ed2ef3befa5ca5000a64: Level_01/45°"), 0);
    };
    const result = await queue.enqueue({ type: "listmap" }, "verify-maps");
    expect(result.status).toBe("acknowledged");
    const names = JSON.parse(result.responseLine ?? "[]") as string[];
    expect(names).toContain("Level_01");
    expect(names).toContain("Level_01/45°");
  });

  it("encodes bulletin, notice and announce as distinct MockClient commands", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = (command) => {
      const [channel, ...content] = command.split(" ");
      const text = content.join(" ");
      const label = channel === "announce" ? "Announcement" : channel === "notice" ? "Notice" : "Bulletin";
      setTimeout(() => queue.observeLine(`[07-02 20:00:00] > ${command}`), 0);
      if (channel !== "bulletin") setTimeout(() => queue.observeLine(`[07-02 20:00:00] [${label}] (999, *ContestConsole): ${text}`), 1);
      setTimeout(() => queue.observeLine(channel === "bulletin"
        ? `[07-02 20:00:00] [${label}] *ContestConsole: ${text}`
        : `[07-02 20:00:00] [${label}] (7, *ContestConsole): ${text}`), 2);
    };
    await queue.enqueue({ type: "notification", channel: "bulletin", text: "SR1 20:10" }, "bulletin");
    await queue.enqueue({ type: "notification", channel: "notice", text: "wait Player" }, "notice");
    await queue.enqueue({ type: "notification", channel: "announce", text: "READY!" }, "announce");
    expect(transport.writes).toEqual(["bulletin SR1 20:10", "notice wait Player", "announce READY!"]);
  });

  it("keeps a business newline but protocol-escapes it into one MockClient command", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => setTimeout(() => queue.observeLine("[Notice] (7, *ContestConsole): SR1 即将发令。\\n本关起跑保护已被使用，后续不再延时。"), 0);
    await queue.enqueue({
      type: "notification",
      channel: "notice",
      text: "SR1 即将发令。\n本关起跑保护已被使用，后续不再延时。"
    }, "protected-notice");
    expect(transport.writes).toEqual(["notice SR1 即将发令。\\n本关起跑保护已被使用，后续不再延时。"]);
  });

  it("does not acknowledge kick or raw commands from local echo and unrelated output", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 20);
    transport.onWrite = (command) => {
      setTimeout(() => queue.observeLine(`> ${command}`), 0);
      setTimeout(() => queue.observeLine("unrelated success and disconnect"), 1);
      if (command.startsWith("kick ")) setTimeout(() => queue.observeLine("Target Player (#42) disconnected."), 2);
    };
    expect((await queue.enqueue({ type: "kick", playerName: "Target Player", reason: "probe" }, "kick-target"))).toMatchObject({
      status: "acknowledged",
      responseLine: "Target Player (#42) disconnected."
    });
    expect((await queue.enqueue({ type: "raw", command: "some-mutating-command" }, "raw-unverifiable")).status).toBe("uncertain");
  });

  it("acknowledges kicking ContestConsole only from the exact 1101 server result", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = (command) => {
      setTimeout(() => queue.observeLine(`> ${command}`), 0);
      setTimeout(() => queue.observeLine("The host hath bidden us farewell.  (5003: Connection dropped)"), 1);
      setTimeout(() => queue.observeLine("The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (workflow-probe-finished).)"), 2);
    };
    expect((await queue.enqueue({ type: "kick", playerName: "*ContestConsole", reason: "workflow-probe-finished" }, "kick-self"))).toMatchObject({
      status: "acknowledged",
      responseLine: "The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (workflow-probe-finished).)"
    });
  });

  it("rejects control characters before writing", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport);
    expect(() => queue.enqueue({ type: "raw", command: "hello\nstop" }, "unsafe")).toThrow("control characters");
    expect(() => queue.enqueue({ type: "notification", channel: "notice", text: "hello\rstop" }, "unsafe-notice")).toThrow("control characters");
    expect(transport.writes).toEqual([]);
  });

  it("rejects forcenextrestart in the final stdin adapter", () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport);
    expect(() => queue.enqueue({ type: "raw", command: " forcenextrestart " }, "unsafe-global-go"))
      .toThrow(/every map/);
    expect(transport.writes).toEqual([]);
  });
});
