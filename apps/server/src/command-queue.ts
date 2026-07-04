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
  | { type: "listmap" }
  | { type: "scores"; map: string; mode: "sr" | "hs" }
  | { type: "kick"; playerName: string; reason: string }
  | { type: "raw"; command: string };

export const requiresExplicitCommandResolution = (action: CommandAction): boolean =>
  ["set-map", "set-official-map", "ready", "cheat-off", "go", "kick", "raw"].includes(action.type);

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

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const refereeEchoConnectionId = (line: string): string | undefined =>
  /\[(\d+),\s*\*ContestConsole\]:/.exec(line)?.[1];

const isContestRefereeEcho = (line: string, expectedConnectionId?: string): boolean => {
  const connectionId = refereeEchoConnectionId(line);
  return expectedConnectionId !== undefined && connectionId === expectedConnectionId;
};

const mapEchoMatches = (line: string, map: string, mapName: string | undefined, mode: "sr" | "hs"): boolean => {
  const target = map.trim().toLowerCase();
  const official = /^level\s+(\d+)$/.exec(target);
  if (official) {
    const levelEcho = /Level[\s_]+(\d+)\*?(?:\s+<(SR|HS)>)?\s+-/i.exec(line);
    if (levelEcho) {
      const echoMode = levelEcho[2]?.toLowerCase();
      return Number(levelEcho[1]) === Number(official[1]) && (mode === "hs" ? echoMode === "hs" : echoMode !== "hs");
    }
    const hashEcho = /:\s*[0-9a-f]+\.\.(?:\s+<(SR|HS)>)?\s+-/i.exec(line);
    if (!hashEcho) return false;
    const echoMode = hashEcho[1]?.toLowerCase();
    return mode === "hs" ? echoMode === "hs" : echoMode !== "hs";
  }
  const custom = /^([0-9a-f]{32})\s+0$/.exec(target);
  const customMatch = /:\s*"([^"]+)"(?:\s+<(SR|HS)>)?\s+-/i.exec(line);
  const customEcho = customMatch?.[1];
  const customMode = customMatch?.[2]?.toLowerCase() ?? "sr";
  if (!custom || !customEcho || customMode !== mode) return false;
  const prefix = /^([0-9a-f]+)\.\.$/i.exec(customEcho)?.[1];
  return prefix ? Boolean(custom[1]?.startsWith(prefix.toLowerCase())) : Boolean(mapName && customEcho === mapName);
};

const PERMISSION_DENIED_TEXT = "Action failed: you don't have the permission to run this action.";

export const isPermissionDeniedLine = (line: string): boolean => line.includes(PERMISSION_DENIED_TEXT);

