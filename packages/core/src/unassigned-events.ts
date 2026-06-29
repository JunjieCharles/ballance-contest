import { randomUUID } from "node:crypto";

export type UnassignedReason = "practice" | "wrong-stage" | "closed-window" | "unknown-identity" | "external-go" | "observation-gap";

export interface UnassignedEvent<T = unknown> {
  id: string;
  sourceId: string;
  reason: UnassignedReason;
  payload: T;
  status: "open" | "assigned" | "dismissed";
  createdAt: string;
}

export interface UnassignedResolution {
  id: string;
  eventId: string;
  action: "assign" | "dismiss";
  actor: string;
  reason: string;
  createdAt: string;
  attemptId?: string;
  stageId?: string;
}

export class UnassignedEventQueue {
  private readonly events = new Map<string, UnassignedEvent>();
  private readonly sourceIds = new Set<string>();
  private readonly resolutions: UnassignedResolution[] = [];

  public add<T>(input: { sourceId: string; reason: UnassignedReason; payload: T }): UnassignedEvent<T> {
    if (this.sourceIds.has(input.sourceId)) throw new Error("UNASSIGNED_SOURCE_DUPLICATE");
    const event: UnassignedEvent<T> = {
      id: randomUUID(), sourceId: input.sourceId, reason: input.reason, payload: structuredClone(input.payload),
      status: "open", createdAt: new Date().toISOString()
    };
    this.sourceIds.add(input.sourceId);
    this.events.set(event.id, event);
    return structuredClone(event);
  }

  public assign(eventId: string, input: { attemptId: string; stageId: string; actor: string; reason: string }): UnassignedResolution {
    if (!input.attemptId || !input.stageId) throw new Error("ASSIGNMENT_TARGET_REQUIRED");
    return this.resolve(eventId, { action: "assign", ...input });
  }

  public dismiss(eventId: string, input: { actor: string; reason: string }): UnassignedResolution {
    return this.resolve(eventId, { action: "dismiss", ...input });
  }

  public snapshot(): { events: readonly UnassignedEvent[]; resolutions: readonly UnassignedResolution[] } {
    return {
      events: [...this.events.values()].map((event) => structuredClone(event)),
      resolutions: this.resolutions.map((resolution) => ({ ...resolution }))
    };
  }

  private resolve(eventId: string, input: {
    action: "assign" | "dismiss";
    actor: string;
    reason: string;
    attemptId?: string;
    stageId?: string;
  }): UnassignedResolution {
    if (!input.actor.trim()) throw new Error("RESOLUTION_ACTOR_REQUIRED");
    if (!input.reason.trim()) throw new Error("RESOLUTION_REASON_REQUIRED");
    const event = this.events.get(eventId);
    if (!event) throw new Error("UNASSIGNED_EVENT_NOT_FOUND");
    if (event.status !== "open") throw new Error("UNASSIGNED_EVENT_ALREADY_RESOLVED");
    const resolution: UnassignedResolution = {
      id: randomUUID(), eventId, action: input.action, actor: input.actor.trim(), reason: input.reason.trim(), createdAt: new Date().toISOString(),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.stageId === undefined ? {} : { stageId: input.stageId })
    };
    this.resolutions.push(resolution);
    event.status = input.action === "assign" ? "assigned" : "dismissed";
    return { ...resolution };
  }
}
