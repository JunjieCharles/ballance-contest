export interface EventMetadata {
  sourceId: string;
  occurredAt: string;
  rawLine?: string;
}

export interface EventMapReference {
  mapKind: "official" | "custom";
  level?: number;
  mapHashPrefix?: string;
  mapDisplayName?: string;
}

export type DomainEvent =
  | (EventMetadata & { type: "connected" })
  | (EventMetadata & { type: "server-disconnected" })
  | (EventMetadata & { type: "permission-denied"; message: string })
  | (EventMetadata & { type: "player-list-start"; count: number })
  | (EventMetadata & { type: "player-list-summary"; clients: number; players: number; spectators: number })
  | (EventMetadata & { type: "player-login"; connectionId: string; playerName: string; cheat: boolean })
  | (EventMetadata & { type: "player-listed"; connectionId: string; playerName: string; cheat: boolean })
  | (EventMetadata & { type: "player-disconnect"; connectionId: string; playerName: string })
  | (EventMetadata & { type: "fatal-error"; playerName: string; message: string })
  | (EventMetadata & EventMapReference & { type: "ready"; connectionId: string; refereeName: string })
  | (EventMetadata & EventMapReference & { type: "countdown"; connectionId: string; refereeName: string; value: 3 | 2 | 1 })
  | (EventMetadata & EventMapReference & { type: "go"; connectionId: string; refereeName: string })
  | (EventMetadata & { type: "notification"; channel: "bulletin" | "notice" | "announce"; connectionId?: string; refereeName: string; text: string })
  | (EventMetadata & EventMapReference & { type: "finish"; connectionId: string; playerName: string; serverPlace: number; score: number; elapsedMs: number; cheat: boolean })
  | (EventMetadata & EventMapReference & { type: "dnf"; connectionId: string; playerName: string; furthestSector: number; cheat: boolean })
  | (EventMetadata & { type: "cheat-changed"; connectionId: string; playerName: string; enabled: boolean })
  | (EventMetadata & { type: "warning"; message: string; playerName?: string; level?: number; violationCode?: "uncontrollable-restart" | "reset-hotkey" })
  | (EventMetadata & { type: "unknown"; text: string });

export interface ParsedLogLine {
  sourceId: string;
  timestamp: string;
  rawLine: string;
  event: DomainEvent;
}
