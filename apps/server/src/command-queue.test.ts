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

  it("marks an unconfirmed critical command uncertain without retry", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 5);
    expect((await queue.enqueue({ type: "force-next-restart" }, "critical")).status).toBe("uncertain");
    expect(transport.writes).toEqual(["forcenextrestart"]);
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

  it("accepts the live server's unquoted official-map hash echo", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = () => setTimeout(() => queue.observeLine("[7, *ContestConsole]: a364b408fffaab434480.. - Go!"), 0);
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "official-hash-go")).status).toBe("acknowledged");
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

  it("rejects control characters before writing", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport);
    expect(() => queue.enqueue({ type: "notification", channel: "notice", text: "hello\nstop" }, "unsafe")).toThrow("control characters");
    expect(transport.writes).toEqual([]);
  });
});
