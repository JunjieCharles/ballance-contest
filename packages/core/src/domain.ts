import type { CompetitionMode, StageMode } from "@ballance/contracts";

export type CompetitionStatus =
  | "draft"
  | "published"
  | "lobby"
  | "preparing"
  | "ready"
  | "countdown"
  | "running"
  | "settling"
  | "between-stages"
  | "review"
  | "finished"
  | "archived"
  | "paused";

export interface Competition {
  id: string;
  name: string;
  mode: CompetitionMode;
  status: CompetitionStatus;
  timezone: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface Stage {
  id: string;
  competitionId: string;
  order: number;
  level: number;
  mode: StageMode;
  timeLimitMs: number;
  minimumScoringPlace: number;
  scoring: readonly number[];
}

export interface Participant {
  id: string;
  competitionId: string;
  displayName: string;
  normalizedName: string;
}

export const normalizePlayerName = (name: string): string => name.toLocaleLowerCase("en-US");

export interface Clock {
  nowMs(): number;
  wallNow(): Date;
}

export class SystemClock implements Clock {
  public nowMs(): number { return performance.now(); }
  public wallNow(): Date { return new Date(); }
}
