import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE competitions (id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('work','test')), status TEXT NOT NULL, timezone TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
  CREATE TABLE config_versions (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), version INTEGER NOT NULL, immutable INTEGER NOT NULL CHECK(immutable IN (0,1)), payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(competition_id, version)) STRICT;
  CREATE TABLE participants (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), display_name TEXT NOT NULL, normalized_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
  CREATE INDEX participants_competition ON participants(competition_id);
  CREATE TABLE connection_identities (id TEXT PRIMARY KEY, participant_id TEXT REFERENCES participants(id), competition_id TEXT NOT NULL REFERENCES competitions(id), connection_id TEXT NOT NULL, raw_name TEXT NOT NULL, connected_at TEXT NOT NULL, disconnected_at TEXT) STRICT;
  CREATE INDEX connections_competition_connection ON connection_identities(competition_id, connection_id);
  CREATE TABLE raw_log_events (source_id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), source_file TEXT NOT NULL, byte_offset INTEGER NOT NULL, occurred_at TEXT NOT NULL, raw_line TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
  CREATE INDEX raw_events_competition_offset ON raw_log_events(competition_id, source_file, byte_offset);
  CREATE TABLE domain_events (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), source_id TEXT NOT NULL REFERENCES raw_log_events(source_id), sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, parser_version TEXT NOT NULL, occurred_at TEXT NOT NULL, UNIQUE(competition_id, sequence)) STRICT;
  CREATE TABLE attempts (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), stage_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, go_event_id TEXT NOT NULL, status TEXT NOT NULL, go_at TEXT NOT NULL) STRICT;
  CREATE TABLE result_intake_windows (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), opened_at TEXT NOT NULL, deadline_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT) STRICT;
  CREATE TABLE scoreboard_versions (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), version INTEGER NOT NULL, trigger_event_id TEXT NOT NULL, payload TEXT NOT NULL, deterministic_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(competition_id, version)) STRICT;
  CREATE TABLE command_audits (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), idempotency_key TEXT NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(competition_id, idempotency_key)) STRICT;
  CREATE TABLE incidents (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), code TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT) STRICT;
  CREATE TABLE overrides (id TEXT PRIMARY KEY, competition_id TEXT NOT NULL REFERENCES competitions(id), target_type TEXT NOT NULL, target_id TEXT NOT NULL, before_value TEXT, after_value TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, reversed_by TEXT, created_at TEXT NOT NULL) STRICT;
  CREATE TABLE runtime_snapshots (competition_id TEXT PRIMARY KEY REFERENCES competitions(id), state_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
  `
];

export interface OpenedDatabase {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export const defaultDataRoot = (): string => join(process.env.LOCALAPPDATA ?? process.cwd(), "BallanceContestConsole");

export const openDatabase = (path: string): OpenedDatabase => {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  const applied = new Set((sqlite.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
  for (const [index, sql] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (applied.has(version)) continue;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
    })();
  }
  return { sqlite, orm: drizzle(sqlite, { schema }), close: () => sqlite.close() };
};
