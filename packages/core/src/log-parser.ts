import { createHash } from "node:crypto";
import type { DomainEvent, ParsedLogLine } from "./events.js";

// ANSI escape bytes are intentionally matched and removed from untrusted console text.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const PREFIX_PATTERN = /^\[(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]\s?(.*)$/;

export interface ParseContext {
  year: number;
  utcOffsetMinutes: number;
  sourceId?: string;
}

const elapsedToMs = (hours: string, minutes: string, seconds: string, milliseconds: string): number =>
  (((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000) + Number(milliseconds.padEnd(3, "0").slice(0, 3));

const sourceIdFor = (line: string): string => createHash("sha256").update(line).digest("hex");

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export const parseLogLine = (input: string, context: ParseContext): ParsedLogLine => {
  const rawLine = stripAnsi(input.replace(/\r$/, ""));
  const prefix = PREFIX_PATTERN.exec(rawLine);
  const sourceId = context.sourceId ?? sourceIdFor(rawLine);
  if (!prefix) {
    const timestamp = new Date(0).toISOString();
    return { sourceId, timestamp, rawLine, event: { type: "unknown", sourceId, occurredAt: timestamp, rawLine, text: rawLine } };
  }

  const [, month, day, hour, minute, second, body = ""] = prefix;
  const utc = Date.UTC(context.year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - context.utcOffsetMinutes * 60_000;
  const timestamp = new Date(utc).toISOString();
  const metadata = { sourceId, occurredAt: timestamp, rawLine };
  let event: DomainEvent;

  if (body === "Connected to server OK") {
    event = { ...metadata, type: "connected" };
  } else {
    const login = /^(.*?) \(#(\d+)\) logged in with cheat mode (on|off)\.$/.exec(body);
    const disconnect = /^(.*?) \(#(\d+)\) disconnected\.$/.exec(body);
    const readyOrGo = /^\[(\d+), (.*?)\]: Level (\d{2}) - (Get ready|Go!)$/.exec(body);
    const finish = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) finished Level (\d{2}) in (\d+)(?:st|nd|rd|th) place \(score: (-?\d+); real time: (\d+):(\d+):(\d+)\.(\d+)\)\.$/.exec(body);
    const dnf = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) did not finish Level (\d{2}) \(furthest reach: sector (-?\d+)\)\.$/.exec(body);
    const cheat = /^\(?#?(\d+), (.*?)\)? turned cheat (on|off)\.$/.exec(body);

    if (login) {
      event = { ...metadata, type: "player-login", playerName: login[1] ?? "", connectionId: login[2] ?? "", cheat: login[3] === "on" };
    } else if (disconnect) {
      event = { ...metadata, type: "player-disconnect", playerName: disconnect[1] ?? "", connectionId: disconnect[2] ?? "" };
    } else if (readyOrGo) {
      event = {
        ...metadata,
        type: readyOrGo[4] === "Go!" ? "go" : "ready",
        connectionId: readyOrGo[1] ?? "",
        refereeName: readyOrGo[2] ?? "",
        level: Number(readyOrGo[3])
      };
    } else if (finish) {
      event = {
        ...metadata,
        type: "finish",
        cheat: Boolean(finish[1]),
        connectionId: finish[2] ?? "",
        playerName: finish[3] ?? "",
        level: Number(finish[4]),
        serverPlace: Number(finish[5]),
        score: Number(finish[6]),
        elapsedMs: elapsedToMs(finish[7] ?? "0", finish[8] ?? "0", finish[9] ?? "0", finish[10] ?? "0")
      };
    } else if (dnf) {
      event = {
        ...metadata,
        type: "dnf",
        cheat: Boolean(dnf[1]),
        connectionId: dnf[2] ?? "",
        playerName: dnf[3] ?? "",
        level: Number(dnf[4]),
        furthestSector: Number(dnf[5])
      };
    } else if (cheat) {
      event = { ...metadata, type: "cheat-changed", connectionId: cheat[1] ?? "", playerName: cheat[2] ?? "", enabled: cheat[3] === "on" };
    } else if (body.startsWith("[Warning]")) {
      event = { ...metadata, type: "warning", message: body.slice("[Warning]".length).trim() };
    } else {
      event = { ...metadata, type: "unknown", text: body };
    }
  }
  return { sourceId, timestamp, rawLine, event };
};
