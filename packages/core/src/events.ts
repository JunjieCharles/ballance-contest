export interface EventMetadata {
  sourceId: string;
  occurredAt: string;
  rawLine?: string;
}

export type DomainEvent =
  | (EventMetadata & { type: "connected" })
  | (EventMetadata & { type: "player-list-start"; count: number })
  | (EventMetadata & { type: "player-login"; connectionId: string; playerName: string; cheat: boolean })
  | (EventMetadata & { type: "player-listed"; connectionId: string; playerName: string; cheat: boolean })
  | (EventMetadata & { type: "player-disconnect"; connectionId: string; playerName: string })
  | (EventMetadata & { type: "ready"; connectionId: string; refereeName: string; level: number })
  | (EventMetadata & { type: "go"; connectionId: string; refereeName: string; level: number })
  | (EventMetadata & { type: "finish"; connectionId: string; playerName: string; level: number; serverPlace: number; score: number; elapsedMs: number; cheat: boolean })
  | (EventMetadata & { type: "dnf"; connectionId: string; playerName: string; level: number; furthestSector: number; cheat: boolean })
  | (EventMetadata & { type: "cheat-changed"; connectionId: string; playerName: string; enabled: boolean })
  | (EventMetadata & { type: "warning"; message: string })
  | (EventMetadata & { type: "unknown"; text: string });

export interface ParsedLogLine {
  sourceId: string;
  timestamp: string;
  rawLine: string;
  event: DomainEvent;
}
