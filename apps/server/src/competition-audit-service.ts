import { isReadyAnnouncement } from "@ballance/core";
import { createHash, randomUUID } from "node:crypto";
import type { AttentionItem, CommandRecordView, RawClientLogLine, RefereeActionId } from "@ballance/contracts";
import type { AutomationAction, AutomationSnapshot } from "@ballance/core";
import type { CommandRecord } from "./command-queue.js";
import { isPermissionDeniedLine } from "./command-queue.js";
import type { EventJournal } from "./event-journal.js";
import { commandView } from "./runtime-shared.js";
import type { OpenedDatabase } from "./storage/database.js";

const rows = <T>(database: OpenedDatabase | undefined, sql: string, ...params: unknown[]): T[] =>
  database ? database.sqlite.prepare(sql).all(...params) as T[] : [];

export class CompetitionAuditService {
  private readonly rawLogs = new Map<string, RawClientLogLine[]>();
  private readonly memoryAttentionItems = new Map<string, AttentionItem[]>();
  private readonly memoryCommands = new Map<string, Map<string, CommandRecord>>();

  public constructor(
    private readonly database: OpenedDatabase | undefined,
    private readonly journal: EventJournal
  ) {}

  public rawClientLogs(competitionId: string, limit: number, complete = false): readonly RawClientLogLine[] {
    const boundedLimit = complete ? -1 : Math.min(1_000, Math.max(1, Math.trunc(limit)));
    if (!this.database && complete) return [...(this.rawLogs.get(competitionId) ?? [])];
    if (!this.database) return (this.rawLogs.get(competitionId) ?? []).slice(-boundedLimit);
    return rows<{ source_id: string; source_file: string; occurred_at: string; raw_line: string }>(
      this.database,
      "SELECT source_id,source_file,occurred_at,raw_line FROM raw_log_events WHERE competition_id=? ORDER BY rowid DESC LIMIT ?",
      competitionId,
      boundedLimit
    ).reverse().map((item) => ({
      id: item.source_id,
      source: item.source_file as RawClientLogLine["source"],
      occurredAt: item.occurred_at,
      rawLine: item.raw_line
    }));
  }

  public removeCompetition(competitionId: string): void {
    this.rawLogs.delete(competitionId);
    this.memoryAttentionItems.delete(competitionId);
  }

  public checkpointCommandMemory(competitionId: string): readonly CommandRecord[] {
    return [...(this.memoryCommands.get(competitionId)?.values() ?? [])]
      .map((record) => ({ ...record, action: { ...record.action } }));
  }

  public restoreCommandMemory(competitionId: string, records: readonly CommandRecord[]): void {
    if (records.length === 0) {
      this.memoryCommands.delete(competitionId);
      return;
    }
    this.memoryCommands.set(
      competitionId,
      new Map(records.map((record) => [
        record.id,
        { ...record, action: { ...record.action } }
      ]))
    );
  }

