import type { AutomationAction, CompetitionController } from "@ballance/core";
import type {
  CommandAction,
  CommandCancellationPreview,
  CommandQueue,
  CommandRecord
} from "./command-queue.js";

export interface CommandQueuePort {
  enqueue(action: CommandAction, idempotencyKey: string, onWriteStart?: (record: CommandRecord) => void): Promise<CommandRecord>;
  cancelWhere?(predicate: (record: Readonly<CommandRecord>) => boolean): readonly CommandRecord[];
  previewCancelWhere?(predicate: (record: Readonly<CommandRecord>) => boolean): readonly CommandCancellationPreview[];
  applyCancellationPreview?(previews: readonly CommandCancellationPreview[], notify?: boolean): readonly CommandRecord[];
}

export interface PreparedCommandSupersession {
  actionKeys: readonly string[];
  previews: readonly CommandCancellationPreview[];
}

const toCommand = (action: AutomationAction): CommandAction => {
  switch (action.kind) {
    case "bulletin":
    case "notice":
    case "announce": return { type: "notification", channel: action.kind, text: action.message ?? "比赛流程通知" };
    case "ready": return { type: "ready", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
    case "cheat-off": return { type: "cheat-off" };
    case "go": return { type: "go", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
  }
};

export class WorkAutomationRuntime {
  private readonly supersededActionKeys = new Set<string>();

  public constructor(private readonly controller: CompetitionController, private readonly commands: CommandQueuePort | CommandQueue) {}

  public supersedeActions(idempotencyKeys: readonly string[]): readonly CommandRecord[] {
    for (const idempotencyKey of idempotencyKeys) this.supersededActionKeys.add(idempotencyKey);
    const keys = new Set(idempotencyKeys);
    const records = this.commands.cancelWhere?.((record) => keys.has(record.idempotencyKey)) ?? [];
    for (const record of records) this.reconcileSupersededAction(record.idempotencyKey, record);
    return records;
  }

  public prepareSupersedeActions(idempotencyKeys: readonly string[]): PreparedCommandSupersession {
    if (!this.commands.previewCancelWhere || !this.commands.applyCancellationPreview) {
      throw new Error("COMMAND_QUEUE_CANCELLATION_PREVIEW_UNSUPPORTED");
    }
    const actionKeys = [...new Set(idempotencyKeys)];
    const keys = new Set(actionKeys);
    return {
      actionKeys,
      previews: this.commands.previewCancelWhere((record) => keys.has(record.idempotencyKey))
    };
  }

  /**
   * Project the durable controller outcome without settling any live queue task.
   * A surrounding SQLite transaction can persist this state and still restore
   * the controller checkpoint if the transaction rolls back.
   */
  public projectPreparedSupersession(prepared: PreparedCommandSupersession): void {
    for (const preview of prepared.previews) {
      if (preview.record.status === "uncertain" || preview.record.status === "failed") {
        this.reconcileSupersededAction(preview.record.idempotencyKey, preview.record);
      }
    }
  }

  public commitPreparedSupersession(prepared: PreparedCommandSupersession): readonly CommandRecord[] {
    if (!this.commands.applyCancellationPreview) {
      throw new Error("COMMAND_QUEUE_CANCELLATION_PREVIEW_UNSUPPORTED");
    }
    // applyCancellationPreview validates the entire selection before mutating
    // any task. Only after that succeeds do future dispatches treat the keys as
    // permanently superseded.
    const records = this.commands.applyCancellationPreview(prepared.previews, false);
    for (const idempotencyKey of prepared.actionKeys) this.supersededActionKeys.add(idempotencyKey);
    for (const record of records) this.reconcileSupersededAction(record.idempotencyKey, record);
    return records;
  }

  public async dispatch(): Promise<readonly CommandRecord[]> {
    const records: CommandRecord[] = [];
    for (const action of this.controller.drainDispatchableActions()) {
      if (this.supersededActionKeys.has(action.idempotencyKey)) {
        this.reconcileSupersededAction(action.idempotencyKey);
        continue;
      }
      const record = await this.commands.enqueue(toCommand(action), action.idempotencyKey);
      records.push(record);
      if (this.supersededActionKeys.has(action.idempotencyKey)) {
        this.reconcileSupersededAction(action.idempotencyKey, record);
        continue;
      }
      const notification = action.kind === "bulletin" || action.kind === "notice" || action.kind === "announce";
      this.controller.acknowledgeAction(
        action.id,
        record.status === "acknowledged" || notification && record.status === "timed_out"
          ? "acknowledged"
          : record.status === "cancelled"
            ? "cancelled"
          : record.status === "uncertain" || record.status === "timed_out"
            ? "uncertain"
            : "failed"
      );
    }
    return records;
  }

  private reconcileSupersededAction(idempotencyKey: string, record?: CommandRecord): void {
    const action = this.controller.snapshot().actions.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (!action) return;
    if (action.isolated) {
      if (record?.status === "uncertain" || record?.status === "failed") {
        this.controller.reconcileIsolatedActionOutcome(action.id, record.status);
      }
      return;
    }
    this.controller.acknowledgeAction(action.id, "cancelled");
  }
}

export class TestAutomationRuntime {
  public constructor(private readonly controller: CompetitionController) {}

  public dispatch(deferGo = false): readonly AutomationAction[] {
    const actions = this.controller.drainDispatchableActions();
    for (const action of actions) {
      if (!deferGo || action.kind !== "go") this.controller.acknowledgeAction(action.id, "acknowledged");
    }
    return actions;
  }
}
