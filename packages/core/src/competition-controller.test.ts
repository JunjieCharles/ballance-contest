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
    { id: "s1", map: "1", displayName: "第一关", mode: "sr", timeLimitMs: 20_000, minimumScoringPlace: 3 },
    { id: "s2", map: "2", displayName: "第二关", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
  ],
  policy: { announcementLeadMs: 0, readyBufferMs: 1_000, reconnectStableMs: 15_000, intermissionMs: 3_000, protectionWindowMs: 10_000 },
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
  for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
  controller.tick();
  for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
  for (let index = 0; index < 2; index += 1) {
    clock.advance(5_000);
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
  }
  clock.advance(5_000);
  controller.tick();
  controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
  clock.advance(5_000);
  controller.tick();
  controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
  clock.advance(10_000);
  controller.tick();
  const go = action(controller, "go");
  controller.acknowledgeAction(go.id, "acknowledged");
};

describe("CompetitionController", () => {
  it("restores a persisted running attempt without redelivering historical commands", () => {
    const clock = new FakeClock();
    const original = new CompetitionController(configuration({ wallClockOriginMs: 1_000_000 }), clock);
    connectAll(original);
    enterRunning(original, clock);
    original.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "persisted-finish" });
    const beforeDrain = original.snapshot();
    const legacyPersisted = {
      ...beforeDrain,
      actions: beforeDrain.actions.map((action) => {
        const historicalAction = { ...action };
        delete historicalAction.undelivered;
        return historicalAction;
      })
    };
    original.drainActions();
    const persisted = original.snapshot();

    const restored = new CompetitionController(configuration({ wallClockOriginMs: 1_000_000, initialSnapshot: persisted }), clock);
    expect(restored.snapshot()).toMatchObject({
      phase: "running",
      currentStageId: "s1",
      attempts: [{ attemptNumber: 1, intakeOpen: true, results: [expect.objectContaining({ sourceId: "persisted-finish" })] }]
    });
    expect(restored.drainActions()).toEqual([]);
    expect(restored.recordResult({ stageId: "s1", playerId: "p2", status: "finished", sourceId: "finish-after-restore" })).toBe("accepted");
    restored.pause();
    restored.observeCheat("p3", true, "cheat-during-recovery-block");
    expect(restored.snapshot().attempts[0]?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "finish-after-restore" }),
      expect.objectContaining({ playerId: "p3", status: "excluded", reason: "cheat-enabled" })
    ]));

    const restoredLegacy = new CompetitionController(configuration({
      wallClockOriginMs: 1_000_000,
      initialSnapshot: legacyPersisted
    }), clock);
    expect(restoredLegacy.drainActions()).toEqual([]);
  });

  it("sends Notice, Ready at 0/5/10, READY at 15, cheat-off at 20 and Go no earlier than 30 seconds", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    const bulletin = action(controller, "bulletin");
    expect(bulletin.message).toBe("第一关 将在 08:00 发令");
    controller.acknowledgeAction(bulletin.id, "acknowledged");

    controller.tick();
    const initialActions = controller.drainActions();
    const notice = initialActions.find((item) => item.kind === "notice");
    let current = initialActions.find((item) => item.kind === "ready");
    expect(notice?.message).toBe("第一关 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。");
    if (!notice || !current) throw new Error("Missing initial Notice or Ready");
    controller.acknowledgeAction(notice.id, "acknowledged");
    expect(current.createdAtMs).toBe(0);
    controller.acknowledgeAction(current.id, "acknowledged");
    clock.advance(5_000);
    controller.tick();
    current = action(controller, "ready");
    expect(current.createdAtMs).toBe(5_000);
    controller.acknowledgeAction(current.id, "acknowledged");
    clock.advance(5_000);
    controller.tick();
    current = action(controller, "ready");
    expect(current.createdAtMs).toBe(10_000);
    controller.acknowledgeAction(current.id, "acknowledged");
    clock.advance(4_999);
    controller.tick();
    expect(controller.drainActions()).toHaveLength(0);
    clock.advance(1);
    controller.tick();
    const readyAnnouncement = action(controller, "announce");
    expect(readyAnnouncement.createdAtMs).toBe(15_000);
    expect(readyAnnouncement.message).toBe("READY!");
    controller.acknowledgeAction(readyAnnouncement.id, "acknowledged");
    clock.advance(5_000);
    controller.tick();
    const cheatOff = action(controller, "cheat-off");
    expect(cheatOff.createdAtMs).toBe(20_000);
    controller.acknowledgeAction(cheatOff.id, "acknowledged");
    clock.advance(9_999);
    controller.tick();
    expect(controller.drainActions()).toHaveLength(0);
    clock.advance(1);
    controller.tick();
    const go = action(controller, "go");
    expect(go.createdAtMs).toBe(30_000);
    controller.acknowledgeAction(go.id, "acknowledged");

    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ goAtMs: 30_000, deadlineAtMs: 50_000 }] });
    expect(controller.snapshot().actions.map((item) => item.kind)).toEqual([
      "bulletin", "notice", "ready", "ready", "ready", "announce", "cheat-off", "go", "bulletin"
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

  it("shifts every scheduled boundary after a delayed acknowledgement while preserving minimum gaps", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    controller.tick();
    for (const item of controller.drainActions()) {
      if (item.kind === "notice") controller.acknowledgeAction(item.id, "acknowledged");
      else if (item.kind === "ready") {
        clock.set(2_000);
        controller.acknowledgeAction(item.id, "acknowledged");
      }
    }
    clock.set(6_999); controller.tick();
    expect(controller.drainActions()).toHaveLength(0);
    clock.set(7_000); controller.tick();
    let scheduled = action(controller, "ready");
    clock.set(9_000); controller.acknowledgeAction(scheduled.id, "acknowledged");
    clock.set(14_000); controller.tick();
    scheduled = action(controller, "ready");
    controller.acknowledgeAction(scheduled.id, "acknowledged");
    clock.set(19_000); controller.tick();
    scheduled = action(controller, "announce");
    clock.set(22_000); controller.acknowledgeAction(scheduled.id, "acknowledged");
    clock.set(27_000); controller.tick();
    scheduled = action(controller, "cheat-off");
    clock.set(30_000); controller.acknowledgeAction(scheduled.id, "acknowledged");
    clock.set(39_999); controller.tick();
    expect(controller.drainActions()).toHaveLength(0);
    clock.set(40_000); controller.tick();
    expect(action(controller, "go").createdAtMs).toBe(40_000);
  });

  it("keeps manual Ready and cheat-off outside the plan, then starts timing only on confirmed manual Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(120_000);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    const before = controller.snapshot();

    controller.manualReady();
    const manualReady = action(controller, "ready");
    expect(manualReady.manual).toBe(true);
    expect(controller.snapshot()).toMatchObject({ phase: before.phase, plannedReadyAtMs: before.plannedReadyAtMs });
    controller.acknowledgeAction(manualReady.id, "acknowledged");

    controller.manualCheatOff();
    const manualCheatOff = action(controller, "cheat-off");
    expect(manualCheatOff.manual).toBe(true);
    expect(controller.snapshot()).toMatchObject({ phase: before.phase, plannedReadyAtMs: before.plannedReadyAtMs });
    controller.acknowledgeAction(manualCheatOff.id, "acknowledged");
    controller.requestManualGo();
    const manualGo = action(controller, "go");
    expect(manualGo.manual).toBe(true);
    expect(controller.snapshot()).toMatchObject({ phase: "countdown", attempts: [] });
    clock.set(3_000);
    controller.acknowledgeAction(manualGo.id, "acknowledged");
    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ goAtMs: 3_000, deadlineAtMs: 23_000 }] });
  });

  it("sends a cheat warning notice after cheat-off and does not block manual Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    // Cheat-on before any cheat-off: no notice
    controller.observeCheat("p1", true, "practice-cheat");
    expect(controller.snapshot().actions.some((action) => action.kind === "notice")).toBe(false);
    // Acknowledge a cheat-off to establish baseline
    controller.manualCheatOff();
    const cheatOff = action(controller, "cheat-off");
    controller.acknowledgeAction(cheatOff.id, "acknowledged");
    // Re-enable cheat after cheat-off: notice fires
    controller.observeCheat("p1", false);
    controller.observeCheat("p1", true, "practice-cheat-again");
    const notice = controller.snapshot().actions.find((a) => a.kind === "notice" && a.status === "pending");
    expect(notice).toBeTruthy();
    controller.observeCheat("p1", false);
    controller.observeCheat("p1", true, "practice-cheat-third-time");
    expect(controller.snapshot().actions.filter((item) => item.kind === "notice")).toHaveLength(1);
    // Acknowledge the notice so it does not block manual Go
    if (notice) controller.acknowledgeAction(notice.id, "acknowledged");
    expect(() => controller.requestManualGo()).not.toThrow();
  });

  it("excludes cheat enabled in the same clock tick after cheat-off", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.manualCheatOff();
    controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.observeCheat("p1", true, "same-tick-cheat");
    controller.acknowledgeAction(action(controller, "notice").id, "acknowledged");
    controller.requestManualGo();
    controller.acknowledgeAction(action(controller, "go").id, "acknowledged");
    expect(controller.snapshot().attempts[0]?.results).toContainEqual(
      expect.objectContaining({ playerId: "p1", status: "excluded", reason: "cheat-enabled" })
    );
  });

  it("formats Bulletin as UTC+8 HH:mm across midnight and republishes it after every schedule change", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({ wallClockOriginMs: Date.UTC(2026, 6, 1, 15, 59) }), clock);
    connectAll(controller);
    controller.enable(60_000);
    expect(action(controller, "bulletin").message).toBe("第一关 将在 00:00 发令");
    controller.reschedule(120_000);
    expect(action(controller, "bulletin").message).toBe("第一关 将在 00:01 发令");
    controller.delayReady(60_000);
    expect(action(controller, "bulletin").message).toBe("第一关 将在 00:02 发令");
  });

  it("does not repeat the planned Bulletin when Ready starts after its timer boundary", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(1_000);
    controller.acknowledgeAction(action(controller, "bulletin").id, "acknowledged");
    clock.set(1_001);
    controller.tick();
    expect(controller.snapshot().actions.filter((item) => item.kind === "bulletin")).toHaveLength(1);
  });

  it("enters the next stage and closes old intake at the T-60 preparation boundary", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", displayName: "第一关", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", displayName: "第二关", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);

    for (const playerId of ["p1", "p2", "p3"]) {
      expect(controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `finish-${playerId}` })).toBe("accepted");
    }
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", plannedReadyAtMs: 150_000, plannedReadyStageId: "s2" });
    expect(controller.snapshot().actions.at(-1)?.message).toBe("第二关 将在 08:02 发令");
    controller.manualReady();
    const tailManualReady = action(controller, "ready");
    expect(tailManualReady).toMatchObject({ stageId: "s2", manual: true });
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", currentStageId: "s1", plannedReadyAtMs: 150_000 });
    controller.acknowledgeAction(tailManualReady.id, "acknowledged");

    clock.set(89_999);
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "finish-p4" })).toBe("accepted");
    clock.set(90_000);
    controller.tick();

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("preparing");
    expect(snapshot.currentStageId).toBe("s2");
    expect(snapshot).toMatchObject({ plannedReadyAtMs: 150_000, plannedReadyStageId: "s2" });
    expect(snapshot.attempts[0]).toMatchObject({ stageId: "s1", intakeOpen: false, intakeClosedAtMs: 90_000 });
    expect(snapshot.attempts[0]?.results.some((result) => result.playerId === "p5")).toBe(false);
    expect(controller.recordResult({ stageId: "s1", playerId: "p5", status: "finished", sourceId: "finish-p5" })).toBe("intake-closed");
    expect(controller.snapshot().rejectedResults.at(-1)?.reason).toBe("intake-closed");
    controller.observeAuthoritativeGo("s1");
    expect(controller.snapshot()).toMatchObject({
      currentStageId: "s2",
      attempts: [{ stageId: "s1", attemptNumber: 1, intakeOpen: false }]
    });
    expect(controller.snapshot().attempts).toHaveLength(1);
    clock.set(149_999);
    controller.tick();
    expect(controller.snapshot().phase).toBe("preparing");
    clock.set(150_000);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({ phase: "ready", currentStageId: "s2" });
  });

  it("re-evaluates the next-stage threshold when live scoring changes the last scoring place", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    for (const playerId of ["p1", "p2"]) {
      expect(controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `before-live-scoring-${playerId}` })).toBe("accepted");
    }
    expect(controller.snapshot().phase).toBe("running");
    controller.updateMinimumScoringPlaces({ s1: 2, s2: 2 });
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", plannedReadyStageId: "s2" });
  });

  it("attaches finish evidence to an exclusion only while that exact attempt is still open", () => {
    const makeController = (): { controller: CompetitionController; clock: FakeClock } => {
      const clock = new FakeClock();
      const controller = new CompetitionController(configuration({
        stages: [
          { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
          { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
        ],
        policy: {
          announcementLeadMs: 0,
          readyBufferMs: 1_000,
          reconnectStableMs: 15_000,
          intermissionMs: 120_000,
          protectionWindowMs: 10_000
        }
      }), clock);
      connectAll(controller);
      enterRunning(controller, clock);
      return { controller, clock };
    };

    const current = makeController();
    current.controller.observeViolation("p1", "warning-p1", "warning");
    expect(current.controller.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "finish-p1"
    })).toBe("accepted");
    expect(current.controller.snapshot().attempts[0]?.results[0]).toMatchObject({
      playerId: "p1",
      status: "excluded",
      sourceId: "warning-p1",
      finishSourceId: "finish-p1"
    });

    const stale = makeController();
    stale.controller.observeViolation("p1", "warning-late", "warning");
    for (const playerId of ["p2", "p3", "p4"]) {
      stale.controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `finish-${playerId}` });
    }
    stale.clock.set(90_000);
    stale.controller.synchronizeStageBoundary();
    expect(stale.controller.snapshot()).toMatchObject({ currentStageId: "s2", phase: "preparing" });

    expect(stale.controller.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "late-finish-p1",
      receivedAtMs: 90_000
    })).toBe("intake-closed");
    const excluded = stale.controller.snapshot().attempts[0]?.results.find((result) => result.playerId === "p1");
    expect(excluded).toMatchObject({ status: "excluded", sourceId: "warning-late" });
    expect(excluded?.finishSourceId).toBeUndefined();
    expect(stale.controller.snapshot().rejectedResults.at(-1)).toMatchObject({
      sourceId: "late-finish-p1",
      reason: "intake-closed"
    });
  });

  it("allows one explicitly bound same-receipt finish to complete an exclusion across an immediate boundary", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      participants: ["p1"],
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 1 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 1 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 30_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller, ["p1"]);
    enterRunning(controller, clock);
    const attempt = controller.snapshot().attempts[0];
    if (!attempt) throw new Error("missing attempt");

    controller.observeViolation("p1", "warning-p1", "warning");
    expect(controller.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      attempts: [{ id: attempt.id, intakeOpen: false, intakeClosedAtMs: 30_000 }]
    });
    expect(controller.recordExcludedFinishEvidence({
      attemptId: attempt.id,
      stageId: "s1",
      playerId: "p1",
      exclusionSourceId: "warning-p1",
      finishSourceId: "finish-p1",
      receivedAtMs: 30_000
    })).toBe("accepted");
    expect(controller.snapshot().attempts[0]?.results[0]).toMatchObject({
      status: "excluded",
      sourceId: "warning-p1",
      finishSourceId: "finish-p1"
    });
  });

  it("keeps snapshots read-only and settles a missed T-60 boundary through the explicit runtime entrypoint", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    for (const playerId of ["p1", "p2", "p3"]) {
      controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: playerId });
    }

    clock.set(120_000);
    const before = controller.snapshot();
    expect(before).toMatchObject({ currentStageId: "s1", phase: "tail-intake", stateVersion: before.stateVersion });
    expect(controller.snapshot()).toEqual(before);

    controller.synchronizeStageBoundary();
    expect(controller.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      attempts: [{ stageId: "s1", intakeOpen: false, intakeClosedAtMs: 90_000 }]
    });
  });

  it("settles deadline and T-60 in chronological order after a large clock jump", () => {
    const makeController = (timeLimitMs: number): { controller: CompetitionController; clock: FakeClock } => {
      const clock = new FakeClock();
      const controller = new CompetitionController(configuration({
        stages: [
          { id: "s1", map: "1", mode: "sr", timeLimitMs, minimumScoringPlace: 3 },
          { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
        ],
        policy: {
          announcementLeadMs: 0,
          readyBufferMs: 1_000,
          reconnectStableMs: 15_000,
          intermissionMs: 120_000,
          protectionWindowMs: 10_000
        }
      }), clock);
      connectAll(controller);
      enterRunning(controller, clock);
      for (const playerId of ["p1", "p2", "p3"]) {
        controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: playerId });
      }
      return { controller, clock };
    };

    const boundaryFirst = makeController(200_000);
    boundaryFirst.clock.set(250_000);
    boundaryFirst.controller.synchronizeStageBoundary();
    expect(boundaryFirst.controller.snapshot().attempts[0]).toMatchObject({
      intakeOpen: false,
      intakeClosedAtMs: 90_000
    });
    expect(boundaryFirst.controller.snapshot().actions.some((item) =>
      item.kind === "announce" && item.message?.includes("比赛时间已到"))).toBe(false);

    const deadlineFirst = makeController(50_000);
    deadlineFirst.clock.set(100_000);
    deadlineFirst.controller.synchronizeStageBoundary();
    expect(deadlineFirst.controller.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      attempts: [{ intakeOpen: false, intakeClosedAtMs: 80_000 }]
    });
    expect(deadlineFirst.controller.snapshot().actions).toContainEqual(
      expect.objectContaining({ kind: "announce", stageId: "s1", message: expect.stringContaining("比赛时间已到") })
    );
  });

  it("preserves a next-stage cheat-off confirmation and reopened-cheat evidence through T-60 and Ready", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    for (const playerId of ["p1", "p2", "p3"]) {
      controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: playerId });
    }
    for (const pending of controller.drainActions()) controller.acknowledgeAction(pending.id, "acknowledged");
    controller.manualCheatOff();
    controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.observeCheat("p4", true, "p4-reopened-cheat");

    clock.set(90_000);
    controller.tick();
    for (const pending of controller.drainActions()) controller.acknowledgeAction(pending.id, "acknowledged");
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "s2",
      lastCheatOffAcknowledgedAtMs: 30_000
    });

    clock.set(150_000);
    controller.tick();
    for (const pending of controller.drainActions()) controller.acknowledgeAction(pending.id, "acknowledged");
    expect(controller.snapshot()).toMatchObject({
      phase: "ready",
      currentStageId: "s2",
      lastCheatOffAcknowledgedAtMs: 30_000
    });
    controller.requestManualGo();
    controller.acknowledgeAction(action(controller, "go").id, "acknowledged");
    expect(controller.snapshot()).toMatchObject({
      phase: "running",
      attempts: [
        expect.objectContaining({ stageId: "s1", intakeOpen: false }),
        expect.objectContaining({
          stageId: "s2",
          intakeOpen: true,
          results: [expect.objectContaining({ playerId: "p4", status: "excluded", reason: "cheat-enabled" })]
        })
      ]
    });
  });

  it("keeps the original deadline when ending a stage early and replans only the next Ready", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    const deadlineAtMs = controller.snapshot().attempts[0]?.deadlineAtMs;
    controller.endStage("referee-ended-stage");
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({ phase: "preparing", currentStageId: "s2", plannedReadyAtMs: 33_000, plannedReadyStageId: "s2" });
    expect(snapshot.attempts[0]).toMatchObject({ intakeOpen: false, deadlineAtMs });
    expect(snapshot.actions.at(-1)).toMatchObject({ kind: "bulletin", stageId: "s2", message: "第二关 将在 08:00 发令" });
  });

  it("keeps result intake and the deadline active while automation is paused", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.pause();

    expect(controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "paused-finish" })).toBe("accepted");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "running", automationEnabled: false });

    clock.set(50_000);
    controller.tick();
    const snapshot = controller.snapshot();
    expect(snapshot.automationEnabled).toBe(false);
    expect(snapshot).toMatchObject({ phase: "paused", pausedFromPhase: "preparing", currentStageId: "s2" });
    expect(snapshot.attempts[0]?.results).toHaveLength(1);
    expect(snapshot.attempts[0]?.results.some((result) => result.reason === "time-limit")).toBe(false);

    controller.enable();
    expect(controller.snapshot()).toMatchObject({ phase: "preparing", automationEnabled: true, currentStageId: "s2" });
  });

  it("blocks old-stage launch actions while paused from running but still allows ending the open stage", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.pause();

    expect(() => controller.startReadyFlow()).toThrow("READY_FLOW_NOT_AVAILABLE");
    expect(() => controller.manualReady()).toThrow("READY_NOT_AVAILABLE");
    expect(() => controller.requestManualGo()).toThrow("MANUAL_GO_NOT_AVAILABLE");

    controller.endStage("referee-ended-stage");
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "preparing",
      currentStageId: "s2",
      plannedReadyStageId: "s2",
      attempts: [{ stageId: "s1", intakeOpen: false }]
    });
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

  it("closes old intake immediately when a plan starts inside T-60 even while a critical command keeps automation paused", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 50_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 5_000, minimumScoringPlace: 3 }
      ]
    }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    for (const playerId of ["p1", "p2", "p3"]) controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: playerId });
    controller.manualReady();
    controller.acknowledgeAction(action(controller, "ready").id, "uncertain");
    clock.set(46_000);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "preparing",
      currentStageId: "s2",
      attempts: [{ intakeOpen: false, intakeClosedAtMs: 30_000 }]
    });
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "p4" })).toBe("intake-closed");

    clock.set(80_000);
    controller.tick();
    expect(controller.snapshot().attempts[0]).toMatchObject({ intakeOpen: false, intakeClosedAtMs: 30_000 });
    expect(controller.snapshot().attempts[0]?.results.some((result) => result.playerId === "p5")).toBe(false);
  });

  it("uses pre-Go protection once and separates the protection announcement from the T-60 notice", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    controller.tick();
    const initial = controller.drainActions();
    for (const item of initial.filter((candidate) => candidate.kind !== "ready")) controller.acknowledgeAction(item.id, "acknowledged");

    controller.observeConnection("p1", false);
    let snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      phase: "restart-preparing",
      plannedReadyAtMs: 60_000,
      startProtectionUsedStageIds: ["s1"],
      attempts: []
    });
    expect(snapshot.actions.find((candidate) => candidate.kind === "ready")?.status).toBe("cancelled");
    const correction = controller.drainActions();
    expect(correction.map((candidate) => candidate.kind)).toEqual(["bulletin", "announce", "notice"]);
    expect(correction.find((candidate) => candidate.kind === "announce")?.message)
      .toBe("由于玩家 p1 起跑保护期掉线，发令流程已中止，本关从 T-60 重新准备。");
    expect(correction.find((candidate) => candidate.kind === "notice")?.message)
      .toBe("第一关 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。\n本关起跑保护已被使用，后续不再延时。");
    expect(correction.find((candidate) => candidate.kind === "bulletin")?.message)
      .toBe("第一关 将在 08:01 发令\n由于玩家 p1 起跑保护期掉线，发令流程已中止，本关从 T-60 重新准备。\n本关起跑保护已被使用，后续不再延时。");
    for (const item of correction) controller.acknowledgeAction(item.id, "acknowledged");

    clock.set(10_000);
    controller.observeConnection("p1", true);
    controller.tick();
    expect(controller.drainActions()).toEqual([]);

    clock.set(59_999);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({ phase: "restart-preparing", plannedReadyAtMs: 60_000 });
    expect(controller.drainActions()).toEqual([]);
    clock.set(60_000);
    controller.tick();
    expect(controller.snapshot().phase).toBe("ready");
    controller.observeConnection("p2", false);
    snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.startProtectionUsedStageIds).toEqual(["s1"]);
    expect(snapshot.incidents.filter((incident) => incident.type === "protected-crash")).toHaveLength(1);
  });

  it.each([9_999, 10_000, 10_001, 15_000])("limits default post-Go protection to ten seconds (elapsed %i ms)", (elapsedMs) => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({ policy: {} }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    const goAtMs = controller.snapshot().attempts[0]!.goAtMs;
    clock.advance(elapsedMs);
    controller.observeConnection("p1", false);
    const snapshot = controller.snapshot();
    const protectedCrash = elapsedMs <= 10_000;
    expect(snapshot.phase).toBe(protectedCrash ? "restart-preparing" : "running");
    expect(snapshot.startProtectionUsedStageIds).toEqual(protectedCrash ? ["s1"] : []);
    expect(snapshot.attempts[0]).toMatchObject({ voided: protectedCrash, intakeOpen: !protectedCrash });
    expect(snapshot.plannedReadyAtMs).toBe(protectedCrash ? goAtMs + elapsedMs + 60_000 : undefined);
  });

  it("voids a protected post-Go attempt and uses a map-scoped manual re-launch", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "finish-before-crash" });
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");

    clock.advance(5_000);
    controller.observeCrash("p2", "p2 was kicked by the server (fatal error) and crashed subsequently.");
    controller.observeConnection("p2", false);
    let snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      phase: "restart-preparing",
      plannedReadyAtMs: 95_000,
      attempts: [{ attemptNumber: 1, intakeOpen: false, voided: true }]
    });
    expect(snapshot.attempts[0]?.results).toEqual([expect.objectContaining({ sourceId: "finish-before-crash" })]);
    expect(snapshot.attempts[0]?.results.some((result) => result.status === "dnf")).toBe(false);
    const correction = controller.drainActions();
    expect(correction.map((candidate) => candidate.kind)).toEqual(["bulletin", "announce", "notice"]);
    expect(correction.find((candidate) => candidate.kind === "announce")?.message)
      .toBe("由于玩家 p2 起跑保护期掉线，当前尝试及成绩已作废，本关从 T-60 重新准备。");
    expect(correction.find((candidate) => candidate.kind === "notice")?.message)
      .toBe("第一关 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。\n本关起跑保护已被使用，后续不再延时。");
    const correctionBulletins = correction.filter((candidate) => candidate.kind === "bulletin");
    expect(correctionBulletins.find((candidate) => candidate.message?.includes("起跑保护"))?.message)
      .toBe("第一关 将在 08:01 发令\n由于玩家 p2 起跑保护期掉线，当前尝试及成绩已作废，本关从 T-60 重新准备。\n本关起跑保护已被使用，后续不再延时。");
    for (const item of correction) controller.acknowledgeAction(item.id, "acknowledged");

    controller.manualCheatOff();
    const cheatOff = action(controller, "cheat-off");
    controller.acknowledgeAction(cheatOff.id, "acknowledged");
    controller.requestManualGo();
    const go = action(controller, "go");
    expect(go.manual).toBe(true);
    controller.acknowledgeAction(go.id, "acknowledged");
    expect(controller.snapshot().attempts).toMatchObject([
      { attemptNumber: 1, voided: true },
      { attemptNumber: 2, voided: false, goAtMs: 35_000 }
    ]);

    clock.advance(1_000);
    controller.observeConnection("p3", false);
    snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("running");
    expect(snapshot.attempts[1]).toMatchObject({ intakeOpen: true, voided: false });
    expect(snapshot.incidents.filter((incident) => incident.type === "protected-crash")).toHaveLength(1);
  });

  it("does not consume start protection when a terminal player disconnects or crashes", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "dnf", sourceId: "dnf-before-disconnect" });
    controller.observeViolation("p2", "exclude-before-disconnect", "warning");

    clock.advance(5_000);
    controller.observeConnection("p1", false);
    controller.observeCrash("p2", "fatal error after exclusion");
    controller.observeConnection("p2", false);

    expect(controller.snapshot()).toMatchObject({
      phase: "running",
      startProtectionUsedStageIds: [],
      incidents: []
    });
  });

  it("can disable protection by policy and manually toggle the current stage usage", () => {
    const disabledClock = new FakeClock();
    const disabled = new CompetitionController(configuration({ policy: { announcementLeadMs: 0, readyBufferMs: 1_000, reconnectStableMs: 15_000, intermissionMs: 3_000, protectionWindowMs: 10_000, startProtectionEnabled: false } }), disabledClock);
    connectAll(disabled);
    enterRunning(disabled, disabledClock);
    disabledClock.advance(5_000);
    disabled.observeConnection("p1", false);
    expect(disabled.snapshot()).toMatchObject({ phase: "running", startProtectionEnabled: false, startProtectionUsedStageIds: [], incidents: [] });
    expect(() => disabled.setStartProtectionUsed(true)).toThrowError("START_PROTECTION_DISABLED");

    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.setStartProtectionUsed(true);
    expect(controller.snapshot().startProtectionUsedStageIds).toEqual(["s1"]);
    controller.setStartProtectionUsed(false);
    expect(controller.snapshot().startProtectionUsedStageIds).toEqual([]);
  });

  it("does not create an attempt when the Go command is uncertain", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    controller.tick();
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    for (let index = 0; index < 2; index += 1) {
      clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    }
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    clock.advance(10_000);
    controller.tick();
    const go = action(controller, "go");
    controller.acknowledgeAction(go.id, "uncertain");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", automationEnabled: false, attempts: [] });
    expect(controller.snapshot().blockers.map((blocker) => blocker.code)).toContain("COMMAND_UNCONFIRMED");
  });

  it("restarts the current stage without requiring an incident or enabling a global Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "p1-finish" });
    const attempt = controller.snapshot().attempts[0];
    if (!attempt) throw new Error("missing attempt");
    const stale = controller.issueStageRestartConfirmation("s1");
    controller.observeCheat("p3", true, "p3-cheat");
    expect(() => controller.confirmStageRestart({ stageId: "s1", impactHash: stale.impactHash, token: stale.token, reason: "群体确认重赛" })).toThrow("STALE_CONFIRMATION_TOKEN");

    controller.observeCheat("p3", false);
    const confirmation = controller.issueStageRestartConfirmation("s1");
    controller.confirmStageRestart({ stageId: "s1", impactHash: confirmation.impactHash, token: confirmation.token, reason: "裁判重赛本关" });
    expect(controller.snapshot()).toMatchObject({ phase: "ready", restartPending: true, blockers: [] });
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    expect(() => controller.requestManualGo()).toThrow("MANUAL_GO_CHEAT_OFF_REQUIRED");
    for (let index = 0; index < 2; index += 1) {
      clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    }
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    clock.advance(10_000);
    controller.tick();
    const go = action(controller, "go");
    controller.acknowledgeAction(go.id, "acknowledged");
    controller.tick();

    const snapshot = controller.snapshot();
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts[0]).toMatchObject({ attemptNumber: 1, voided: true });
    expect(snapshot.attempts[1]).toMatchObject({ attemptNumber: 2, voided: false });
    const newAttempt = snapshot.attempts[1];
    if (!newAttempt) throw new Error("missing restarted attempt");
    expect(controller.recordResult({
      stageId: "s1",
      playerId: "p2",
      status: "finished",
      sourceId: "late-old-cycle-finish",
      receivedAtMs: newAttempt.goAtMs - 1
    })).toBe("pre-go");
  });

  it("restores runtime state and restart-token consumption from a checkpoint", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    const checkpoint = controller.checkpoint();
    const confirmation = controller.issueStageRestartConfirmation("s1");

    controller.confirmStageRestart({
      stageId: "s1",
      impactHash: confirmation.impactHash,
      token: confirmation.token,
      reason: "transaction attempt"
    });
    expect(controller.snapshot().phase).toBe("ready");

    controller.restore(checkpoint);
    expect(controller.snapshot()).toEqual(checkpoint.snapshot);
    expect(() => controller.confirmStageRestart({
      stageId: "s1",
      impactHash: confirmation.impactHash,
      token: confirmation.token,
      reason: "transaction retry"
    })).not.toThrow();
  });

  it("force-resets a pre-Go stage despite command, permission and incident blockers", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    controller.tick();
    const cycleActions = controller.drainActions();
    const ready = cycleActions.find((item) => item.kind === "ready");
    if (!ready) throw new Error("missing ready action");
    controller.acknowledgeAction(ready.id, "uncertain");
    controller.observePermissionDenied("permission denied");
    controller.observeServerDisconnect("connection dropped");
    expect(controller.snapshot().blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "PERMISSION_DENIED", "COMMAND_UNCONFIRMED", "INCIDENT_OPEN"
    ]));

    const confirmation = controller.issueStageRestartConfirmation("s1");
    controller.confirmStageRestart({ stageId: "s1", impactHash: confirmation.impactHash, token: confirmation.token, reason: "强制恢复现场" });

    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({ phase: "ready", automationEnabled: true, restartPending: true, attempts: [], blockers: [] });
    expect(snapshot.incidents.every((incident) => incident.status === "resolved")).toBe(true);
    expect(snapshot.actions.find((item) => item.id === ready.id)).toMatchObject({ status: "uncertain", isolated: true });
    expect(controller.drainActions()).toEqual([expect.objectContaining({ kind: "ready", stageId: "s1", status: "pending" })]);
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
    expect(controller.snapshot().incidents.filter((item) => item.type === "cheat-violation")).toHaveLength(0);
  });

  it("warns but does not exclude a player who turns cheat on during countdown before Go is acknowledged", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    controller.tick();
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    for (let index = 0; index < 2; index += 1) {
      clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    }
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "announce").id, "acknowledged");
    clock.advance(5_000); controller.tick(); controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    clock.advance(10_000); controller.tick();
    // Go is queued, phase is countdown
    expect(controller.snapshot().phase).toBe("countdown");
    // cheat ON during countdown should warn but not exclude (no attempt yet)
    controller.observeCheat("p1", true, "countdown-cheat");
    expect(controller.snapshot().attempts).toHaveLength(0);
    // Go acknowledged → running
    controller.acknowledgeAction(action(controller, "go").id, "acknowledged");
    expect(controller.snapshot().phase).toBe("running");
    expect(controller.snapshot().attempts[0]?.results).toContainEqual(
      expect.objectContaining({ playerId: "p1", status: "excluded", reason: "cheat-enabled" })
    );
  });

  it("does not block or suggest restart for disconnects outside the start-protection window", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({ policy: { announcementLeadMs: 0, readyBufferMs: 1_000, groupDisconnectThreshold: 2 } }), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    clock.advance(16_000);
    controller.observeConnection("p1", false);
    expect(controller.snapshot().incidents).toHaveLength(0);
    controller.observeConnection("p2", false);
    expect(controller.snapshot()).toMatchObject({ phase: "running", automationEnabled: true, blockers: [] });
  });

  it("excludes a player who reconnects with cheat during the race", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    clock.advance(16_000);
    controller.observeConnection("p1", false);
    controller.observeConnection("p1", true);
    controller.observeCheat("p1", true, "reconnected-with-cheat");
    expect(controller.snapshot().attempts[0]?.results).toContainEqual(
      expect.objectContaining({ playerId: "p1", status: "excluded", sourceId: "reconnected-with-cheat", reason: "cheat-enabled" })
    );
  });

  it("keeps one attempt and one launch Bulletin when countdown lines arrive around duplicate Go evidence", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.observeAuthoritativeGo("s1");
    controller.observeCountdown(2);
    controller.observeCountdown(1);
    controller.observeAuthoritativeGo("s1");
    expect(controller.snapshot().attempts).toHaveLength(1);
    expect(controller.snapshot().phase).toBe("running");
    expect(controller.snapshot().actions.filter((item) => item.kind === "bulletin" && item.message === "第一关已起跑")).toHaveLength(1);
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
    expect(controller.snapshot().incidents).toContainEqual(expect.objectContaining({ type: "timing-discontinuity", status: "open" }));
    controller.enable();
    expect(controller.snapshot()).toMatchObject({ phase: "ready", automationEnabled: true });
    expect(controller.snapshot().incidents).toContainEqual(expect.objectContaining({ type: "timing-discontinuity", status: "resolved" }));
  });

  it("recovers a server disconnect explicitly and keeps results and deadlines active while blocked", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    const deadlineAtMs = controller.snapshot().attempts[0]?.deadlineAtMs as number;
    controller.observeServerDisconnect("Disconnected from server.");
    controller.observeServerDisconnect("duplicate disconnect evidence");
    expect(controller.snapshot()).toMatchObject({ phase: "incident", pausedFromPhase: "running", automationEnabled: false });
    expect(controller.snapshot().blockers).toContainEqual(expect.objectContaining({ code: "INCIDENT_OPEN", severity: "critical" }));
    expect(controller.snapshot().incidents.filter((item) => item.type === "server-disconnect")).toHaveLength(1);
    expect(controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "during-blocker" })).toBe("accepted");

    controller.observeServerConnected();
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "running", automationEnabled: false, blockers: [] });
    controller.enable();
    expect(controller.snapshot()).toMatchObject({ phase: "running", automationEnabled: true });

    controller.observeServerDisconnect("second disconnect");
    clock.set(deadlineAtMs);
    controller.tick();
    expect(controller.snapshot().attempts[0]).toMatchObject({ intakeOpen: false });
  });

  it("keeps the current phase before a missed Ready boundary and enters Ready after it", () => {
    const beforeClock = new FakeClock();
    const before = new CompetitionController(configuration(), beforeClock);
    connectAll(before);
    before.enable(10_000);
    before.acknowledgeAction(action(before, "bulletin").id, "acknowledged");
    beforeClock.set(5_000);
    before.observeTimingDiscontinuity("pause before boundary");
    beforeClock.set(9_000);
    before.enable();
    before.tick();
    expect(before.snapshot().phase).toBe("preparing");

    const afterClock = new FakeClock();
    const after = new CompetitionController(configuration(), afterClock);
    connectAll(after);
    after.enable(10_000);
    after.acknowledgeAction(action(after, "bulletin").id, "acknowledged");
    afterClock.set(5_000);
    after.observeTimingDiscontinuity("pause across boundary");
    afterClock.set(11_000);
    after.enable();
    after.tick();
    expect(after.snapshot().phase).toBe("ready");
  });

  it("pauses and exposes an explicit blocker after a permission failure", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.observePermissionDenied("Action failed: you don't have the permission to run this action.");
    expect(controller.snapshot()).toMatchObject({ phase: "paused", automationEnabled: false });
    expect(controller.snapshot().blockers).toContainEqual(expect.objectContaining({ code: "PERMISSION_DENIED", severity: "critical" }));
  });

  it("marks only the current Ready stage as started from the action clock without sending a command", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.acknowledgeAction(action(controller, "bulletin").id, "acknowledged");
    controller.tick();
    const readyCycle = controller.drainActions();
    expect(readyCycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notice", stageId: "s1" }),
      expect.objectContaining({ kind: "ready", stageId: "s1" })
    ]));
    controller.manualCheatOff();
    controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    for (const participantId of ["p1", "p2", "p3", "p4", "p5"]) {
      controller.observeCheat(participantId, true, `pre-mark-cheat:${participantId}`);
    }

    clock.set(4_321);
    const marked = controller.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" });
    expect(marked).toMatchObject({
      stageId: "s1",
      attemptNumber: 1,
      origin: "referee-marked-started",
      goAtMs: 4_321,
      deadlineAtMs: 24_321,
      intakeOpen: true,
      voided: false
    });
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      phase: "paused",
      pausedFromPhase: "running",
      automationEnabled: false,
      nextStagePending: false,
      restartPending: false,
      attempts: [expect.objectContaining({ id: marked.id, origin: "referee-marked-started", results: [] })]
    });
    expect(snapshot.actions.filter((item) => item.kind === "bulletin")).toHaveLength(1);
    expect(snapshot.actions.some((item) => item.kind === "bulletin" && item.message?.includes("已起跑"))).toBe(false);
    expect(readyCycle.every((item) => snapshot.actions.find((candidate) => candidate.id === item.id)?.status === "cancelled")).toBe(true);
    expect(controller.drainActions()).toEqual([]);
    expect(controller.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "before-mark",
      receivedAtMs: 4_320
    })).toBe("pre-go");
    expect(controller.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "at-mark",
      receivedAtMs: 4_321
    })).toBe("accepted");

    const restored = new CompetitionController(configuration({ initialSnapshot: controller.snapshot() }), clock);
    expect(restored.snapshot().attempts[0]).toMatchObject({
      id: marked.id,
      origin: "referee-marked-started",
      goAtMs: 4_321,
      deadlineAtMs: 24_321
    });
  });

  it("accepts a paused-from-Ready mark and keeps its deadline active while paused", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.drainActions();
    controller.pause();
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "ready" });

    clock.set(1_000);
    controller.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" });
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "running",
      attempts: [{ origin: "referee-marked-started", goAtMs: 1_000, deadlineAtMs: 21_000, intakeOpen: true }]
    });
    clock.set(21_000);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "preparing",
      currentStageId: "s2",
      attempts: [{ intakeOpen: false, intakeClosedAtMs: 21_000 }]
    });
  });

  it("rejects marking outside Ready or when a non-void attempt already exists", () => {
    const clock = new FakeClock();
    const preparing = new CompetitionController(configuration(), clock);
    connectAll(preparing);
    preparing.enable(60_000);
    expect(() => preparing.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" })).toThrow("MARK_STAGE_STARTED_NOT_AVAILABLE");

    const ready = new CompetitionController(configuration(), clock);
    connectAll(ready);
    ready.enable(0);
    ready.drainActions();
    ready.tick();
    ready.drainActions();
    ready.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" });
    const markedSnapshot = { ...ready.snapshot() };
    delete markedSnapshot.pausedFromPhase;
    const incompatible = {
      ...markedSnapshot,
      phase: "ready" as const,
      automationEnabled: true
    };
    const restored = new CompetitionController(configuration({ initialSnapshot: incompatible }), clock);
    expect(() => restored.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" })).toThrow("MARK_STAGE_STARTED_ATTEMPT_EXISTS");
  });

  it("force-resets the current stage at T-60, voids scores and isolates old blockers", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "old-score" });
    const oldBulletin = action(controller, "bulletin");
    controller.acknowledgeAction(oldBulletin.id, "failed");
    controller.observePermissionDenied("permission denied");
    controller.observeServerDisconnect("connection dropped");

    clock.set(31_000);
    const result = controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    expect(result).toMatchObject({
      targetStageId: "s1",
      boundaryAtMs: 31_000,
      voidedAttempts: [expect.objectContaining({ attemptNumber: 1, voided: true, intakeOpen: false, results: [expect.objectContaining({ sourceId: "old-score" })] })]
    });
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      phase: "preparing",
      automationEnabled: true,
      currentStageId: "s1",
      plannedReadyStageId: "s1",
      plannedReadyAtMs: 91_000,
      restartPending: true,
      blockers: [],
      attempts: [expect.objectContaining({ voided: true, intakeClosedAtMs: 31_000 })]
    });
    expect(snapshot.actions.find((item) => item.id === oldBulletin.id)).toMatchObject({ status: "failed", isolated: true });
    expect(snapshot.incidents.every((incident) => incident.status === "resolved")).toBe(true);
    expect(controller.drainActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bulletin", stageId: "s1", status: "pending" }),
      expect.objectContaining({ kind: "notice", stageId: "s1", status: "pending" })
    ]));
  });

  it("keeps a later disposition of an isolated old Go from creating a reset-cycle attempt", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.manualCheatOff();
    controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.requestManualGo();
    const oldGo = action(controller, "go");
    controller.acknowledgeAction(oldGo.id, "uncertain");

    controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    expect(controller.snapshot().actions.find((item) => item.id === oldGo.id)).toMatchObject({
      status: "uncertain",
      isolated: true
    });
    controller.resolveUnconfirmedAction(oldGo.id, "referee-confirmed");
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "s1",
      attempts: []
    });
  });

  it("ignores a late old-cycle countdown until the reset cycle has its own pending Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.drainActions();

    controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    controller.observeCountdown(2);
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "s1"
    });
    expect(controller.snapshot().countdownValue).toBeUndefined();

    for (const pending of controller.drainActions()) {
      controller.acknowledgeAction(pending.id, "acknowledged");
    }
    clock.set(60_000);
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
    controller.manualCheatOff();
    controller.acknowledgeAction(action(controller, "cheat-off").id, "acknowledged");
    controller.requestManualGo();
    controller.observeCountdown(3);
    expect(controller.snapshot()).toMatchObject({
      phase: "countdown",
      countdownValue: 3,
      attempts: []
    });
  });

  it("force-advances at the T-60 boundary, preserves old results and rejects late old-cycle Go", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "kept-score" });
    controller.drainActions();
    clock.set(35_000);

    const result = controller.forceAdvanceToNextStage({
      expectedCurrentStageId: "s1",
      expectedTargetStageId: "s2"
    });
    expect(result).toMatchObject({
      previousStageId: "s1",
      targetStageId: "s2",
      boundaryAtMs: 35_000,
      closedAttempt: expect.objectContaining({ stageId: "s1", intakeOpen: false, voided: false })
    });
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      automationEnabled: true,
      currentStageId: "s2",
      plannedReadyStageId: "s2",
      plannedReadyAtMs: 95_000,
      attempts: [expect.objectContaining({
        stageId: "s1",
        intakeOpen: false,
        voided: false,
        intakeClosedAtMs: 35_000,
        results: [expect.objectContaining({ sourceId: "kept-score" })]
      })]
    });
    expect(controller.recordResult({
      stageId: "s1",
      playerId: "p2",
      status: "finished",
      sourceId: "late-old-result"
    })).toBe("intake-closed");
    controller.observeAuthoritativeGo("s1");
    expect(controller.snapshot()).toMatchObject({ currentStageId: "s2", attempts: [{ stageId: "s1" }] });
    expect(controller.snapshot().attempts).toHaveLength(1);

    const restored = new CompetitionController(configuration({ initialSnapshot: controller.snapshot() }), clock);
    expect(restored.snapshot()).toMatchObject({
      currentStageId: "s2",
      plannedReadyAtMs: 95_000,
      attempts: [expect.objectContaining({ stageId: "s1", voided: false, intakeOpen: false })]
    });
  });

  it("force-advances before Go and does not let a late old Go reopen the previous stage", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.drainActions();
    controller.forceAdvanceToNextStage({
      expectedCurrentStageId: "s1",
      expectedTargetStageId: "s2"
    });
    controller.observeAuthoritativeGo("s1");
    expect(controller.snapshot()).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      attempts: []
    });
  });

  it("lets service-owned lifecycle checks decide force recovery from review snapshots", () => {
    const clock = new FakeClock();
    const base = new CompetitionController(configuration(), clock).snapshot();
    const reviewAtFirstStage = new CompetitionController(configuration({
      initialSnapshot: { ...base, phase: "review", currentStageId: "s1" }
    }), clock);
    expect(() => reviewAtFirstStage.forceResetCurrentStage({ expectedCurrentStageId: "s1" })).not.toThrow();

    const anotherReview = new CompetitionController(configuration({
      initialSnapshot: { ...base, phase: "review", currentStageId: "s1" }
    }), clock);
    expect(() => anotherReview.forceAdvanceToNextStage({
      expectedCurrentStageId: "s1",
      expectedTargetStageId: "s2"
    })).not.toThrow();
    expect(anotherReview.snapshot()).toMatchObject({ currentStageId: "s2", phase: "preparing" });
  });

  it("atomically rejects stale recovery targets after settling a due T-60 boundary", () => {
    const makeBoundaryController = (): { controller: CompetitionController; clock: FakeClock } => {
      const clock = new FakeClock();
      const controller = new CompetitionController(configuration({
        stages: [
          { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
          { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
        ],
        policy: {
          announcementLeadMs: 0,
          readyBufferMs: 1_000,
          reconnectStableMs: 15_000,
          intermissionMs: 120_000,
          protectionWindowMs: 10_000
        }
      }), clock);
      connectAll(controller);
      enterRunning(controller, clock);
      for (const playerId of ["p1", "p2", "p3"]) {
        controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `boundary-${playerId}` });
      }
      clock.set(90_000);
      return { controller, clock };
    };

    const operations: Array<(controller: CompetitionController) => unknown> = [
      (controller) => controller.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" }),
      (controller) => controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" }),
      (controller) => controller.forceAdvanceToNextStage({
        expectedCurrentStageId: "s1",
        expectedTargetStageId: "s2"
      })
    ];
    for (const operation of operations) {
      const { controller } = makeBoundaryController();
      expect(() => operation(controller)).toThrow("ACTION_TARGET_CHANGED");
      const snapshot = controller.snapshot();
      expect(snapshot).toMatchObject({
        currentStageId: "s2",
        phase: "preparing",
        plannedReadyStageId: "s2",
        plannedReadyAtMs: 150_000,
        attempts: [expect.objectContaining({ stageId: "s1", intakeOpen: false, voided: false, intakeClosedAtMs: 90_000 })]
      });
      expect(snapshot.actions.filter((item) => item.kind === "bulletin" && item.stageId === "s2")).toHaveLength(1);
    }
  });

  it("validates both sides of force-next before changing the current stage", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    const before = controller.snapshot();
    expect(() => controller.forceAdvanceToNextStage({
      expectedCurrentStageId: "s1",
      expectedTargetStageId: "not-s2"
    })).toThrow("ACTION_TARGET_CHANGED");
    expect(controller.snapshot()).toEqual(before);
  });

  it("reconciles a write-started old action as isolated without disturbing the new cycle", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    const oldReady = controller.snapshot().actions.findLast((item) => item.kind === "ready");
    if (!oldReady) throw new Error("missing old Ready");

    controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    expect(controller.snapshot().actions.find((item) => item.id === oldReady.id)).toMatchObject({
      status: "cancelled",
      isolated: true
    });
    controller.reconcileIsolatedActionOutcome(oldReady.id, "uncertain");
    controller.reconcileIsolatedActionOutcome(oldReady.id, "uncertain");
    expect(controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "s1",
      blockers: [],
      actions: expect.arrayContaining([
        expect.objectContaining({ id: oldReady.id, status: "uncertain", isolated: true })
      ])
    });
    const newBulletin = controller.snapshot().actions.findLast((item) =>
      item.kind === "bulletin" && item.status === "pending");
    if (!newBulletin) throw new Error("missing new Bulletin");
    expect(() => controller.reconcileIsolatedActionOutcome(newBulletin.id, "failed"))
      .toThrow("ISOLATED_ACTION_RECONCILE_NOT_AVAILABLE");
  });

  it("holds automatic actions while a marked attempt is paused, but dispatches manual actions and restores the hold", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      }
    }), clock);
    connectAll(controller);
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    controller.drainActions();
    controller.markCurrentReadyStageStarted({ expectedCurrentStageId: "s1" });
    for (const playerId of ["p1", "p2", "p3"]) {
      controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `marked-${playerId}` });
    }
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      pausedFromPhase: "tail-intake",
      automationEnabled: false,
      plannedReadyStageId: "s2",
      plannedReadyAtMs: 120_000
    });
    const heldBulletin = controller.snapshot().actions.findLast((item) =>
      item.kind === "bulletin" && item.stageId === "s2");
    expect(heldBulletin).toMatchObject({ status: "pending", undelivered: true });
    expect(controller.drainDispatchableActions()).toEqual([]);

    controller.manualCheatOff();
    expect(controller.drainDispatchableActions()).toEqual([
      expect.objectContaining({ kind: "cheat-off", stageId: "s2", manual: true })
    ]);
    expect(controller.snapshot().actions.find((item) => item.id === heldBulletin?.id)).toMatchObject({
      status: "pending",
      undelivered: true
    });

    const restored = new CompetitionController(configuration({
      stages: [
        { id: "s1", map: "1", mode: "sr", timeLimitMs: 200_000, minimumScoringPlace: 3 },
        { id: "s2", map: "2", mode: "hs", timeLimitMs: 20_000, minimumScoringPlace: 3 }
      ],
      policy: {
        announcementLeadMs: 0,
        readyBufferMs: 1_000,
        reconnectStableMs: 15_000,
        intermissionMs: 120_000,
        protectionWindowMs: 10_000
      },
      initialSnapshot: controller.snapshot()
    }), clock);
    expect(restored.drainDispatchableActions()).toEqual([]);
    restored.enable();
    expect(restored.drainDispatchableActions()).toEqual([
      expect.objectContaining({ id: heldBulletin?.id, kind: "bulletin", stageId: "s2" })
    ]);
  });
});
