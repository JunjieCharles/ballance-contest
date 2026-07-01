import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionConfig } from "@ballance/contracts";
import { CompetitionController, type CompetitionEngine } from "@ballance/core";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandTransport } from "./mock-client.js";
import { CompetitionService, seededBehaviorRandom } from "./competition-service.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";

interface WorkRuntimeHarness {
  controller: CompetitionController;
  engine: CompetitionEngine;
}

describe("CompetitionService dynamic participants", () => {
  it("uses a fixed seed for varied but reproducible player behavior", () => {
    const first = seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time");
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time")).toBe(first);
    expect(seededBehaviorRandom(20_260_632, "sr-1", 1, "expert", "finish-time")).not.toBe(first);
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "normal", "finish-time")).not.toBe(first);
  });

  it("keeps work automation ticking on the same one-timescale controller", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Realtime work", mode: "work", idempotencyKey: "realtime-work" });
    const controller = new CompetitionController({
      competitionId: record.id,
      participants: ["p1"],
      stages: [{ id: "sr-1", map: "1", mode: "sr", timeLimitMs: 60_000, minimumScoringPlace: 1 }],
      policy: { announcementLeadMs: 0, readyBufferMs: 10 }
    }, { now: () => performance.now() });
    controller.observeConnection("p1", true);
    const runtime = {
      competitionId: record.id,
      controller,
      runtime: {
        dispatch: async () => {
          const actions = controller.drainActions();
          for (const action of actions) controller.acknowledgeAction(action.id, "acknowledged");
          return actions;
        }
      }
    };
    const internals = service as unknown as {
      workRuntimes: Map<string, typeof runtime>;
      startRealtimeWorkAutomation(candidate: typeof runtime): void;
    };
    internals.workRuntimes.set(record.id, runtime);
    controller.enable(performance.now());
    internals.startRealtimeWorkAutomation(runtime);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
    expect(controller.snapshot().phase).toBe("running");
    service.close();
  });
  let dataRoot = "";
  let database: OpenedDatabase | undefined;

  afterEach(() => {
    database?.close();
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  });

  it("registers normal players from list output and keeps display aliases separate", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-dynamic-participants-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Dynamic", mode: "work", idempotencyKey: "create" });
    service.publish(record.id, 0, "publish");

    const internals = service as unknown as {
      workRuntimes: Map<string, WorkRuntimeHarness>;
      makeWorkRuntime(competitionId: string, config: CompetitionConfig, transport: CommandTransport): WorkRuntimeHarness;
      ingestWorkLine(runtime: WorkRuntimeHarness, line: string): void;
    };
    const transport: CommandTransport = { write: async () => undefined };
    const published = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = internals.makeWorkRuntime(record.id, published, transport);
    internals.workRuntimes.set(record.id, runtime);

    internals.ingestWorkLine(runtime, "[06-30 12:00:00] 2 player(s) online:");
    internals.ingestWorkLine(runtime, "[06-30 12:00:00] Silent_Snow (#42)");
    internals.ingestWorkLine(runtime, "[06-30 12:00:00] *Observer (#99)");
    expect(service.snapshot(record.id).config.participants).toMatchObject([{
      id: "Silent_Snow",
      displayName: "Silent_Snow",
      connectionIds: ["42"],
      online: true
    }]);

    await service.performAction(record.id, {
      expectedStateVersion: 1,
      idempotencyKey: "alias",
      action: { type: "player-alias-upsert", playerId: "Silent_Snow", displayName: "渴望新地图", reason: "直播显示名" }
    });
    internals.ingestWorkLine(runtime, "[06-30 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    internals.ingestWorkLine(runtime, "[06-30 12:00:02] (#42, Silent_Snow) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");

    expect(service.getRawClientLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mock-client", rawLine: expect.stringContaining("Silent_Snow") })
    ]));

    expect(service.snapshot(record.id).currentScoreboard).toMatchObject([{
      playerId: "Silent_Snow",
      displayName: "渴望新地图",
      points: 20
    }]);
    internals.ingestWorkLine(runtime, "[06-30 12:00:03] 0 player(s) online:");
    expect(service.snapshot(record.id).config.participants[0]?.online).toBe(false);
  });
});
