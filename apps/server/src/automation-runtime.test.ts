import { describe, expect, it } from "vitest";
import { CompetitionController } from "@ballance/core";
import { TestAutomationRuntime, WorkAutomationRuntime, type CommandQueuePort } from "./automation-runtime.js";
import type { CommandAction, CommandRecord } from "./command-queue.js";

class Clock {
  public value = 0;
  public now(): number { return this.value; }
}

const makeController = (): { controller: CompetitionController; clock: Clock } => {
  const clock = new Clock();
  const controller = new CompetitionController({
    competitionId: "c1", participants: ["p1"], confirmationSecret: "secret",
    stages: [{ id: "s1", map: "1", mode: "sr", timeLimitMs: 10_000, minimumScoringPlace: 1 }],
    policy: { announcementLeadMs: 0, readyBufferMs: 0 }
  }, clock);
  controller.observeConnection("p1", true);
  return { controller, clock };
};

const makeTwoStageController = (): { controller: CompetitionController; clock: Clock } => {
  const clock = new Clock();
  const controller = new CompetitionController({
    competitionId: "c2",
    participants: ["p1"],
    confirmationSecret: "secret",
    stages: [
      { id: "s1", map: "1", mode: "sr", timeLimitMs: 10_000, minimumScoringPlace: 1 },
      { id: "s2", map: "2", mode: "sr", timeLimitMs: 10_000, minimumScoringPlace: 1 }
    ],
    policy: { announcementLeadMs: 0, readyBufferMs: 0, intermissionMs: 60_000 }
  }, clock);
  controller.observeConnection("p1", true);
  return { controller, clock };
};

