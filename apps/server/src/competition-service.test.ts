import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionConfig } from "@ballance/contracts";
import type { CompetitionController, CompetitionEngine } from "@ballance/core";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandTransport } from "./mock-client.js";
import { CompetitionService } from "./competition-service.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";

interface WorkRuntimeHarness {
  controller: CompetitionController;
  engine: CompetitionEngine;
}

describe("CompetitionService dynamic participants", () => {
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
