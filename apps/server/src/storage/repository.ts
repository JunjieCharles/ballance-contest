import { createHash, randomUUID } from "node:crypto";
import type { CompetitionMode } from "@ballance/contracts";
import type { DomainEvent } from "@ballance/core";
import type { OpenedDatabase } from "./database.js";

export interface RawEventInput {
  sourceId: string;
  sourceFile: string;
  byteOffset: number;
  rawLine: string;
  occurredAt: string;
}

export class CompetitionRepository {
  public constructor(private readonly database: OpenedDatabase) {}

  public createCompetition(input: { id?: string; name: string; mode: CompetitionMode; timezone: string }): string {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.database.sqlite.prepare("INSERT INTO competitions(id,name,mode,status,timezone,state_version,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)")
      .run(id, input.name, input.mode, "draft", input.timezone, now, now);
    return id;
  }

  public appendRawAndDomainEvent(competitionId: string, raw: RawEventInput, event: DomainEvent, parserVersion = "1"): boolean {
    return this.database.sqlite.transaction(() => {
      const inserted = this.database.sqlite.prepare("INSERT OR IGNORE INTO raw_log_events(source_id,competition_id,source_file,byte_offset,occurred_at,raw_line,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(raw.sourceId, competitionId, raw.sourceFile, raw.byteOffset, raw.occurredAt, raw.rawLine, createHash("sha256").update(raw.rawLine).digest("hex"), new Date().toISOString());
      if (inserted.changes === 0) return false;
      const sequence = (this.database.sqlite.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM domain_events WHERE competition_id=?").get(competitionId) as { value: number }).value;
      this.database.sqlite.prepare("INSERT INTO domain_events(id,competition_id,source_id,sequence,type,payload,parser_version,occurred_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(randomUUID(), competitionId, raw.sourceId, sequence, event.type, JSON.stringify(event), parserVersion, event.occurredAt);
      this.database.sqlite.prepare("UPDATE competitions SET state_version=state_version+1, updated_at=? WHERE id=?").run(new Date().toISOString(), competitionId);
      return true;
    })();
  }

  public saveSnapshot(competitionId: string, stateVersion: number, payload: unknown): void {
    this.database.sqlite.prepare("INSERT INTO runtime_snapshots(competition_id,state_version,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(competition_id) DO UPDATE SET state_version=excluded.state_version,payload=excluded.payload,updated_at=excluded.updated_at")
      .run(competitionId, stateVersion, JSON.stringify(payload), new Date().toISOString());
  }
}
