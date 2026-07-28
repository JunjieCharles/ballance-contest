import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandQueue } from "../../../apps/server/src/command-queue.js";
import { CompetitionController, type AutomationAction, type AutomationPolicy } from "../../../packages/core/src/index.js";

class ManualClock {
  public constructor(private currentMs = 0) {}
  public now(): number { return this.currentMs; }
  public advanceBy(milliseconds: number): void { this.currentMs += milliseconds; }
}

const makeController = (clock: ManualClock, policy: Partial<AutomationPolicy> = {}, participants = ["p1", "p2", "p3"], timeLimitMs = 600_000): CompetitionController =>
  new CompetitionController({
    competitionId: "competition-automation",
    participants,
    stages: [
      { id: "s1", map: "1", mode: "sr", timeLimitMs, minimumScoringPlace: 1 },
      { id: "s2", map: "2", mode: "sr", timeLimitMs, minimumScoringPlace: 1 }
    ],
    policy: { announcementLeadMs: 0, readyBufferMs: 15_000, reconnectStableMs: 15_000, intermissionMs: 3_000, ...policy },
    confirmationSecret: "secret"
  }, clock);

const acknowledge = (controller: CompetitionController, statusFor: (action: AutomationAction) => "acknowledged" | "failed" | "uncertain" = () => "acknowledged"): void => {
  for (const action of controller.drainActions()) controller.acknowledgeAction(action.id, statusFor(action));
};

const settle = (controller: CompetitionController, statusFor?: (action: AutomationAction) => "acknowledged" | "failed" | "uncertain"): void => {
  for (let index = 0; index < 10; index += 1) {
    const before = controller.snapshot().stateVersion;
    controller.tick();
    acknowledge(controller, statusFor);
    if (controller.snapshot().stateVersion === before) break;
  }
};

const startRunning = (controller: CompetitionController, clock: ManualClock): void => {
  controller.enable(0);
  settle(controller);
  clock.advanceBy(5_000);
  settle(controller);
  clock.advanceBy(5_000);
  settle(controller);
  clock.advanceBy(5_000);
  settle(controller);
  clock.advanceBy(5_000);
  settle(controller);
  clock.advanceBy(10_000);
  settle(controller);
};

const putEveryoneOnline = (controller: CompetitionController, participants = ["p1", "p2", "p3"]): void => {
  for (const participantId of participants) controller.observeConnection(participantId, true);
};

afterEach(() => vi.useRealTimers());

