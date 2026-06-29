import { randomUUID } from "node:crypto";
import { normalizePlayerName, type Participant } from "./domain.js";

export type ConnectionRole = "participant" | "staff" | "unregistered";

export interface ConnectionIdentityState {
  connectionId: string;
  rawName: string;
  normalizedName: string;
  role: ConnectionRole;
  participantId?: string;
  online: boolean;
  historicalConnectionIds: readonly string[];
}

export type AssociationResult =
  | { kind: "associated"; participantId: string; automatic: boolean }
  | { kind: "suggested"; participantId: string }
  | { kind: "conflict"; candidateParticipantIds: readonly string[] }
  | { kind: "unmatched" };

export class ParticipantRegistry {
  private readonly participants = new Map<string, Participant>();
  private readonly connections = new Map<string, ConnectionIdentityState>();
  private readonly participantConnections = new Map<string, Set<string>>();

  public constructor(private readonly competitionId: string) {}

  public addParticipant(displayName: string, id: string = randomUUID()): Participant {
    const participant: Participant = {
      id,
      competitionId: this.competitionId,
      displayName,
      normalizedName: normalizePlayerName(displayName)
    };
    this.participants.set(id, participant);
    return participant;
  }

  public observeConnection(connectionId: string, rawName: string): AssociationResult {
    const existing = this.connections.get(connectionId);
    if (existing?.participantId) {
      this.connections.set(connectionId, { ...existing, online: true, rawName });
      return { kind: "associated", participantId: existing.participantId, automatic: false };
    }
    const normalizedName = normalizePlayerName(rawName);
    const state: ConnectionIdentityState = {
      connectionId,
      rawName,
      normalizedName,
      role: rawName.startsWith("*") ? "staff" : "unregistered",
      online: true,
      historicalConnectionIds: [connectionId]
    };
    this.connections.set(connectionId, state);
    if (state.role === "staff") return { kind: "unmatched" };
    const candidates = [...this.participants.values()].filter((participant) => participant.normalizedName === normalizedName);
    if (candidates.length === 1 && candidates[0]) return { kind: "suggested", participantId: candidates[0].id };
    if (candidates.length > 1) return { kind: "conflict", candidateParticipantIds: candidates.map((candidate) => candidate.id) };
    return { kind: "unmatched" };
  }

  public associate(connectionId: string, participantId: string): ConnectionIdentityState {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown connection ${connectionId}`);
    if (!this.participants.has(participantId)) throw new Error(`Unknown participant ${participantId}`);
    if (connection.participantId && connection.participantId !== participantId) {
      this.participantConnections.get(connection.participantId)?.delete(connectionId);
    }
    const updated: ConnectionIdentityState = { ...connection, participantId, role: "participant" };
    this.connections.set(connectionId, updated);
    const history = this.participantConnections.get(participantId) ?? new Set<string>();
    history.add(connectionId);
    this.participantConnections.set(participantId, history);
    return { ...updated, historicalConnectionIds: [...history] };
  }

  public split(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection?.participantId) return;
    this.participantConnections.get(connection.participantId)?.delete(connectionId);
    const updated: ConnectionIdentityState = { ...connection, role: connection.rawName.startsWith("*") ? "staff" : "unregistered" };
    delete updated.participantId;
    this.connections.set(connectionId, updated);
  }

  public disconnect(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) this.connections.set(connectionId, { ...connection, online: false });
  }

  public getConnection(connectionId: string): ConnectionIdentityState | undefined {
    const connection = this.connections.get(connectionId);
    if (!connection) return undefined;
    const history = connection.participantId ? [...(this.participantConnections.get(connection.participantId) ?? [])] : [connectionId];
    return { ...connection, historicalConnectionIds: history };
  }
}
