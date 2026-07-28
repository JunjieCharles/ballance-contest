import type { ScoreboardVersionView, ScenarioDefinition, WorkConnectionView } from "@ballance/contracts";
import type { AutomationAction, AutomationSnapshot, EngineSnapshot } from "@ballance/core";

export interface PersistedTestOperation {
  kind: "automation-start" | "advance-clock" | "fault" | "start-protection";
  readyInMs?: number;
  milliseconds?: number;
  fault?: string;
  playerId?: string;
  used?: boolean;
}

export interface PendingTestCountdown {
  action: AutomationAction;
  emitted: number;
}

export interface ScheduledTestRecovery {
  playerId: string;
  dueAtMs: number;
}

export interface PersistedTestRun {
  id: string;
  definition: ScenarioDefinition;
  playedEvents: number;
  operations: PersistedTestOperation[];
  automation?: AutomationSnapshot;
  engine?: EngineSnapshot;
  pendingCountdown?: PendingTestCountdown;
  appliedFaultIds?: string[];
  stageFinishOrdinals?: Record<string, number>;
  phaseStartedAt?: Record<string, number>;
  recoveries?: ScheduledTestRecovery[];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceSnapshotPayload {
  activeRunId?: string;
  testRuns?: PersistedTestRun[];
  scoreboardRevisions?: ScoreboardVersionView[];
  archives?: Array<{ version: number; directory: string; packagePath: string; manifestHash: string; createdAt: string }>;
  resolvedCommandIds?: string[];
  work?: {
    started: boolean;
    mockClientVersion?: string;
    participantStageId?: string;
    automation?: AutomationSnapshot;
    engine?: EngineSnapshot;
    mapEchoPrefixes?: Record<string, string>;
    connection?: WorkConnectionView;
  };
}
