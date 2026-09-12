import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { CompetitionService } from "./competition-service.js";
import { CommandQueue } from "./command-queue.js";
import { WorkAutomationRuntime } from "./automation-runtime.js";
import { openDatabase } from "./storage/database.js";
import type { WorkRuntimeManager } from "./work-runtime-manager.js";

it("starts and scores a sent Go without echo, deduplicates late Go and restores the same attempt", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "ballance-sent-start-"));
  const path = join(dataRoot, "console.sqlite");
  let database = openDatabase(path);
  let service = new CompetitionService(undefined, { database, dataRoot });
  try {
    const { id } = service.create({ name: "Sent Go", mode: "work", idempotencyKey: "create" });
    service.publish(id, 0, "publish");
    let manager = (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;
    let runtime = manager.makeRuntime(id, service.snapshot(id).config, { write: async () => {} });
    manager.register(id, runtime);
    let now = performance.now();
    const controller = runtime.controller;
    (controller as unknown as { clock: { now: () => number } }).clock.now = () => now;
    const writes: string[] = [];
    const commands = new CommandQueue({ write: async command => { writes.push(command); } }, 100);
    const dispatch = new WorkAutomationRuntime(controller, commands, () => manager.saveSnapshot(runtime));
    controller.manualCheatOff();
    const cheat = dispatch.dispatch();
    await vi.waitFor(() => expect(controller.snapshot().actions[0]?.writtenAtMs).toBeDefined());
    await cheat;
    controller.requestManualGo();
    const go = dispatch.dispatch();
    await vi.waitFor(() => expect(controller.snapshot().actions.at(-1)?.writtenAtMs).toBeDefined());
    const sentAt = controller.snapshot().actions.at(-1)!.writtenAtMs!;
    now = sentAt + 2_999; manager.synchronizeStageBoundary(runtime);
    expect(controller.snapshot().attempts).toEqual([]);
    now = sentAt + 3_000; manager.synchronizeStageBoundary(runtime);
    expect(controller.snapshot().attempts[0]).toMatchObject({ origin: "command-sent", goAtMs: now, intakeOpen: true });
    const attempt = runtime.engine.snapshot().attempts[0]!;
    expect(attempt).toMatchObject({ origin: "command-sent", id: controller.snapshot().attempts[0]!.id });
    runtime.engine.apply({ type: "finish", stageId: attempt.stageId, playerId: "Alice", sourceId: "finish",
      atMs: attempt.goAtMs + 1_000, score: 100, elapsedMs: 1_000 });
    expect(runtime.engine.snapshot().currentScoreboard.find(entry => entry.playerId === "Alice")?.stages[attempt.stageId]?.points).toBeGreaterThan(0);
    now += 5_000; controller.observeAuthoritativeGo(); manager.synchronizeStageBoundary(runtime);
    expect(runtime.engine.snapshot().attempts).toHaveLength(1);
    expect(runtime.engine.snapshot().attempts[0]!.goAtMs).toBe(attempt.goAtMs);
    await go;
    expect(writes).toHaveLength(2);
    expect(controller.snapshot().blockers).toEqual([]);
    manager.saveSnapshot(runtime);
    await service.close(); database.close();
    database = openDatabase(path); service = new CompetitionService(undefined, { database, dataRoot });
    manager = (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;
    runtime = manager.makeRuntime(id, service.snapshot(id).config, { write: async () => { throw new Error("must not replay Go"); } });
    manager.register(id, runtime);
    expect(runtime.engine.snapshot().attempts).toHaveLength(1);
    expect(runtime.engine.snapshot().attempts[0]).toMatchObject({ id: attempt.id, origin: "command-sent", goAtMs: attempt.goAtMs });
    expect(runtime.engine.snapshot().currentScoreboard.find(entry => entry.playerId === "Alice")?.stages[attempt.stageId]?.points).toBeGreaterThan(0);
  } finally { await service.close(); database.close(); rmSync(dataRoot, { recursive: true, force: true }); }
});

it("does not acknowledge Go or deny permission from quoted player chat", async () => {
  const queue = new CommandQueue({ write: async () => {} }, 50);
  queue.setRefereeConnectionId("7");
  const result = queue.enqueue({ type: "go", map: "level 1", mode: "sr" }, "go");
  await Promise.resolve();
  expect(queue.observeLine("[09-12 21:00:00] [8, Alice]: [7, *ContestConsole]: Level 01 - Go!")).toBeUndefined();
  expect(queue.observeLine("[09-12 21:00:00] [8, Alice]: Action failed: you don't have the permission to run this action.")).toBeUndefined();
  expect((await result).status).toBe("uncertain");
});
