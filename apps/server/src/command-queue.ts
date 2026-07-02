import { randomUUID } from "node:crypto";
import type { CommandTransport } from "./mock-client.js";
import type { NotificationChannel } from "@ballance/contracts";

export type CommandStatus = "queued" | "sent" | "acknowledged" | "failed" | "timed_out" | "uncertain";
export type CommandAction =
  | { type: "list" }
  | { type: "set-map"; mapHash: string; displayName: string }
  | { type: "set-official-map"; level: number; displayName: string }
  | { type: "notification"; channel: NotificationChannel; text: string }
  | { type: "ready"; map: string; mapName?: string; mode: "sr" | "hs" }
  | { type: "cheat-off" }
  | { type: "go"; map: string; mapName?: string; mode: "sr" | "hs" }
  | { type: "force-next-restart" }
  | { type: "listmap" }
  | { type: "scores"; map: string; mode: "sr" | "hs" }
  | { type: "kick"; playerName: string; reason: string }
  | { type: "raw"; command: string };

export interface CommandRecord {
  id: string;
  idempotencyKey: string;
  action: CommandAction;
  command: string;
  status: CommandStatus;
  createdAt: string;
  updatedAt: string;
  responseLine?: string;
}

const cleanText = (text: string): string => {
  if (text.includes("\n") || text.includes("\r") || text.length > 500) throw new Error("Command text contains invalid control characters or is too long");
  return text.trim();
};

const cleanNotificationText = (text: string): string => {
  if (text.includes("\r") || text.length > 500) throw new Error("Notification text contains invalid control characters or is too long");
  return text.trim().replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
};

const mapEchoMatches = (line: string, map: string, mapName?: string): boolean => {
  const target = map.trim().toLowerCase();
  const official = /^level\s+(\d+)$/.exec(target);
  if (official) {
    const levelEcho = /Level[\s_]+(\d+)\s+-/i.exec(line);
    if (levelEcho) return Number(levelEcho[1]) === Number(official[1]);
    return /:\s*[0-9a-f]+\.\.\s+-/i.test(line);
  }
  const custom = /^([0-9a-f]{32})\s+0$/.exec(target);
  const customEcho = /:\s*"([^"]+)"\s+-/i.exec(line)?.[1];
  if (!custom || !customEcho) return false;
  const prefix = /^([0-9a-f]+)\.\.$/i.exec(customEcho)?.[1];
  return prefix ? Boolean(custom[1]?.startsWith(prefix.toLowerCase())) : Boolean(mapName && customEcho === mapName);
};

const PERMISSION_DENIED_TEXT = "Action failed: you don't have the permission to run this action.";

export const isPermissionDeniedLine = (line: string): boolean => line.includes(PERMISSION_DENIED_TEXT);

const encode = (action: CommandAction): { command: string; critical: boolean; acknowledgeAfterWriteMs?: number; acknowledge: (line: string) => boolean; onSettle?: () => string } => {
  switch (action.type) {
    case "list": return {
      command: "list",
      critical: false,
      acknowledge: (line) => /player\(s\) online:|client\(s\) online:\s*\d+ player\(s\)/.test(line)
    };
    case "set-map": {
      const mapHash = cleanText(action.mapHash).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(mapHash)) throw new Error("setmap requires a complete 32-character MD5");
      return {
        command: `setmap ${mapHash} 0 ${cleanText(action.displayName)}`,
        critical: false,
        // setmap has no success echo, but its permission failure is asynchronous.
        // Keep a short observation window before treating the accepted stdin write as success.
        acknowledgeAfterWriteMs: 250,
        acknowledge: () => false
      };
    }
    case "set-official-map": return {
      command: `setmap level ${action.level} ${cleanText(action.displayName)}`,
      critical: false,
      acknowledgeAfterWriteMs: 250,
      acknowledge: () => false
    };
    case "notification": return {
      command: `${action.channel} ${cleanNotificationText(action.text)}`,
      critical: false,
      acknowledge: (line) => line.includes(action.text) || line.includes(`[${action.channel === "announce" ? "Announcement" : action.channel === "notice" ? "Notice" : "Bulletin"}]`) || /success/i.test(line)
    };
    case "ready": return { command: `countdown ${cleanText(action.map)} ${action.mode} 4`, critical: false, acknowledge: (line) => /Get ready$/.test(line) && mapEchoMatches(line, action.map, action.mapName) };
    case "cheat-off": return { command: "cheat off", critical: false, acknowledge: (line) => /cheat.*off/i.test(line) };
    case "go": return { command: `countdown ${cleanText(action.map)} ${action.mode}`, critical: true, acknowledge: (line) => / - (?:Go!|[321])$/.test(line) && mapEchoMatches(line, action.map, action.mapName) };
    case "force-next-restart": return {
      command: "forcenextrestart",
      critical: true,
      acknowledgeAfterWriteMs: 250,
      acknowledge: () => false
    };
    case "listmap": {
      const seen = new Set<string>();
      return {
        command: "listmap",
        critical: false,
        acknowledgeAfterWriteMs: 500,
        acknowledge: (line) => {
          const match = /([0-9a-f]{32}):\s*(\S+)/i.exec(line);
          if (match?.[2]) seen.add(match[2]);
          return false;
        },
        onSettle: () => JSON.stringify([...seen])
      };
    }
    case "scores": return { command: `scores ${action.mode} ${cleanText(action.map)}`, critical: false, acknowledge: (line) => /place|score|ranking/i.test(line) };
    case "kick": return { command: `kick ${cleanText(action.playerName)} ${cleanText(action.reason)}`, critical: true, acknowledge: (line) => /kick|disconnect|success/i.test(line) };
    case "raw": return { command: cleanText(action.command), critical: true, acknowledge: (line) => /success|error|warning|ready|go|disconnect/i.test(line) };
  }
};

