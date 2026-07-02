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

  it("runs the normal flow and closes tail intake atomically at the next actual Ready", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);

    for (const playerId of ["p1", "p2", "p3"]) {
      expect(controller.recordResult({ stageId: "s1", playerId, status: "finished", sourceId: `finish-${playerId}` })).toBe("accepted");
    }
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", plannedReadyAtMs: 33_000, plannedReadyStageId: "s2" });
    expect(controller.snapshot().actions.at(-1)?.message).toBe("第二关 将在 08:00 发令");
    controller.manualReady();
    const tailManualReady = action(controller, "ready");
    expect(tailManualReady).toMatchObject({ stageId: "s2", manual: true });
    expect(controller.snapshot()).toMatchObject({ phase: "tail-intake", currentStageId: "s1", plannedReadyAtMs: 33_000 });
    controller.acknowledgeAction(tailManualReady.id, "acknowledged");

    clock.set(32_999);
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "finish-p4" })).toBe("accepted");
    clock.set(33_000);
    controller.tick();

    const snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.currentStageId).toBe("s2");
    expect(snapshot.attempts[0]).toMatchObject({ stageId: "s1", intakeOpen: false, intakeClosedAtMs: 33_000 });
    expect(snapshot.attempts[0]?.results.some((result) => result.playerId === "p5")).toBe(false);
    expect(controller.recordResult({ stageId: "s1", playerId: "p5", status: "finished", sourceId: "finish-p5" })).toBe("intake-closed");
    expect(controller.snapshot().rejectedResults.at(-1)?.reason).toBe("intake-closed");
  });

  it("keeps the original deadline when ending a stage early and replans only the next Ready", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    const deadlineAtMs = controller.snapshot().attempts[0]?.deadlineAtMs;
    controller.endStage("referee-ended-stage");
    const snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({ phase: "tail-intake", plannedReadyAtMs: 33_000, plannedReadyStageId: "s2" });
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

  it("keeps the old intake open while a critical command blocks the next Ready, but never beyond its deadline", () => {
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
    expect(controller.snapshot()).toMatchObject({ phase: "paused", pausedFromPhase: "tail-intake", attempts: [{ intakeOpen: true }] });
    expect(controller.recordResult({ stageId: "s1", playerId: "p4", status: "finished", sourceId: "p4" })).toBe("accepted");

    clock.set(80_000);
    controller.tick();
    expect(controller.snapshot().attempts[0]).toMatchObject({ intakeOpen: false, intakeClosedAtMs: 80_000 });
    expect(controller.snapshot().attempts[0]?.results).toContainEqual(expect.objectContaining({ playerId: "p5", status: "dnf", reason: "time-limit" }));
  });

  it("uses pre-Go protection once, keeps the full two-minute delay, and emits exact newline suffixes", () => {
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
      plannedReadyAtMs: 120_000,
      startProtectionUsedStageIds: ["s1"],
      attempts: []
    });
    expect(snapshot.actions.find((candidate) => candidate.kind === "ready")?.status).toBe("cancelled");
    const correction = controller.drainActions();
    expect(correction.find((candidate) => candidate.kind === "notice")?.message)
      .toBe("第一关：玩家 p1 在起跑敏感期掉线，发令流程已中止，第一条 Ready 改至 08:02。");
    expect(correction.find((candidate) => candidate.kind === "bulletin")?.message)
      .toBe("第一关 将在 08:02 发令\n由于玩家 p1 起跑保护期掉线，发令时间延迟\n本关起跑保护已被使用，后续不再延时。");
    for (const item of correction) controller.acknowledgeAction(item.id, "acknowledged");

    clock.set(10_000);
    controller.observeConnection("p1", true);
    clock.set(60_000);
    controller.tick();
    const notice = action(controller, "notice");
    expect(notice.message).toBe("第一关 即将在 1 分钟后发令，请提前做好重启游戏等准备，避免影响发令流程。\n本关起跑保护已被使用，后续不再延时。");
    expect(notice.message).toContain("\n");
    expect(notice.message).not.toContain("\\n");
    controller.acknowledgeAction(notice.id, "acknowledged");

    clock.set(119_999);
    controller.tick();
    expect(controller.snapshot()).toMatchObject({ phase: "restart-preparing", plannedReadyAtMs: 120_000 });
    clock.set(120_000);
    controller.tick();
    expect(controller.snapshot().phase).toBe("ready");
    controller.observeConnection("p2", false);
    snapshot = controller.snapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.startProtectionUsedStageIds).toEqual(["s1"]);
    expect(snapshot.incidents.filter((incident) => incident.type === "protected-crash")).toHaveLength(1);
  });

  it("voids a protected post-Go attempt and uses a map-scoped manual re-launch", () => {
    const clock = new FakeClock();
    const controller = new CompetitionController(configuration(), clock);
    connectAll(controller);
    enterRunning(controller, clock);
    controller.recordResult({ stageId: "s1", playerId: "p1", status: "finished", sourceId: "finish-before-crash" });

    clock.advance(5_000);
    controller.observeCrash("p2", "p2 was kicked by the server (fatal error) and crashed subsequently.");
    controller.observeConnection("p2", false);
    let snapshot = controller.snapshot();
    expect(snapshot).toMatchObject({
      phase: "restart-preparing",
      plannedReadyAtMs: 155_000,
      attempts: [{ attemptNumber: 1, intakeOpen: false, voided: true }]
    });
    expect(snapshot.attempts[0]?.results).toEqual([expect.objectContaining({ sourceId: "finish-before-crash" })]);
    expect(snapshot.attempts[0]?.results.some((result) => result.status === "dnf")).toBe(false);
    const correction = controller.drainActions();
    expect(correction.find((candidate) => candidate.kind === "announce")?.message)
      .toBe("第一关：玩家 p2 在起跑保护期掉线，当前尝试及成绩已作废，第一条 Ready 改至 08:02。");
    const correctionBulletins = correction.filter((candidate) => candidate.kind === "bulletin");
    expect(correctionBulletins.find((candidate) => candidate.message?.includes("起跑保护"))?.message)
      .toBe("第一关 将在 08:02 发令\n由于玩家 p2 起跑保护期掉线，本关重赛\n本关起跑保护已被使用，后续不再延时。");
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
    const stale = controller.issueStageRestartConfirmation(attempt.id);
    controller.observeCheat("p3", true, "p3-cheat");
    expect(() => controller.confirmStageRestart({ attemptId: attempt.id, impactHash: stale.impactHash, token: stale.token, reason: "群体确认重赛" })).toThrow("STALE_CONFIRMATION_TOKEN");

    controller.observeCheat("p3", false);
    const confirmation = controller.issueStageRestartConfirmation(attempt.id);
    controller.confirmStageRestart({ attemptId: attempt.id, impactHash: confirmation.impactHash, token: confirmation.token, reason: "裁判重赛本关" });
    for (const item of controller.drainActions()) controller.acknowledgeAction(item.id, "acknowledged");
    expect(() => controller.requestManualGo()).toThrow("MANUAL_GO_CHEAT_OFF_REQUIRED");
    clock.advance(60_000);
    controller.tick();
    controller.acknowledgeAction(action(controller, "ready").id, "acknowledged");
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
});
