import { describe, expect, it } from "vitest";
import type { AutomationSnapshot } from "@ballance/core";
import { currentStageReadyAt, nextStageReadyAt, plannedStageStartAt, stageDeadlineAt } from "./runtime-shared.js";

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
    expect(currentStageReadyAt(snapshot, 1_000)).toBeUndefined();
    expect(nextStageReadyAt(snapshot, 1_000)).toBe(new Date(51_000).toISOString());
  });

  it("shows the current first Ready separately from a genuinely next-stage Ready", () => {
    const base: AutomationSnapshot = {
      phase: "preparing", stateVersion: 1, automationEnabled: true, currentStageId: "s1", plannedReadyAtMs: 60_000, plannedReadyStageId: "s1",
      blockers: [], waitingParticipants: [], attempts: [], incidents: [], rejectedResults: [], actions: []
    };
    expect(currentStageReadyAt(base, 1_000)).toBe(new Date(61_000).toISOString());
    expect(nextStageReadyAt(base, 1_000)).toBeUndefined();

    const running: AutomationSnapshot = {
      ...base,
      phase: "tail-intake",
      plannedReadyAtMs: 180_000,
      plannedReadyStageId: "s2",
      attempts: [{ id: "a1", stageId: "s1", attemptNumber: 1, goAtMs: 40_000, deadlineAtMs: 640_000, intakeOpen: true, voided: false, results: [] }],
      actions: [{ id: "r1", kind: "ready", idempotencyKey: "r1", createdAtMs: 10_000, stageId: "s1", map: "level 1", mode: "sr", status: "acknowledged" }]
    };
    expect(currentStageReadyAt(running, 1_000)).toBe(new Date(11_000).toISOString());
    expect(nextStageReadyAt(running, 1_000)).toBe(new Date(181_000).toISOString());

    const runningWithoutPlan: Partial<AutomationSnapshot> = { ...running };
    delete runningWithoutPlan.plannedReadyAtMs;
    delete runningWithoutPlan.plannedReadyStageId;
    const restarted = {
      ...runningWithoutPlan,
      phase: "running",
      attempts: [
        { id: "a1", stageId: "s1", attemptNumber: 1, goAtMs: 40_000, deadlineAtMs: 640_000, intakeOpen: false, voided: true, results: [] },
        { id: "a2", stageId: "s1", attemptNumber: 2, goAtMs: 100_000, deadlineAtMs: 700_000, intakeOpen: true, voided: false, results: [] }
      ],
      actions: [
        ...running.actions,
        { id: "r2", kind: "ready", idempotencyKey: "r2", createdAtMs: 70_000, stageId: "s1", map: "level 1", mode: "sr", status: "acknowledged" }
      ]
    } as AutomationSnapshot;
    expect(currentStageReadyAt(restarted, 1_000)).toBe(new Date(71_000).toISOString());
  });

  it.each(["READY!", "READY!\n记得收分"])("moves planned Go after delayed %s acknowledgement", (message) => {
    const action = (id: string, kind: "ready" | "announce" | "cheat-off", createdAtMs: number, acknowledgedAtMs: number) => ({
      id, kind, idempotencyKey: id, createdAtMs, acknowledgedAtMs, stageId: "s1", map: "level 1", mode: "sr" as const,
      ...(kind === "announce" ? { message } : {}), status: "acknowledged" as const
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
