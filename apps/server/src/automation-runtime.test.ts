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

describe("automation runtimes", () => {
  it("maps work actions to the serial command port and only advances after acknowledgements", async () => {
    const { controller } = makeController();
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
    controller.tick();
    await runtime.dispatch();

    expect(sent.map((item) => item.type)).toEqual(["announcement", "ready", "cheat-off", "go"]);
    expect(controller.snapshot()).toMatchObject({ phase: "running", attempts: [{ attemptNumber: 1 }] });
  });

  it("acknowledges test actions in memory without a process or command transport", () => {
    const { controller } = makeController();
    const runtime = new TestAutomationRuntime(controller);
    controller.enable(0);
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["announcement"]);
    controller.tick();
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["ready", "cheat-off"]);
    controller.tick();
    expect(runtime.dispatch().map((item) => item.kind)).toEqual(["go"]);
    expect(controller.snapshot().attempts).toHaveLength(1);
  });
});
