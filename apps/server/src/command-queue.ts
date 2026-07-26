import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CommandTransport } from "./mock-client.js";
import type { NotificationChannel } from "@ballance/contracts";

export type CommandStatus = "queued" | "sent" | "acknowledged" | "failed" | "timed_out" | "uncertain" | "cancelled";
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
  /** Missing only on records restored from a version that predates connection generations. */
  generation?: number;
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
): { command: string; acknowledgeAfterWriteMs?: number; acknowledge: (line: string) => boolean; onSettle?: () => string } => {
  switch (action.type) {
    case "list": return {
      command: "list",
      acknowledge: (line) => /player\(s\) online:|client\(s\) online:\s*\d+ player\(s\)/.test(line)
    };
    case "set-map": {
      const mapHash = cleanText(action.mapHash).toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(mapHash)) throw new Error("setmap requires a complete 32-character MD5");
      return {
        command: `setmap ${mapHash} 0 ${cleanText(action.displayName)}`,
        // setmap has no success echo, but its permission failure is asynchronous.
        // Keep a short observation window before treating the accepted stdin write as success.
        acknowledgeAfterWriteMs: 500,
        acknowledge: () => false
      };
    }
    case "set-official-map": return {
      command: `setmap level ${action.level} ${cleanText(action.displayName)}`,
      acknowledgeAfterWriteMs: 500,
      acknowledge: () => false
    };
    case "notification": {
      const text = cleanNotificationText(action.text);
      const label = action.channel === "announce" ? "Announcement" : action.channel === "notice" ? "Notice" : "Bulletin";
      return {
        command: `${action.channel} ${text}`,
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
      acknowledge: (line) => isContestRefereeEcho(line, refereeConnectionId()) && /Get ready$/.test(line) && mapEchoMatches(line, action.map, action.mapName, action.mode)
    };
    case "cheat-off": return {
      command: "cheat off",
      acknowledge: (line) => {
        const connectionId = /\(#?(\d+),\s*\*ContestConsole\) toggled cheat off globally!$/.exec(line)?.[1];
        const expected = refereeConnectionId();
        return expected !== undefined && connectionId === expected;
      }
    };
    case "go": return {
      command: `countdown ${cleanText(action.map)} ${action.mode}`,
      acknowledge: (line) => isContestRefereeEcho(line, refereeConnectionId()) && / - Go!$/.test(line) && mapEchoMatches(line, action.map, action.mapName, action.mode)
    };
    case "listmap": {
      const seen = new Set<string>();
      return {
        command: "listmap",
        acknowledgeAfterWriteMs: 500,
        acknowledge: (line) => {
          const match = /([0-9a-f]{32}):\s*(\S+)/i.exec(line);
          if (match?.[2]) seen.add(match[2]);
          return false;
        },
        onSettle: () => JSON.stringify([...seen])
      };
    }
    case "scores": return { command: `scores ${action.mode} ${cleanText(action.map)}`, acknowledge: (line) => /place|score|ranking/i.test(line) };
    case "kick": {
      const playerName = cleanText(action.playerName);
      const reason = cleanText(action.reason);
      const disconnected = new RegExp(`${escapePattern(playerName)} \\(#[0-9]+\\) disconnected\\.$`);
      const selfKicked = `The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (${reason}).)`;
      return {
        command: `kick ${playerName} ${reason}`,
        acknowledge: (line) => disconnected.test(line) || playerName === "*ContestConsole" && line.endsWith(selfKicked)
      };
    }
    case "raw": {
      const command = cleanText(action.command);
      if (/^forcenextrestart$/i.test(command)) throw new Error("forcenextrestart is disabled because it makes the next Go apply to every map");
      return { command, acknowledge: () => false };
    }
  }
};

type EncodedCommand = ReturnType<typeof encode>;

interface CommandTask {
  encoded: EncodedCommand;
  record: CommandRecord;
  generation: number;
  deadlineAtMs: number;
  writeStarted: boolean;
  settled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  settleAfterWriteTimeout?: ReturnType<typeof setTimeout>;
  onWriteStart?: (record: CommandRecord) => void;
  resolveResult: (record: CommandRecord) => void;
  finishTurn?: () => void;
}

export class CommandQueue {
  private readonly records = new Map<string, CommandRecord>();
  private tail: Promise<void> = Promise.resolve();
  private readonly tasks = new Map<string, CommandTask>();
  private pending: CommandTask | undefined;
  private transport: CommandTransport;
  private refereeConnectionId: string | undefined;
  private connectionGeneration = 1;

  public constructor(
    transport: CommandTransport,
    private readonly timeoutMs: number | ((action: CommandAction) => number) = 10_000,
    private readonly onChange?: (record: CommandRecord) => void
  ) { this.transport = transport; }

  public get generation(): number { return this.connectionGeneration; }

  public advanceGeneration(transport?: CommandTransport): number {
    this.connectionGeneration += 1;
    if (transport) this.transport = transport;
    this.refereeConnectionId = undefined;
    for (const task of this.tasks.values()) {
      if (task.generation >= this.connectionGeneration || task.settled) continue;
      if (!task.writeStarted) {
        this.settleTask(task, "cancelled");
        continue;
      }
      const status: CommandStatus = requiresExplicitCommandResolution(task.record.action) ? "uncertain" : "timed_out";
      this.settleTask(task, status);
    }
    return this.connectionGeneration;
  }

  public replaceTransport(transport: CommandTransport): void {
    this.advanceGeneration(transport);
  }

  public setRefereeConnectionId(connectionId: string | undefined, generation = this.connectionGeneration): boolean {
    if (generation !== this.connectionGeneration) return false;
    this.refereeConnectionId = connectionId;
    return true;
  }

  public enqueue(action: CommandAction, idempotencyKey: string, onWriteStart?: (record: CommandRecord) => void): Promise<CommandRecord> {
    const old = this.records.get(idempotencyKey);
    if (old) return Promise.resolve(old);
    const encoded = encode(action, () => this.refereeConnectionId);
    const commandTimeoutMs = typeof this.timeoutMs === "function" ? this.timeoutMs(action) : this.timeoutMs;
    const deadlineAtMs = performance.now() + Math.max(0, commandTimeoutMs);
    const now = new Date().toISOString();
    const generation = this.connectionGeneration;
    const record: CommandRecord = {
      id: randomUUID(),
      idempotencyKey,
      action,
      command: encoded.command,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      generation
    };
    this.records.set(idempotencyKey, record);
    this.onChange?.(record);
    const result = new Promise<CommandRecord>((resolve) => {
      const task: CommandTask = {
        encoded,
        record,
        generation,
        deadlineAtMs,
        writeStarted: false,
        settled: false,
        ...(onWriteStart === undefined ? {} : { onWriteStart }),
        resolveResult: resolve
      };
      this.tasks.set(record.id, task);
      task.timeout = setTimeout(() => {
        if (task.settled) return;
        this.settleTask(task, this.timeoutStatus(task));
      }, Math.max(0, deadlineAtMs - performance.now()));
      this.tail = this.tail.then(() => this.runTask(task));
    });
    return result;
  }

  public observeLine(line: string, generation = this.connectionGeneration): CommandRecord | undefined {
    if (generation !== this.connectionGeneration) return undefined;
    const pending = this.pending;
    if (!pending || pending.generation !== generation || pending.settled) return undefined;
    if (isPermissionDeniedLine(line)) {
      return this.settleTask(pending, "failed", line);
    }
    if (pending.encoded.acknowledge(line)) {
      return this.settleTask(pending, "acknowledged", line);
    }
    return undefined;
  }

  private runTask(task: CommandTask): Promise<void> {
    if (task.settled) return Promise.resolve();
    if (task.generation !== this.connectionGeneration) {
      this.settleTask(task, "cancelled");
      return Promise.resolve();
    }
    if (performance.now() >= task.deadlineAtMs) {
      this.settleTask(task, "cancelled");
      return Promise.resolve();
    }
    return new Promise<void>((done) => {
      task.finishTurn = done;
      this.pending = task;
      try {
        task.onWriteStart?.(task.record);
      } catch {
        this.settleTask(task, "failed");
        return;
      }
      if (task.settled || task.generation !== this.connectionGeneration) return;
      if (performance.now() >= task.deadlineAtMs) {
        this.settleTask(task, "cancelled");
        return;
      }
      task.writeStarted = true;
      this.update(task.record, "sent");
      if (task.settled || task.generation !== this.connectionGeneration) return;
      const transport = this.transport;
      let write: Promise<void>;
      try {
        write = transport.write(task.encoded.command);
      } catch {
        if (!task.settled && task.generation === this.connectionGeneration) this.settleTask(task, this.timeoutStatus(task));
        return;
      }
      void write.then(() => {
        if (task.settled || task.generation !== this.connectionGeneration) return;
        if (task.encoded.acknowledgeAfterWriteMs !== undefined) {
          task.settleAfterWriteTimeout = setTimeout(() => {
            if (task.settled || task.generation !== this.connectionGeneration) return;
            const responseLine = task.encoded.onSettle?.() ?? "MockClient 已接受本地命令，权限观察窗口内未返回失败";
            this.settleTask(task, "acknowledged", responseLine);
          }, task.encoded.acknowledgeAfterWriteMs);
        }
      }, () => {
        if (task.settled || task.generation !== this.connectionGeneration) return;
        this.settleTask(task, this.timeoutStatus(task));
      });
    });
  }

  private timeoutStatus(task: CommandTask): CommandStatus {
    if (!task.writeStarted) return "cancelled";
    return requiresExplicitCommandResolution(task.record.action) ? "uncertain" : "timed_out";
  }

  private settleTask(
    task: CommandTask,
    status: CommandStatus,
    responseLine?: string
  ): CommandRecord {
    if (task.settled) return task.record;
    task.settled = true;
    if (task.timeout) clearTimeout(task.timeout);
    if (task.settleAfterWriteTimeout) clearTimeout(task.settleAfterWriteTimeout);
    if (this.pending?.record.id === task.record.id) this.pending = undefined;
    this.tasks.delete(task.record.id);
    const record = this.update(task.record, status, responseLine);
    task.resolveResult(record);
    task.finishTurn?.();
    return record;
  }

  private update(record: CommandRecord, status: CommandStatus, responseLine?: string): CommandRecord {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (responseLine !== undefined) record.responseLine = responseLine;
    this.onChange?.(record);
    return record;
  }
}
