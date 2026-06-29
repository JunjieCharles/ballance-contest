import { randomUUID } from "node:crypto";
import type { OpenedDatabase } from "./storage/database.js";

export interface RecoverySnapshotPayload {
  phase: string;
  automationEnabled?: boolean;
  lastDomainSequence?: number;
  deadlineAt?: string;
  logOffsets?: Readonly<Record<string, number>>;
  observationGap?: string;
  [key: string]: unknown;
}

export interface RecoveryReport {
  id: string;
  competitionId: string;
  stateVersion: number;
  restoredPhase: string;
  automationEnabled: false;
  snapshot: RecoverySnapshotPayload;
  replayEvents: readonly { sequence: number; type: string; payload: unknown; occurredAt: string }[];
  uncertainCommandIds: readonly string[];
  observationGaps: readonly { id: string; code: string; detail: string }[];
  remainingTimeMs?: number;
  canResumeAfterConfirmation: boolean;
  requiresConfirmation: true;
}

export class RecoveryCoordinator {
  public constructor(private readonly database: OpenedDatabase, private readonly wallNow: () => Date = () => new Date()) {}

  public recover(competitionId: string): RecoveryReport {
    return this.database.sqlite.transaction(() => {
      const competition = this.database.sqlite.prepare("SELECT id FROM competitions WHERE id=?").get(competitionId);
      if (!competition) throw new Error("COMPETITION_NOT_FOUND");
      const stored = this.database.sqlite.prepare("SELECT state_version,payload FROM runtime_snapshots WHERE competition_id=?").get(competitionId) as { state_version: number; payload: string } | undefined;
      if (!stored) throw new Error("RUNTIME_SNAPSHOT_NOT_FOUND");
      const snapshot = JSON.parse(stored.payload) as RecoverySnapshotPayload;
      const lastSequence = snapshot.lastDomainSequence ?? 0;
      const replayRows = this.database.sqlite.prepare("SELECT sequence,type,payload,occurred_at FROM domain_events WHERE competition_id=? AND sequence>? ORDER BY sequence")
        .all(competitionId, lastSequence) as Array<{ sequence: number; type: string; payload: string; occurred_at: string }>;

      this.database.sqlite.prepare("UPDATE command_audits SET status='uncertain',updated_at=? WHERE competition_id=? AND status='sent'")
        .run(this.wallNow().toISOString(), competitionId);
      const uncertainCommandIds = (this.database.sqlite.prepare("SELECT id FROM command_audits WHERE competition_id=? AND status='uncertain' ORDER BY created_at")
        .all(competitionId) as Array<{ id: string }>).map((row) => row.id);

      if (snapshot.observationGap) {
        const exists = this.database.sqlite.prepare("SELECT id FROM observation_gaps WHERE competition_id=? AND code='SNAPSHOT_OBSERVATION_GAP' AND status='open'").get(competitionId);
        if (!exists) this.database.sqlite.prepare("INSERT INTO observation_gaps(id,competition_id,code,detail,status,created_at) VALUES (?,?,?,?,?,?)")
          .run(randomUUID(), competitionId, "SNAPSHOT_OBSERVATION_GAP", snapshot.observationGap, "open", this.wallNow().toISOString());
      }
      const gaps = this.database.sqlite.prepare("SELECT id,code,detail FROM observation_gaps WHERE competition_id=? AND status='open' ORDER BY created_at")
        .all(competitionId) as Array<{ id: string; code: string; detail: string }>;
      const deadline = snapshot.deadlineAt ? Date.parse(snapshot.deadlineAt) : Number.NaN;
      const remainingTimeMs = Number.isFinite(deadline) ? Math.max(0, deadline - this.wallNow().getTime()) : undefined;
      const report: RecoveryReport = {
        id: randomUUID(), competitionId, stateVersion: stored.state_version, restoredPhase: snapshot.phase,
        automationEnabled: false, snapshot: { ...snapshot, automationEnabled: false },
        replayEvents: replayRows.map((row) => ({ sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload) as unknown, occurredAt: row.occurred_at })),
        uncertainCommandIds, observationGaps: gaps,
        ...(remainingTimeMs === undefined ? {} : { remainingTimeMs }),
        canResumeAfterConfirmation: uncertainCommandIds.length === 0 && gaps.length === 0,
        requiresConfirmation: true
      };
      this.database.sqlite.prepare("INSERT INTO recovery_audits(id,competition_id,state_version,status,report,created_at) VALUES (?,?,?,?,?,?)")
        .run(report.id, competitionId, report.stateVersion, "pending", JSON.stringify(report), this.wallNow().toISOString());
      return report;
    })();
  }

  public confirm(reportId: string, input: { actor: string; reason: string }): void {
    if (!input.actor.trim()) throw new Error("RECOVERY_ACTOR_REQUIRED");
    if (!input.reason.trim()) throw new Error("RECOVERY_REASON_REQUIRED");
    this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare("SELECT status,report FROM recovery_audits WHERE id=?").get(reportId) as { status: string; report: string } | undefined;
      if (!row) throw new Error("RECOVERY_REPORT_NOT_FOUND");
      if (row.status !== "pending") throw new Error("RECOVERY_ALREADY_RESOLVED");
      const report = JSON.parse(row.report) as RecoveryReport;
      if (!report.canResumeAfterConfirmation) throw new Error("RECOVERY_BLOCKED");
      this.database.sqlite.prepare("UPDATE recovery_audits SET status='confirmed',confirmed_at=?,confirmed_by=?,confirmation_reason=? WHERE id=?")
        .run(this.wallNow().toISOString(), input.actor.trim(), input.reason.trim(), reportId);
    })();
  }

  public recordObservationGap(competitionId: string, code: string, detail: string): string {
    if (!code.trim() || !detail.trim()) throw new Error("OBSERVATION_GAP_DETAIL_REQUIRED");
    const id = randomUUID();
    this.database.sqlite.prepare("INSERT INTO observation_gaps(id,competition_id,code,detail,status,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, competitionId, code.trim(), detail.trim(), "open", this.wallNow().toISOString());
    return id;
  }
}
