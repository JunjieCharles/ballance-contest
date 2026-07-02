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

const quotedMapReference = (value: string): { mapKind: "custom"; mapHashPrefix?: string; mapDisplayName?: string } => {
  const prefix = /^([0-9a-f]+)\.\.$/i.exec(value)?.[1];
  return prefix ? { mapKind: "custom", mapHashPrefix: prefix.toLowerCase() } : { mapKind: "custom", mapDisplayName: value };
};

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
  } else if (body === "Action failed: you don't have the permission to run this action.") {
    event = { ...metadata, type: "permission-denied", message: body };
  } else {
    const listStart = /^(\d+) player\(s\) online:$/.exec(body);
    const listSummary = /^(\d+) client\(s\) online:\s*(\d+) player\(s\),\s*(\d+) spectator\(s\)\.$/.exec(body);
    const modernListed = /^(\d+):\s+(.+?)\s+(-?\d+)ms(?:\s+(\[CHEAT\]))?$/.exec(body);
    const login = /^(.*?) \(#(\d+)\) logged in with cheat mode (on|off)\.$/.exec(body);
    const disconnect = /^(.*?) \(#(\d+)\) disconnected\.$/.exec(body);
    const listed = /^(.*?) \(#(\d+)\)( \[CHEAT\])?$/.exec(body);
    const readyOrGo = /^\[(\d+), (.*?)\]: Level (\d{2}) - (Get ready|3|2|1|Go!)$/.exec(body);
    const customReadyOrGo = /^\[(\d+), (.*?)\]: "([^"]+)" - (Get ready|3|2|1|Go!)$/.exec(body);
    const officialHashReadyOrGo = /^\[(\d+), (.*?)\]: ([0-9a-fA-F]+)\.\. - (Get ready|3|2|1|Go!)$/.exec(body);
    const noticeOrAnnouncement = /^\[(Notice|Announcement)\] \((\d+), (.*?)\): (.*)$/.exec(body);
    const bulletin = /^\[Bulletin\] (.*?): (.*)$/.exec(body);
    const finish = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) finished Level (\d{2}) in (\d+)(?:st|nd|rd|th) place \(score: (-?\d+); real time: (\d+):(\d+):(\d+)\.(\d+)\)\.$/.exec(body);
    const customFinish = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) finished "([^"]+)" in (\d+)(?:st|nd|rd|th) place \(score: (-?\d+)(?: \[-?\d+\])?; real time: (\d+):(\d+):(\d+)\.(\d+)\)\.$/.exec(body);
    const officialHashFinish = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) finished ([0-9a-fA-F]+)\.\. in (\d+)(?:st|nd|rd|th) place \(score: (-?\d+)(?: \[-?\d+\])?; real time: (\d+):(\d+):(\d+)\.(\d+)\)\.$/.exec(body);
    const dnf = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) did not finish Level (\d{2}) \(furthest reach: sector (-?\d+)\)\.$/.exec(body);
    const customDnf = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) did not finish "([^"]+)" \(furthest reach: sector (-?\d+)\)\.$/.exec(body);
    const officialHashDnf = /^(\[CHEAT\] )?\(#(\d+), (.*?)\) did not finish ([0-9a-fA-F]+)\.\. \(furthest reach: sector (-?\d+)\)\.$/.exec(body);
    const cheat = /^\(?#?(\d+), (.*?)\)? turned cheat (on|off)\.$/.exec(body);

    if (listStart) {
      event = { ...metadata, type: "player-list-start", count: Number(listStart[1]) };
    } else if (listSummary) {
      event = {
        ...metadata,
        type: "player-list-summary",
        clients: Number(listSummary[1]),
        players: Number(listSummary[2]),
        spectators: Number(listSummary[3])
      };
    } else if (modernListed) {
      event = {
        ...metadata,
        type: "player-listed",
        connectionId: modernListed[1] ?? "",
        playerName: modernListed[2]?.trim() ?? "",
        cheat: Boolean(modernListed[4])
      };
    } else if (login) {
      event = { ...metadata, type: "player-login", playerName: login[1] ?? "", connectionId: login[2] ?? "", cheat: login[3] === "on" };
    } else if (disconnect) {
      event = { ...metadata, type: "player-disconnect", playerName: disconnect[1] ?? "", connectionId: disconnect[2] ?? "" };
    } else if (listed) {
      event = { ...metadata, type: "player-listed", playerName: listed[1] ?? "", connectionId: listed[2] ?? "", cheat: Boolean(listed[3]) };
    } else if (readyOrGo || customReadyOrGo || officialHashReadyOrGo) {
      const match = readyOrGo ?? customReadyOrGo ?? officialHashReadyOrGo as RegExpExecArray;
      const value = match[4] ?? "";
      const common = {
        ...metadata,
        connectionId: match[1] ?? "",
        refereeName: match[2] ?? "",
        ...(readyOrGo
          ? { mapKind: "official" as const, level: Number(match[3]) }
          : customReadyOrGo ? quotedMapReference(match[3] ?? "") : { mapKind: "official" as const, mapHashPrefix: (match[3] ?? "").toLowerCase() })
      };
      event = value === "Go!" ? { ...common, type: "go" }
        : value === "Get ready" ? { ...common, type: "ready" }
        : { ...common, type: "countdown", value: Number(value) as 3 | 2 | 1 };
    } else if (noticeOrAnnouncement) {
      event = {
        ...metadata,
        type: "notification",
        channel: noticeOrAnnouncement[1] === "Notice" ? "notice" : "announce",
        connectionId: noticeOrAnnouncement[2] ?? "",
        refereeName: noticeOrAnnouncement[3] ?? "",
        text: noticeOrAnnouncement[4] ?? ""
      };
    } else if (bulletin) {
      event = { ...metadata, type: "notification", channel: "bulletin", refereeName: bulletin[1] ?? "", text: bulletin[2] ?? "" };
    } else if (finish || customFinish || officialHashFinish) {
      const match = finish ?? customFinish ?? officialHashFinish as RegExpExecArray;
      event = {
        ...metadata,
        type: "finish",
        cheat: Boolean(match[1]),
        connectionId: match[2] ?? "",
        playerName: match[3] ?? "",
        ...(finish
          ? { mapKind: "official" as const, level: Number(match[4]) }
          : customFinish ? quotedMapReference(match[4] ?? "") : { mapKind: "official" as const, mapHashPrefix: (match[4] ?? "").toLowerCase() }),
        serverPlace: Number(match[5]),
        score: Number(match[6]),
        elapsedMs: elapsedToMs(match[7] ?? "0", match[8] ?? "0", match[9] ?? "0", match[10] ?? "0")
      };
    } else if (dnf || customDnf || officialHashDnf) {
      const match = dnf ?? customDnf ?? officialHashDnf as RegExpExecArray;
      event = {
        ...metadata,
        type: "dnf",
        cheat: Boolean(match[1]),
        connectionId: match[2] ?? "",
        playerName: match[3] ?? "",
        ...(dnf
          ? { mapKind: "official" as const, level: Number(match[4]) }
          : customDnf ? quotedMapReference(match[4] ?? "") : { mapKind: "official" as const, mapHashPrefix: (match[4] ?? "").toLowerCase() }),
        furthestSector: Number(match[5])
      };
    } else if (cheat) {
      event = { ...metadata, type: "cheat-changed", connectionId: cheat[1] ?? "", playerName: cheat[2] ?? "", enabled: cheat[3] === "on" };
    } else if (body.startsWith("[Warning]")) {
      const message = body.slice("[Warning]".length).trim();
      const uncontrollable = /^(.*?) just restarted Level (\d{2}) when their ball is not controllable\.$/.exec(message);
      const resetHotkey = /^(.*?) just pressed the Reset hotkey at Level (\d{2})!$/.exec(message);
      const violation = uncontrollable ?? resetHotkey;
      event = violation
        ? {
            ...metadata,
            type: "warning",
            message,
            playerName: violation[1] ?? "",
            level: Number(violation[2]),
            violationCode: uncontrollable ? "uncontrollable-restart" : "reset-hotkey"
          }
        : { ...metadata, type: "warning", message };
    } else {
      event = { ...metadata, type: "unknown", text: body };
    }
  }
  return { sourceId, timestamp, rawLine, event };
};
