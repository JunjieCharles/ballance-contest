import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLogLine } from "@ballance/core";
import { RecoveryCoordinator } from "./recovery.js";
import { openDatabase } from "./storage/database.js";
import { CompetitionRepository } from "./storage/repository.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("RecoveryCoordinator", () => {
  it("replays post-snapshot events, changes sent commands to uncertain and preserves the competition", () => {
    const directory = mkdtempSync(join(tmpdir(), "ballance-recovery-"));
    temporary.push(directory);
    const database = openDatabase(join(directory, "console.sqlite"));
    try {
      const repository = new CompetitionRepository(database);
      const competitionId = repository.createCompetition({ id: "competition-1", name: "Final", mode: "work", timezone: "Asia/Shanghai" });
      const parsed = parseLogLine("[06-29 11:20:28] Connected to server OK", { year: 2026, utcOffsetMinutes: 480, sourceId: "raw-1" });
      repository.appendRawAndDomainEvent(competitionId, { sourceId: "raw-1", sourceFile: "live.log", byteOffset: 42, rawLine: parsed.rawLine, occurredAt: parsed.timestamp }, parsed.event);
      repository.saveSnapshot(competitionId, 4, {
        phase: "running", automationEnabled: true, lastDomainSequence: 0,
        deadlineAt: "2026-06-29T12:01:00.000Z", logOffsets: { "live.log": 42 }
      });
      database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("command-1", competitionId, "go-1", "go", "sent", "{}", "2026-06-29T12:00:00.000Z", "2026-06-29T12:00:00.000Z");
      const recovery = new RecoveryCoordinator(database, () => new Date("2026-06-29T12:00:30.000Z"));
      const report = recovery.recover(competitionId);

      expect(report).toMatchObject({
        competitionId, stateVersion: 4, restoredPhase: "running", automationEnabled: false,
        uncertainCommandIds: ["command-1"], remainingTimeMs: 30_000, canResumeAfterConfirmation: false
      });
      expect(report.replayEvents).toHaveLength(1);
      expect(report.snapshot.logOffsets).toEqual({ "live.log": 42 });
      expect((database.sqlite.prepare("SELECT status FROM command_audits WHERE id='command-1'").get() as { status: string }).status).toBe("uncertain");
      expect((database.sqlite.prepare("SELECT COUNT(*) AS count FROM competitions").get() as { count: number }).count).toBe(1);
      expect(() => recovery.confirm(report.id, { actor: "referee", reason: "现场核对" })).toThrow("RECOVERY_BLOCKED");
    } finally {
      database.close();
    }
  });

  it("requires confirmation even for a clean recovery and persists the audit", () => {
    const directory = mkdtempSync(join(tmpdir(), "ballance-recovery-clean-"));
    temporary.push(directory);
    const database = openDatabase(join(directory, "console.sqlite"));
    try {
      const repository = new CompetitionRepository(database);
      const competitionId = repository.createCompetition({ id: "competition-2", name: "Clean", mode: "test", timezone: "Asia/Shanghai" });
      repository.saveSnapshot(competitionId, 2, { phase: "ready", automationEnabled: true, lastDomainSequence: 0 });
      const recovery = new RecoveryCoordinator(database, () => new Date("2026-06-29T12:00:00.000Z"));
      const report = recovery.recover(competitionId);
      expect(report).toMatchObject({ restoredPhase: "ready", automationEnabled: false, canResumeAfterConfirmation: true, requiresConfirmation: true });
      recovery.confirm(report.id, { actor: "referee", reason: "已重新查询在线与榜单" });
      expect(database.sqlite.prepare("SELECT status,confirmed_by FROM recovery_audits WHERE id=?").get(report.id)).toMatchObject({ status: "confirmed", confirmed_by: "referee" });
    } finally {
      database.close();
    }
  });
});
