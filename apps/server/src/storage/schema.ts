import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const competitions = sqliteTable("competitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode", { enum: ["work", "test"] }).notNull(),
  status: text("status").notNull(),
  timezone: text("timezone").notNull(),
  stateVersion: integer("state_version").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const configVersions = sqliteTable("config_versions", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  version: integer("version").notNull(),
  immutable: integer("immutable", { mode: "boolean" }).notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("config_versions_competition_version").on(table.competitionId, table.version)]);

export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  displayName: text("display_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("participants_competition").on(table.competitionId)]);

export const connectionIdentities = sqliteTable("connection_identities", {
  id: text("id").primaryKey(),
  participantId: text("participant_id").references(() => participants.id),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  connectionId: text("connection_id").notNull(),
  rawName: text("raw_name").notNull(),
  connectedAt: text("connected_at").notNull(),
  disconnectedAt: text("disconnected_at")
}, (table) => [index("connections_competition_connection").on(table.competitionId, table.connectionId)]);

export const rawLogEvents = sqliteTable("raw_log_events", {
  sourceId: text("source_id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  sourceFile: text("source_file").notNull(),
  byteOffset: integer("byte_offset").notNull(),
  occurredAt: text("occurred_at").notNull(),
  rawLine: text("raw_line").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [index("raw_events_competition_offset").on(table.competitionId, table.sourceFile, table.byteOffset)]);

export const domainEvents = sqliteTable("domain_events", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  sourceId: text("source_id").notNull().references(() => rawLogEvents.sourceId),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  parserVersion: text("parser_version").notNull(),
  occurredAt: text("occurred_at").notNull()
}, (table) => [uniqueIndex("domain_events_competition_sequence").on(table.competitionId, table.sequence)]);

export const attempts = sqliteTable("attempts", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  stageId: text("stage_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  goEventId: text("go_event_id").notNull(),
  status: text("status").notNull(),
  goAt: text("go_at").notNull()
});

export const resultIntakeWindows = sqliteTable("result_intake_windows", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull().references(() => attempts.id),
  openedAt: text("opened_at").notNull(),
  deadlineAt: text("deadline_at").notNull(),
  closedAt: text("closed_at"),
  closeReason: text("close_reason")
});

export const scoreboardVersions = sqliteTable("scoreboard_versions", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  version: integer("version").notNull(),
  triggerEventId: text("trigger_event_id").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  deterministicHash: text("deterministic_hash").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("scoreboards_competition_version").on(table.competitionId, table.version)]);

export const commandAudits = sqliteTable("command_audits", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  idempotencyKey: text("idempotency_key").notNull(),
  actionType: text("action_type").notNull(),
  status: text("status").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("commands_competition_idempotency").on(table.competitionId, table.idempotencyKey)]);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  code: text("code").notNull(),
  status: text("status").notNull(),
  evidence: text("evidence", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
});

export const overrides = sqliteTable("overrides", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  beforeValue: text("before_value", { mode: "json" }),
  afterValue: text("after_value", { mode: "json" }).notNull(),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  reversedBy: text("reversed_by"),
  createdAt: text("created_at").notNull()
});

export const runtimeSnapshots = sqliteTable("runtime_snapshots", {
  competitionId: text("competition_id").primaryKey().references(() => competitions.id),
  stateVersion: integer("state_version").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull()
});

export const recoveryAudits = sqliteTable("recovery_audits", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  stateVersion: integer("state_version").notNull(),
  status: text("status").notNull(),
  report: text("report", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
  confirmedAt: text("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  confirmationReason: text("confirmation_reason")
});

export const observationGaps = sqliteTable("observation_gaps", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  code: text("code").notNull(),
  detail: text("detail").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
});

export const archiveVersions = sqliteTable("archive_versions", {
  id: text("id").primaryKey(),
  competitionId: text("competition_id").notNull().references(() => competitions.id),
  version: integer("version").notNull(),
  mode: text("mode", { enum: ["work", "test"] }).notNull(),
  relativePath: text("relative_path").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  createdAt: text("created_at").notNull()
}, (table) => [uniqueIndex("archive_versions_competition_version").on(table.competitionId, table.version)]);