const encode = (
  action: CommandAction,
  refereeConnectionId: () => string | undefined = () => undefined
): { command: string; critical: boolean; acknowledgeAfterWriteMs?: number; acknowledge: (line: string) => boolean; onSettle?: () => string } => {
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
        acknowledgeAfterWriteMs: 500,
        acknowledge: () => false
      };
    }
    case "set-official-map": return {
      command: `setmap level ${action.level} ${cleanText(action.displayName)}`,
      critical: false,
      acknowledgeAfterWriteMs: 500,
      acknowledge: () => false
    };
    case "notification": {
      const text = cleanNotificationText(action.text);
      const label = action.channel === "announce" ? "Announcement" : action.channel === "notice" ? "Notice" : "Bulletin";
      return {
        command: `${action.channel} ${text}`,
        critical: false,
        acknowledge: (line) => {
          if (action.channel === "bulletin") return line.endsWith(`[${label}] *ContestConsole: ${text}`);
          const match = new RegExp(`\\[${label}\\] \\(\\d+, \\*ContestConsole\\): (.*)$`).exec(line);
          const expected = refereeConnectionId();
          return expected !== undefined && match?.[1] === text && match[0].includes(`(${expected}, *ContestConsole)`);
        }
      };
    }
    case "ready": return {
      command: `countdown ${cleanText(action.map)} ${action.mode} 4`,
      critical: false,
      acknowledge: (line) => isContestRefereeEcho(line, refereeConnectionId()) && /Get ready$/.test(line) && mapEchoMatches(line, action.map, action.mapName, action.mode)
    };
    case "cheat-off": return {
      command: "cheat off",
      critical: false,
      acknowledge: (line) => {
        const connectionId = /\(#?(\d+),\s*\*ContestConsole\) toggled cheat off globally!$/.exec(line)?.[1];
        const expected = refereeConnectionId();
        return expected !== undefined && connectionId === expected;
      }
    };
    case "go": return {
      command: `countdown ${cleanText(action.map)} ${action.mode}`,
      critical: true,
      acknowledge: (line) => isContestRefereeEcho(line, refereeConnectionId()) && / - Go!$/.test(line) && mapEchoMatches(line, action.map, action.mapName, action.mode)
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
    case "kick": {
      const playerName = cleanText(action.playerName);
      const reason = cleanText(action.reason);
      const disconnected = new RegExp(`${escapePattern(playerName)} \\(#[0-9]+\\) disconnected\\.$`);
      const selfKicked = `The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (${reason}).)`;
      return {
        command: `kick ${playerName} ${reason}`,
        critical: true,
        acknowledge: (line) => disconnected.test(line) || playerName === "*ContestConsole" && line.endsWith(selfKicked)
      };
    }
    case "raw": {
      const command = cleanText(action.command);
      if (/^forcenextrestart$/i.test(command)) throw new Error("forcenextrestart is disabled because it makes the next Go apply to every map");
      return { command, critical: true, acknowledge: () => false };
    }
  }
};

export class CommandQueue {
  private readonly records = new Map<string, CommandRecord>();
  private tail: Promise<void> = Promise.resolve();
  private pending: { encoded: ReturnType<typeof encode>; record: CommandRecord; resolve: (record: CommandRecord) => void } | undefined;
  private transport: CommandTransport;
  private refereeConnectionId: string | undefined;

  public constructor(
    transport: CommandTransport,
    private readonly timeoutMs: number | ((action: CommandAction) => number) = 10_000,
    private readonly onChange?: (record: CommandRecord) => void
  ) { this.transport = transport; }

  public replaceTransport(transport: CommandTransport): void {
    this.transport = transport;
    this.refereeConnectionId = undefined;
  }

  public setRefereeConnectionId(connectionId: string | undefined): void { this.refereeConnectionId = connectionId; }

  public enqueue(action: CommandAction, idempotencyKey: string): Promise<CommandRecord> {
    const old = this.records.get(idempotencyKey);
    if (old) return Promise.resolve(old);
    const encoded = encode(action, () => this.refereeConnectionId);
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

  public observeLine(line: string): CommandRecord | undefined {
    const modernIdentity = /(?:^|\] )(\d+):\s+\*ContestConsole\s+-?\d+ms/.exec(line)?.[1];
    const legacyIdentity = /(?:^|\] )\*ContestConsole \(#(\d+)\)$/.exec(line)?.[1];
    if (modernIdentity || legacyIdentity) this.refereeConnectionId = modernIdentity ?? legacyIdentity;
    const pending = this.pending;
    if (!pending) return undefined;
    if (isPermissionDeniedLine(line)) {
      const record = this.update(pending.record, "failed", line);
      pending.resolve(record);
      return record;
    }
    if (pending.encoded.acknowledge(line)) {
      const record = this.update(pending.record, "acknowledged", line);
      pending.resolve(record);
      return record;
    }
    return undefined;
  }

  private update(record: CommandRecord, status: CommandStatus, responseLine?: string): CommandRecord {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (responseLine !== undefined) record.responseLine = responseLine;
    this.onChange?.(record);
    return record;
  }
}