describe("automation runtimes", () => {
  it("maps work actions to the serial command port and only advances after acknowledgements", async () => {
    const { controller, clock } = makeController();
    const sent: CommandAction[] = [];
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => {
        sent.push(command);
        return {
          id: idempotencyKey, idempotencyKey, action: command, command: command.type,
          status: "acknowledged", createdAt: "2026-06-29T00:00:00Z", updatedAt: "2026-06-29T00:00:00Z"
        } satisfies CommandRecord;
      }
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    await runtime.dispatch();
    controller.tick();
    await runtime.dispatch();
    clock.value = 5_000;
    controller.tick();
    await runtime.dispatch();
    clock.value = 10_000; controller.tick(); await runtime.dispatch();
    clock.value = 15_000; controller.tick(); await runtime.dispatch();
    clock.value = 20_000; controller.tick(); await runtime.dispatch();
    clock.value = 30_000; controller.tick(); await runtime.dispatch();

    expect(sent.map((item) => item.type)).toEqual(["notification", "notification", "ready", "ready", "ready", "notification", "cheat-off", "go"]);
    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ attemptNumber: 1 }] });
  });

  it("acknowledges test actions in memory without a process or command transport", () => {
    const { controller, clock } = makeController();
    const runtime = new TestAutomationRuntime(controller);
    controller.enable(0);
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["bulletin"]);
    controller.tick();
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["notice", "ready"]);
    clock.value = 5_000; controller.tick();
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["ready"]);
    clock.value = 10_000; controller.tick();
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["ready"]);
    clock.value = 15_000; controller.tick(); expect(runtime.dispatch().map((item) => item.kind)).toEqual(["announce"]);
    clock.value = 20_000; controller.tick(); expect(runtime.dispatch().map((item) => item.kind)).toEqual(["cheat-off"]);
    clock.value = 30_000; controller.tick(); expect(runtime.dispatch().map((item) => item.kind)).toEqual(["go"]);
    expect(controller.snapshot().attempts).toHaveLength(1);
  });

  it("keeps ordinary notification timeouts non-blocking", async () => {
    const { controller } = makeController();
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => ({
        id: idempotencyKey, idempotencyKey, action: command, command: command.type,
        status: command.type === "notification" ? "timed_out" : "acknowledged",
        createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z"
      })
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    await runtime.dispatch();
    controller.tick();
    await runtime.dispatch();
    expect(controller.snapshot()).toMatchObject({ phase: "ready", automationEnabled: true, blockers: [] });
  });

  it("turns a Ready timeout into a recoverable uncertain blocker", async () => {
    const { controller } = makeController();
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => ({
        id: idempotencyKey, idempotencyKey, action: command, command: command.type,
        status: command.type === "ready" ? "timed_out" : "acknowledged",
        createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z"
      })
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    await runtime.dispatch();
    controller.tick();
    await runtime.dispatch();
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      automationEnabled: false,
      blockers: [expect.objectContaining({ code: "COMMAND_UNCONFIRMED", severity: "critical" })]
    });
  });

  it("propagates a generation-cancelled queued action without creating an unconfirmed-command blocker", async () => {
    const { controller } = makeController();
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => ({
        id: idempotencyKey, idempotencyKey, action: command, command: command.type,
        status: command.type === "ready" ? "cancelled" : "acknowledged",
        createdAt: "2026-07-22T00:00:00Z", updatedAt: "2026-07-22T00:00:00Z"
      })
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    await runtime.dispatch();
    controller.tick();
    await runtime.dispatch();

    expect(controller.snapshot()).toMatchObject({ phase: "paused", automationEnabled: false });
    expect(controller.snapshot().actions).toContainEqual(expect.objectContaining({ kind: "ready", status: "cancelled" }));
    expect(controller.snapshot().blockers.some((blocker) => blocker.code === "COMMAND_UNCONFIRMED")).toBe(false);
  });

  it("does not enqueue an action drained from a superseded referee cycle", async () => {
    const { controller } = makeController();
    const enqueued: string[] = [];
    let releaseFirst!: (record: CommandRecord) => void;
    const firstResult = new Promise<CommandRecord>((resolve) => { releaseFirst = resolve; });
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => {
        enqueued.push(idempotencyKey);
        if (enqueued.length === 1) return firstResult;
        return {
          id: idempotencyKey,
          idempotencyKey,
          action: command,
          command: command.type,
          status: "acknowledged",
          createdAt: "2026-07-28T00:00:00Z",
          updatedAt: "2026-07-28T00:00:00Z"
        };
      }
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    const [first, second] = controller.snapshot().actions;
    expect(first).toBeDefined();
    // Add a second pending action to model a command already drained behind the
    // first one. It remains in the controller action list even while dispatch awaits.
    controller.tick();
    const pendingKeys = controller.snapshot().actions.map((action) => action.idempotencyKey);
    const dispatching = runtime.dispatch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.supersedeActions(pendingKeys);
    releaseFirst({
      id: first!.id,
      idempotencyKey: first!.idempotencyKey,
      action: { type: "notification", channel: "bulletin", text: first!.message ?? "notice" },
      command: "bulletin",
      status: "uncertain",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T00:00:00Z"
    });

    await dispatching;
    expect(enqueued).toEqual([first!.idempotencyKey]);
    expect(controller.snapshot().actions.filter((action) => pendingKeys.includes(action.idempotencyKey)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "cancelled" })]));
    expect(second).toBeUndefined();
  });

  it("preserves an isolated uncertain action when its old-cycle write had already started", () => {
    const { controller } = makeController();
    controller.enable(0);
    controller.tick();
    const oldAction = controller.snapshot().actions.find((action) => action.kind === "ready");
    if (!oldAction) throw new Error("missing old action");
    controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    const uncertainRecord: CommandRecord = {
      id: "old-write",
      idempotencyKey: oldAction.idempotencyKey,
      action: { type: "ready", map: "1", mode: "sr" },
      command: "countdown 1 sr 4",
      status: "uncertain",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T00:00:00Z"
    };
    const runtime = new WorkAutomationRuntime(controller, {
      enqueue: async () => uncertainRecord,
      cancelWhere: () => [uncertainRecord]
    });

    runtime.supersedeActions([oldAction.idempotencyKey]);

    expect(controller.snapshot().actions).toContainEqual(expect.objectContaining({
      id: oldAction.id,
      status: "uncertain",
      isolated: true
    }));
    expect(controller.snapshot().blockers.some((blocker) => blocker.code === "COMMAND_UNCONFIRMED")).toBe(false);
  });

  it("projects a write-started supersession before commit without settling the live queue twice", () => {
    const { controller } = makeController();
    controller.enable(0);
    controller.drainActions();
    controller.tick();
    const oldReady = controller.snapshot().actions.find((action) => action.kind === "ready");
    if (!oldReady) throw new Error("missing old Ready");
    controller.forceResetCurrentStage({ expectedCurrentStageId: "s1" });
    const uncertainRecord: CommandRecord = {
      id: "write-started-ready",
      idempotencyKey: oldReady.idempotencyKey,
      action: { type: "ready", map: "1", mode: "sr" },
      command: "countdown 1 sr 4",
      status: "uncertain",
      createdAt: "2026-07-29T00:00:00Z",
      updatedAt: "2026-07-29T00:00:01Z"
    };
    let queueApplied = false;
    const runtime = new WorkAutomationRuntime(controller, {
      enqueue: async () => uncertainRecord,
      previewCancelWhere: () => [{
        record: uncertainRecord,
        expected: {
          id: uncertainRecord.id,
          idempotencyKey: uncertainRecord.idempotencyKey,
          status: "sent" as const,
          updatedAt: uncertainRecord.createdAt,
          taskState: "write-started" as const
        }
      }],
      applyCancellationPreview: () => {
        queueApplied = true;
        return [uncertainRecord];
      }
    });

    const prepared = runtime.prepareSupersedeActions([oldReady.idempotencyKey]);
    runtime.projectPreparedSupersession(prepared);
    const projected = controller.snapshot();
    expect(queueApplied).toBe(false);
    expect(projected.actions).toContainEqual(expect.objectContaining({
      id: oldReady.id,
      status: "uncertain",
      isolated: true
    }));

    runtime.commitPreparedSupersession(prepared);
    expect(queueApplied).toBe(true);
    expect(controller.snapshot().stateVersion).toBe(projected.stateVersion);
  });

  it("keeps automatic next-stage announcements undelivered while a referee-marked attempt is paused", async () => {
    const { controller } = makeTwoStageController();
    const sent: CommandAction[] = [];
    const port: CommandQueuePort = {
      enqueue: async (command, idempotencyKey) => {
        sent.push(command);
        return {
          id: idempotencyKey,
          idempotencyKey,
          action: command,
          command: command.type,
          status: "acknowledged",
          createdAt: "2026-07-28T00:00:00Z",
          updatedAt: "2026-07-28T00:00:00Z"
        };
      }
    };
    const runtime = new WorkAutomationRuntime(controller, port);
    controller.enable(0);
    await runtime.dispatch();
    controller.tick();
    await runtime.dispatch();
    controller.markCurrentStageStarted({ expectedCurrentStageId: "s1" });
    controller.pause();
    expect(controller.recordResult({
      stageId: "s1",
      playerId: "p1",
      status: "finished",
      sourceId: "marked-threshold",
      receivedAtMs: 0
    })).toBe("accepted");
    const sentBeforePausedDispatch = sent.length;

    await runtime.dispatch();

    expect(sent).toHaveLength(sentBeforePausedDispatch);
    expect(controller.snapshot()).toMatchObject({
      phase: "paused",
      automationEnabled: false,
      plannedReadyStageId: "s2"
    });
    expect(controller.snapshot().actions).toContainEqual(expect.objectContaining({
      kind: "bulletin",
      stageId: "s2",
      status: "pending",
      undelivered: true
    }));
    controller.enable();
    await runtime.dispatch();
    expect(sent.length).toBeGreaterThan(sentBeforePausedDispatch);
  });
});
