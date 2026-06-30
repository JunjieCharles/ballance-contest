import { randomUUID } from "node:crypto";
import type { CommandTransport } from "./mock-client.js";

export type CommandStatus = "queued" | "sent" | "acknowledged" | "failed" | "timed_out" | "uncertain";
export type CommandAction =
  | { type: "list" }
  | { type: "announcement"; text: string }
  | { type: "ready"; map: string; mode: "sr" | "hs" }
  | { type: "cheat-off" }
  | { type: "go"; map: string; mode: "sr" | "hs" }
  | { type: "force-next-restart" }
  | { type: "scores"; map: string; mode: "sr" | "hs" }
  | { type: "kick"; playerName: string; reason: string }
  | { type: "crash"; playerName: string; reason: string }
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

const encode = (action: CommandAction): { command: string; critical: boolean; acknowledge: (line: string) => boolean } => {
  switch (action.type) {
    case "list": return { command: "list", critical: false, acknowledge: (line) => /player\(s\) online|\(#\d+\)/.test(line) };
    case "announcement": return { command: `announce ${cleanText(action.text)}`, critical: false, acknowledge: (line) => line.includes(action.text) || /success/i.test(line) };
    case "ready": return { command: `countdown ${cleanText(action.map)} ${action.mode} 4`, critical: false, acknowledge: (line) => /Get ready/.test(line) };
    case "cheat-off": return { command: "cheat off", critical: false, acknowledge: (line) => /cheat.*off/i.test(line) };
    case "go": return { command: `countdown ${cleanText(action.map)} ${action.mode}`, critical: true, acknowledge: (line) => / - Go!$/.test(line) };
    case "force-next-restart": return { command: "forcenextrestart", critical: true, acknowledge: (line) => /force.*restart|success/i.test(line) };
    case "scores": return { command: `scores ${action.mode} ${cleanText(action.map)}`, critical: false, acknowledge: (line) => /place|score|ranking/i.test(line) };
    case "kick": return { command: `kick ${cleanText(action.playerName)} ${cleanText(action.reason)}`, critical: true, acknowledge: (line) => /kick|disconnect|success/i.test(line) };
    case "crash": return { command: `crash ${cleanText(action.playerName)} ${cleanText(action.reason)}`, critical: true, acknowledge: (line) => /crash|disconnect|success/i.test(line) };
    case "raw": return { command: cleanText(action.command), critical: true, acknowledge: (line) => /success|error|warning|ready|go|disconnect/i.test(line) };
  }
};

export class CommandQueue {
  private readonly records = new Map<string, CommandRecord>();
  private tail: Promise<void> = Promise.resolve();
  private pending: { encoded: ReturnType<typeof encode>; record: CommandRecord; resolve: (record: CommandRecord) => void } | undefined;

  public constructor(private readonly transport: CommandTransport, private readonly timeoutMs = 5_000, private readonly onChange?: (record: CommandRecord) => void) {}

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
        try {
          await this.transport.write(encoded.command);
          this.update(record, "sent");
          await new Promise<void>((done) => {
            this.pending = { encoded, record, resolve: (final) => { resolve(final); done(); } };
            setTimeout(() => {
              if (this.pending?.record.id !== record.id) return;
              this.pending = undefined;
              const final = this.update(record, encoded.critical ? "uncertain" : "timed_out");
              resolve(final); done();
            }, this.timeoutMs);
          });
        } catch {
          resolve(this.update(record, "failed"));
        }
      });
    });
    return result;
  }

  public observeLine(line: string): void {
    const pending = this.pending;
    if (!pending || !pending.encoded.acknowledge(line)) return;
    this.pending = undefined;
    pending.resolve(this.update(pending.record, "acknowledged", line));
  }

  private update(record: CommandRecord, status: CommandStatus, responseLine?: string): CommandRecord {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (responseLine !== undefined) record.responseLine = responseLine;
    this.onChange?.(record);
    return record;
  }
}
