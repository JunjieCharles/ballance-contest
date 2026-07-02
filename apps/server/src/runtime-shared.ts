import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  ActionAvailability,
  AttentionItem,
  CommandRecordView,
  CompetitionConfig,
  CompetitionMode,
  CompetitionSnapshot,
  RuntimeSnapshot,
  ScenarioDefinition,
  TestScenarioSummary
} from "@ballance/contracts";
import type { AutomationAction, AutomationSnapshot, ScoreboardEntry, ScoreboardVersion } from "@ballance/core";
import type { CommandRecord } from "./command-queue.js";

export const seededBehaviorRandom = (seed: number, stageId: string, attemptNumber: number, playerId: string, channel: string): number => {
  const digest = createHash("sha256").update(`${seed}:${stageId}:${attemptNumber}:${playerId}:${channel}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
};

export const commandView = (record: CommandRecord): CommandRecordView => ({
  id: record.id,
  actionType: record.action.type,
  status: record.status,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  command: record.command,
  ...(record.responseLine === undefined ? {} : { responseLine: record.responseLine })
});

export const simulatedCommand = (type: string, text = "测试模式模拟命令"): CommandRecordView => {
  const now = new Date().toISOString();
  return { id: randomUUID(), actionType: type, status: "simulated", createdAt: now, updatedAt: now, command: text, responseLine: "模拟成功", simulated: true };
};

export const isFlowCriticalAutomationAction = (action: AutomationAction): boolean =>
  action.kind === "ready" || action.kind === "cheat-off" || action.kind === "go" || action.kind === "force-next-restart";

export const isUnresolvedAutomationAction = (action: AutomationAction): action is AutomationAction & { status: "failed" | "uncertain" } =>
  action.status === "failed" || action.status === "uncertain" && isFlowCriticalAutomationAction(action);

export const scoreEntries = (entries: readonly ScoreboardEntry[]): CompetitionSnapshot["currentScoreboard"] =>
  entries.map((entry) => ({
    rank: entry.rank,
    playerId: entry.playerId,
    displayName: entry.displayName,
    points: entry.points,
    change: entry.change,
    stages: entry.stages
  }));

export const scoreboardView = (version: ScoreboardVersion): CompetitionSnapshot["scoreboardVersions"][number] => ({
  id: version.id,
  version: version.version,
  triggerSourceId: version.triggerSourceId,
  stageId: version.stageId,
  entries: scoreEntries(version.entries),
  deterministicHash: version.deterministicHash
});

export const automationView = (
  mode: CompetitionMode,
  snapshot?: AutomationSnapshot,
  commands: readonly CommandRecordView[] = [],
  plannedStageStartAt?: string,
  plannedReadyAtValue?: string,
  virtualNowMs?: number,
  availableActions: readonly ActionAvailability[] = [],
  attentionItems: readonly AttentionItem[] = [],
  deadlineAt?: string
): RuntimeSnapshot => ({
  phase: snapshot?.phase ?? "draft",
  ...(snapshot?.pausedFromPhase === undefined ? {} : { pausedFromPhase: snapshot.pausedFromPhase }),
  stateVersion: snapshot?.stateVersion ?? 0,
  mode,
  automationEnabled: snapshot?.automationEnabled ?? false,
  ...(snapshot?.currentStageId === undefined ? {} : { currentStageId: snapshot.currentStageId }),
  ...(snapshot?.plannedReadyAtMs === undefined ? {} : { plannedReadyAtMs: snapshot.plannedReadyAtMs }),
  ...(snapshot?.plannedReadyStageId === undefined ? {} : { plannedReadyStageId: snapshot.plannedReadyStageId }),
  ...(plannedReadyAtValue === undefined ? {} : { plannedReadyAt: plannedReadyAtValue }),
  ...(plannedStageStartAt === undefined ? {} : { plannedStageStartAt }),
  ...(deadlineAt === undefined ? {} : { stageDeadlineAt: deadlineAt }),
  ...(virtualNowMs === undefined ? {} : { virtualNowMs }),
  ...(snapshot?.countdownValue === undefined ? {} : { countdownValue: snapshot.countdownValue }),
  blockers: snapshot?.blockers ?? [],
  waitingParticipants: snapshot?.waitingParticipants ?? [],
  attempts: snapshot?.attempts ?? [],
  incidents: snapshot?.incidents ?? [],
  rejectedResults: snapshot?.rejectedResults ?? [],
  commands,
  availableActions,
  attentionItems,
  scoreEditPermissions: [],
  unconfirmedAutomationActions: snapshot?.actions
    .filter(isUnresolvedAutomationAction)
    .map((action) => ({ id: action.id, kind: action.kind, stageId: action.stageId, status: action.status })) ?? []
});

export const plannedStageStartAt = (snapshot: AutomationSnapshot, epochOriginMs: number): string | undefined => {
  const attempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === snapshot.currentStageId && !candidate.voided);
  if (attempt) return new Date(epochOriginMs + attempt.goAtMs).toISOString();
  const stageActions = snapshot.actions.filter((action) => action.stageId === snapshot.currentStageId);
  const lastGoIndex = stageActions.findLastIndex((action) => action.kind === "go");
  const flowActions = stageActions.slice(lastGoIndex + 1).filter((action) => !action.manual);
  const firstReady = flowActions.find((action) => action.kind === "ready");
  const pendingGo = flowActions.findLast((action) => action.kind === "go");
  const cheatOff = flowActions.findLast((action) => action.kind === "cheat-off");
  const readyAnnouncement = flowActions.findLast((action) => action.kind === "announce" && action.message === "READY!");
  const readyActions = flowActions.filter((action) => action.kind === "ready");
  const acknowledgedOrCreatedAt = (action: typeof flowActions[number]): number => action.acknowledgedAtMs ?? action.createdAtMs;
  const plannedFromFlow = pendingGo ? pendingGo.createdAtMs + 3_000
    : cheatOff ? acknowledgedOrCreatedAt(cheatOff) + 13_000
      : readyAnnouncement && firstReady
        ? Math.max(firstReady.createdAtMs + 20_000, acknowledgedOrCreatedAt(readyAnnouncement) + 5_000) + 13_000
        : firstReady && readyActions.length > 0
          ? (() => {
              const lastReady = readyActions.at(-1) as typeof readyActions[number];
              const nextReadyAt = Math.max(firstReady.createdAtMs + readyActions.length * 5_000, acknowledgedOrCreatedAt(lastReady) + 5_000);
              const readyStepsRemaining = Math.max(0, 2 - readyActions.length);
              return nextReadyAt + readyStepsRemaining * 5_000 + 5_000 + 5_000 + 10_000 + 3_000;
            })()
          : undefined;
  const plannedAtMs = plannedFromFlow ?? (
    snapshot.plannedReadyStageId === snapshot.currentStageId && snapshot.plannedReadyAtMs !== undefined
      ? snapshot.plannedReadyAtMs + 33_000
      : undefined
  );
  return plannedAtMs === undefined ? undefined : new Date(epochOriginMs + plannedAtMs).toISOString();
};

export const plannedReadyAt = (snapshot: AutomationSnapshot, epochOriginMs: number): string | undefined =>
  snapshot.plannedReadyAtMs === undefined ? undefined : new Date(epochOriginMs + snapshot.plannedReadyAtMs).toISOString();

export const stageDeadlineAt = (snapshot: AutomationSnapshot, epochOriginMs: number): string | undefined => {
  const attempt = [...snapshot.attempts].reverse().find((candidate) => candidate.stageId === snapshot.currentStageId && !candidate.voided);
  return attempt ? new Date(epochOriginMs + attempt.deadlineAtMs).toISOString() : undefined;
};

export const automationPolicyFor = (config: CompetitionConfig) => ({
  announcementLeadMs: config.flow.announcementLeadMs,
  readyBufferMs: config.flow.readyBufferMs,
  reconnectStableMs: config.flow.reconnectStableMs,
  preStartWaitLimitMs: config.flow.delayLimitMs,
  intermissionMs: config.flow.intermissionMs,
  protectionWindowMs: config.flow.protectionWindowMs,
  groupDisconnectThreshold: config.flow.groupDisconnectThreshold
});

export const scenarioSummary = (definition: ScenarioDefinition): TestScenarioSummary => ({
  id: definition.id,
  name: definition.name,
  kind: definition.kind ?? "scripted-replay",
  randomSeed: definition.randomSeed ?? 1,
  players: definition.players.length,
  stages: definition.stages.length,
  events: definition.events.length,
  expectedScoreboardVersions: definition.expected.scoreboardVersions,
  playerProfiles: [...new Set(definition.players.map((player) => player.profile ?? "normal"))],
  faults: definition.faultPlan?.length ?? 0
});

export const utcOffsetMinutes = (timezone: string): number => timezone === "Asia/Shanghai" ? 8 * 60 : 0;

export const serverLeaseKey = (server: string): string => {
  const normalized = server.trim().toLocaleLowerCase("en-US");
  const match = /^([^:]+?)(?::(\d+))?$/.exec(normalized);
  if (!match) return normalized;
  const host = (match[1] ?? normalized).replace(/\.$/, "");
  return match[2] ? `${host}:${Number(match[2])}` : host;
};

export class SystemMonotonicClock {
  public now(): number { return performance.now(); }
}