export class CommandQueue {
  private readonly records = new Map<string, CommandRecord>();
  private tail: Promise<void> = Promise.resolve();
  private pending: { encoded: ReturnType<typeof encode>; record: CommandRecord; resolve: (record: CommandRecord) => void } | undefined;

  public constructor(
    private readonly transport: CommandTransport,
    private readonly timeoutMs: number | ((action: CommandAction) => number) = 10_000,
    private readonly onChange?: (record: CommandRecord) => void
  ) {}

  public enqueue(action: CommandAction, idempotencyKey: string): Promise<CommandRecord> {
    const old = this.records.get(idempotencyKey);
    if (old) return Promise.resolve(old);
    const encoded = encode(action);
    const now = new Date().toISOString();
    const record: CommandRecord = { id: randomUUID(), idempotencyKey, action, command: encoded.command, status: "queued", createdAt: now, updatedAt: now };
    this.records.set(idempotencyKey, record);
    this.onChange?.(record);
    const result = new Promise<CommandRecord>((resolve) => {
      this.tail = this.tail.then(async () => {
        await new Promise<void>((done) => {
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const settle = (final: CommandRecord): void => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (this.pending?.record.id === record.id) this.pending = undefined;
            resolve(final);
            done();
          };
          this.pending = { encoded, record, resolve: settle };
          void (async () => {
            try {
              await this.transport.write(encoded.command);
              if (settled) return;
              this.update(record, "sent");
              if (encoded.acknowledgeAfterWriteMs !== undefined) {
                timeout = setTimeout(() => {
                  const responseLine = encoded.onSettle?.() ?? "MockClient 已接受本地命令，权限观察窗口内未返回失败";
                  settle(this.update(record, "acknowledged", responseLine));
                }, encoded.acknowledgeAfterWriteMs);
                return;
              }
              timeout = setTimeout(() => {
                if (this.pending?.record.id !== record.id) return;
                settle(this.update(record, encoded.critical ? "uncertain" : "timed_out"));
              }, typeof this.timeoutMs === "function" ? this.timeoutMs(action) : this.timeoutMs);
            } catch {
              settle(this.update(record, "failed"));
            }
          })();
        });
      });
    });
    return result;
  }

  public observeLine(line: string): void {
    const pending = this.pending;
    if (!pending) return;
    if (isPermissionDeniedLine(line)) {
      pending.resolve(this.update(pending.record, "failed", line));
      return;
    }
    if (pending.encoded.acknowledge(line)) pending.resolve(this.update(pending.record, "acknowledged", line));
  }

  private update(record: CommandRecord, status: CommandStatus, responseLine?: string): CommandRecord {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (responseLine !== undefined) record.responseLine = responseLine;
    this.onChange?.(record);
    return record;
  }
}
