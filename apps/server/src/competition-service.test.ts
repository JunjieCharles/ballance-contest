import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionConfig, ScenarioDefinition } from "@ballance/contracts";
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

  it("keeps work automation on the fixed Ready cadence", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Realtime work", mode: "work", idempotencyKey: "realtime-work" });
    let now = 0;
    const controller = new CompetitionController({
      competitionId: record.id,
      participants: ["p1"],
      stages: [{ id: "sr-1", map: "1", mode: "sr", timeLimitMs: 60_000, minimumScoringPlace: 1 }],
      policy: { announcementLeadMs: 0, readyBufferMs: 10 }
    }, { now: () => now });
    controller.observeConnection("p1", true);
    const runtime = {
      competitionId: record.id,
      controller,
      engine: {
        snapshot: () => ({ currentScoreboard: [], scoreboardVersions: [] }),
        apply: () => undefined
      },
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
      tickRealtimeWorkAutomation(candidate: typeof runtime): Promise<void>;
    };
    internals.workRuntimes.set(record.id, runtime);
    controller.enable(now);
    await internals.tickRealtimeWorkAutomation(runtime);
    now = 3_000;
    await internals.tickRealtimeWorkAutomation(runtime);
    now = 6_000;
    for (let index = 0; index < 4; index += 1) await internals.tickRealtimeWorkAutomation(runtime);
    now = 10_000;
    await internals.tickRealtimeWorkAutomation(runtime);
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
      action: { type: "player-alias-upsert", playerId: "Silent_Snow", displayName: "渴望新地图" }
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

  it("excludes cheat and known Warning results without fabricating DNF logs", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-exclusion-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Exclusion", mode: "work", idempotencyKey: "create-exclusion" });
    service.publish(record.id, 0, "publish-exclusion");
    const internals = service as unknown as {
      workRuntimes: Map<string, WorkRuntimeHarness>;
      makeWorkRuntime(competitionId: string, config: CompetitionConfig, transport: CommandTransport): WorkRuntimeHarness;
      ingestWorkLine(runtime: WorkRuntimeHarness, line: string): void;
    };
    const runtime = internals.makeWorkRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    internals.workRuntimes.set(record.id, runtime);
    for (const [id, name] of [["11", "Cheater"], ["12", "Valid"], ["13", "Warned"]]) {
      internals.ingestWorkLine(runtime, `[07-01 12:00:00] ${name} (#${id}) logged in with cheat mode off.`);
    }
    internals.ingestWorkLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    internals.ingestWorkLine(runtime, "[07-01 12:00:02] (11, Cheater) turned cheat on.");
    internals.ingestWorkLine(runtime, "[07-01 12:00:03] (11, Cheater) turned cheat off.");
    internals.ingestWorkLine(runtime, "[07-01 12:00:04] (#11, Cheater) finished Level 01 in 1st place (score: 100; real time: 00:00:03.000).");
    internals.ingestWorkLine(runtime, "[07-01 12:00:05] (#12, Valid) finished Level 01 in 2nd place (score: 90; real time: 00:00:04.000).");
    internals.ingestWorkLine(runtime, "[07-01 12:00:06] [Warning] Warned just pressed the Reset hotkey at Level 01!");
    internals.ingestWorkLine(runtime, "[07-01 12:00:07] (#13, Warned) finished Level 01 in 3rd place (score: 80; real time: 00:00:06.000).");

    const snapshot = service.snapshot(record.id);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Cheater")?.stages["sr-1"]).toMatchObject({ status: "excluded", points: 0, finishSourceId: expect.any(String) });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Warned")?.stages["sr-1"]).toMatchObject({ status: "excluded", points: 0, finishSourceId: expect.any(String) });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Valid")?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 20 });
    expect(service.getRawClientLogs(record.id).some((line) => line.rawLine.includes("did not finish"))).toBe(false);
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(2);
  });

  it("recovers sent commands as uncertain and keeps automation paused after restart", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-command-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const first = new CompetitionService(undefined, { database, dataRoot });
    const record = first.create({ name: "Recovery", mode: "work", idempotencyKey: "create-recovery" });
    const now = new Date().toISOString();
    const payload = {
      id: "sent-command", idempotencyKey: "sent-command", action: { type: "raw", command: "status" }, command: "status",
      status: "sent", createdAt: now, updatedAt: now
    };
    database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(payload.id, record.id, payload.idempotencyKey, "raw", "sent", JSON.stringify(payload), now, now);
    first.close();

    const restored = new CompetitionService(undefined, { database, dataRoot }).snapshot(record.id);
    expect(restored.runtime.commands).toContainEqual(expect.objectContaining({ id: "sent-command", status: "uncertain" }));
    expect(restored.runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "重启前命令结果不确定", severity: "critical" }));
    expect(restored.runtime.automationEnabled).toBe(false);
  });

  it("records timeout DNF in results without inventing MockClient DNF lines", () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Timeout evidence", mode: "test", idempotencyKey: "timeout-evidence" });
    const definition: ScenarioDefinition = {
      schemaVersion: 1,
      kind: "player-behavior",
      randomSeed: 77_031,
      id: "timeout-evidence",
      name: "Timeout evidence",
      year: 2026,
      timezone: "Asia/Shanghai",
      refereeConnectionId: "timeout-referee",
      players: Array.from({ length: 15 }, (_unused, index) => ({ id: `timeout-p${index + 1}`, displayName: `Timeout ${index + 1}`, connectionId: String(500 + index), profile: "struggler" as const })),
      stages: [],
      events: [],
      expected: { attempts: 0, scoreboardVersions: 0 }
    };
    const runId = service.createTestRun(record.id, definition).runId;
    service.startTestAutomation(record.id, runId);
    const automation = service.advanceTestAutomation(record.id, runId, 700_000);
    const results = automation.attempts[0]?.results ?? [];
    const timedOut = results.filter((result) => result.reason === "time-limit");
    const explicitDnf = results.filter((result) => result.reason === "gave-up");
    const rawDnfLines = service.getRawClientLogs(record.id, 1_000).filter((line) => line.rawLine.includes("did not finish Level"));
    expect(timedOut.length).toBeGreaterThan(0);
    expect(rawDnfLines).toHaveLength(explicitDnf.length);
    expect(service.snapshot(record.id).runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "关卡时限已到" }));
  });
});
