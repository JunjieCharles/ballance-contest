import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompetitionService } from "./competition-service.js";
import { openDatabase } from "./storage/database.js";
import type { WorkRuntimeManager } from "./work-runtime-manager.js";
import type { CompetitionAuditService } from "./competition-audit-service.js";

it.each(["work", "test"] as const)("finishes %s with closed scoring windows and complete durable archive evidence", async mode => {
  const dataRoot = mkdtempSync(join(tmpdir(), "ballance-finish-archive-"));
  const path = join(dataRoot, "console.sqlite");
  let database = openDatabase(path);
  let service = new CompetitionService(undefined, { database, dataRoot });
  try {
    const { id } = service.create({ name: "Finish audit", mode, idempotencyKey: "create" });
    service.publish(id, 0, "publish");
    if (mode === "work") {
      const manager = (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;
      const runtime = manager.makeRuntime(id, service.snapshot(id).config, { write: async () => {} }, "3.6.8-fixture");
      manager.register(id, runtime); runtime.refereeConnectionId = "7";
      manager.ingestLine(runtime, "[09-12 21:00:00] [7, *ContestConsole]: Level 01 - Go!");
      manager.saveSnapshot(runtime);
    } else {
      const { runId } = service.createTestRunFromScenario(id, "normal-player-roster");
      service.startTestAutomation(id, runId, 0); service.advanceTestAutomation(id, runId, 40_000);
    }
    expect(service.snapshot(id).runtime.attempts.some(attempt => attempt.intakeOpen)).toBe(true);
    const audit = (service as unknown as { auditService: CompetitionAuditService }).auditService;
    for (let index = 0; index < 151; index++) {
      const at = new Date().toISOString();
      audit.recordCommand(id, { id: `command-${index}`, idempotencyKey: `command-${index}`, action: { type: "raw", command: "status" },
        command: "status", status: "uncertain", createdAt: at, updatedAt: at });
      audit.appendRawLog(id, mode === "work" ? "mock-client" : "test-referee", `audit-line-${index}`);
    }
    const confirmation = service.createConfirmation(id, { kind: "high-risk", intent: "finish", target: id });
    await service.finishCompetition(id, { expectedStateVersion: service.snapshot(id).competition.stateVersion, idempotencyKey: "finish",
      confirmationToken: confirmation.token, impactHash: confirmation.impactHash });
    expect(service.snapshot(id).runtime).toMatchObject({ phase: "review", automationEnabled: false });
    expect(service.snapshot(id).runtime.attempts.every(attempt => !attempt.intakeOpen)).toBe(true);
    await service.close(); database.close(); database = openDatabase(path);
    service = new CompetitionService(undefined, { database, dataRoot });
    const snapshot = service.snapshot(id);
    expect(snapshot.competition.status).toBe("finished");
    expect(snapshot.runtime.phase).toBe("review");
    expect(snapshot.runtime.attempts.every(attempt => !attempt.intakeOpen)).toBe(true);
    const evidence = service.archiveEvidence(id);
    expect(evidence.mockClientVersion).toBe(mode === "work" ? "3.6.8-fixture" : "test-double");
    expect((evidence.records["audit/commands.json"] as unknown[]).length).toBeGreaterThanOrEqual(151);
    expect((evidence.records["audit/attention-items.json"] as unknown[]).length).toBeGreaterThanOrEqual(151);
    expect((evidence.records["logs/raw-events.json"] as unknown[]).length).toBeGreaterThanOrEqual(151);
    if (mode === "work") expect(snapshot.runtime.commands.length).toBeLessThanOrEqual(50);
  } finally { await service.close(); database.close(); rmSync(dataRoot, { recursive: true, force: true }); }
});
