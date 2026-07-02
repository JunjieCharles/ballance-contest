import { describe, expect, it } from "vitest";
import type { AutomationSnapshot } from "@ballance/core";
import { plannedStageStartAt, stageDeadlineAt } from "./runtime-shared.js";

describe("runtime schedule views", () => {
  it("uses authoritative Go for the stage start and preserves the deadline after early intake closure", () => {
    const snapshot: AutomationSnapshot = {
      phase: "tail-intake",
      stateVersion: 1,
      automationEnabled: true,
      currentStageId: "s1",
      plannedReadyAtMs: 50_000,
      plannedReadyStageId: "s2",
      blockers: [],
      waitingParticipants: [],
      attempts: [{
        id: "attempt-1",
        stageId: "s1",
        attemptNumber: 1,
        goAtMs: 10_000,
        deadlineAtMs: 70_000,
        intakeOpen: false,
        intakeClosedAtMs: 30_000,
        voided: false,
        results: []
      }],
      incidents: [],
      rejectedResults: [],
      actions: [{
        id: "manual-go",
        kind: "go",
        idempotencyKey: "manual-go",
        createdAtMs: 7_000,
        acknowledgedAtMs: 10_000,
        stageId: "s1",
        map: "level 1",
        mode: "sr",
        manual: true,
        status: "acknowledged"
      }]
    };

    expect(plannedStageStartAt(snapshot, 1_000)).toBe(new Date(11_000).toISOString());
    expect(stageDeadlineAt(snapshot, 1_000)).toBe(new Date(71_000).toISOString());
  });

  it("moves the displayed planned Go after delayed acknowledgements", () => {
    const action = (id: string, kind: "ready" | "announce" | "cheat-off", createdAtMs: number, acknowledgedAtMs: number) => ({
      id, kind, idempotencyKey: id, createdAtMs, acknowledgedAtMs, stageId: "s1", map: "level 1", mode: "sr" as const,
      ...(kind === "announce" ? { message: "READY!" } : {}), status: "acknowledged" as const
    });
    const snapshot: AutomationSnapshot = {
      phase: "ready", stateVersion: 1, automationEnabled: true, currentStageId: "s1", blockers: [], waitingParticipants: [], attempts: [], incidents: [], rejectedResults: [],
      actions: [
        action("r1", "ready", 0, 2_000),
        action("r2", "ready", 7_000, 9_000),
        action("r3", "ready", 14_000, 14_000),
        action("announce", "announce", 19_000, 22_000),
        action("cheat", "cheat-off", 27_000, 30_000)
      ]
    };
    expect(plannedStageStartAt(snapshot, 0)).toBe(new Date(43_000).toISOString());
  });
});
