import { describe, expect, it } from "vitest";
import { CompetitionController, type AutomationAction, type AutomationConfiguration, type MonotonicClock } from "./competition-controller.js";

class FakeClock implements MonotonicClock {
  public constructor(private value = 0) {}
  public now(): number { return this.value; }
  public advance(milliseconds: number): void { this.value += milliseconds; }
  public set(milliseconds: number): void { this.value = milliseconds; }
}

const configuration = (overrides: Partial<AutomationConfiguration> = {}): AutomationConfiguration => ({
  competitionId: "competition-1",
  participants: ["p1", "p2", "p3", "p4", "p5"],
  stages: [
    { id: "s1", map: "1", mode: "sr", timeLimitMs: 20_000, minimumScoringPlace: 3 },
    { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
  ],
  policy: { announcementLeadMs: 0, readyBufferMs: 1_000, reconnectStableMs: 15_000, intermissionMs: 3_000, protectionWindowMs: 15_000 },
  confirmationSecret: "test-only-secret",
  ...overrides
});

const connectAll = (controller: CompetitionController, ids = ["p1", "p2", "p3", "p4", "p5"]): void => {
  for (const id of ids) controller.observeConnection(id, true);
};

const action = (controller: CompetitionController, kind: AutomationAction["kind"]): AutomationAction => {
  const found = controller.drainActions().find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`Missing ${kind} action`);
  return found;
};

const enterRunning = (controller: CompetitionController, clock: FakeClock): void => {
  controller.enable(clock.now());
  controller.drainActions();
  controller.tick();
  controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
  for (let index = 0; index < 2; index += 1) {
    clock.advance(3_000);
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
  }
  controller.tick();
  controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
  controller.tick();
  controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
  controller.tick();
  const go = action(controller, "go");
  controller.acknowledgeAction(go.id, "acknowledged");
};