  public appendRawLog(competitionId: string, source: RawClientLogLine["source"], rawLine: string, occurredAt = new Date().toISOString()): void {
    const line: RawClientLogLine = { id: randomUUID(), source, occurredAt, rawLine };
    if (this.database) {
      this.database.sqlite.prepare("INSERT INTO raw_log_events(source_id,competition_id,source_file,byte_offset,occurred_at,raw_line,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(line.id, competitionId, source, 0, occurredAt, rawLine, createHash("sha256").update(rawLine).digest("hex"), new Date().toISOString());
    } else {
      const logs = [...(this.rawLogs.get(competitionId) ?? []), line];
      this.rawLogs.set(competitionId, logs.slice(-1_000));
    }
    this.journal.append({ type: "client.raw-log", competitionId, data: line });
  }

  public appendAttention(competitionId: string, item: AttentionItem): void {
    let inserted = false;
    if (this.database) {
      inserted = this.database.sqlite.prepare("INSERT OR IGNORE INTO attention_items(id,competition_id,category,severity,title,message,occurred_at,stage_id,participant_ids,action) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(item.id, competitionId, item.category, item.severity, item.title, item.message, item.occurredAt, item.stageId ?? null, item.participantIds ? JSON.stringify(item.participantIds) : null, item.action ?? null).changes > 0;
    } else {
      const items = this.memoryAttentionItems.get(competitionId) ?? [];
      if (!items.some((candidate) => candidate.id === item.id)) {
        this.memoryAttentionItems.set(competitionId, [...items, item].slice(-200));
        inserted = true;
      }
    }
    if (inserted) this.journal.append({ type: "flow.attention", competitionId, data: item });
  }

  public attentionItems(competitionId: string, snapshot?: AutomationSnapshot, complete = false): AttentionItem[] {
    const stored = this.database
      ? rows<{ id: string; category: AttentionItem["category"]; severity: AttentionItem["severity"]; title: string; message: string; occurred_at: string; stage_id: string | null; participant_ids: string | null; action: RefereeActionId | null }>(
        this.database,
        "SELECT id,category,severity,title,message,occurred_at,stage_id,participant_ids,action FROM attention_items WHERE competition_id=? ORDER BY occurred_at DESC LIMIT ?",
        competitionId, complete ? -1 : 100
      ).map((item) => ({
        id: item.id, category: item.category, severity: item.severity, title: item.title, message: item.message, occurredAt: item.occurred_at,
        ...(item.stage_id ? { stageId: item.stage_id } : {}),
        ...(item.participant_ids ? { participantIds: JSON.parse(item.participant_ids) as string[] } : {}),
        ...(item.action ? { action: item.action } : {})
      }))
      : [...(this.memoryAttentionItems.get(competitionId) ?? [])].reverse();
    const incidentOccurredAt = (createdAtMs: number): string => snapshot?.wallClockOriginMs === undefined
      ? new Date().toISOString()
      : new Date(snapshot.wallClockOriginMs + createdAtMs).toISOString();
    const dynamic: AttentionItem[] = [
      ...(snapshot?.blockers ?? []).map((blocker, index) => ({
        id: `blocker:${blocker.code}:${blocker.participantId ?? index}`,
        category: "blocker" as const,
        severity: blocker.severity,
        title: blocker.code === "COMMAND_UNCONFIRMED" ? "命令结果不确定" : "流程暂时阻断",
        message: blocker.suggestion,
        occurredAt: new Date().toISOString(),
        ...(blocker.participantId ? { participantIds: [blocker.participantId] } : {})
      })),
      ...(snapshot?.incidents ?? []).filter((incident) =>
        (incident as { status?: string }).status === "open" || incident.type === "protected-crash").map((incident) => {
        const value = incident as { id: string; type: string; status?: string; evidence: string; participantIds: readonly string[]; createdAtMs: number };
        const automaticProtection = value.type === "protected-crash" && value.status === "resolved";
        return {
          id: `incident:${value.id}`,
          category: "incident" as const,
          severity: automaticProtection ? "warning" as const : "critical" as const,
          title: automaticProtection ? "起跑保护已自动执行" : "待处理事故",
          message: automaticProtection ? `尝试已按规则自动处理；证据：${value.evidence}` : `${value.type}：${value.evidence}`,
          occurredAt: incidentOccurredAt(value.createdAtMs),
          ...(value.type === "server-disconnect" ? { action: "restart-work" as const }
            : value.type === "timing-discontinuity" ? { action: "enable-automation" as const }
              : automaticProtection ? {} : { action: "restart-stage" as const }),
          ...(value.participantIds.length ? { participantIds: value.participantIds } : {})
        };
      })
    ];
    return [...dynamic, ...stored]
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id))
      .slice(0, complete ? undefined : 100);
  }

  public recordAutomationAttention(competitionId: string, action: AutomationAction): void {
    const details = action.kind === "bulletin" ? ["flow", "info", "赛程计划已更新"] as const
      : action.kind === "notice" ? ["flow", "info", "流程通知"] as const
      : action.kind === "announce" ? ["flow", "info", isReadyAnnouncement(action) ? "已发出 READY" : "重要比赛通知"] as const
      : action.kind === "go" ? ["flow", "warning", "本关已发令 Go"] as const
      : ["command", "info", "裁判命令已确认"] as const;
    this.appendAttention(competitionId, {
      id: `automation:${action.id}`,
      category: details[0],
      severity: details[1],
      title: details[2],
      message: action.message ?? action.kind,
      occurredAt: new Date().toISOString(),
      stageId: action.stageId
    });
  }

