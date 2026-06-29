import { describe, expect, it } from "vitest";
import { UnassignedEventQueue } from "./unassigned-events.js";

describe("UnassignedEventQueue", () => {
  it("keeps the source event immutable while appending an explicit assignment audit", () => {
    const queue = new UnassignedEventQueue();
    const source = { player: "Alpha", score: 100 };
    const event = queue.add({ sourceId: "raw-1", reason: "unknown-identity", payload: source });
    source.score = 999;
    const resolution = queue.assign(event.id, { attemptId: "attempt-1", stageId: "stage-1", actor: "referee", reason: "核对连接历史" });

    expect(queue.snapshot().events[0]).toMatchObject({ sourceId: "raw-1", status: "assigned", payload: { score: 100 } });
    expect(resolution).toMatchObject({ action: "assign", attemptId: "attempt-1", actor: "referee" });
    expect(() => queue.dismiss(event.id, { actor: "referee", reason: "second decision" })).toThrow("UNASSIGNED_EVENT_ALREADY_RESOLVED");
  });

  it("requires a reason and deduplicates by stable source ID", () => {
    const queue = new UnassignedEventQueue();
    const event = queue.add({ sourceId: "raw-2", reason: "closed-window", payload: { result: "finish" } });
    expect(() => queue.dismiss(event.id, { actor: "referee", reason: "" })).toThrow("RESOLUTION_REASON_REQUIRED");
    expect(() => queue.add({ sourceId: "raw-2", reason: "practice", payload: {} })).toThrow("UNASSIGNED_SOURCE_DUPLICATE");
    expect(queue.dismiss(event.id, { actor: "referee", reason: "确认属于截止后记录" })).toMatchObject({ action: "dismiss" });
  });
});