describe("CompetitionController", () => {
  it("sends Ready three times at 0/3/6 seconds before READY, cheat-off and Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);

    controller.tick();
    let current = action(controller, "ready");
    expect(current.createdAtMs).toBe(0);
    controller.acknowledgeAction(current.id, "acknowledged");
    clock.advance(3_000);
    controller.tick();
    current = action(controller, "ready");
    expect(current.createdAtMs).toBe(3_000);
    controller.acknowledgeAction(current.id, "acknowledged");
    clock.advance(3_000);
    controller.tick();
    current = action(controller, "ready");
    expect(current.createdAtMs).toBe(6_000);
    controller.acknowledgeAction(current.id, "acknowledged");
    controller.tick();
    const readyAnnouncement = action(controller, "announce");
    expect(readyAnnouncement.message).toBe("READY!");
    controller.acknowledgeAction(readyAnnouncement.id, "acknowledged");
    controller.tick();
    const cheatOff = action(controller, "cheat-off");
    controller.acknowledgeAction(cheatOff.id, "acknowledged");
    controller.tick();
    const go = action(controller, "go");
    controller.acknowledgeAction(go.id, "acknowledged");

    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ goAtMs: 6_000 }] });
    expect(controller.snapshot().actions.map((item) => item.kind)).toEqual([
      "bulletin", "ready", "ready", "ready", "announce", "cheat-off", "go"
    ]);
  });

  it("registers observed players dynamically without treating the known set as a closed roster", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      participants: [],
      dynamicParticipants: true,
      stages: [{ id: "s1", map: "1", mode: "sr", timeLimitMs: 20_000, minimumScoringPlace: 3 }]
    }), clock);
    controller.observeAuthoritativeGo("s1");
    expect(controller.registerParticipant("Silent_Snow")).toBe(true);
    expect(controller.recordResult({ stageId: "s1", playerId: "Silent_Snow", status: "finished", sourceId: "finish" })).toBe("accepted");
    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ intakeOpen: true, results: [{ playerId: "Silent_Snow" }] }] });
  });

  it("runs the normal flow and closes tail intake atomically at the next actual Ready", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);

    for (const playerId of ["p1", "p2", "p3"]) {
      expect(controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `finish-${playerId}` })).toBe("accepted");
    }
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", plannedReadyAtMs: 9_000 });
    expect(controller.snapshot().actions.at(-1)?.message).toBe("下一轮 Ready 计划在 3 秒后执行");

    clock.set(8_999);
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "finish-p4" })).toBe("accepted");
    clock.set(9_000);
    controller.tick();

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.currentStageId).toBe("s2");
    expect(snapshot.attempts[0]).toMatchObject({ stageId: "s1", intakeOpen: false, intakeClosedAtMs: 9_000 });
    expect(snapshot.attempts[0]?.results.some((result) => result.playerId === "p5")).toBe(false);
    expect(controller.recordResult({ stageId: "s1", playerId: "p5", status: "finished", sourceId: "finish-p5" })).toBe("intake-closed");
    expect(controller.snapshot().rejectedResults.at(-1)?.reason).toBe("intake-closed");
  });

  it("keeps result intake and the deadline active while automation is paused", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.pause();

    expect(controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "paused-finish" })).toBe("accepted");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "running", automationEnabled: false });

    clock.set(30_000);
    controller.tick();
    const snapshot = controller.snapshot();
    expect(snapshot.automationEnabled).toBe(false);
    expect(snapshot.phase).toBe("tail-intake");
    expect(snapshot.attempts[0]?.results).toHaveLength(5);
    expect(snapshot.attempts[0]?.results.filter((result) => result.reason === "time-limit")).toHaveLength(4);

    controller.enable();
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", automationEnabled: true });
  });

  it("lets a referee resolve each unconfirmed action before resuming the previous phase", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    const ready = action(controller, "ready");
    controller.acknowledgeAction(ready.id, "failed");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "ready", automationEnabled: false });

    controller.resolveUnconfirmedAction(ready.id, "referee-confirmed");
    controller.enable();
    expect(controller.snapshot()).toMatchObject({ phase: "ready", automationEnabled: true });
    expect(controller.snapshot().actions.find((candidate) => candidate.id === ready.id)?.status).toBe("referee-confirmed");
  });

  it("keeps the old intake open while the next Ready is blocked, but never beyond its deadline", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 5_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 5_000, minimumScoringPlace: 3 }
      ]
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    for (const playerId of ["p1", "p2", "p3"]) controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: playerId });
    controller.observeConnection("p5", false);

    clock.set(9_000);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", attempts: [{ intakeOpen: true }] });
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "p4" })).toBe("accepted");

    clock.set(12_000);
    controller.tick();
    expect(controller.snapshot().attempts[0]).toMatchObject({ intakeOpen: false, intakeClosedAtMs: 12_000 });
    expect(controller.snapshot().attempts[0]?.results).toContainEqual(expect.objectContaining({ playerId: "p5", status: "dnf", reason: "time-limit" }));
  });

  it("restarts the full Ready flow only after every reconnected player is stable for 15 seconds", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.drainActions();

    controller.observeConnection("p1", false);
    controller.observeConnection("p1", true);
    clock.advance(14_000);
    controller.observeConnection("p1", false);
    controller.observeConnection("p1", true);
    clock.advance(14_999);
    controller.tick();
    expect(controller.snapshot().phase).toBe("pre-start-wait");
    clock.advance(1);
    controller.tick();
    expect(controller.snapshot().phase).toBe("ready");
    expect(controller.drainActions().filter((item) => item.kind === "ready")).toHaveLength(1);
  });

  it("does not create an attempt when the Go command is uncertain", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    for (let index = 0; index < 2; index += 1) {
      clock.advance(3_000); controller.tick(); controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    }
    controller.tick(); controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
    controller.tick(); controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.tick();
    const go = action(controller, "go");
    controller.acknowledgeAction(go.id, "uncertain");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", automationEnabled: false, attempts: [] });
    expect(controller.snapshot().blockers.map((blocker) => blocker.code)).toContain("COMMAND_UNCONFIRMED");
  });

  it("binds restart confirmation to current state and sends force-next-restart exactly once", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "p1-finish" });
    controller.observeCrash("p2", "Fatal Error in protection window");
    const incident = controller.snapshot().incidents[0] as NonNullable<ReturnType<typeof controller.snapshot>["incidents"][number]>;
    const stale = controller.issueRestartConfirmation(incident.id);
    controller.observeCheat("p3", true, "p3-cheat");
    expect(() => controller.confirmRestart({ incidentId: incident.id, impactHash: stale.impactHash, token: stale.token, reason: "群体确认重赛" })).toThrow("STALE_CONFIRMATION_TOKEN");

    controller.observeCheat("p3", false);
    const confirmation = controller.issueRestartConfirmation(incident.id);
    controller.confirmRestart({ incidentId: incident.id, impactHash: confirmation.impactHash, token: confirmation.token, reason: "保护窗口崩溃" });
    controller.drainActions();
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    for (let index = 0; index < 2; index += 1) {
      clock.advance(3_000); controller.tick(); controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    }
    controller.tick(); controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
    controller.tick(); controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.tick();
    const force = action(controller, "force-next-restart");
    controller.acknowledgeAction(force.id, "acknowledged");
    controller.tick();
    const go = action(controller, "go");
    controller.acknowledgeAction(go.id, "acknowledged");
    controller.tick();

    const snapshot = controller.snapshot();
    expect(snapshot.actions.filter((item) => item.kind === "force-next-restart")).toHaveLength(1);
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts[0]).toMatchObject({ attemptNumber: 1, voided: true });
    expect(snapshot.attempts[1]).toMatchObject({ attemptNumber: 2, voided: false });
  });

  it("excludes an unfinished player's in-race cheat without changing completed players", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.observeCheat("p1", true, "cheat-p1");
    expect(controller.recordResult({ stageId: "s1", playerId: "p2", status: "finished", sourceId: "finish-p2" })).toBe("accepted");
    controller.observeCheat("p2", true, "cheat-p2-after-finish");

    const results = controller.snapshot().attempts[0]?.results ?? [];
    expect(results).toContainEqual(expect.objectContaining({ playerId: "p1", status: "excluded", reason: "cheat-enabled" }));
    expect(results.filter((result) => result.playerId === "p2")).toEqual([expect.objectContaining({ status: "finished" })]);
    expect(controller.snapshot().incidents.filter((item) => item.type === "cheat-violation")).toHaveLength(1);
  });

  it("suggests restart for a protected crash or configured group disconnect, not a lone normal disconnect", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({ policy: { announcementLeadMs: 0, readyBufferMs: 1_000, groupDisconnectThreshold: 2 } }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    clock.advance(16_000);
    controller.observeConnection("p1", false);
    expect(controller.snapshot().incidents).toHaveLength(0);
    controller.observeConnection("p2", false);
    expect(controller.snapshot().incidents).toContainEqual(expect.objectContaining({ type: "group-disconnect", recommendedRestart: true }));
  });

  it("blocks overdue actions after a detected sleep or clock discontinuity", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    clock.advance(60_000);
    controller.observeTimingDiscontinuity("event loop suspended for 60 seconds");
    controller.tick();
    expect(controller.snapshot()).toMatchObject({ phase: "paused", automationEnabled: false, attempts: [] });
    expect(controller.snapshot().actions.filter((item) => item.kind === "go")).toHaveLength(0);
    expect(controller.snapshot().incidents).toContainEqual(expect.objectContaining({ type: "timing-discontinuity" }));
  });
});
