import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLogLine } from "@ballance/core";
import { openDatabase } from "./database.js";
import { CompetitionRepository } from "./repository.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("SQLite storage", () => {
  it("migrates, enables safety pragmas and appends events idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "ballance-db-"));
    temporary.push(directory);
    const database = openDatabase(join(directory, "console.sqlite"));
    try {
      expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      const repository = new CompetitionRepository(database);
      const competitionId = repository.createCompetition({ id: "competition-1", name: "Test", mode: "test", timezone: "Asia/Shanghai" });
      const parsed = parseLogLine("[06-29 11:20:28] Connected to server OK", { year: 2026, utcOffsetMinutes: 480, sourceId: "raw-1" });
      const raw = { sourceId: "raw-1", sourceFile: "fixture.log", byteOffset: 0, rawLine: parsed.rawLine, occurredAt: parsed.timestamp };
      expect(repository.appendRawAndDomainEvent(competitionId, raw, parsed.event)).toBe(true);
      expect(repository.appendRawAndDomainEvent(competitionId, raw, parsed.event)).toBe(false);
      expect((database.sqlite.prepare("SELECT COUNT(*) AS count FROM raw_log_events").get() as { count: number }).count).toBe(1);
      expect((database.sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events").get() as { count: number }).count).toBe(1);
      expect((database.sqlite.prepare("SELECT state_version AS version FROM competitions WHERE id=?").get(competitionId) as { version: number }).version).toBe(1);
      expect((database.sqlite.prepare("SELECT COUNT(*) AS count FROM action_receipts").get() as { count: number }).count).toBe(0);
    } finally {
      database.close();
    }
  });
});