describe("P0 centralized automation and command regression", () => {
  it("BE-DISC-001/002: ignores player disconnects outside the start-protection window", () => {
    const clock = new ManualClock();
    const controller = makeController(clock);
    putEveryoneOnline(controller);
    controller.enable(60_000);
    controller.observeConnection("p2", false);
    expect(controller.snapshot()).toMatchObject({ phase: "preparing", plannedReadyAtMs: 60_000, waitingParticipants: [], blockers: [] });
    controller.observeConnection("p2", true);
    clock.advanceBy(60_000);
    settle(controller);
    expect(controller.snapshot()).toMatchObject({ phase: "ready", waitingParticipants: [], attempts: [] });
    expect(controller.snapshot().actions.some((item) => item.kind === "notice" && item.message?.includes("等待"))).toBe(false);
  });

  it("BE-WINDOW-001/002: keeps tail intake open before T-60 and closes it at the preparation boundary", () => {
    const clock = new ManualClock();
    const controller = makeController(clock, { readyBufferMs: 0, intermissionMs: 63_000 });
    putEveryoneOnline(controller);
    startRunning(controller, clock);
    expect(controller.snapshot().phase).toBe("running");

    expect(controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "s1-p1" })).toBe("accepted");
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", attempts: [{ intakeOpen: true, results: [{ playerId: "p1" }] }] });
    const plannedReadyAtMs = controller.snapshot().plannedReadyAtMs;
    expect(plannedReadyAtMs).toBeDefined();
    const preparationBoundaryAtMs = (plannedReadyAtMs as number) - 60_000;
    clock.advanceBy(preparationBoundaryAtMs - clock.now() - 1);
    settle(controller);
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", currentStageId: "s1", attempts: [{ intakeOpen: true }] });
    expect(controller.recordResult({ stageId: "s1", playerId: "p2", status: "finished", sourceId: "s1-p2" })).toBe("accepted");
    expect(controller.snapshot().attempts[0]?.results).toHaveLength(2);

    clock.advanceBy(1);
    settle(controller);
    expect(controller.snapshot()).toMatchObject({ phase: "preparing", currentStageId: "s2" });
    expect(controller.snapshot().attempts[0]).toMatchObject({
      stageId: "s1",
      intakeOpen: false,
      intakeClosedAtMs: preparationBoundaryAtMs
    });
    expect(controller.snapshot().attempts[0]?.results.some((result) => result.playerId === "p3")).toBe(false);
    expect(controller.recordResult({ stageId: "s1", playerId: "p3", status: "finished", sourceId: "s1-p3-after-t60" })).toBe("intake-closed");
  });

  it("BE-CHEAT-001/002: handles in-race cheat before T-60 and rejects later results after the boundary", () => {
    const clock = new ManualClock();
    const controller = makeController(clock, { readyBufferMs: 0, intermissionMs: 63_000 });
    putEveryoneOnline(controller);
    controller.observeCheat("p2", true, "practice-cheat");
    controller.observeCheat("p2", false, "practice-cheat-off");
    startRunning(controller, clock);
    expect(controller.snapshot().phase).toBe("running");

    expect(controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "p1-finish" })).toBe("accepted");
    const plannedReadyAtMs = controller.snapshot().plannedReadyAtMs;
    expect(plannedReadyAtMs).toBeDefined();
    const preparationBoundaryAtMs = (plannedReadyAtMs as number) - 60_000;
    clock.advanceBy(preparationBoundaryAtMs - clock.now() - 1);
    controller.observeCheat("p1", true, "p1-cheat-after-finish");
    controller.observeCheat("p2", true, "p2-cheat-running");
    const attempt = controller.snapshot().attempts[0];
    expect(attempt?.results).toEqual([
      expect.objectContaining({ playerId: "p1", status: "finished", sourceId: "p1-finish" }),
      expect.objectContaining({ playerId: "p2", status: "excluded", sourceId: "p2-cheat-running", reason: "cheat-enabled" })
    ]);
    expect(controller.snapshot().incidents).toEqual([]);
    expect(controller.recordResult({ stageId: "s1", playerId: "p2", status: "finished", sourceId: "p2-finish-after-cheat" })).toBe("accepted");
    clock.advanceBy(1);
    settle(controller);
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "s2",
      attempts: [{ stageId: "s1", intakeOpen: false, intakeClosedAtMs: preparationBoundaryAtMs }]
    });
    expect(controller.recordResult({ stageId: "s1", playerId: "p3", status: "finished", sourceId: "p3-finish-after-t60" })).toBe("intake-closed");
  });

  it("BE-RESTART-001/002/003: binds restart confirmation and keeps the new Go map-scoped", () => {
    const clock = new ManualClock();
    const controller = makeController(clock, { readyBufferMs: 0 }, ["p1", "p2"]);
    putEveryoneOnline(controller, ["p1", "p2"]);
    startRunning(controller, clock);
    const attempt = controller.snapshot().attempts[0];
    if (!attempt) throw new Error("missing attempt");
    const confirmation = controller.issueStageRestartConfirmation("s1");
    expect(() => controller.confirmStageRestart({ stageId: "s1", impactHash: confirmation.impactHash, token: "bad-token", reason: "bad" })).toThrow("INVALID_CONFIRMATION_TOKEN");
    controller.confirmStageRestart({ stageId: "s1", impactHash: confirmation.impactHash, token: confirmation.token, reason: "裁判重赛本关" });
    settle(controller);
    clock.advanceBy(5_000); settle(controller);
    clock.advanceBy(5_000); settle(controller);
    clock.advanceBy(5_000); settle(controller);
    clock.advanceBy(5_000); settle(controller);
    clock.advanceBy(10_000); settle(controller);
    expect(controller.snapshot().attempts[0]).toMatchObject({ voided: true });
    expect(controller.snapshot().phase).toBe("running");
    expect(controller.snapshot().attempts).toHaveLength(2);
  });

  it("BE-CMD-002/003: marks an unconfirmed critical Go uncertain, does not retry and preserves idempotency", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const queue = new CommandQueue({ write: async (command) => { writes.push(command); } }, 100);
    const pending = queue.enqueue({ type: "go", map: "1", mode: "sr" }, "critical-go");
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result).toMatchObject({ status: "uncertain", command: "countdown 1 sr" });
    expect(writes).toEqual(["countdown 1 sr"]);
    const duplicate = await queue.enqueue({ type: "go", map: "1", mode: "sr" }, "critical-go");
    expect(duplicate.id).toBe(result.id);
    expect(writes).toEqual(["countdown 1 sr"]);
  });
});
