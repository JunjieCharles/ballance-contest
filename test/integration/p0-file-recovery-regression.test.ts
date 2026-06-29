import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowingLogReader, readStaticLog } from "../../apps/server/src/log-source.js";
import { RecoveryCoordinator } from "../../apps/server/src/recovery.js";
import { openDatabase } from "../../apps/server/src/storage/database.js";
import { CompetitionRepository } from "../../apps/server/src/storage/repository.js";
import { parseLogLine } from "../../packages/core/src/index.js";

const temporaryDirectories: string[] = [];
const tempdir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("P0 file source and recovery regression", () => {
  it("BE-FILE-001/003/004: reads static logs without changing source bytes and preserves unknown/ANSI/invalid encoding evidence", async () => {
    const fixture = resolve("test/fixtures/logs/mockclient-edge-cases.log");
    const before = statSync(fixture);
    const result = await readStaticLog(fixture);
    const after = statSync(fixture);

    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
    expect(result.size).toBe(before.size);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.lines).toContain("unrecognised diagnostic line preserved as unknown");
    expect(parseLogLine("\u001b[31m[06-29 11:22:15] [101, ContestConsole]: Level 01 - Go!\u001b[0m", { year: 2026, utcOffsetMinutes: 480 }).event)
      .toMatchObject({ type: "go", refereeName: "ContestConsole" });

    const directory = tempdir("ballance-invalid-log-");
    const invalid = join(directory, "invalid.log");
    writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0x0a]));
    expect((await readStaticLog(invalid)).invalidEncoding).toBe(true);
  });

  it("BE-FILE-001/002: emits only complete growing lines and starts a new generation after truncation", async () => {
    const directory = tempdir("ballance-growing-log-");
    const log = join(directory, "MockClient.log");
    writeFileSync(log, "[06-29 11:20:28] Connected to server OK\npartial", "utf8");
    const reader = new GrowingLogReader(log);

    const first = await reader.readAvailable();
    expect(first).toEqual([expect.objectContaining({ offset: 0, text: "[06-29 11:20:28] Connected to server OK" })]);
    expect(reader.getOffset()).toBe(Buffer.byteLength("[06-29 11:20:28] Connected to server OK\npartial"));

    appendFileSync(log, " line\n", "utf8");
    const second = await reader.readAvailable();
    expect(second).toEqual([expect.objectContaining({ text: "partial line" })]);
    const oldSourceId = second[0]?.sourceId;

    writeFileSync(log, "rotated\n", "utf8");
    const afterTruncate = await reader.readAvailable();
    expect(afterTruncate).toEqual([expect.objectContaining({ offset: 0, text: "rotated" })]);
    expect(afterTruncate[0]?.sourceId).not.toBe(oldSourceId);
  });

  it("BE-RECOVER-001/003: restores from snapshot, marks sent commands uncertain and records observation gaps instead of guessing", () => {
    const directory = tempdir("ballance-recovery-central-");
    const database = openDatabase(join(directory, "console.sqlite"));
    try {
      const repository = new CompetitionRepository(database);
      const competitionId = repository.createCompetition({ id: "competition-recover", name: "Recovery", mode: "work", timezone: "Asia/Shanghai" });
      const parsed = parseLogLine("[06-29 11:20:28] Connected to server OK", { year: 2026, utcOffsetMinutes: 480, sourceId: "raw-1" });
      repository.appendRawAndDomainEvent(competitionId, { sourceId: "raw-1", sourceFile: "live.log", byteOffset: 42, rawLine: parsed.rawLine, occurredAt: parsed.timestamp }, parsed.event);
      repository.saveSnapshot(competitionId, 7, {
        phase: "running",
        automationEnabled: true,
        lastDomainSequence: 0,
        deadlineAt: "2026-06-29T12:01:00.000Z",
        logOffsets: { "live.log": 42 },
        observationGap: "断连期间服务器可能产生了未观察到的 DNF"
      });
      database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("command-go", competitionId, "go-1", "go", "sent", "{}", "2026-06-29T12:00:00.000Z", "2026-06-29T12:00:00.000Z");

      const recovery = new RecoveryCoordinator(database, () => new Date("2026-06-29T12:00:30.000Z"));
      const report = recovery.recover(competitionId);

      expect(report).toMatchObject({
        competitionId,
        stateVersion: 7,
        restoredPhase: "running",
        automationEnabled: false,
        uncertainCommandIds: ["command-go"],
        remainingTimeMs: 30_000,
        canResumeAfterConfirmation: false,
        requiresConfirmation: true
      });
      expect(report.replayEvents).toHaveLength(1);
      expect(report.observationGaps).toEqual([expect.objectContaining({ code: "SNAPSHOT_OBSERVATION_GAP", detail: "断连期间服务器可能产生了未观察到的 DNF" })]);
      expect(database.sqlite.prepare("SELECT status FROM command_audits WHERE id='command-go'").get()).toMatchObject({ status: "uncertain" });
      expect(() => recovery.confirm(report.id, { actor: "referee", reason: "现场确认" })).toThrow("RECOVERY_BLOCKED");
    } finally {
      database.close();
    }
  });
});
