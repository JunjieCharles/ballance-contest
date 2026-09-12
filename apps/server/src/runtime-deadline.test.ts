import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompetitionService } from "./competition-service.js";
import { openDatabase } from "./storage/database.js";
import type { WorkRuntimeManager } from "./work-runtime-manager.js";
import type { TestRuntimeManager } from "./test-runtime-manager.js";

it("persists an extended work scoring window across service recreation and accepts a finish after the original deadline", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "ballance-deadline-"));
  const path = join(dataRoot, "console.sqlite");
  let database = openDatabase(path);
  let service = new CompetitionService(undefined, { database, dataRoot });
  try {
    const { id } = service.create({ name: "Deadline recovery", mode: "work", idempotencyKey: "create" });
    service.updateDraft(id, { expectedStateVersion: 0, idempotencyKey: "config", date: "2026-09-12", stages: [1, 2].map(level => ({
      id: `s${level}`, label: `SR${level}`, level, order: level, mode: "SR" as const,
      mapKind: "official" as const, timeLimitMs: 60_000, scoring: [20], minimumScoringPlace: 1
    })) });
    service.publish(id, 1, "publish");
    let manager = (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;
    let runtime = manager.makeRuntime(id, service.snapshot(id).config, { write: async () => {} });
    manager.register(id, runtime);
    runtime.refereeConnectionId = "7";
    runtime.commands.setRefereeConnectionId("7");
    manager.ingestLine(runtime, "[09-12 21:00:00] [7, *ContestConsole]: Level 01 - Go!");
    runtime.controller.extendStageDeadline(60_000);
    manager.synchronizeStageBoundary(runtime);
    manager.saveSnapshot(runtime);
    expect(runtime.engine.snapshot().attempts[0]!.deadlineAtMs - runtime.engine.snapshot().attempts[0]!.goAtMs).toBe(120_000);
    await service.close();
    database.close();
    database = openDatabase(path);
    service = new CompetitionService(undefined, { database, dataRoot });
    manager = (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;
    runtime = manager.makeRuntime(id, service.snapshot(id).config, { write: async () => {} });
    manager.register(id, runtime);
    manager.ingestLine(runtime, "[09-12 21:01:10] (#11, Alice) finished Level 01 in 1st place (score: 100; real time: 0:01:10.000).");
    expect(runtime.engine.snapshot().currentScoreboard.find(entry => entry.playerId === "Alice")?.stages.s1?.points).toBe(20);
    expect(runtime.engine.snapshot().anomalies.some(item => item.code === "late-result")).toBe(false);
  } finally {
    await service.close(); database.close(); rmSync(dataRoot, { recursive: true, force: true });
  }
});

it("synchronizes both later and earlier test deadlines with the scoring engine", async () => {
  const service = new CompetitionService();
  try {
    const { id } = service.create({ name: "Test deadline", mode: "test", idempotencyKey: "create" });
    service.publish(id, 0, "publish");
    const { runId } = service.createTestRunFromScenario(id, "normal-player-roster");
    const manager = (service as unknown as { testRuntimeManager: TestRuntimeManager }).testRuntimeManager;
    const runtime = manager.getRuntime(id, runId);
    service.startTestAutomation(id, runId, 0);
    service.advanceTestAutomation(id, runId, 40_000);
    const before = runtime.engine.snapshot().attempts[0]!;
    runtime.automation.extendStageDeadline(60_000);
    manager.settle(runtime);
    expect(runtime.engine.snapshot().attempts[0]!.deadlineAtMs).toBe(before.deadlineAtMs + 60_000);
    runtime.automation.rescheduleStageDeadline(runtime.automation.snapshot().attempts[0]!.goAtMs + 120_000);
    manager.settle(runtime);
    expect(runtime.engine.snapshot().attempts[0]!.deadlineAtMs).toBe(before.goAtMs + 120_000);
  } finally { await service.close(); }
});
