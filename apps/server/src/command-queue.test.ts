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
    transport.onWrite = (command) => setTimeout(() => queue.observeLine(command === "list" ? "2 player(s) online:" : "Level 01 - Go!"), 0);
    const first = queue.enqueue({ type: "list" }, "same");
    const second = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go");
    expect((await first).status).toBe("acknowledged");
    expect((await second).status).toBe("acknowledged");
    expect((await queue.enqueue({ type: "list" }, "same")).id).toBe((await first).id);
    expect(transport.writes).toEqual(["list", "countdown level 1 sr"]);
  });

  it("acknowledges forcenextrestart after write without server echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 5);
    expect((await queue.enqueue({ type: "force-next-restart" }, "critical")).status).toBe("acknowledged");
    expect(transport.writes).toEqual(["forcenextrestart"]);
  });

  it("observes a synchronous echo produced while stdin is still being written", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 5);
    transport.onWrite = () => queue.observeLine("[7, *ContestConsole]: Level 01 - Go!");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "sync-go")).status).toBe("acknowledged");
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
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: Level_03 - Go!"), 0);
    expect((await queue.enqueue({ type: "go", map: "level 3", mode: "sr" }, "level3-with-underscore-go")).status).toBe("acknowledged");
  });

  it("acknowledges list from the current trailing summary format", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => setTimeout(() => {
      queue.observeLine("3598759654: *ContestConsole     0ms");
      queue.observeLine("1 client(s) online: 0 player(s), 1 spectator(s).");
    }, 0);
    expect((await queue.enqueue({ type: "list" }, "current-list")).status).toBe("acknowledged");
  });

  it("encodes custom maps with hidden level zero and requires their quoted hash prefix", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    transport.onWrite = (command) => setTimeout(() => {
      queue.observeLine(`[7, *ContestConsole]: "ffffffffffffffffffff.." - ${command.endsWith(" 4") ? "Get ready" : "Go!"}`);
      queue.observeLine(`[7, *ContestConsole]: "${hash.slice(0, 20)}.." - ${command.endsWith(" 4") ? "Get ready" : "Go!"}`);
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
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: \"Contest Map With Spaces\" - Get ready"), 0);
    expect((await queue.enqueue({ type: "ready", map: `${hash} 0`, mapName: "Contest Map With Spaces", mode: "hs" }, "named-custom-ready")).status)
      .toBe("acknowledged");
  });

  it("accepts the live server's unquoted official-map hash echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
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
    transport.onWrite = () => setTimeout(() => queue.observeLine("success"), 0);
    await queue.enqueue({ type: "notification", channel: "bulletin", text: "SR1 20:10" }, "bulletin");
    await queue.enqueue({ type: "notification", channel: "notice", text: "wait Player" }, "notice");
    await queue.enqueue({ type: "notification", channel: "announce", text: "READY!" }, "announce");
    expect(transport.writes).toEqual(["bulletin SR1 20:10", "notice wait Player", "announce READY!"]);
  });

  it("keeps a business newline but protocol-escapes it into one MockClient command", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => setTimeout(() => queue.observeLine("[Notice] accepted"), 0);
    await queue.enqueue({
      type: "notification",
      channel: "notice",
      text: "SR1 即将发令。\n本关起跑保护已被使用，后续不再延时。"
    }, "protected-notice");
    expect(transport.writes).toEqual(["notice SR1 即将发令。\\n本关起跑保护已被使用，后续不再延时。"]);
  });

  it("rejects control characters before writing", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport);
    expect(() => queue.enqueue({ type: "raw", command: "hello\nstop" }, "unsafe")).toThrow("control characters");
    expect(() => queue.enqueue({ type: "notification", channel: "notice", text: "hello\rstop" }, "unsafe-notice")).toThrow("control characters");
    expect(transport.writes).toEqual([]);
  });
});