  public recordExclusionAttention(competitionId: string, stageId: string, playerId: string, sourceId: string, reason: string): void {
    this.appendAttention(competitionId, {
      id: `excluded:${sourceId}`,
      category: "result",
      severity: "warning",
      title: "违规成绩已排除",
      message: `${playerId}：${reason}。真实完赛日志保留，但本关计 0 分并顺延其他选手。`,
      occurredAt: new Date().toISOString(),
      stageId,
      participantIds: [playerId]
    });
  }

  public recordCommand(competitionId: string, record: CommandRecord): void {
    if (this.database) {
      this.database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(competition_id,idempotency_key) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at")
        .run(record.id, competitionId, record.idempotencyKey, record.action.type, record.status, JSON.stringify(record), record.createdAt, record.updatedAt);
    }
    const memory = this.memoryCommands.get(competitionId) ?? new Map<string, CommandRecord>();
    memory.set(record.id, { ...record, action: { ...record.action } });
    this.memoryCommands.set(competitionId, memory);
    if (record.status === "uncertain" || record.status === "failed" || record.status === "timed_out") {
      const permissionDenied = Boolean(record.responseLine && isPermissionDeniedLine(record.responseLine));
      const transportFailed = record.responseLine === "MockClient stdin 写入失败";
      const blocksFlow = permissionDenied || transportFailed;
      this.appendAttention(competitionId, {
        id: `command:${record.id}:${record.status}`,
        category: "command",
        severity: blocksFlow ? "critical" : "warning",
        title: permissionDenied ? "ContestConsole 权限不足" : record.status === "uncertain" ? "命令结果待核实" : record.status === "timed_out" ? "命令等待回显超时" : "命令发送失败",
        message: permissionDenied
          ? `${record.command} 被服务器拒绝；自动化已阻断，请修复 ContestConsole 权限后重新核对。`
          : transportFailed ? `${record.command} 写入 MockClient 失败；请恢复连接后重新启动起跑流程。`
          : `${record.command} 未获得服务器确认；自动化继续，不会自动重发。如现场未起跑，请使用“重置本关到 Ready”或“重置本关到 T-60”。`,
        occurredAt: record.updatedAt
      });
    }
  }

  public recordCommandView(competitionId: string, idempotencyKey: string, record: CommandRecordView): void {
    if (!this.database) return;
    this.database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(competition_id,idempotency_key) DO UPDATE SET status=excluded.status,payload=excluded.payload,updated_at=excluded.updated_at")
      .run(record.id, competitionId, idempotencyKey, record.actionType, record.status, JSON.stringify(record), record.createdAt, record.updatedAt);
  }

  public commandHistory(competitionId: string, complete = false): CommandRecordView[] {
    if (!this.database) return [...(this.memoryCommands.get(competitionId)?.values() ?? [])].reverse().slice(0, complete ? undefined : 50).map(commandView);
    return rows<{ payload: string }>(this.database, "SELECT payload FROM command_audits WHERE competition_id=? ORDER BY created_at DESC LIMIT ?", competitionId, complete ? -1 : 50).map((item) => {
      const stored = JSON.parse(item.payload) as CommandRecord | CommandRecordView;
      return "action" in stored ? commandView(stored) : stored;
    });
  }

  public commandRecords(competitionId: string): CommandRecord[] {
    if (!this.database) return [...(this.memoryCommands.get(competitionId)?.values() ?? [])]
      .filter((record) => record.status === "failed" || record.status === "uncertain")
      .map((record) => ({ ...record, action: { ...record.action } }));
    return rows<{ payload: string }>(this.database, "SELECT payload FROM command_audits WHERE competition_id=? AND status IN ('failed','uncertain') ORDER BY created_at", competitionId)
      .map((item) => JSON.parse(item.payload) as CommandRecord | CommandRecordView)
      .filter((item): item is CommandRecord => "action" in item);
  }
}
