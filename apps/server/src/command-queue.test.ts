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

  it("starts the command timeout before transport.write and ignores a late write failure", async () => {
    const writes: string[] = [];
    const statusChanges: string[] = [];
    let rejectBlockedWrite: ((error: Error) => void) | undefined;
    const transport: CommandTransport = {
      write: async (command) => {
        writes.push(command);
        if (command === "unverifiable-command") {
          await new Promise<void>((_resolve, reject) => { rejectBlockedWrite = reject; });
          return;
        }
        queueMicrotask(() => queue.observeLine("1 player(s) online:"));
      }
    };
    const queue = new CommandQueue(transport, 25, (record) => statusChanges.push(record.status));

    const first = await Promise.race([
      queue.enqueue({ type: "raw", command: "unverifiable-command" }, "blocked-write"),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("command timeout did not cover transport.write")), 500))
    ]);
    expect(first.status).toBe("uncertain");
    expect((await queue.enqueue({ type: "list" }, "after-blocked-write")).status).toBe("acknowledged");

    rejectBlockedWrite?.(new Error("late write failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.status).toBe("uncertain");
    expect(statusChanges).not.toContain("failed");
    expect(writes).toEqual(["unverifiable-command", "list"]);
  });

  it("treats a rejected write attempt for a high-risk command as uncertain", async () => {
    const queue = new CommandQueue({
      write: async () => { throw new Error("stdin callback timed out after write was attempted"); }
    }, 100);

    await expect(queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "rejected-go-write"))
      .resolves.toMatchObject({ status: "uncertain" });
  });

  it("treats a synchronous transport throw after write initiation as uncertain", async () => {
    const queue = new CommandQueue({
      write: () => { throw new Error("stdin rejected the write synchronously"); }
    }, 100);

    await expect(queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "sync-rejected-ready"))
      .resolves.toMatchObject({ status: "uncertain" });
  });

  it.each([
    ["ready", { type: "ready", map: "level 1", mode: "sr" } as const],
    ["cheat off", { type: "cheat-off" } as const],
    ["custom setmap", { type: "set-map", mapHash: "a".repeat(32), displayName: "Recovery_Map" } as const],
    ["official setmap", { type: "set-official-map", level: 1, displayName: "Level_01" } as const]
  ])("keeps a rejected %s write uncertain for referee resolution", async (_label, action) => {
    const queue = new CommandQueue({
      write: async () => { throw new Error("stdin callback rejected after write was attempted"); }
    }, 100);

    await expect(queue.enqueue(action, `rejected-${action.type}`))
      .resolves.toMatchObject({ status: "uncertain" });
  });

  it("expires queued commands from enqueue time without writing them later", async () => {
    const writes: string[] = [];
    const queue = new CommandQueue({
      write: (command) => {
        writes.push(command);
        return new Promise<void>(() => undefined);
      }
    }, (action) => action.type === "raw" ? 50 : 10);

    const writing = queue.enqueue({ type: "raw", command: "slow-high-risk-command" }, "writing-until-deadline");
    const queued = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "queued-short-deadline");

    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
    await expect(writing).resolves.toMatchObject({ status: "uncertain" });
    expect(writes).toEqual(["slow-high-risk-command"]);
  });

  it("rechecks the monotonic deadline before opening an observer or writing after event-loop delay", async () => {
    const writes: string[] = [];
    let observerCalls = 0;
    const queue = new CommandQueue({
      write: async (command) => { writes.push(command); }
    }, 5);

    const pending = queue.enqueue(
      { type: "ready", map: "level 1", mode: "sr" },
      "expired-before-turn",
      () => { observerCalls += 1; }
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(observerCalls).toBe(0);
    expect(writes).toEqual([]);
  });

  it("opens a command-specific observer immediately before calling the transport", async () => {
    const order: string[] = [];
    const queue = new CommandQueue({ write: async () => { order.push("write"); } }, 5);
    const result = await queue.enqueue({ type: "list" }, "list-observer-order", () => { order.push("observer"); });

    expect(result.status).toBe("timed_out");
    expect(order).toEqual(["observer", "write"]);
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

  it("cancels commands that never started and isolates a generation that was already writing", async () => {
    const oldWrites: string[] = [];
    const newTransport = new FakeTransport();
    const finalStatuses: string[] = [];
    let rejectOldWrite: ((error: Error) => void) | undefined;
    const oldTransport: CommandTransport = {
      write: async (command) => {
        oldWrites.push(command);
        await new Promise<void>((_resolve, reject) => { rejectOldWrite = reject; });
      }
    };
    const queue = new CommandQueue(oldTransport, 1_000, (record) => {
      if (["uncertain", "timed_out", "cancelled", "failed"].includes(record.status)) finalStatuses.push(`${record.idempotencyKey}:${record.status}`);
    });
    const oldGeneration = queue.generation;
    const writing = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "old-writing");
    const queuedRead = queue.enqueue({ type: "list" }, "old-queued-read");
    const queuedWrite = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "old-queued-write");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldWrites).toEqual(["countdown level 1 sr 4"]);
    expect(queue.advanceGeneration(newTransport)).toBe(oldGeneration + 1);
    expect((await writing).status).toBe("uncertain");
    expect((await queuedRead).status).toBe("cancelled");
    expect((await queuedWrite).status).toBe("cancelled");
    expect(finalStatuses).toEqual([
      "old-writing:uncertain",
      "old-queued-read:cancelled",
      "old-queued-write:cancelled"
    ]);

    rejectOldWrite?.(new Error("late failure from replaced MockClient"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finalStatuses).not.toContain("old-writing:failed");
    expect(oldWrites).toHaveLength(1);
  });

  it("isolates selected old-cycle commands without replacing the healthy connection generation", async () => {
    const writes: string[] = [];
    const queue = new CommandQueue({
      write: (command) => {
        writes.push(command);
        if (command === "countdown level 2 sr") {
          queueMicrotask(() => queue.observeLine("[77, *ContestConsole]: Level 02 - Go!"));
          return Promise.resolve();
        }
        return new Promise<void>(() => undefined);
      }
    }, 1_000);
    queue.setRefereeConnectionId("77");
    const generation = queue.generation;
    const writingReady = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "old-cycle-ready");
    const queuedGo = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "old-cycle-go");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const isolated = queue.cancelWhere((record) => record.idempotencyKey.startsWith("old-cycle-"));

    expect(isolated.map((record) => [record.idempotencyKey, record.status])).toEqual([
      ["old-cycle-ready", "uncertain"],
      ["old-cycle-go", "cancelled"]
    ]);
    await expect(writingReady).resolves.toMatchObject({ status: "uncertain" });
    await expect(queuedGo).resolves.toMatchObject({ status: "cancelled" });
    expect(queue.generation).toBe(generation);
    expect((await queue.enqueue({ type: "go", map: "level 2", mode: "sr" }, "new-cycle-go")).status).toBe("acknowledged");
    expect(writes).toEqual(["countdown level 1 sr 4", "countdown level 2 sr"]);
  });

  it("previews command isolation without mutating tasks and applies the exact durable projection", async () => {
    const writes: string[] = [];
    const terminalNotifications: string[] = [];
    const queue = new CommandQueue({
      write: (command) => {
        writes.push(command);
        return new Promise<void>(() => undefined);
      }
    }, 1_000, (record) => {
      if (["uncertain", "cancelled"].includes(record.status)) {
        terminalNotifications.push(`${record.idempotencyKey}:${record.status}`);
      }
    });
    const writing = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "preview-ready");
    const queued = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "preview-go");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const preview = queue.previewCancelWhere((record) => record.idempotencyKey.startsWith("preview-"));
    expect(preview.map((item) => [item.record.idempotencyKey, item.record.status])).toEqual([
      ["preview-ready", "uncertain"],
      ["preview-go", "cancelled"]
    ]);
    expect(terminalNotifications).toEqual([]);
    expect(writes).toEqual(["countdown level 1 sr 4"]);

    const applied = queue.applyCancellationPreview(preview);
    expect(applied.map((record) => [record.idempotencyKey, record.status])).toEqual([
      ["preview-ready", "uncertain"],
      ["preview-go", "cancelled"]
    ]);
    await expect(writing).resolves.toMatchObject({ status: "uncertain" });
    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
    expect(terminalNotifications).toEqual([]);
  });

  it("fails a stale cancellation preview before mutating another selected task", async () => {
    const queue = new CommandQueue({
      write: () => new Promise<void>(() => undefined)
    }, 1_000);
    queue.setRefereeConnectionId("7");
    const writing = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "stale-ready");
    const queued = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "still-queued-go");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const preview = queue.previewCancelWhere(() => true);

    queue.observeLine("[7, *ContestConsole]: Level 01 - Get ready");
    expect(() => queue.applyCancellationPreview(preview)).toThrow("COMMAND_CANCELLATION_PREVIEW_STALE");
    expect(await writing).toMatchObject({ status: "acknowledged" });
    queue.advanceGeneration();
    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
  });

  it("times out a low-risk write when advancing the connection generation", async () => {
    const transport: CommandTransport = { write: () => new Promise<void>(() => undefined) };
    const queue = new CommandQueue(transport, 1_000);
    const pending = queue.enqueue({ type: "list" }, "old-list");
    await new Promise((resolve) => setTimeout(resolve, 0));
    queue.advanceGeneration();
    expect((await pending).status).toBe("timed_out");
  });

  it("publishes one terminal transition even when onChange advances the generation again", async () => {
    const statuses: string[] = [];
    let reentered = false;
    const queue = new CommandQueue({ write: () => new Promise<void>(() => undefined) }, 1_000, (record) => {
      if (record.idempotencyKey !== "reentrant-ready") return;
      statuses.push(record.status);
      if (record.status === "uncertain" && !reentered) {
        reentered = true;
        queue.advanceGeneration();
      }
    });
    const initialGeneration = queue.generation;
    const pending = queue.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "reentrant-ready");
    await new Promise((resolve) => setTimeout(resolve, 0));

    queue.advanceGeneration();
    expect((await pending).status).toBe("uncertain");
    expect(statuses).toEqual(["queued", "sent", "uncertain"]);
    expect(queue.generation).toBe(initialGeneration + 2);
  });

  it("does not let an old-generation echo confirm a new-generation command", async () => {
    const oldTransport = new FakeTransport();
    const newTransport = new FakeTransport();
    const queue = new CommandQueue(oldTransport, 100);
    const oldGeneration = queue.generation;
    queue.advanceGeneration(newTransport);
    const newGeneration = queue.generation;
    expect(queue.setRefereeConnectionId("999", oldGeneration)).toBe(false);
    expect(queue.setRefereeConnectionId("7", newGeneration)).toBe(true);
    const pending = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "new-go");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queue.observeLine("[7, *ContestConsole]: Level 01 - Go!", oldGeneration)).toBeUndefined();
    expect(queue.observeLine("[7, *ContestConsole]: Level 01 - Go!", newGeneration)?.status).toBe("acknowledged");
    expect((await pending).status).toBe("acknowledged");
    expect(oldTransport.writes).toEqual([]);
    expect(newTransport.writes).toEqual(["countdown level 1 sr"]);
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
    const queue = new CommandQueue(transport, 1_000);
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
    const queue = new CommandQueue(transport, 1_000);
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

  it("acknowledges list from the current trailing summary format without learning referee identity", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    transport.onWrite = (command) => setTimeout(() => {
      if (command === "list") {
        queue.observeLine("3598759654: *ContestConsole     0ms");
        queue.observeLine("1 client(s) online: 0 player(s), 1 spectator(s).");
      } else queue.observeLine("[3598759654, *ContestConsole]: Level 01 - Go!");
    }, 0);
    expect((await queue.enqueue({ type: "list" }, "current-list")).status).toBe("acknowledged");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go-after-list")).status).toBe("uncertain");
    queue.setRefereeConnectionId("3598759654");
    expect((await queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go-after-explicit-identity")).status).toBe("acknowledged");
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
    const queue = new CommandQueue(transport, 1_000);
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

  it("encodes bulletin, notice, announce and s as distinct MockClient commands", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = (command) => {
      const [channel, ...content] = command.split(" ");
      const text = content.join(" ");
      const label = channel === "announce" ? "Announcement" : channel === "notice" ? "Notice" : "Bulletin";
      setTimeout(() => queue.observeLine(`[07-02 20:00:00] > ${command}`), 0);
      if (channel === "s") {
        setTimeout(() => queue.observeLine(`[07-02 20:00:00] [999, *ContestConsole]: ${text}`), 1);
        setTimeout(() => queue.observeLine(`[07-02 20:00:00] [7, *ContestConsole]: ${text}`), 2);
        return;
      }
      if (channel !== "bulletin") setTimeout(() => queue.observeLine(`[07-02 20:00:00] [${label}] (999, *ContestConsole): ${text}`), 1);
      setTimeout(() => queue.observeLine(channel === "bulletin"
        ? `[07-02 20:00:00] [${label}] *ContestConsole: ${text}`
        : `[07-02 20:00:00] [${label}] (7, *ContestConsole): ${text}`), 2);
    };
    await queue.enqueue({ type: "notification", channel: "bulletin", text: "SR1 20:10" }, "bulletin");
    await queue.enqueue({ type: "notification", channel: "notice", text: "wait Player" }, "notice");
    await queue.enqueue({ type: "notification", channel: "announce", text: "READY!" }, "announce");
    const hsReady = await queue.enqueue({ type: "notification", channel: "announce", text: "READY!\n记得收分" }, "announce-hs");
    expect(hsReady.status).toBe("acknowledged");
    await queue.enqueue({ type: "notification", channel: "s", text: "请回到大厅" }, "chat");
    expect(transport.writes).toEqual(["bulletin SR1 20:10", "notice wait Player", "announce READY!", "announce READY!\\n记得收分", "s 请回到大厅"]);
  });

  it("keeps three business lines but protocol-escapes them into one MockClient command", async () => {
    const transport = new FakeTransport();
    const queue = new CommandQueue(transport, 100);
    queue.setRefereeConnectionId("7");
    transport.onWrite = () => setTimeout(() => queue.observeLine("[Notice] (7, *ContestConsole): SR1 将在一分钟后发令。\\n请提前重启游戏，做好准备。\\n本关起跑保护已被使用，后续不再延时。"), 0);
    await queue.enqueue({
      type: "notification",
      channel: "notice",
      text: "SR1 将在一分钟后发令。\n请提前重启游戏，做好准备。\n本关起跑保护已被使用，后续不再延时。"
    }, "protected-notice");
    expect(transport.writes).toEqual(["notice SR1 将在一分钟后发令。\\n请提前重启游戏，做好准备。\\n本关起跑保护已被使用，后续不再延时。"]);
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
