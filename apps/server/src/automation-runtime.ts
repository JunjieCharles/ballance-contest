import type { AutomationAction, CompetitionController } from "@ballance/core";
import type { CommandAction, CommandQueue, CommandRecord } from "./command-queue.js";

export interface CommandQueuePort {
  enqueue(action: CommandAction, idempotencyKey: string): Promise<CommandRecord>;
}

const toCommand = (action: AutomationAction): CommandAction => {
  switch (action.kind) {
    case "bulletin":
    case "notice":
    case "announce": return { type: "notification", channel: action.kind, text: action.message ?? "比赛流程通知" };
    case "ready": return { type: "ready", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
    case "cheat-off": return { type: "cheat-off" };
    case "go": return { type: "go", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
    case "force-next-restart": return { type: "force-next-restart" };
  }
};

export class WorkAutomationRuntime {
  public constructor(private readonly controller: CompetitionController, private readonly commands: CommandQueuePort | CommandQueue) {}

  public async dispatch(): Promise<readonly CommandRecord[]> {
    const records: CommandRecord[] = [];
    for (const action of this.controller.drainActions()) {
      const record = await this.commands.enqueue(toCommand(action), action.idempotencyKey);
      records.push(record);
      const notification = action.kind === "bulletin" || action.kind === "notice" || action.kind === "announce";
      this.controller.acknowledgeAction(
        action.id,
        record.status === "acknowledged" || notification && record.status === "timed_out"
          ? "acknowledged"
          : record.status === "uncertain" || record.status === "timed_out"
            ? "uncertain"
            : "failed"
      );
    }
    return records;
  }
}

export class TestAutomationRuntime {
  public constructor(private readonly controller: CompetitionController) {}

  public dispatch(deferGo = false): readonly AutomationAction[] {
    const actions = this.controller.drainActions();
    for (const action of actions) {
      if (!deferGo || action.kind !== "go") this.controller.acknowledgeAction(action.id, "acknowledged");
    }
    return actions;
  }
}
