import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionConfig, ScenarioDefinition, ScenarioEvent, WorkConnectionStatus } from "@ballance/contracts";
import { CompetitionController } from "@ballance/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandTransport } from "./mock-client.js";
import { CompetitionService, seededBehaviorRandom } from "./competition-service.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";
import type { TestRuntime, TestRuntimeManager } from "./test-runtime-manager.js";
import type { WorkRuntimeManager, WorkRuntime } from "./work-runtime-manager.js";

const workRuntimeManager = (service: CompetitionService): WorkRuntimeManager =>
  (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;

const testRuntimeManager = (service: CompetitionService): TestRuntimeManager =>
  (service as unknown as { testRuntimeManager: TestRuntimeManager }).testRuntimeManager;

const establishAuthenticatedReferee = (runtime: WorkRuntime, connectionId = "7"): void => {
  runtime.refereeConnectionId = connectionId;
  runtime.connection = { ...runtime.connection, status: "healthy", refereeConnectionId: connectionId };
  runtime.commands.setRefereeConnectionId(connectionId);
};

describe("CompetitionService dynamic participants", () => {
  let dataRoot = "";
  let database: OpenedDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
    dataRoot = "";
  });

  it("uses a fixed seed for varied but reproducible player behavior", () => {
    const first = seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time");
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time")).toBe(first);
    expect(seededBehaviorRandom(20_260_632, "sr-1", 1, "expert", "finish-time")).not.toBe(first);
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "normal", "finish-time")).not.toBe(first);
  });

  it("resets simulated server finish ordinals on every authoritative Go", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Ordinal reset", mode: "test", idempotencyKey: "ordinal-reset" });
    service.publish(record.id, 0, "publish-ordinal-reset");
    const manager = testRuntimeManager(service);
    const scenario = manager.listScenarios()[0];
    if (!scenario) throw new Error("missing test scenario");
    const created = manager.createFromScenario(record.id, scenario.id);
    const runtime = manager.getRuntime(record.id, created.runId);
    const stage = runtime.definition.stages[0];
    const player = runtime.definition.players[0];
    if (!stage || !player) throw new Error("invalid test scenario");
    const render = (manager as unknown as { testEventLogLine(runtime: TestRuntime, event: ScenarioEvent): string }).testEventLogLine.bind(manager);
    const finish = (sourceId: string) => ({ atMs: 1_000, sourceId, type: "finish" as const, stageId: stage.id, playerId: player.id, score: 1, elapsedMs: 1_000 });
    expect(render(runtime, finish("first"))).toContain("1st place");
    expect(render(runtime, finish("second"))).toContain("2nd place");
    render(runtime, { atMs: 2_000, sourceId: "go-again", type: "go", stageId: stage.id, refereeConnectionId: runtime.definition.refereeConnectionId });
    expect(render(runtime, finish("after-go"))).toContain("1st place");
    await service.close();
  });

  it("simulates the s public-chat command without leaving test mode", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Test chat", mode: "test", idempotencyKey: "test-chat" });
    service.publish(record.id, 0, "publish-test-chat");
    const manager = testRuntimeManager(service);
    const scenario = manager.listScenarios()[0];
    if (!scenario) throw new Error("missing test scenario");
    const created = service.createTestRunFromScenario(record.id, scenario.id);
    const runtime = manager.getRuntime(record.id, created.runId);
    const before = service.snapshot(record.id);
    const result = await service.performAction(record.id, {
      expectedStateVersion: before.competition.stateVersion,
      idempotencyKey: "send-test-chat",
      action: { type: "notification", channel: "s", text: "请回到大厅" }
    });
    expect(result).toMatchObject({ actionType: "notification", status: "simulated", simulated: true });
    expect(service.getRawClientLogs(record.id).at(-1)?.rawLine).toContain(`[${runtime.definition.refereeConnectionId}, *ContestConsole]: 请回到大厅`);
    expect(service.snapshot(record.id).runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "裁判已发送公共聊天", message: "请回到大厅" }));
    await service.close();
  });

  it("keeps work automation on the fixed Ready cadence", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Realtime work", mode: "work", idempotencyKey: "realtime-work" });
    service.publish(record.id, 0, "publish-realtime-work");
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
        snapshot: () => ({ attempts: [], currentScoreboard: [], scoreboardVersions: [] }),
        apply: () => undefined
      },
      runtime: {
        dispatch: async () => {
          const actions = controller.drainActions();
          for (const action of actions) controller.acknowledgeAction(action.id, "acknowledged");
          return actions;
        }
      },
      commands: { advanceGeneration: () => 1 },
      connection: { status: "healthy", processGeneration: 0, connectionGeneration: 0 },
      mapEchoPrefixes: new Map<string, string>()
    };
    workRuntimeManager(service).register(record.id, runtime as never);
    controller.enable(now);
    await workRuntimeManager(service).tickRealtime(runtime as never);
    now = 5_000;
    await workRuntimeManager(service).tickRealtime(runtime as never);
    now = 10_000; await workRuntimeManager(service).tickRealtime(runtime as never);
    now = 15_000; await workRuntimeManager(service).tickRealtime(runtime as never);
    now = 20_000; await workRuntimeManager(service).tickRealtime(runtime as never);
    now = 30_000;
    await workRuntimeManager(service).tickRealtime(runtime as never);
    expect(controller.snapshot().phase).toBe("running");
    await service.close();
  });

  it("does not let a player's countdown move the referee flow out of Ready", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-foreign-countdown-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Foreign countdown", mode: "work", idempotencyKey: "foreign-countdown" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "configure-foreign-countdown",
      stages: [{
        id: "sr-2", order: 1, label: "SR2", level: 2, mode: "SR", mapKind: "official",
        timeLimitMs: 600_000, scoring: [5, 3, 1], minimumScoringPlace: 3
      }]
    });
    service.publish(record.id, 1, "publish-foreign-countdown");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.controller.enable(0);
    runtime.controller.tick();
    expect(runtime.controller.snapshot().phase).toBe("ready");
    expect(runtime.controller.snapshot().countdownValue).toBeUndefined();

    manager.ingestLine(runtime, "[07-03 20:20:06] [9999999999, *ContestConsole]: Level 02 - 2");
    expect(runtime.refereeConnectionId).toBeUndefined();
    expect(runtime.controller.snapshot().phase).toBe("ready");
    manager.ingestLine(runtime, "[07-03 20:20:07] 2760557282: *ContestConsole    70ms");
    expect(runtime.refereeConnectionId).toBeUndefined();
    establishAuthenticatedReferee(runtime, "2760557282");
    manager.ingestLine(runtime, "[07-03 20:20:17] [3210244510, liangzhichao]: Level 02 - 2");

    expect(runtime.controller.snapshot().phase).toBe("ready");
    expect(runtime.controller.snapshot().countdownValue).toBeUndefined();
    await service.close();
  });
  it("registers normal players from list output and keeps display aliases separate", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-dynamic-participants-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Dynamic", mode: "work", idempotencyKey: "create" });
    service.publish(record.id, 0, "publish");

    const manager = workRuntimeManager(service);
    const transport: CommandTransport = { write: async () => undefined };
    const published = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = manager.makeRuntime(record.id, published, transport);
    manager.register(record.id, runtime);

    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[06-30 12:00:00] 3 player(s) online:");
    manager.ingestLine(runtime, "[06-30 12:00:00] Silent_Snow (#42)");
    manager.ingestLine(runtime, "[06-30 12:00:00] *Observer (#99)");
    manager.ingestLine(runtime, "[06-30 12:00:00] *ContestConsole (#7)");
    establishAuthenticatedReferee(runtime);
    await vi.waitFor(() => expect(service.snapshot(record.id).config.participants).toMatchObject([{
      id: "Silent_Snow",
      displayName: "Silent_Snow",
      connectionIds: ["42"],
      online: true
    }]));

    await service.performAction(record.id, {
      expectedStateVersion: 1,
      idempotencyKey: "alias",
      action: { type: "player-alias-upsert", playerId: "Silent_Snow", displayName: "渴望新地图" }
    });
    manager.ingestLine(runtime, "[06-30 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[06-30 12:00:02] (#42, Silent_Snow) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");

    expect(service.getRawClientLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mock-client", rawLine: expect.stringContaining("Silent_Snow") })
    ]));

    expect(service.snapshot(record.id).currentScoreboard).toMatchObject([{
      playerId: "Silent_Snow",
      displayName: "渴望新地图",
      points: 15
    }]);
    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[06-30 12:00:03] 0 player(s) online:");
    await vi.waitFor(() => expect(service.snapshot(record.id).config.participants[0]?.online).toBe(false));

    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[06-30 12:00:04] 314: Modern_Player     28ms");
    manager.ingestLine(runtime, "[06-30 12:00:04] 99: *Observer     0ms");
    manager.ingestLine(runtime, "[06-30 12:00:04] 2 client(s) online: 1 player(s), 1 spectator(s).");
    await vi.waitFor(() => expect(service.snapshot(record.id).config.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Silent_Snow", online: false }),
      expect.objectContaining({ id: "Modern_Player", connectionIds: ["314"], online: true })
    ])));
    await service.close();
  });

  it("uses a live fatal-error line once and mirrors the voided protected attempt into scoring", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-fatal-protection-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Fatal protection", mode: "work", idempotencyKey: "create-fatal" });
    service.publish(record.id, 0, "publish-fatal");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-02 12:00:00] Player One (#42) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-02 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-02 12:00:02] (#42, Player One) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    manager.ingestLine(runtime, "[07-02 12:00:03] Player One was kicked by the server (fatal error) and crashed subsequently.");
    manager.ingestLine(runtime, "[07-02 12:00:04] Player One (#42) disconnected.");

    const automation = runtime.controller.snapshot();
    expect(automation).toMatchObject({
      phase: "restart-preparing",
      startProtectionUsedStageIds: ["sr-1"],
      attempts: [{ attemptNumber: 1, voided: true, intakeOpen: false }],
      incidents: [expect.objectContaining({ type: "protected-crash", status: "resolved", participantIds: ["Player One"] })]
    });
    expect(automation.incidents.filter((incident) => incident.type === "protected-crash")).toHaveLength(1);
    expect(automation.actions.filter((action) => action.kind === "bulletin").at(-1)?.message)
      .toContain("\n本关起跑保护剩余 1 次，仅保护 fatal error。");
    expect(runtime.engine.snapshot().attempts).toMatchObject([{ attemptNumber: 1, voided: true, open: false }]);
    expect(runtime.engine.snapshot().currentScoreboard.every((entry) => Object.keys(entry.stages).length === 0)).toBe(true);
    expect(service.snapshot(record.id).config.participants).toContainEqual(expect.objectContaining({ id: "Player One", online: false }));
    const restoredRuntime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    expect(restoredRuntime.controller.snapshot().startProtectionUsedStageIds).toEqual(["sr-1"]);
    await service.close();
  });

  it("registers every published custom map once after connection and attributes its quoted echoes", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-custom-map-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Custom map", mode: "work", idempotencyKey: "create-custom-map" });
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "configure-custom-map",
      stages: [{
        id: "custom-hs-final", order: 1, label: "云端决赛图", level: 0, mode: "HS", mapKind: "custom", mapHash: hash,
        timeLimitMs: 600_000, scoring: [20, 15], minimumScoringPlace: 2
      }]
    });
    service.publish(record.id, 1, "publish-custom-map");
    const internals = service as unknown as {
      toCommandAction(competitionId: string, action: { type: "ready" } | { type: "manual-go" }): { type: string; map: string; mode: string };
    };
    const manager = workRuntimeManager(service);
    const published = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const writes: string[] = [];
    const runtime = manager.makeRuntime(record.id, published, { write: async (command) => { writes.push(command); } });
    manager.register(record.id, runtime);
    expect(internals.toCommandAction(record.id, { type: "ready" })).toMatchObject({ map: `${hash} 0`, mode: "hs" });
    expect(internals.toCommandAction(record.id, { type: "manual-go" })).toMatchObject({ map: `${hash} 0`, mode: "hs" });
    await manager.registerPublishedCustomMaps(runtime, published);
    await manager.registerPublishedCustomMaps(runtime, published);
    expect(writes).toEqual([`setmap ${hash} 0 云端决赛图`, "listmap"]);
    const prefix = hash.slice(0, 20);
    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-01 19:25:40] Alpha (#11) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-01 19:25:40] Beta (#12) logged in with cheat mode off.");
    manager.ingestLine(runtime, `[07-01 19:25:43] [7, *ContestConsole]: "${prefix}.." <HS> - Get ready`);
    manager.ingestLine(runtime, "[07-01 19:25:46] [7, *ContestConsole]: \"云端决赛图\" <HS> - Go!");
    manager.ingestLine(runtime, "[07-01 19:26:19] (#11, Alpha) finished \"云端决赛图\" <HS> in 1st place (score: 120 [20]; real time: 00:00:02.045).");
    manager.ingestLine(runtime, "[07-01 19:26:46] (#12, Beta) did not finish \"云端决赛图\" (furthest reach: sector 1).");

    const snapshot = service.snapshot(record.id);
    expect(snapshot.config.stages[0]).toMatchObject({ mapKind: "custom", mapHash: hash, level: 0, label: "云端决赛图" });
    expect(snapshot.runtime.attempts).toContainEqual(expect.objectContaining({ stageId: "custom-hs-final", attemptNumber: 1 }));
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Alpha")?.stages["custom-hs-final"])
      .toMatchObject({ status: "finished", score: 120, points: 20 });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Beta")?.stages["custom-hs-final"])
      .toMatchObject({ status: "dnf", points: 0 });
    expect(service.getRawClientLogs(record.id).filter((line) => line.rawLine.includes("云端决赛图") || line.rawLine.includes(`"${prefix}.."`))).toHaveLength(4);
    await service.close();
  });

  it("binds an official server hash echo only after the current referee Ready", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-official-map-echo-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Official map echo", mode: "work", idempotencyKey: "create-official-map" });
    service.publish(record.id, 0, "publish-official-map");
    const manager = workRuntimeManager(service);
    const published = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = manager.makeRuntime(record.id, published, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.controller.manualReady();
    const prefix = "a364b408fffaab434480";
    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-01 19:30:00] Alpha (#11) logged in with cheat mode off.");
    manager.ingestLine(runtime, `[07-01 19:30:01] [7, *ContestConsole]: ${prefix}.. - Get ready`);
    manager.ingestLine(runtime, `[07-01 19:30:16] [7, *ContestConsole]: ${prefix}.. - Go!`);
    manager.ingestLine(runtime, `[07-01 19:30:20] (#11, Alpha) finished ${prefix}.. in 1st place (score: 100; real time: 00:00:04.000).`);

    expect(service.snapshot(record.id).currentScoreboard.find((entry) => entry.playerId === "Alpha")?.stages["sr-1"])
      .toMatchObject({ status: "finished", score: 100, points: 15 });
  });

  it("attributes the live official hash HS marker to an HS stage and result", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-official-hs-echo-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Official HS echo", mode: "work", idempotencyKey: "create-official-hs" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "configure-official-hs",
      stages: [{
        id: "hs-1", order: 1, label: "HS1", level: 1, mode: "HS", mapKind: "official",
        timeLimitMs: 600_000, scoring: [20, 15], minimumScoringPlace: 2
      }]
    });
    service.publish(record.id, 1, "publish-official-hs");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.controller.manualReady();
    const prefix = "a364b408fffaab434480";
    establishAuthenticatedReferee(runtime, "1427745711");
    manager.ingestLine(runtime, "[07-03 21:01:31] Runner (#11) logged in with cheat mode off.");
    manager.ingestLine(runtime, `[07-03 21:01:36] [1427745711, *ContestConsole]: ${prefix}.. <HS> - Get ready`);
    manager.ingestLine(runtime, `[07-03 21:01:39] [1427745711, *ContestConsole]: ${prefix}.. <HS> - Go!`);
    manager.ingestLine(runtime, `[07-03 21:01:43] (#11, Runner) finished ${prefix}.. <HS> in 1st place (score: 120 [20]; real time: 00:00:04.000).`);

    expect(service.snapshot(record.id).runtime.attempts).toContainEqual(expect.objectContaining({ stageId: "hs-1", attemptNumber: 1 }));
    expect(service.snapshot(record.id).currentScoreboard.find((entry) => entry.playerId === "Runner")?.stages["hs-1"])
      .toMatchObject({ status: "finished", score: 120, points: 20 });
  });

  it("renders custom-map test logs with the same quoted registered-name sentences as the live server", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-custom-test-logs-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Custom test logs", mode: "test", idempotencyKey: "custom-test-logs" });
    const hash = "e90b2f535c8bf881e9cb83129fba241d";
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "custom-test-stage",
      stages: [{
        id: "custom-hs", order: 1, label: "云端竞速图", level: 0, mode: "HS", mapKind: "custom", mapHash: hash,
        timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3
      }]
    });
    service.publish(record.id, 1, "publish-custom-test-stage");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runId, 0);
    service.advanceTestAutomation(record.id, runId, 240_000);
    const mapEcho = `"云端竞速图" <HS>`;
    const lines = service.getRawClientLogs(record.id, 1_000).map((line) => line.rawLine);
    expect(lines.filter((line) => line.includes(`${mapEcho} - Get ready`)), lines.join("\n")).toHaveLength(3);
    expect(lines).toContainEqual(expect.stringContaining(`${mapEcho} - Go!`));
    expect(lines).toContainEqual(expect.stringContaining(`finished ${mapEcho}`));
  });

  it("excludes cheat and known Warning results without fabricating DNF logs", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-exclusion-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Exclusion", mode: "work", idempotencyKey: "create-exclusion" });
    service.publish(record.id, 0, "publish-exclusion");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);
    for (const [id, name] of [["11", "Cheater"], ["12", "Valid"], ["13", "Warned"]]) {
      manager.ingestLine(runtime, `[07-01 12:00:00] ${name} (#${id}) logged in with cheat mode off.`);
    }
    manager.ingestLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:02] (11, Cheater) turned cheat on.");
    manager.ingestLine(runtime, "[07-01 12:00:03] (11, Cheater) turned cheat off.");
    manager.ingestLine(runtime, "[07-01 12:00:04] (#11, Cheater) finished Level 01 in 1st place (score: 100; real time: 00:00:03.000).");
    manager.ingestLine(runtime, "[07-01 12:00:05] (#12, Valid) finished Level 01 in 2nd place (score: 90; real time: 00:00:04.000).");
    manager.ingestLine(runtime, "[07-01 12:00:06] [Warning] Warned just pressed the Reset hotkey at Level 01!");
    manager.ingestLine(runtime, "[07-01 12:00:07] (#13, Warned) finished Level 01 in 3rd place (score: 80; real time: 00:00:06.000).");

    const snapshot = service.snapshot(record.id);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Cheater")?.stages["sr-1"]).toMatchObject({ status: "excluded", points: 0, finishSourceId: expect.any(String) });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Warned")?.stages["sr-1"]).toMatchObject({ status: "excluded", points: 0, finishSourceId: expect.any(String) });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Valid")?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 15 });
    expect(service.getRawClientLogs(record.id).some((line) => line.rawLine.includes("did not finish"))).toBe(false);
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(2);
    expect(runtime.engine.snapshot().anomalies.filter((item) => item.code === "duplicate-event" || item.code === "post-completion-result")).toHaveLength(0);
  });

  it("does not claim a second exclusion when a [CHEAT] DNF repeats an existing terminal result", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-duplicate-cheat-dnf-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Duplicate cheat DNF", mode: "work", idempotencyKey: "duplicate-cheat-dnf" });
    service.publish(record.id, 0, "publish-duplicate-cheat-dnf");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);

    manager.ingestLine(runtime, "[07-01 12:00:00] RepeatPlayer (#13) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:02] [Warning] RepeatPlayer just pressed the Reset hotkey at Level 01!");
    const versionCount = runtime.engine.snapshot().scoreboardVersions.length;
    manager.ingestLine(runtime, "[07-01 12:00:03] [CHEAT] (#13, RepeatPlayer) did not finish Level 01 (furthest reach: sector 4).");

    const snapshot = service.snapshot(record.id);
    expect(runtime.engine.snapshot().scoreboardVersions).toHaveLength(versionCount);
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(1);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "RepeatPlayer")?.stages["sr-1"])
      .toMatchObject({ status: "excluded", points: 0 });
  });

  it("does not let a [CHEAT] DNF enter the engine when T-60 closes the captured attempt before controller acceptance", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-cheat-dnf-boundary-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Atomic cheat DNF", mode: "work", idempotencyKey: "atomic-cheat-dnf" });
    const draft = service.snapshot(record.id).config;
    const firstStage = draft.stages[0];
    if (!firstStage) throw new Error("missing first stage");
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "atomic-cheat-dnf-scoring",
      stages: draft.stages.map((stage, index) => index === 0
        ? { ...stage, scoring: [20], minimumScoringPlace: 1 }
        : stage)
    });
    service.publish(record.id, 1, "publish-atomic-cheat-dnf");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);

    manager.ingestLine(runtime, "[07-01 12:00:00] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:01] (#11, Threshold) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "tail-intake",
      currentStageId: firstStage.id,
      plannedReadyStageId: draft.stages[1]?.id
    });

    const originalObserveViolation = runtime.controller.observeViolation.bind(runtime.controller);
    const observeViolation = vi.spyOn(runtime.controller, "observeViolation").mockImplementation((...args) => {
      runtime.controller.reschedule(performance.now() + 60_000);
      originalObserveViolation(...args);
    });
    const versionsBefore = runtime.engine.snapshot().scoreboardVersions.length;
    const attentionsBefore = service.snapshot(record.id).runtime.attentionItems
      .filter((item) => item.id.startsWith("excluded:")).length;

    manager.ingestLine(runtime, "[07-01 12:00:02] [CHEAT] (#12, BoundaryCheater) did not finish Level 01 (furthest reach: sector 4).");
    observeViolation.mockRestore();

    expect(runtime.controller.snapshot()).toMatchObject({
      currentStageId: draft.stages[1]?.id,
      attempts: [expect.objectContaining({
        stageId: firstStage.id,
        intakeOpen: false,
        results: [expect.objectContaining({ playerId: "Threshold", status: "finished" })]
      })]
    });
    expect(runtime.controller.snapshot().attempts[0]?.results)
      .not.toContainEqual(expect.objectContaining({ playerId: "BoundaryCheater" }));
    expect(runtime.engine.snapshot().scoreboardVersions).toHaveLength(versionsBefore);
    expect(runtime.engine.snapshot().currentScoreboard.find((entry) => entry.playerId === "BoundaryCheater")?.stages[firstStage.id])
      .toBeUndefined();
    expect(service.snapshot(record.id).runtime.attentionItems
      .filter((item) => item.id.startsWith("excluded:"))).toHaveLength(attentionsBefore);
  });

  it("applies a [CHEAT] finish atomically before an immediate T-60 plan can switch stages", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-cheat-finish-boundary-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Atomic cheat finish", mode: "work", idempotencyKey: "atomic-cheat-finish" });
    const draft = service.snapshot(record.id).config;
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "atomic-cheat-finish-flow",
      flow: { ...draft.flow, intermissionMs: 30_000 }
    });
    service.publish(record.id, 1, "publish-atomic-cheat-finish");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);

    manager.ingestLine(runtime, "[07-01 12:00:00] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:01] (#11, Alpha) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    manager.ingestLine(runtime, "[07-01 12:00:02] (#12, Beta) finished Level 01 in 2nd place (score: 90; real time: 00:00:02.000).");
    manager.ingestLine(runtime, "[07-01 12:00:03] [CHEAT] (#13, Cheater) finished Level 01 in 3rd place (score: 80; real time: 00:00:03.000).");

    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "running",
      currentStageId: "sr-1",
      attempts: [expect.objectContaining({
        stageId: "sr-1",
        intakeOpen: true,
        results: expect.arrayContaining([
          expect.objectContaining({
            playerId: "Cheater",
            status: "excluded",
            reason: "cheat-finish",
            finishSourceId: expect.any(String)
          })
        ])
      })]
    });
    expect(runtime.engine.snapshot().currentScoreboard.find((entry) => entry.playerId === "Cheater")?.stages["sr-1"])
      .toMatchObject({ status: "excluded", reason: "cheat-finish", finishSourceId: expect.any(String) });
    expect(runtime.controller.snapshot().plannedReadyStageId).toBeUndefined();
    await service.close();
  });

  it("warns once after cheat-off and mirrors a cheat-on reconnect into the live scoreboard at Go", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-cheat-reconnect-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Cheat reconnect", mode: "work", idempotencyKey: "create-cheat-reconnect" });
    service.publish(record.id, 0, "publish-cheat-reconnect");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-02 20:00:00] OfflineCheater (#41) logged in with cheat mode off.");
    runtime.controller.manualCheatOff();
    const cheatOff = runtime.controller.drainActions().find((item) => item.kind === "cheat-off");
    if (!cheatOff) throw new Error("missing cheat-off action");
    runtime.controller.acknowledgeAction(cheatOff.id, "acknowledged");
    manager.ingestLine(runtime, "[07-02 20:00:01] OfflineCheater (#41) disconnected.");
    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[07-02 20:00:02] 42: OfflineCheater [CHEAT]    34ms");
    manager.ingestLine(runtime, "[07-02 20:00:02] 1 client(s) online: 1 player(s), 0 spectator(s).");
    await vi.waitFor(() => expect(runtime.listReconciliation).toBeUndefined());
    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[07-02 20:00:03] 42: OfflineCheater [CHEAT]    34ms");
    manager.ingestLine(runtime, "[07-02 20:00:03] 1 client(s) online: 1 player(s), 0 spectator(s).");
    await vi.waitFor(() => expect(runtime.listReconciliation).toBeUndefined());

    expect(runtime.controller.snapshot().actions.filter((item) => item.kind === "notice")).toHaveLength(1);
    expect(runtime.controller.snapshot().blockers.some((blocker) => blocker.code === "PARTICIPANT_OFFLINE" || blocker.code === "PARTICIPANT_CHEAT")).toBe(false);
    manager.ingestLine(runtime, "[07-02 20:00:04] [7, *ContestConsole]: Level 01 - Go!");

    const snapshot = service.snapshot(record.id);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "OfflineCheater")?.stages["sr-1"]).toMatchObject({
      status: "excluded",
      points: 0,
      reason: "cheat-enabled"
    });
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(1);
    await service.close();
  });

  it("records a player who enters with cheat enabled directly in the live scoreboard", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-cheat-login-scoreboard-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Cheat login scoreboard", mode: "work", idempotencyKey: "create-cheat-login-scoreboard" });
    service.publish(record.id, 0, "publish-cheat-login-scoreboard");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-02 20:00:00] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-02 20:00:01] LoginCheater (#41) logged in with cheat mode on.");

    expect(service.snapshot(record.id).currentScoreboard.find((entry) => entry.playerId === "LoginCheater")?.stages["sr-1"]).toMatchObject({
      status: "excluded",
      points: 0,
      reason: "cheat-enabled"
    });
    expect(service.snapshot(record.id).runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(1);
    await service.close();
  });

  it("keeps raw test finish logs sequential when earlier finisher is excluded", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-test-log-order-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Test log order", mode: "work", idempotencyKey: "create-test-log-order" });
    service.publish(record.id, 0, "publish-test-log-order");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    establishAuthenticatedReferee(runtime);
    for (const [id, name] of [["11", "Cheater"], ["12", "Valid"]]) {
      manager.ingestLine(runtime, `[07-01 12:00:00] ${name} (#${id}) logged in with cheat mode off.`);
    }
    manager.ingestLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:02] (11, Cheater) turned cheat on.");
    manager.ingestLine(runtime, "[07-01 12:00:03] (#11, Cheater) finished Level 01 in 1st place (score: 100; real time: 00:00:03.000).");
    manager.ingestLine(runtime, "[07-01 12:00:04] (#12, Valid) finished Level 01 in 2nd place (score: 90; real time: 00:00:04.000).");

    const logs = service.getRawClientLogs(record.id).map((line) => line.rawLine);
    expect(logs.filter((line) => line.includes("finished Level 01"))).toEqual([
      expect.stringContaining("1st place"),
      expect.stringContaining("2nd place")
    ]);
    const snapshot = service.snapshot(record.id);
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Cheater")?.stages["sr-1"]).toMatchObject({ status: "excluded", points: 0 });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Valid")?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 15 });
  });

  it("ignores next-stage practice while the previous result window is still open", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-next-stage-practice-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Practice overlap", mode: "work", idempotencyKey: "create-practice-overlap" });
    service.publish(record.id, 0, "publish-practice-overlap");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-01 12:00:00] Practicing (#21) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:02] (#21, Practicing) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    manager.ingestLine(runtime, "[07-01 12:00:03] (21, Practicing) turned cheat on.");
    manager.ingestLine(runtime, "[07-01 12:00:04] [Warning] Practicing just pressed the Reset hotkey at Level 02!");
    manager.ingestLine(runtime, "[07-01 12:00:05] [CHEAT] (#21, Practicing) finished Level 02 in 1st place (score: 999; real time: 00:00:01.000).");

    const snapshot = service.snapshot(record.id);
    const player = snapshot.currentScoreboard.find((entry) => entry.playerId === "Practicing");
    expect(player?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 15 });
    expect(player?.stages["sr-2"]).toBeUndefined();
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(0);
    expect(snapshot.runtime.blockers.some((blocker) => blocker.code === "PARTICIPANT_CHEAT")).toBe(false);
    expect(service.getRawClientLogs(record.id).some((line) => line.rawLine.includes("finished Level 02"))).toBe(true);
  });

  it("closes controller and scoring-engine intake at T-60 and keeps later live results raw-only", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-t60-live-boundary-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "T-60 live boundary", mode: "work", idempotencyKey: "t60-live-boundary" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "t60-live-stages",
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-t60-live-boundary");
    const manager = workRuntimeManager(service);
    const config = service.snapshot(record.id).config;
    const runtime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    let clockNow = 0;
    runtime.controller = new CompetitionController({
      competitionId: record.id,
      participants: [],
      dynamicParticipants: true,
      stages: config.stages.map((stage) => ({
        id: stage.id,
        map: `level ${stage.level}`,
        displayName: stage.label,
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      })),
      policy: { intermissionMs: 180_000 }
    }, { now: () => clockNow });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);

    manager.ingestLine(runtime, "[07-03 20:00:00] [7, *ContestConsole]: Level 01 - Go!");
    for (const [index, player] of ["Alpha", "Beta", "Gamma"].entries()) {
      const place = ["1st", "2nd", "3rd"][index];
      manager.ingestLine(runtime, `[07-03 20:00:0${index + 1}] (#${index + 10}, ${player}) finished Level 01 in ${place} place (score: ${100 - index}; real time: 00:00:0${index + 1}.000).`);
    }
    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "tail-intake",
      currentStageId: "sr-1",
      plannedReadyAtMs: 180_000,
      plannedReadyStageId: "sr-2"
    });
    expect(runtime.engine.snapshot().scoreboardVersions).toHaveLength(3);

    clockNow = 120_000;
    const boundarySnapshot = service.snapshot(record.id);
    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "sr-2",
      attempts: [{ stageId: "sr-1", intakeOpen: false, intakeClosedAtMs: 120_000 }]
    });
    expect(runtime.engine.snapshot().attempts[0]).toMatchObject({ stageId: "sr-1", open: false, voided: false });
    expect(boundarySnapshot.runtime.scoreEditPermissions).toContainEqual({ stageId: "sr-1", editable: true });
    expect(service.journal.after(0)).toContainEqual(expect.objectContaining({
      type: "work.stage-boundary",
      competitionId: record.id,
      data: expect.objectContaining({ previousStageId: "sr-1", currentStageId: "sr-2" })
    }));

    manager.ingestLine(runtime, "[07-03 20:02:01] (#99, LateRunner) finished Level 01 in 4th place (score: 90; real time: 00:02:01.000).");
    manager.ingestLine(runtime, "[07-03 20:02:02] (#100, LateDnf) did not finish Level 01 (furthest reach: sector 4).");
    manager.ingestLine(runtime, "[07-03 20:02:03] [Warning] LateWarning just pressed the Reset hotkey at Level 01!");
    manager.ingestLine(runtime, "[07-03 20:02:04] [CHEAT] (#101, LateCheat) finished Level 01 in 5th place (score: 80; real time: 00:02:04.000).");
    manager.ingestLine(runtime, "[07-03 20:02:05] [7, *ContestConsole]: Level 01 - Go!");
    expect(runtime.engine.snapshot().scoreboardVersions).toHaveLength(3);
    expect(runtime.engine.snapshot().currentScoreboard.some((entry) => entry.playerId === "LateRunner")).toBe(false);
    expect(runtime.engine.snapshot().attempts).toHaveLength(1);
    expect(runtime.controller.snapshot()).toMatchObject({ currentStageId: "sr-2", attempts: [{ stageId: "sr-1", intakeOpen: false }] });
    expect(runtime.controller.snapshot().attempts).toHaveLength(1);
    const rawLines = service.getRawClientLogs(record.id, 100).map((line) => line.rawLine);
    for (const evidence of ["LateRunner", "LateDnf", "LateWarning", "LateCheat", "Level 01 - Go!"]) {
      expect(rawLines.some((line) => line.includes(evidence))).toBe(true);
    }
    expect(service.snapshot(record.id).runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(0);

    manager.saveSnapshot(runtime);
    await service.close();
    const restoredService = new CompetitionService(undefined, { database, dataRoot });
    const restored = restoredService.snapshot(record.id);
    expect(restored.runtime).toMatchObject({
      phase: "paused",
      currentStageId: "sr-2",
      attempts: [{ stageId: "sr-1", intakeOpen: false }]
    });
    expect(restored.runtime.scoreEditPermissions).toContainEqual({ stageId: "sr-1", editable: true });
    expect(restored.currentScoreboard.some((entry) => ["LateRunner", "LateDnf", "LateWarning", "LateCheat"].includes(entry.playerId))).toBe(false);
    const scoreConfirmation = restoredService.createConfirmation(record.id, {
      kind: "scoreboard-override",
      intent: "scoreboard-set-place",
      target: "Alpha:sr-1",
      playerId: "Alpha",
      stageId: "sr-1",
      operation: "set-place",
      place: 2,
      rankPolicy: "shift"
    });
    const revised = restoredService.applyScoreboardOverride(record.id, {
      expectedStateVersion: restored.competition.stateVersion,
      idempotencyKey: "offline-t60-score-edit",
      playerId: "Alpha",
      stageId: "sr-1",
      operation: "set-place",
      place: 2,
      rankPolicy: "shift",
      confirmationToken: scoreConfirmation.token,
      impactHash: scoreConfirmation.impactHash
    });
    expect(revised.entries.find((entry) => entry.playerId === "Alpha")?.stages["sr-1"]).toMatchObject({
      status: "finished",
      place: 2
    });
    await restoredService.close();
  });

  it("records a live deadline closure separately from a stage boundary", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-live-deadline-audit-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Live deadline audit", mode: "work", idempotencyKey: "live-deadline-audit" });
    service.publish(record.id, 0, "publish-live-deadline-audit");
    const manager = workRuntimeManager(service);
    const config = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    let clockNow = 0;
    const stage = config.stages[0];
    if (!stage) throw new Error("missing stage");
    runtime.controller = new CompetitionController({
      competitionId: record.id,
      participants: [],
      dynamicParticipants: true,
      stages: [{
        id: stage.id,
        map: `level ${stage.level}`,
        displayName: stage.label,
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: 1_000,
        minimumScoringPlace: stage.minimumScoringPlace
      }]
    }, { now: () => clockNow });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-03 20:00:00] [7, *ContestConsole]: Level 01 - Go!");

    clockNow = 1_000;
    manager.saveSnapshot(runtime);

    expect(runtime.controller.snapshot()).toMatchObject({
      currentStageId: "sr-1",
      phase: "review",
      attempts: [{ stageId: "sr-1", intakeOpen: false, intakeClosedAtMs: 1_000 }]
    });
    expect(runtime.engine.snapshot().attempts[0]).toMatchObject({ stageId: "sr-1", open: false });
    expect(service.journal.after(0)).toContainEqual(expect.objectContaining({
      type: "work.stage-deadline",
      competitionId: record.id,
      data: expect.objectContaining({
        previousStageId: "sr-1",
        currentStageId: "sr-1",
        stageChanged: false
      })
    }));
    expect(service.journal.after(0)).not.toContainEqual(expect.objectContaining({
      type: "work.stage-boundary",
      competitionId: record.id,
      data: expect.objectContaining({ previousStageId: "sr-1", currentStageId: "sr-1" })
    }));
  });

  it("atomically catches up and persists a missed T-60 boundary before a work runtime is recreated", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-t60-offline-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const first = new CompetitionService(undefined, { database, dataRoot });
    const record = first.create({ name: "Offline T-60 recovery", mode: "work", idempotencyKey: "offline-t60-recovery" });
    first.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "offline-t60-stages",
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    first.publish(record.id, 1, "publish-offline-t60-recovery");
    await first.close();

    const now = performance.now();
    const wallClockOriginMs = Date.now() - now;
    const plannedReadyAtMs = now + 30_000;
    const attempt = {
      id: "offline-attempt",
      stageId: "sr-1",
      attemptNumber: 1,
      goAtMs: now - 120_000,
      deadlineAtMs: now + 480_000,
      intakeOpen: true,
      voided: false,
      results: [{
        playerId: "Alpha",
        status: "finished" as const,
        sourceId: "offline-alpha-finish",
        receivedAtMs: now - 90_000
      }]
    };
    const storedRow = database.sqlite.prepare("SELECT payload FROM runtime_snapshots WHERE competition_id=?")
      .get(record.id) as { payload: string };
    const storedPayload = JSON.parse(storedRow.payload) as Record<string, unknown>;
    database.sqlite.prepare("UPDATE runtime_snapshots SET payload=? WHERE competition_id=?").run(JSON.stringify({
      ...storedPayload,
      work: {
        started: true,
        automation: {
          phase: "tail-intake",
          stateVersion: 7,
          automationEnabled: true,
          clockNowMs: now - 90_000,
          wallClockOriginMs,
          currentStageId: "sr-1",
          plannedReadyAtMs,
          plannedReadyStageId: "sr-2",
          nextStagePending: true,
          restartPending: false,
          blockers: [],
          waitingParticipants: [],
          attempts: [attempt],
          incidents: [],
          rejectedResults: [],
          actions: []
        },
        engine: {
          attempts: [{
            id: attempt.id,
            stageId: attempt.stageId,
            attemptNumber: attempt.attemptNumber,
            goSourceId: "offline-go",
            goAtMs: attempt.goAtMs,
            deadlineAtMs: attempt.deadlineAtMs,
            open: true,
            voided: false
          }],
          scoreboardVersions: [],
          anomalies: [],
          currentScoreboard: []
        },
        mapEchoPrefixes: {}
      }
    }), record.id);

    const restoredService = new CompetitionService(undefined, { database, dataRoot });
    const restored = restoredService.snapshot(record.id);
    expect(restored.runtime).toMatchObject({
      phase: "paused",
      currentStageId: "sr-2",
      attempts: [{ stageId: "sr-1", intakeOpen: false }]
    });
    expect(restored.runtime.scoreEditPermissions).toContainEqual({ stageId: "sr-1", editable: true });
    const persistedRow = database.sqlite.prepare("SELECT payload FROM runtime_snapshots WHERE competition_id=?")
      .get(record.id) as { payload: string };
    const persisted = JSON.parse(persistedRow.payload) as {
      work: {
        automation: { currentStageId: string; attempts: Array<{ intakeOpen: boolean; intakeClosedAtMs?: number }> };
        engine: { attempts: Array<{ open: boolean }> };
      };
    };
    expect(persisted.work.automation.currentStageId).toBe("sr-2");
    expect(persisted.work.automation.attempts[0]).toMatchObject({ intakeOpen: false, intakeClosedAtMs: expect.any(Number) });
    expect(persisted.work.engine.attempts[0]).toMatchObject({ open: false });
    await restoredService.close();
  });

  it("closes and persists an expired attempt offline even before the next T-60 boundary", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-deadline-offline-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const first = new CompetitionService(undefined, { database, dataRoot });
    const record = first.create({ name: "Offline deadline recovery", mode: "work", idempotencyKey: "offline-deadline-recovery" });
    first.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "offline-deadline-stages",
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20], minimumScoringPlace: 1 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20], minimumScoringPlace: 1 }
      ]
    });
    first.publish(record.id, 1, "publish-offline-deadline-recovery");
    await first.close();

    const now = performance.now();
    const wallClockOriginMs = Date.now() - now;
    const deadlineAtMs = now - 30_000;
    const plannedReadyAtMs = now + 180_000;
    const attempt = {
      id: "offline-expired-attempt",
      stageId: "sr-1",
      attemptNumber: 1,
      goAtMs: now - 90_000,
      deadlineAtMs,
      intakeOpen: true,
      voided: false,
      results: []
    };
    const storedRow = database.sqlite.prepare("SELECT payload FROM runtime_snapshots WHERE competition_id=?")
      .get(record.id) as { payload: string };
    const storedPayload = JSON.parse(storedRow.payload) as Record<string, unknown>;
    database.sqlite.prepare("UPDATE runtime_snapshots SET payload=? WHERE competition_id=?").run(JSON.stringify({
      ...storedPayload,
      work: {
        started: true,
        automation: {
          phase: "tail-intake",
          stateVersion: 11,
          automationEnabled: true,
          clockNowMs: now - 45_000,
          wallClockOriginMs,
          currentStageId: "sr-1",
          plannedReadyAtMs,
          plannedReadyStageId: "sr-2",
          nextStagePending: true,
          restartPending: false,
          blockers: [],
          waitingParticipants: [],
          attempts: [attempt],
          incidents: [],
          rejectedResults: [],
          actions: []
        },
        engine: {
          attempts: [{
            id: attempt.id,
            stageId: attempt.stageId,
            attemptNumber: attempt.attemptNumber,
            goSourceId: "offline-expired-go",
            goAtMs: attempt.goAtMs,
            deadlineAtMs: attempt.deadlineAtMs,
            open: true,
            voided: false
          }],
          scoreboardVersions: [],
          anomalies: [],
          currentScoreboard: []
        },
        mapEchoPrefixes: {}
      }
    }), record.id);

    const restoredService = new CompetitionService(undefined, { database, dataRoot });
    const restored = restoredService.snapshot(record.id);
    expect(restored.runtime).toMatchObject({
      phase: "paused",
      currentStageId: "sr-1",
      plannedReadyStageId: "sr-2",
      attempts: [{ stageId: "sr-1", intakeOpen: false, intakeClosedAtMs: expect.any(Number) }]
    });
    expect(restored.runtime.scoreEditPermissions).toContainEqual(expect.objectContaining({
      stageId: "sr-1",
      editable: false
    }));
    const persistedRow = database.sqlite.prepare("SELECT payload FROM runtime_snapshots WHERE competition_id=?")
      .get(record.id) as { payload: string };
    const persisted = JSON.parse(persistedRow.payload) as {
      work: {
        automation: {
          currentStageId: string;
          attempts: Array<{ intakeOpen: boolean; intakeClosedAtMs?: number }>;
          actions: Array<{ kind: string; stageId: string; status: string }>;
        };
        engine: { attempts: Array<{ open: boolean }> };
      };
    };
    expect(persisted.work.automation.currentStageId).toBe("sr-1");
    expect(persisted.work.automation.attempts[0]).toMatchObject({
      intakeOpen: false,
      intakeClosedAtMs: expect.any(Number)
    });
    expect(persisted.work.automation.actions).toContainEqual(expect.objectContaining({
      kind: "announce",
      stageId: "sr-1",
      status: "cancelled"
    }));
    expect(persisted.work.engine.attempts[0]).toMatchObject({ open: false });
    expect(restoredService.journal.after(0)).toContainEqual(expect.objectContaining({
      type: "work.stage-deadline-recovered",
      competitionId: record.id,
      data: expect.objectContaining({ stageChanged: false, intakeChanged: true })
    }));
    await restoredService.close();
  });

  it("recovers sent commands as uncertain and keeps automation paused after restart", async () => {
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
    await first.close();

    const restored = new CompetitionService(undefined, { database, dataRoot }).snapshot(record.id);
    expect(restored.runtime.commands).toContainEqual(expect.objectContaining({ id: "sent-command", status: "uncertain" }));
    expect(restored.runtime.unconfirmedCommands).toEqual([]);
    expect(restored.runtime.blockers.some(item => item.code === "COMMAND_UNCONFIRMED")).toBe(false);
    expect(restored.runtime.observationGaps).toEqual([]);
    expect(restored.runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "命令结果待核实", severity: "warning" }));
    expect(restored.runtime.automationEnabled).toBe(false);
  });

  it("offers an explicit connection recovery before automation can resume", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-connection-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Connection recovery", mode: "test", idempotencyKey: "connection-recovery" });
    service.publish(record.id, 0, "publish-connection-recovery");
    const runId = service.createTestRunFromScenario(record.id, "server-disconnect-fault").runId;
    const runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    runtime.automation.observeServerDisconnect("测试服务器断线");

    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "restart-work", enabled: true }));
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "enable-automation", enabled: false }));
    expect(snapshot.runtime.attentionItems).toContainEqual(expect.objectContaining({ category: "incident", severity: "critical", action: "restart-work" }));
    const confirmation = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "restart-work",
      target: record.id
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "recover-test-connection",
      action: { type: "restart-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });

    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({ phase: "paused", automationEnabled: false, blockers: [] });
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "enable-automation", enabled: true }));
    await service.enableAutomation(record.id, {
      runId,
      readyInMs: 60_000,
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "resume-after-connection"
    });
    expect(service.snapshot(record.id).runtime).toMatchObject({ phase: "preparing", automationEnabled: true });
    await service.close();
  });

  it("records a critical incident when automatic review cannot safely stop MockClient", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Review stop failure", mode: "work", idempotencyKey: "review-stop-failure" });
    service.publish(record.id, 0, "publish-review-stop-failure");
    const manager = workRuntimeManager(service);
    const mutableManager = manager as unknown as {
      get(competitionId: string): WorkRuntime | undefined;
      saveSnapshot(runtime: WorkRuntime): void;
      remove(competitionId: string): Promise<void>;
    };
    const originalGet = mutableManager.get;
    const originalSaveSnapshot = mutableManager.saveSnapshot;
    const originalRemove = mutableManager.remove;
    mutableManager.get = () => ({ competitionId: record.id } as WorkRuntime);
    mutableManager.saveSnapshot = () => undefined;
    mutableManager.remove = async () => { throw new Error("owned process tree still running"); };

    try {
      const internals = service as unknown as {
        completeCompetitionOnReview(competitionId: string, snapshot: ReturnType<CompetitionController["snapshot"]>): void;
      };
      internals.completeCompetitionOnReview(record.id, { phase: "review" } as ReturnType<CompetitionController["snapshot"]>);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      mutableManager.get = originalGet;
      mutableManager.saveSnapshot = originalSaveSnapshot;
      mutableManager.remove = originalRemove;
    }

    const snapshot = service.snapshot(record.id);
    expect(snapshot.competition.status).toBe("finished");
    expect(snapshot.runtime.attentionItems).toContainEqual(expect.objectContaining({
      title: "比赛已结束，但 MockClient 未确认退出",
      severity: "critical",
      action: "delete",
      message: expect.stringContaining("owned process tree still running")
    }));
    await service.close();
  });

  it("gates every live command on a healthy work connection and exposes lifecycle recovery by connection state", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Work connection matrix", mode: "work", idempotencyKey: "work-connection-matrix" });
    service.publish(record.id, 0, "publish-work-connection-matrix");
    const manager = workRuntimeManager(service);
    const writes: string[] = [];
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, {
      write: async (command) => { writes.push(command); }
    });
    manager.register(record.id, runtime);

    const expectedByStatus: ReadonlyArray<{
      status: WorkConnectionStatus;
      lifecycleEnabled: boolean;
      liveWritesEnabled: boolean;
    }> = [
      { status: "connecting", lifecycleEnabled: false, liveWritesEnabled: false },
      { status: "authenticating", lifecycleEnabled: false, liveWritesEnabled: false },
      { status: "healthy", lifecycleEnabled: true, liveWritesEnabled: true },
      { status: "suspect", lifecycleEnabled: true, liveWritesEnabled: false },
      { status: "recovering", lifecycleEnabled: false, liveWritesEnabled: false },
      { status: "blocked", lifecycleEnabled: true, liveWritesEnabled: false }
    ];
    for (const expected of expectedByStatus) {
      runtime.connection = { ...runtime.connection, status: expected.status };
      const actions = service.snapshot(record.id).runtime.availableActions;
      expect(actions.find((action) => action.action === "reconnect-work"), expected.status)
        .toMatchObject({ enabled: expected.lifecycleEnabled });
      expect(actions.find((action) => action.action === "restart-work"), expected.status)
        .toMatchObject({ enabled: expected.lifecycleEnabled });
      expect(actions.find((action) => action.action === "ready"), expected.status)
        .toMatchObject({ enabled: expected.liveWritesEnabled });
      expect(actions.find((action) => action.action === "raw-command"), expected.status)
        .toMatchObject({ enabled: expected.liveWritesEnabled });
    }

    runtime.connection = { ...runtime.connection, status: "healthy", processGeneration: 4, connectionGeneration: 9 };
    const staleLifecycleConfirmation = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "restart-work",
      target: record.id
    });
    runtime.connection = { ...runtime.connection, status: "suspect", connectionGeneration: 10 };
    await expect(service.performAction(record.id, {
      expectedStateVersion: service.snapshot(record.id).competition.stateVersion,
      idempotencyKey: "stale-lifecycle-confirmation",
      action: {
        type: "restart-work",
        confirmationToken: staleLifecycleConfirmation.token,
        impactHash: staleLifecycleConfirmation.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });

    runtime.connection = { ...runtime.connection, status: "blocked" };
    const expectedStateVersion = service.snapshot(record.id).competition.stateVersion;
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "blocked-notification",
      action: { type: "notification", channel: "announce", text: "must not be sent" }
    })).rejects.toMatchObject({ code: "ACTION_UNAVAILABLE", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "blocked-ready",
      action: { type: "ready", confirmationToken: "unused-while-blocked", impactHash: "unused-while-blocked" }
    })).rejects.toMatchObject({ code: "ACTION_UNAVAILABLE", statusCode: 409 });
    const rawConfirmation = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "raw-command",
      target: record.id,
      command: "scores"
    });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "blocked-raw-command",
      action: {
        type: "raw-command",
        command: "scores",
        confirmationToken: rawConfirmation.token,
        impactHash: rawConfirmation.impactHash
      }
    })).rejects.toMatchObject({ code: "ACTION_UNAVAILABLE", statusCode: 409 });
    expect(writes).toEqual([]);

    const draft = service.create({ name: "Draft connection matrix", mode: "work", idempotencyKey: "draft-connection-matrix" });
    const draftRuntime = manager.makeRuntime(draft.id, service.snapshot(draft.id).config, { write: async () => undefined });
    manager.register(draft.id, draftRuntime);
    const draftActions = service.snapshot(draft.id).runtime.availableActions;
    expect(draftActions.find((action) => action.action === "reconnect-work")).toMatchObject({ enabled: false });
    expect(draftActions.find((action) => action.action === "restart-work")).toMatchObject({ enabled: false });
    await service.close();
  });

  it("persists work connection generations but exposes an offline runtime only through start-work recovery", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-connection-snapshot-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Persisted connection", mode: "work", idempotencyKey: "persisted-connection" });
    service.publish(record.id, 0, "publish-persisted-connection");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    runtime.connection = {
      status: "healthy",
      processGeneration: 4,
      connectionGeneration: 9,
      refereeConnectionId: "314159",
      recentServerEvidence: {
        kind: "list-verified",
        occurredAt: "2026-07-22T10:00:00.000Z",
        detail: "authenticated before service stop",
        processGeneration: 4,
        connectionGeneration: 9
      }
    };
    manager.register(record.id, runtime);
    manager.saveSnapshot(runtime);
    await service.close();

    service = new CompetitionService(undefined, { database, dataRoot });
    const restored = service.snapshot(record.id);
    expect(restored.runtime.workConnection).toMatchObject({
      status: "blocked",
      processGeneration: 4,
      connectionGeneration: 9,
      recentServerEvidence: expect.objectContaining({ kind: "list-verified" })
    });
    expect(restored.runtime.workConnection).not.toHaveProperty("refereeConnectionId");
    expect(restored.runtime.availableActions.find((action) => action.action === "start-work"))
      .toMatchObject({ enabled: true });
    expect(restored.runtime.availableActions.find((action) => action.action === "reconnect-work"))
      .toMatchObject({ enabled: false });
    expect(restored.runtime.availableActions.find((action) => action.action === "restart-work"))
      .toMatchObject({ enabled: false });
    await service.close();
  });

  it("recovers a sent Go as acknowledged when the persisted authoritative attempt proves execution", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-proven-command-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const first = new CompetitionService(undefined, { database, dataRoot });
    const record = first.create({ name: "Proven recovery", mode: "work", idempotencyKey: "create-proven-recovery" });
    const now = new Date().toISOString();
    const command = {
      id: "sent-go", idempotencyKey: "automation-go", action: { type: "go", map: "level 1", mode: "sr" }, command: "countdown level 1 sr",
      status: "sent", createdAt: now, updatedAt: now
    };
    database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(command.id, record.id, command.idempotencyKey, "go", "sent", JSON.stringify(command), now, now);
    const automation = {
      phase: "running", stateVersion: 5, automationEnabled: true, currentStageId: "sr-1", blockers: [], waitingParticipants: [], incidents: [], rejectedResults: [],
      attempts: [{ id: "attempt-1", stageId: "sr-1", attemptNumber: 1, goAtMs: 20, deadlineAtMs: 60_020, intakeOpen: true, voided: false, results: [] }],
      actions: [{ id: "go-action", kind: "go", idempotencyKey: "automation-go", createdAtMs: 10, stageId: "sr-1", map: "level 1", mode: "sr", status: "pending" }]
    };
    database.sqlite.prepare("UPDATE runtime_snapshots SET payload=? WHERE competition_id=?")
      .run(JSON.stringify({ work: { started: true, automation, mapEchoPrefixes: {} } }), record.id);
    await first.close();

    const restored = new CompetitionService(undefined, { database, dataRoot }).snapshot(record.id);
    expect(restored.runtime.commands).toContainEqual(expect.objectContaining({ id: "sent-go", status: "acknowledged" }));
    expect(restored.runtime.attentionItems).not.toContainEqual(expect.objectContaining({ title: "命令结果待核实" }));
  });

  it("restores a running work attempt and requires an auditable observation-gap decision", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-runtime-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Recover running work", mode: "work", idempotencyKey: "recover-running-work" });
    service.publish(record.id, 0, "publish-recover-running-work");
    let manager = workRuntimeManager(service);
    let runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-03 01:00:00] Runner (#41) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-03 01:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-03 01:00:02] (#41, Runner) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    expect(service.snapshot(record.id).runtime.phase).toBe("running");
    expect(service.snapshot(record.id).currentScoreboard).toContainEqual(expect.objectContaining({ playerId: "Runner", points: 15 }));
    await service.close();

    service = new CompetitionService(undefined, { database, dataRoot });
    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.observationGaps).toContainEqual(expect.objectContaining({ code: "SERVICE_RESTART_GAP" }));
    expect(snapshot.runtime.blockers).toContainEqual(expect.objectContaining({ code: "OBSERVATION_GAP", severity: "critical" }));
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "enable-automation", enabled: false }));

    manager = workRuntimeManager(service);
    runtime = manager.makeRuntime(record.id, snapshot.config, { write: async () => undefined });
    manager.register(record.id, runtime);
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({ phase: "paused", pausedFromPhase: "running" });
    expect(snapshot.runtime.attempts).toContainEqual(expect.objectContaining({ stageId: "sr-1", intakeOpen: true }));
    expect(snapshot.currentScoreboard).toContainEqual(expect.objectContaining({ playerId: "Runner", points: 15 }));

    const gap = snapshot.runtime.observationGaps[0];
    if (!gap) throw new Error("missing recovery observation gap");
    const confirmation = service.createConfirmation(record.id, {
      kind: "observation-gap-resolution",
      target: gap.id,
      gapId: gap.id,
      resolution: "continue"
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "continue-after-gap",
      action: { type: "resolve-observation-gap", gapId: gap.id, resolution: "continue", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.observationGaps).toEqual([]);
    expect(snapshot.runtime.blockers.some((blocker) => blocker.code === "OBSERVATION_GAP")).toBe(false);
    await service.enableAutomation(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "resume-after-observation-gap"
    });
    expect(service.snapshot(record.id).runtime).toMatchObject({ phase: "running", automationEnabled: true });
    expect(service.snapshot(record.id).currentScoreboard).toContainEqual(expect.objectContaining({ playerId: "Runner", points: 15 }));
    await service.close();
  });

  it("reads legacy stages as official maps without rewriting immutable published snapshots", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-stage-map-migration-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Legacy maps", mode: "test", idempotencyKey: "legacy-maps" });
    service.publish(record.id, 0, "publish-legacy-maps");
    const stored = database.sqlite.prepare("SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1").get(record.id) as { payload: string };
    const legacy = JSON.parse(stored.payload) as { flow: { startProtectionEnabled?: boolean }; stages: Array<{ mapKind?: string; label: string }> };
    delete legacy.flow.startProtectionEnabled;
    for (const [index, stage] of legacy.stages.entries()) {
      delete stage.mapKind;
      stage.label = `SR ${index + 1}`;
    }
    const immutablePayload = JSON.stringify(legacy);
    database.sqlite.prepare("UPDATE config_versions SET payload=? WHERE competition_id=? AND immutable=1").run(immutablePayload, record.id);

    expect(service.snapshot(record.id).publishedConfig?.stages[0]).toMatchObject({ mapKind: "official", label: "SR1", level: 1 });
    expect(service.snapshot(record.id).publishedConfig?.flow.startProtectionEnabled).toBe(true);
    const afterRead = database.sqlite.prepare("SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1").get(record.id) as { payload: string };
    expect(afterRead.payload).toBe(immutablePayload);
  });

  it("persists the configured and manually toggled start-protection state", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-start-protection-toggle-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Protection toggle", mode: "test", idempotencyKey: "protection-toggle" });
    service.publish(record.id, 0, "publish-protection-toggle");
    service.createTestRunFromScenario(record.id, "normal-player-roster");

    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({ startProtectionEnabled: true, startProtectionUsed: false, startProtectionRemaining: 2 });
    let confirmation = service.createConfirmation(record.id, { kind: "manual-action", intent: "set-start-protection", target: `${record.id}:start-protection:sr-1:true` });
    expect(confirmation.effect).toMatchObject({
      title: "把 SR1 的起跑保护标记为已使用？",
      consequences: expect.arrayContaining(["本关后续掉线不再触发自动延时或作废尝试。"])
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "mark-protection-used",
      action: { type: "set-start-protection", used: true, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    expect(service.snapshot(record.id).runtime.startProtectionUsed).toBe(true);
    await service.close();

    service = new CompetitionService(undefined, { database, dataRoot });
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.startProtectionUsed).toBe(true);
    expect(snapshot.runtime.startProtectionRemaining).toBe(0);
    confirmation = service.createConfirmation(record.id, { kind: "manual-action", intent: "set-start-protection", target: `${record.id}:start-protection:sr-1:false` });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "reset-protection-unused",
      action: { type: "set-start-protection", used: false, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    expect(service.snapshot(record.id).runtime.startProtectionUsed).toBe(false);
    expect(service.snapshot(record.id).runtime.startProtectionRemaining).toBe(2);
    await service.close();
  });

  it("returns button-specific confirmation copy and rejects a token prepared for another action", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Specific confirmations", mode: "work", idempotencyKey: "specific-confirmations" });
    service.publish(record.id, 0, "publish-specific-confirmations");
    const manager = workRuntimeManager(service);
    manager.register(record.id, manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined }));
    const snapshot = service.snapshot(record.id);
    const stageId = snapshot.runtime.currentStageId;
    if (!stageId) throw new Error("missing current stage");

    const readyFlow = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "start-ready-flow",
      target: record.id,
      stageId
    });
    expect(readyFlow.effect).toMatchObject({
      title: "进入 SR1 的 Ready+发令流程？",
      consequences: expect.arrayContaining(["立即发布本关发令预告，并把第一条 Ready 安排在 1 分钟后。"])
    });

    const manualReady = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "ready",
      target: record.id,
      stageId
    });
    expect(manualReady.effect.title).toBe("发送一次 SR1 Ready？");
    await expect(service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "wrong-confirmation-intent",
      action: { type: "start-ready-flow", confirmationToken: manualReady.token, impactHash: manualReady.impactHash }
    })).rejects.toThrow(/确认令牌与当前操作不匹配/);

    const rawCommand = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "raw-command",
      target: record.id,
      command: "list"
    });
    expect(rawCommand.effect.consequences).toContain("将发送：list");
    await expect(service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "changed-command-after-confirmation",
      action: { type: "raw-command", command: "scores", confirmationToken: rawCommand.token, impactHash: rawCommand.impactHash }
    })).rejects.toThrow(/确认令牌与当前操作不匹配/);

    const finish = service.createConfirmation(record.id, { kind: "high-risk", intent: "finish", target: record.id });
    const remove = service.createConfirmation(record.id, { kind: "high-risk", intent: "delete", target: record.id });
    expect(finish.effect.title).toBe("结束比赛“Specific confirmations”？");
    expect(remove.effect).toMatchObject({
      title: "永久删除比赛“Specific confirmations”？",
      consequences: expect.arrayContaining(["已生成的归档文件会保留，但比赛无法从控制台恢复。"])
    });
    await service.close();
  });

  it("binds stage actions to the backend SR3 target and rejects confirmations after target changes", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-stage-target-binding-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Stage target binding", mode: "test", idempotencyKey: "stage-target-binding" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "stage-target-stages",
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-3", order: 3, label: "SR3", level: 3, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-stage-target-binding");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    const runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    const [stage1, stage2, stage3] = runtime.definition.stages;
    if (!stage1 || !stage2 || !stage3) throw new Error("missing three-stage runtime");
    const base = runtime.automation.snapshot();
    const initialSnapshot: ReturnType<CompetitionController["snapshot"]> = {
      ...base,
      phase: "tail-intake",
      stateVersion: 42,
      automationEnabled: true,
      currentStageId: stage2.id,
      plannedReadyAtMs: 120_000,
      plannedReadyStageId: stage3.id,
      nextStagePending: true,
      attempts: [{
        id: "stage-2-attempt",
        stageId: stage2.id,
        attemptNumber: 1,
        goAtMs: 0,
        deadlineAtMs: 600_000,
        intakeOpen: true,
        voided: false,
        results: []
      }],
      actions: [],
      incidents: [],
      rejectedResults: [],
      blockers: []
    };
    const controllerConfiguration = {
      competitionId: record.id,
      participants: runtime.definition.players.map((player) => player.id),
      stages: runtime.definition.stages.map((stage) => ({
        id: stage.id,
        map: `level ${stage.level}`,
        ...(stage.displayName === undefined ? {} : { displayName: stage.displayName }),
        mode: stage.mode.toLowerCase() as "sr" | "hs",
        timeLimitMs: stage.timeLimitMs,
        minimumScoringPlace: stage.minimumScoringPlace
      }))
    };
    runtime.automation = new CompetitionController({ ...controllerConfiguration, initialSnapshot }, runtime.automationClock);

    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "start-ready-flow", targetStageId: "sr-3" }),
      expect.objectContaining({ action: "ready", targetStageId: "sr-3" }),
      expect.objectContaining({ action: "manual-go", targetStageId: "sr-3" }),
      expect.objectContaining({ action: "end-stage", targetStageId: "sr-2", enabled: true })
    ]));
    const confirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "ready",
      target: record.id,
      stageId: "sr-2"
    });
    expect(confirmation).toMatchObject({
      target: "sr-3",
      runtimeStateVersion: 42,
      effect: { title: "发送一次 SR3 Ready？", target: "sr-3" }
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "execute-backend-targeted-sr3-ready",
      action: {
        type: "ready",
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    });
    expect(runtime.automation.snapshot().actions).toContainEqual(expect.objectContaining({
      kind: "ready",
      stageId: "sr-3",
      manual: true
    }));
    const staleConfirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "ready",
      target: record.id,
      stageId: "sr-2"
    });

    const retargetedSnapshot = {
      ...runtime.automation.snapshot(),
      phase: "preparing" as const,
      stateVersion: runtime.automation.snapshot().stateVersion + 1,
      currentStageId: "sr-2",
      nextStagePending: false
    };
    delete retargetedSnapshot.plannedReadyAtMs;
    delete retargetedSnapshot.plannedReadyStageId;
    runtime.automation = new CompetitionController({
      ...controllerConfiguration,
      initialSnapshot: retargetedSnapshot
    }, runtime.automationClock);
    snapshot = service.snapshot(record.id);
    const readyAfterRuntimeChange = snapshot.runtime.availableActions.find((action) => action.action === "ready");
    expect(readyAfterRuntimeChange?.disabledReason).toBeUndefined();
    expect(readyAfterRuntimeChange).toMatchObject({ enabled: true, targetStageId: "sr-2" });
    await expect(service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "stale-ready-target-impact",
      action: {
        type: "ready",
        confirmationToken: staleConfirmation.token,
        impactHash: staleConfirmation.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });

    const pausedFromRunning = {
      ...runtime.automation.snapshot(),
      phase: "paused" as const,
      pausedFromPhase: "running" as const,
      currentStageId: "sr-2",
      nextStagePending: false,
      attempts: initialSnapshot.attempts
    };
    delete pausedFromRunning.plannedReadyAtMs;
    delete pausedFromRunning.plannedReadyStageId;
    const internals = service as unknown as {
      availableActionsFor(competitionId: string, automation: ReturnType<CompetitionController["snapshot"]>): Array<{ action: string; enabled: boolean; targetStageId?: string }>;
    };
    const pausedActions = internals.availableActionsFor(record.id, pausedFromRunning);
    expect(pausedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "start-ready-flow", enabled: false, targetStageId: "sr-2" }),
      expect.objectContaining({ action: "ready", enabled: false, targetStageId: "sr-2" }),
      expect.objectContaining({ action: "manual-go", enabled: false, targetStageId: "sr-2" }),
      expect.objectContaining({ action: "end-stage", enabled: true, targetStageId: "sr-2" })
    ]));
    await service.close();
  });

  it("persists explicit stage recovery across SQLite restart and isolates old uncertain flow actions", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-explicit-stage-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Explicit stage recovery", mode: "test", idempotencyKey: "explicit-stage-recovery" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "explicit-stage-recovery-stages",
      stages: [
        { id: "s1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "s2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-explicit-stage-recovery");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runId, 0);
    const manager = testRuntimeManager(service);
    const runtime = manager.getRuntime(record.id, runId);

    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({ phase: "ready", currentStageId: "s1" });
    expect(snapshot.runtime.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "mark-stage-started", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-reset-stage", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-next-stage", enabled: true, targetStageId: "s2" })
    ]));
    const staleMark = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });

    runtime.automation.manualReady();
    const oldReady = runtime.automation.drainActions().find((action) => action.kind === "ready");
    if (!oldReady) throw new Error("missing old-cycle Ready action");
    runtime.automation.acknowledgeAction(oldReady.id, "uncertain");
    manager.persist(runtime);
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.blockers.length).toBeGreaterThan(0);
    expect(snapshot.runtime.unconfirmedAutomationActions).toContainEqual(expect.objectContaining({
      id: oldReady.id,
      status: "uncertain"
    }));
    expect(snapshot.runtime.availableActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "mark-stage-started", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-reset-stage", enabled: true, targetStageId: "s1" }),
      expect.objectContaining({ action: "force-next-stage", enabled: true, targetStageId: "s2" })
    ]));
    await expect(service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "stale-mark-after-runtime-change",
      action: {
        type: "mark-stage-started",
        stageId: "s1",
        confirmationToken: staleMark.token,
        impactHash: staleMark.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });

    const markConfirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "mark-stage-started-after-blocker",
      action: {
        type: "mark-stage-started",
        stageId: "s1",
        confirmationToken: markConfirmation.token,
        impactHash: markConfirmation.impactHash
      }
    });
    snapshot = service.snapshot(record.id);
    const markedAttempt = runtime.automation.snapshot().attempts.find((attempt) => attempt.stageId === "s1" && !attempt.voided);
    if (!markedAttempt) throw new Error("missing referee-marked attempt");
    expect(markedAttempt.origin).toBe("referee-marked-started");
    expect(markedAttempt.deadlineAtMs - markedAttempt.goAtMs).toBe(200_000);
    expect(snapshot.runtime).toMatchObject({ phase: "running", automationEnabled: true });
    expect(snapshot.runtime.unconfirmedAutomationActions).toEqual([]);
    expect(runtime.automation.snapshot().actions).toContainEqual(expect.objectContaining({
      id: oldReady.id,
      status: "uncertain",
      isolated: true
    }));
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({
      action: "mark-stage-started",
      enabled: true,
      targetStageId: "s1"
    }));

    const firstReceivedAtMs = runtime.automationClock.now();
    const firstPlayer = runtime.definition.players[0];
    if (!firstPlayer) throw new Error("missing test player");
    expect(runtime.automation.recordResult({
      stageId: "s1",
      playerId: firstPlayer.id,
      status: "finished",
      sourceId: "first-marked-result",
      receivedAtMs: firstReceivedAtMs
    })).toBe("accepted");
    runtime.engine.apply({
      atMs: firstReceivedAtMs,
      sourceId: "first-marked-result",
      type: "finish",
      stageId: "s1",
      playerId: firstPlayer.id,
      score: 100,
      elapsedMs: 1_000
    });
    manager.settle(runtime);
    manager.persist(runtime);
    expect(service.snapshot(record.id).currentScoreboard.some((entry) => entry.stages.s1)).toBe(true);

    snapshot = service.snapshot(record.id);
    const resetConfirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "force-reset-stage",
      target: "s1",
      stageId: "s1"
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "force-reset-marked-stage",
      action: {
        type: "force-reset-stage",
        stageId: "s1",
        confirmationToken: resetConfirmation.token,
        impactHash: resetConfirmation.impactHash
      }
    });
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({
      currentStageId: "s1",
      phase: "preparing",
      plannedReadyStageId: "s1",
      attempts: [expect.objectContaining({ id: markedAttempt.id, voided: true, intakeOpen: false })]
    });
    expect(snapshot.currentScoreboard.every((entry) => entry.stages.s1 === undefined)).toBe(true);

    service.advanceTestAutomation(record.id, runId, 60_000);
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.phase).toBe("ready");
    const secondMark = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "mark-stage-started-for-force-next",
      action: {
        type: "mark-stage-started",
        stageId: "s1",
        confirmationToken: secondMark.token,
        impactHash: secondMark.impactHash
      }
    });
    const secondReceivedAtMs = runtime.automationClock.now();
    expect(runtime.automation.recordResult({
      stageId: "s1",
      playerId: firstPlayer.id,
      status: "finished",
      sourceId: "retained-result-before-force-next",
      receivedAtMs: secondReceivedAtMs
    })).toBe("accepted");
    runtime.engine.apply({
      atMs: secondReceivedAtMs,
      sourceId: "retained-result-before-force-next",
      type: "finish",
      stageId: "s1",
      playerId: firstPlayer.id,
      score: 110,
      elapsedMs: 1_000
    });
    manager.settle(runtime);
    manager.persist(runtime);

    snapshot = service.snapshot(record.id);
    const nextConfirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "force-next-stage",
      target: "s2",
      stageId: "s2"
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "force-next-stage-retains-score",
      action: {
        type: "force-next-stage",
        stageId: "s2",
        confirmationToken: nextConfirmation.token,
        impactHash: nextConfirmation.impactHash
      }
    });
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({
      currentStageId: "s2",
      phase: "preparing",
      plannedReadyStageId: "s2"
    });
    expect(snapshot.currentScoreboard).toContainEqual(expect.objectContaining({
      playerId: firstPlayer.id,
      stages: { s1: expect.objectContaining({ sourceId: "retained-result-before-force-next" }) }
    }));
    expect(snapshot.runtime.scoreEditPermissions).toContainEqual(expect.objectContaining({
      stageId: "s1",
      editable: true
    }));

    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime).toMatchObject({
      currentStageId: "s2",
      phase: "paused",
      pausedFromPhase: "preparing",
      plannedReadyStageId: "s2",
      attempts: [
        expect.objectContaining({ id: markedAttempt.id, origin: "referee-marked-started", voided: true }),
        expect.objectContaining({ origin: "referee-marked-started", stageId: "s1", voided: false, intakeOpen: false })
      ]
    });
    expect(snapshot.runtime.unconfirmedAutomationActions).toEqual([]);
    expect(snapshot.currentScoreboard).toContainEqual(expect.objectContaining({
      playerId: firstPlayer.id,
      stages: { s1: expect.objectContaining({ sourceId: "retained-result-before-force-next" }) }
    }));
    await service.close();
  });

  it("rejects stage-recovery confirmations after the active test runtime changes at the same state version", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-runtime-bound-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({
      name: "Runtime-bound recovery confirmation",
      mode: "test",
      idempotencyKey: "runtime-bound-recovery-confirmation"
    });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "runtime-bound-recovery-stages",
      stages: [
        { id: "s1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "s2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-runtime-bound-recovery");
    const runAId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runAId, 0);
    const runA = testRuntimeManager(service).getRuntime(record.id, runAId);
    const markA = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });
    const resetA = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "force-reset-stage",
      target: "s1",
      stageId: "s1"
    });
    const nextA = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "force-next-stage",
      target: "s2",
      stageId: "s2"
    });
    const restartA = service.createConfirmation(record.id, {
      kind: "restart-stage",
      intent: "restart-stage",
      target: "s1",
      stageId: "s1"
    });

    const runBId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runBId, 0);
    const runB = testRuntimeManager(service).getRuntime(record.id, runBId);
    expect(runB.automation.snapshot().stateVersion).toBe(runA.automation.snapshot().stateVersion);
    const expectedStateVersion = service.snapshot(record.id).competition.stateVersion;
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "stale-run-a-mark",
      action: {
        type: "mark-stage-started",
        stageId: "s1",
        confirmationToken: markA.token,
        impactHash: markA.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "stale-run-a-reset",
      action: {
        type: "force-reset-stage",
        stageId: "s1",
        confirmationToken: resetA.token,
        impactHash: resetA.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "stale-run-a-next",
      action: {
        type: "force-next-stage",
        stageId: "s2",
        confirmationToken: nextA.token,
        impactHash: nextA.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "stale-run-a-restart",
      action: {
        type: "restart-stage",
        stageId: "s1",
        confirmationToken: restartA.token,
        impactHash: restartA.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_STALE", statusCode: 409 });
    expect(runA.automation.snapshot().attempts).toEqual([]);
    expect(runB.automation.snapshot().attempts).toEqual([]);

    const markB = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "current-run-b-mark",
      action: {
        type: "mark-stage-started",
        stageId: "s1",
        confirmationToken: markB.token,
        impactHash: markB.impactHash
      }
    })).resolves.toMatchObject({ actionType: "mark-stage-started" });
    expect(runA.automation.snapshot().attempts).toEqual([]);
    expect(runB.automation.snapshot().attempts).toContainEqual(expect.objectContaining({
      stageId: "s1",
      origin: "referee-marked-started"
    }));
    await service.close();
  });

  it("relocates a restored work controller without shifting its wall-clock engine attempt", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-attempt-time-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({
      name: "Work attempt time recovery",
      mode: "work",
      idempotencyKey: "work-attempt-time-recovery"
    });
    service.publish(record.id, 0, "publish-work-attempt-time-recovery");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(
      record.id,
      service.snapshot(record.id).config,
      { write: async () => undefined }
    );
    manager.register(record.id, runtime);
    runtime.client = {
      flushLog: () => ({ streamGeneration: 0, byteOffset: 0 })
    } as unknown as NonNullable<WorkRuntime["client"]>;
    const stageId = runtime.controller.snapshot().currentStageId;
    const restart = runtime.controller.issueStageRestartConfirmation(stageId);
    runtime.controller.confirmStageRestart({
      stageId,
      impactHash: restart.impactHash,
      token: restart.token,
      reason: "prepare referee-marked attempt"
    });
    const marked = manager.markCurrentStageStarted(runtime, stageId);
    const storedEngineAttempt = runtime.engine.snapshot().attempts.find((attempt) => attempt.id === marked.id);
    if (!storedEngineAttempt) throw new Error("missing stored work engine attempt");
    const persistedGoWallMs = storedEngineAttempt.goAtMs;
    const persistedDeadlineWallMs = storedEngineAttempt.deadlineAtMs;

    delete runtime.client;
    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    const restored = workRuntimeManager(service).makeRuntime(
      record.id,
      service.snapshot(record.id).config,
      { write: async () => undefined }
    );
    const restoredControllerAttempt = restored.controller.snapshot().attempts.find((attempt) => attempt.id === marked.id);
    const restoredEngineAttempt = restored.engine.snapshot().attempts.find((attempt) => attempt.id === marked.id);
    if (!restoredControllerAttempt || !restoredEngineAttempt) throw new Error("missing restored work attempt");
    const restoredOrigin = restored.controller.snapshot().wallClockOriginMs;
    if (restoredOrigin === undefined) throw new Error("missing restored wall-clock origin");

    expect(restoredEngineAttempt).toMatchObject({
      origin: "referee-marked-started",
      goAtMs: persistedGoWallMs,
      deadlineAtMs: persistedDeadlineWallMs
    });
    expect(restoredOrigin + restoredControllerAttempt.goAtMs).toBe(persistedGoWallMs);
    expect(restoredOrigin + restoredControllerAttempt.deadlineAtMs).toBe(persistedDeadlineWallMs);
    await service.close();
  });

  it("persists and relocates the delayed launch Bulletin with its authoritative Go across service recreation", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-delayed-bulletin-recovery-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Delayed launch notice", mode: "work", idempotencyKey: "delayed-launch" });
    service.publish(record.id, 0, "publish-delayed-launch");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.controller.observeAuthoritativeGo();
    manager.saveSnapshot(runtime);
    const original = runtime.controller.snapshot();
    const bulletin = original.actions.find(item => item.notBeforeMs !== undefined)!;
    expect(bulletin.notBeforeMs! - original.attempts[0]!.goAtMs).toBeCloseTo(1_000, 4);
    await service.close();
    database.close();
    database = openDatabase(join(dataRoot, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot });
    const restored = workRuntimeManager(service).makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    workRuntimeManager(service).register(record.id, restored);
    const state = restored.controller.snapshot();
    const pending = state.actions.find(item => item.id === bulletin.id)!;
    expect(pending).toMatchObject({ status: "pending", undelivered: true });
    expect(pending.notBeforeMs! - state.attempts[0]!.goAtMs).toBeCloseTo(1_000, 4);
    expect(state.wallClockOriginMs! + pending.notBeforeMs!).toBeCloseTo(original.wallClockOriginMs! + bulletin.notBeforeMs!, 2);
    expect(restored.controller.drainDispatchableActions()).toEqual([]);
    restored.controller.observeAuthoritativeGo();
    expect(restored.controller.snapshot().actions.filter(item => item.notBeforeMs !== undefined)).toHaveLength(1);
    await service.close();
  });

  it("persists a repeated started reset with cleared scores and resumes automatic next-stage planning", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-started-reset-"));
    const dbPath = join(dataRoot, "console.sqlite");
    database = openDatabase(dbPath);
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Started reset", mode: "test", idempotencyKey: "started-reset" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0, idempotencyKey: "stages",
      stages: [1, 2].map(level => ({ id: `s${level}`, order: level, label: `SR${level}`, level, mode: "SR" as const,
        mapKind: "official" as const, timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }))
    });
    service.publish(record.id, 1, "publish");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    const setStarted = async (key: string) => {
      const confirmation = service.createConfirmation(record.id, { kind: "manual-action", intent: "mark-stage-started", target: "s1", stageId: "s1" });
      await service.performAction(record.id, {
        expectedStateVersion: service.snapshot(record.id).competition.stateVersion, idempotencyKey: key,
        action: { type: "mark-stage-started", stageId: "s1", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
      });
    };
    // First mark is allowed directly from the lobby, before any Ready or Go.
    await setStarted("first");
    let runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    const first = runtime.automation.snapshot().attempts[0]!;
    const player = runtime.definition.players[0]!;
    const atMs = runtime.automationClock.now();
    runtime.automation.recordResult({ stageId: "s1", playerId: player.id, status: "finished", sourceId: "old-score", receivedAtMs: atMs });
    runtime.engine.apply({ type: "finish", stageId: "s1", playerId: player.id, sourceId: "old-score", atMs, score: 100, elapsedMs: 0 });
    testRuntimeManager(service).settle(runtime);
    expect(service.snapshot(record.id).currentScoreboard.some(entry => entry.stages.s1)).toBe(true);
    runtime.automationClock.advanceBy(1_000);
    await setStarted("second");
    const second = runtime.automation.snapshot().attempts[1]!;
    expect(second).toMatchObject({ goAtMs: atMs + 1_000, deadlineAtMs: atMs + 201_000, voided: false });
    expect(service.snapshot(record.id).currentScoreboard.every(entry => !entry.stages.s1)).toBe(true);
    await service.close();
    database.close();
    database = openDatabase(dbPath);
    service = new CompetitionService(undefined, { database, dataRoot });
    const restored = service.snapshot(record.id);
    expect(restored.runtime).toMatchObject({ phase: "paused", pausedFromPhase: "running" });
    expect(restored.runtime.attempts).toEqual([
      expect.objectContaining({ id: first.id, voided: true }), expect.objectContaining({ id: second.id, voided: false, goAtMs: second.goAtMs })
    ]);
    expect(restored.currentScoreboard.every(entry => !entry.stages.s1)).toBe(true);
    runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    runtime.automation.enable();
    for (const [index, participant] of runtime.definition.players.slice(0, 3).entries()) {
      runtime.automation.recordResult({ stageId: "s1", playerId: participant.id, status: "finished", sourceId: `new-${index}`, receivedAtMs: runtime.automationClock.now() });
    }
    expect(runtime.automation.snapshot()).toMatchObject({ automationEnabled: true, phase: "tail-intake", plannedReadyStageId: "s2" });
    testRuntimeManager(service).settle(runtime);
    expect(runtime.automation.snapshot().actions).toContainEqual(expect.objectContaining({ kind: "bulletin", stageId: "s2", status: "acknowledged" }));
    await service.close();
  });

  it("rolls back a failed stage-recovery transaction, restores its confirmation, and replays the durable receipt after restart", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-stage-recovery-uow-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Stage recovery UOW", mode: "test", idempotencyKey: "stage-recovery-uow" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "stage-recovery-uow-stages",
      stages: [
        { id: "s1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "s2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 200_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-stage-recovery-uow");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runId, 0);
    const runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    const beforeCompetition = service.snapshot(record.id).competition;
    const beforeController = runtime.automation.snapshot();
    const beforeEngine = runtime.engine.snapshot();
    const beforePayload = (database.sqlite.prepare(
      "SELECT state_version,payload FROM runtime_snapshots WHERE competition_id=?"
    ).get(record.id) as { state_version: number; payload: string });
    const beforeJournal = service.journal.after(0)?.length ?? 0;
    const confirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "mark-stage-started",
      target: "s1",
      stageId: "s1"
    });
    const input = {
      expectedStateVersion: beforeCompetition.stateVersion,
      idempotencyKey: "stage-recovery-uow-mark",
      action: {
        type: "mark-stage-started" as const,
        stageId: "s1",
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    };

    database.sqlite.exec(`
      CREATE TEMP TRIGGER fail_stage_recovery_receipt
      BEFORE INSERT ON action_receipts
      BEGIN
        SELECT RAISE(FAIL, 'injected stage recovery receipt failure');
      END
    `);
    await expect(service.performAction(record.id, input)).rejects.toThrow(/injected stage recovery receipt failure/);
    database.sqlite.exec("DROP TRIGGER fail_stage_recovery_receipt");

    expect(runtime.automation.snapshot()).toEqual(beforeController);
    expect(runtime.engine.snapshot()).toEqual(beforeEngine);
    expect(service.snapshot(record.id).competition).toEqual(beforeCompetition);
    expect(database.sqlite.prepare(
      "SELECT state_version,payload FROM runtime_snapshots WHERE competition_id=?"
    ).get(record.id)).toEqual(beforePayload);
    expect((database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM command_audits WHERE competition_id=? AND idempotency_key=?"
    ).get(record.id, input.idempotencyKey) as { count: number }).count).toBe(0);
    expect((database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM action_receipts WHERE competition_id=? AND idempotency_key=?"
    ).get(record.id, input.idempotencyKey) as { count: number }).count).toBe(0);
    expect(service.journal.after(0)?.length).toBe(beforeJournal);

    const committed = await service.performAction(record.id, input);
    expect(runtime.automation.snapshot()).toMatchObject({
      phase: "running",
      automationEnabled: true,
      attempts: [expect.objectContaining({ stageId: "s1", origin: "referee-marked-started" })]
    });
    const committedStateVersion = service.snapshot(record.id).competition.stateVersion;
    expect((database.sqlite.prepare(
      "SELECT state_version FROM runtime_snapshots WHERE competition_id=?"
    ).get(record.id) as { state_version: number }).state_version).toBe(committedStateVersion);
    await expect(service.performAction(record.id, {
      ...input,
      expectedStateVersion: -123
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });

    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    await expect(service.performAction(record.id, input)).resolves.toEqual(committed);
    await expect(service.performAction(record.id, {
      ...input,
      expectedStateVersion: -456
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion: input.expectedStateVersion,
      idempotencyKey: input.idempotencyKey,
      action: {
        type: "force-reset-stage",
        stageId: "s1",
        confirmationToken: "not-consumed-because-receipt-conflicts-first",
        impactHash: "different-action"
      }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(service.performAction(record.id, {
      expectedStateVersion: input.expectedStateVersion,
      idempotencyKey: input.idempotencyKey,
      action: {
        ...input.action,
        confirmationToken: "new-cycle-confirmation",
        impactHash: "new-cycle-impact"
      }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await service.close();
  });

  it("restores a consumed stage-recovery confirmation when checkpoint setup fails before the unit of work starts", async () => {
    const service = new CompetitionService();
    const record = service.create({
      name: "Stage recovery checkpoint failure",
      mode: "work",
      idempotencyKey: "stage-recovery-checkpoint-failure"
    });
    service.publish(record.id, 0, "publish-stage-recovery-checkpoint-failure");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(
      record.id,
      service.snapshot(record.id).config,
      { write: async () => undefined }
    );
    manager.register(record.id, runtime);
    runtime.client = {
      flushLog: () => ({ streamGeneration: 0, byteOffset: 0 })
    } as unknown as NonNullable<WorkRuntime["client"]>;
    const stageId = runtime.controller.snapshot().currentStageId;
    const confirmation = service.createConfirmation(record.id, {
      kind: "restart-stage",
      intent: "restart-stage",
      target: stageId
    });
    const input = {
      expectedStateVersion: service.snapshot(record.id).competition.stateVersion,
      idempotencyKey: "retry-after-checkpoint-failure",
      action: {
        type: "restart-stage" as const,
        stageId,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    };
    runtime.preparedStageRecovery = {
      stageId,
      supersession: { actionKeys: [], previews: [] }
    };

    await expect(service.performAction(record.id, input)).rejects.toThrow("STAGE_RECOVERY_ALREADY_PREPARED");
    delete runtime.preparedStageRecovery;
    await expect(service.performAction(record.id, input)).resolves.toMatchObject({
      actionType: "restart-stage"
    });
    expect(runtime.controller.snapshot()).toMatchObject({
      currentStageId: stageId,
      phase: "ready"
    });

    delete runtime.client;
    await service.close();
  });

  it("refuses to overwrite an older durable command audit when an idempotency key is reused after restart", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-durable-idempotency-collision-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({
      name: "Durable idempotency collision",
      mode: "test",
      idempotencyKey: "durable-idempotency-competition"
    });
    service.publish(record.id, 0, "publish-durable-idempotency-collision");
    service.createTestRunFromScenario(record.id, "normal-player-roster");
    const idempotencyKey = "durable-notification-key";
    const before = service.snapshot(record.id);
    await service.performAction(record.id, {
      expectedStateVersion: before.competition.stateVersion,
      idempotencyKey,
      action: { type: "notification", channel: "notice", text: "保留这条原始审计" }
    });
    const storedBeforeRestart = database.sqlite.prepare(
      "SELECT id,action_type,status,payload,created_at,updated_at FROM command_audits WHERE competition_id=? AND idempotency_key=?"
    ).get(record.id, idempotencyKey);

    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    await expect(service.performAction(record.id, {
      expectedStateVersion: service.snapshot(record.id).competition.stateVersion,
      idempotencyKey,
      action: { type: "notification", channel: "notice", text: "试图覆盖旧审计" }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(database.sqlite.prepare(
      "SELECT id,action_type,status,payload,created_at,updated_at FROM command_audits WHERE competition_id=? AND idempotency_key=?"
    ).get(record.id, idempotencyKey)).toEqual(storedBeforeRestart);
    await service.close();
  });

  it("rejects generic or input-unbound confirmations for lifecycle and raw actions", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Strict confirmation binding", mode: "work", idempotencyKey: "strict-confirmation-binding" });
    service.publish(record.id, 0, "publish-strict-confirmation-binding");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    manager.register(record.id, runtime);
    const expectedStateVersion = service.snapshot(record.id).competition.stateVersion;

    for (const actionType of ["reconnect-work", "restart-work"] as const) {
      const correctlyBound = service.createConfirmation(record.id, {
        kind: "high-risk",
        intent: actionType,
        target: record.id
      });
      const generic = service.createConfirmation(record.id, {
        kind: "high-risk",
        target: correctlyBound.target
      });
      await expect(service.performAction(record.id, {
        expectedStateVersion,
        idempotencyKey: `generic-${actionType}`,
        action: {
          type: actionType,
          confirmationToken: generic.token,
          impactHash: generic.impactHash
        }
      })).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", statusCode: 409 });
    }

    const genericRaw = service.createConfirmation(record.id, { kind: "high-risk", target: record.id });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "generic-raw-command",
      action: {
        type: "raw-command",
        command: "scores",
        confirmationToken: genericRaw.token,
        impactHash: genericRaw.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", statusCode: 409 });

    const inputUnboundRaw = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "raw-command",
      target: record.id
    });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "input-unbound-raw-command",
      action: {
        type: "raw-command",
        command: "scores",
        confirmationToken: inputUnboundRaw.token,
        impactHash: inputUnboundRaw.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", statusCode: 409 });

    const genericManual = service.createConfirmation(record.id, {
      kind: "manual-action",
      target: record.id
    });
    await expect(service.performAction(record.id, {
      expectedStateVersion,
      idempotencyKey: "generic-ready-flow",
      action: {
        type: "start-ready-flow",
        confirmationToken: genericManual.token,
        impactHash: genericManual.impactHash
      }
    })).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", statusCode: 409 });

    await service.close();
  });

  it("persists the remaining fatal-only protection through SQLite shutdown and restores both on reset", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-two-protections-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Two protections", mode: "work", idempotencyKey: "two-protections" });
    service.publish(record.id, 0, "publish-two-protections");
    const config = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    let manager = workRuntimeManager(service);
    let runtime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.controller.registerParticipant("p1");
    runtime.controller.enable(0);
    for (const action of runtime.controller.drainActions()) runtime.controller.acknowledgeAction(action.id, "acknowledged");
    runtime.controller.tick();
    runtime.controller.observeConnection("p1", false);
    manager.saveSnapshot(runtime);
    expect(service.snapshot(record.id).runtime.startProtectionRemaining).toBe(1);
    await service.close();
    database.close();

    database = openDatabase(join(dataRoot, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot });
    manager = workRuntimeManager(service);
    runtime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    manager.register(record.id, runtime);
    expect(service.snapshot(record.id).runtime.startProtectionRemaining).toBe(1);
    expect(() => service.createConfirmation(record.id, {
      kind: "manual-action", intent: "set-start-protection", target: `${record.id}:start-protection:sr-1:true`
    })).not.toThrow();
    const snapshot = service.snapshot(record.id);
    const confirmation = service.createConfirmation(record.id, {
      kind: "manual-action", intent: "set-start-protection", target: `${record.id}:start-protection:sr-1:false`
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: "restore-both",
      action: { type: "set-start-protection", used: false, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });
    expect(service.snapshot(record.id).runtime.startProtectionRemaining).toBe(2);
    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    expect(service.snapshot(record.id).runtime.startProtectionRemaining).toBe(2);
    await service.close();
  });

  it("binds start-protection confirmations to the current stage and persists work-mode changes immediately", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-start-protection-toggle-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Work protection toggle", mode: "work", idempotencyKey: "work-protection-toggle" });
    service.publish(record.id, 0, "publish-work-protection-toggle");
    const manager = workRuntimeManager(service);
    const config = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    manager.register(record.id, runtime);

    expect(() => service.createConfirmation(record.id, {
      kind: "manual-action",
      target: `${record.id}:start-protection:sr-2:true`
    })).toThrowError(/目标关或目标状态已经变化/);

    const snapshot = service.snapshot(record.id);
    const confirmation = service.createConfirmation(record.id, {
      kind: "manual-action",
      intent: "set-start-protection",
      target: `${record.id}:start-protection:sr-1:true`
    });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "mark-work-protection-used",
      action: { type: "set-start-protection", used: true, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });

    const restoredRuntime = manager.makeRuntime(record.id, config, { write: async () => undefined });
    expect(restoredRuntime.controller.snapshot().startProtectionUsedStageIds).toEqual(["sr-1"]);
    await service.close();
  });

  it("disables manual start-protection control when the published config opts out", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-no-start-protection-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "No protection", mode: "test", idempotencyKey: "no-protection" });
    const config = service.snapshot(record.id).config;
    service.updateDraft(record.id, { expectedStateVersion: 0, idempotencyKey: "disable-protection", flow: { ...config.flow, startProtectionEnabled: false } });
    service.publish(record.id, 1, "publish-no-protection");
    service.createTestRunFromScenario(record.id, "normal-player-roster");
    expect(service.snapshot(record.id).runtime.availableActions.find((action) => action.action === "set-start-protection")).toMatchObject({
      enabled: false,
      disabledReason: "比赛配置未启用起跑保护"
    });
    expect(() => service.createConfirmation(record.id, {
      kind: "manual-action",
      target: `${record.id}:start-protection:sr-1:true`
    })).toThrowError(/比赛配置未启用起跑保护/);
    await service.close();
  });

  it("closes timed-out stages without inventing DNF results or MockClient DNF lines", () => {
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
    expect(timedOut).toHaveLength(0);
    expect(rawDnfLines).toHaveLength(explicitDnf.length);
    expect(service.snapshot(record.id).runtime.attentionItems.some((item) => item.id.startsWith("deadline:"))).toBe(false);
  });

  it("models player Warning as deterministic behavior instead of a scenario fault", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Warning behavior", mode: "test", idempotencyKey: "warning-behavior" });
    service.publish(record.id, 0, "publish-warning-behavior");
    expect(service.listTestScenarios().find((scenario) => scenario.id === "disruptor-player-roster")?.faults).toBe(0);
    const runId = service.createTestRunFromScenario(record.id, "disruptor-player-roster").runId;
    service.startTestAutomation(record.id, runId);
    service.advanceTestAutomation(record.id, runId, 360_000);

    const snapshot = service.snapshot(record.id);
    expect(service.getRawClientLogs(record.id, 1_000).some((line) => line.rawLine.includes("[Warning]"))).toBe(true);
    expect(snapshot.currentScoreboard.some((entry) => entry.stages["sr-1"] && (entry.stages["sr-1"] as { status?: string }).status === "excluded")).toBe(true);
    expect(snapshot.runtime.incidents).toEqual([]);
    expect(snapshot.runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "违规成绩已排除" }));
    await service.close();
  });

  it.each([
    { seed: 1, expectedLastViolation: "warning" },
    { seed: 2, expectedLastViolation: "cheat" }
  ] as const)("keeps a final $expectedLastViolation exclusion and its finish evidence on the old attempt across an immediate T-60 boundary", async ({
    seed,
    expectedLastViolation
  }) => {
    dataRoot = mkdtempSync(join(tmpdir(), `ballance-atomic-${expectedLastViolation}-boundary-`));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({
      name: `Atomic ${expectedLastViolation} boundary`,
      mode: "test",
      idempotencyKey: `atomic-${expectedLastViolation}-boundary`
    });
    const initialConfig = service.snapshot(record.id).config;
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: `atomic-${expectedLastViolation}-config`,
      flow: { ...initialConfig.flow, intermissionMs: 30_000 },
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, `publish-atomic-${expectedLastViolation}-boundary`);

    const players = Array.from({ length: 15 }, (_unused, index) => ({
      id: `p${index + 1}`,
      displayName: `Player ${index + 1}`,
      connectionId: String(700 + index),
      profile: "disruptor" as const
    }));
    const lastPlayer = [...players].sort((left, right) => {
      const leftDelay = Math.round(20_000 + seededBehaviorRandom(seed, "sr-1", 1, left.id, "disrupt-time") * 70_000);
      const rightDelay = Math.round(20_000 + seededBehaviorRandom(seed, "sr-1", 1, right.id, "disrupt-time") * 70_000);
      return leftDelay - rightDelay || left.id.localeCompare(right.id);
    }).at(-1);
    if (!lastPlayer) throw new Error("missing final disruptor");
    const lastViolation = seededBehaviorRandom(seed, "sr-1", 1, lastPlayer.id, "disrupt-kind") < 0.5
      ? "warning"
      : "cheat";
    expect(lastViolation).toBe(expectedLastViolation);

    const definition: ScenarioDefinition = {
      schemaVersion: 1,
      kind: "player-behavior",
      id: `atomic-${expectedLastViolation}-scenario`,
      name: `Atomic ${expectedLastViolation} scenario`,
      year: 2026,
      timezone: "Asia/Shanghai",
      refereeConnectionId: "atomic-referee",
      randomSeed: seed,
      players,
      stages: [],
      events: [],
      expected: { attempts: 2, scoreboardVersions: 30 }
    };
    const runId = service.createTestRun(record.id, definition).runId;
    service.startTestAutomation(record.id, runId);
    service.advanceTestAutomation(record.id, runId, 130_000);

    const runtime = testRuntimeManager(service).getRuntime(record.id, runId);
    const automation = runtime.automation.snapshot();
    const engine = runtime.engine.snapshot();
    const controllerAttempt = automation.attempts.find((attempt) => attempt.stageId === "sr-1");
    const engineAttempt = engine.attempts.find((attempt) => attempt.stageId === "sr-1");
    expect(automation).toMatchObject({
      phase: "preparing",
      currentStageId: "sr-2",
      plannedReadyStageId: "sr-2"
    });
    expect(controllerAttempt).toMatchObject({ intakeOpen: false, voided: false });
    expect(engineAttempt).toMatchObject({ open: false, voided: false });
    expect(controllerAttempt?.results).toHaveLength(players.length);

    const engineResultByPlayer = new Map(engine.currentScoreboard.map((entry) => [entry.playerId, entry.stages["sr-1"]]));
    for (const result of controllerAttempt?.results ?? []) {
      expect(result).toMatchObject({ status: "excluded", finishSourceId: expect.any(String) });
      expect(engineResultByPlayer.get(result.playerId)).toMatchObject({
        status: "excluded",
        finishSourceId: result.finishSourceId
      });
    }
    expect(engine.currentScoreboard.every((entry) => entry.stages["sr-2"] === undefined)).toBe(true);
    expect(engine.anomalies.filter((anomaly) => anomaly.code === "practice-result")).toEqual([]);

    const exclusionAttentions = service.snapshot(record.id).runtime.attentionItems
      .filter((item) => item.id.startsWith("excluded:"));
    expect(exclusionAttentions).toHaveLength(players.length);
    expect(exclusionAttentions.every((item) => item.stageId === "sr-1")).toBe(true);
    await service.close();
  });

  it("keeps accepting post-threshold finishes before the next T-60 preparation boundary", () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Tail intake accepts finishes", mode: "test", idempotencyKey: "tail-intake-finish" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "short-two-stages",
      stages: [
        { id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 },
        { id: "sr-2", order: 2, label: "SR2", level: 2, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3 }
      ]
    });
    service.publish(record.id, 1, "publish-tail-intake-finish");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runId);
    service.advanceTestAutomation(record.id, runId, 200_000);
    const snapshot = service.snapshot(record.id);
    const stage1Finished = snapshot.currentScoreboard
      .map((entry) => entry.stages["sr-1"])
      .filter((result): result is { status?: string } => Boolean(result))
      .filter((result) => result.status === "finished");
    expect(stage1Finished.length).toBeGreaterThan(3);
  });

  it("lets the referee confirm or explicitly resend each uncertain automation command", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Resolve uncertain", mode: "test", idempotencyKey: "resolve-uncertain" });
    service.publish(record.id, 0, "publish-resolve-uncertain");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    const internals = service as unknown as {
      runtimeAutomationSnapshot(competitionId: string): ReturnType<CompetitionController["snapshot"]>;
    };
    const controller = testRuntimeManager(service).getRuntime(record.id, runId).automation;

    controller.enable(0);
    for (const initial of controller.drainActions()) controller.acknowledgeAction(initial.id, "acknowledged");
    controller.tick();
    const due = controller.drainActions();
    const ready = due.find((action) => action.kind === "ready");
    for (const action of due.filter((candidate) => candidate.id !== ready?.id)) controller.acknowledgeAction(action.id, "acknowledged");
    expect(ready).toBeDefined();
    controller.acknowledgeAction(ready!.id, "uncertain");
    expect(service.snapshot(record.id).runtime.unconfirmedAutomationActions).toEqual([
      expect.objectContaining({ id: ready!.id, status: "uncertain" })
    ]);
    expect(internals.runtimeAutomationSnapshot(record.id).actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ready!.id, status: "uncertain" })
    ]));
    const confirmExecuted = service.createConfirmation(record.id, {
      kind: "automation-command-resolution",
      target: ready!.id,
      actionId: ready!.id,
      resolution: "confirm-executed"
    });
    await service.performAction(record.id, {
      expectedStateVersion: 1,
      idempotencyKey: "confirm-bulletin",
      action: {
        type: "resolve-automation-command",
        actionId: ready!.id,
        resolution: "confirm-executed",
        confirmationToken: confirmExecuted.token,
        impactHash: confirmExecuted.impactHash
      }
    });
    expect(controller.snapshot().actions.find((action) => action.id === ready!.id)?.status).toBe("referee-confirmed");

    controller.enable();
    controller.manualReady();
    const retryReady = controller.drainActions().find((action) => action.kind === "ready");
    expect(retryReady).toBeDefined();
    controller.acknowledgeAction(retryReady!.id, "failed");
    const resend = service.createConfirmation(record.id, {
      kind: "automation-command-resolution",
      target: retryReady!.id,
      actionId: retryReady!.id,
      resolution: "resend"
    });
    await service.performAction(record.id, {
      expectedStateVersion: 2,
      idempotencyKey: "resend-ready",
      action: {
        type: "resolve-automation-command",
        actionId: retryReady!.id,
        resolution: "resend",
        confirmationToken: resend.token,
        impactHash: resend.impactHash
      }
    });
    expect(controller.snapshot().actions.find((action) => action.id === retryReady!.id)?.status).toBe("acknowledged");
    expect(service.snapshot(record.id).runtime.attentionItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "流程命令已确认执行" }),
      expect.objectContaining({ title: "流程命令已由裁判执行重发" })
    ]));
  });

  it("keeps missing replies advisory across service recreation without retries or rewriting original audits", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-real-command-resolution-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    let service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Resolve real commands", mode: "work", idempotencyKey: "resolve-real-commands" });
    service.publish(record.id, 0, "publish-resolve-real-commands");
    const manager = workRuntimeManager(service);
    const runtimeHolder: { current?: WorkRuntime } = {};
    const writes: string[] = [];
    const transport: CommandTransport = {
      write: async (command) => {
        writes.push(command);
        setTimeout(() => runtimeHolder.current?.commands.observeLine("Action failed: you don't have the permission to run this action."), 0);
      }
    };
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, transport);
    runtimeHolder.current = runtime;
    manager.register(record.id, runtime);
    const now = new Date().toISOString();
    const originals = [
      { id: "uncertain-raw-confirm", command: "status", status: "uncertain" as const },
      { id: "uncertain-raw-resend", command: "version", status: "uncertain" as const },
      { id: "failed-raw-dismiss", command: "not-a-command", status: "failed" as const }
    ].map((item) => ({
      ...item,
      idempotencyKey: item.id,
      action: { type: "raw" as const, command: item.command },
      createdAt: now,
      updatedAt: now
    }));
    for (const command of originals) {
      database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(command.id, record.id, command.idempotencyKey, "raw", command.status, JSON.stringify(command), now, now);
    }

    const snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.unconfirmedCommands).toEqual([]);
    expect(snapshot.runtime.blockers.some(item => item.code === "COMMAND_UNCONFIRMED")).toBe(false);
    expect(writes).toEqual([]);
    expect(() => service.createConfirmation(record.id, { kind: "command-resolution", target: originals[0]!.id,
      commandId: originals[0]!.id, resolution: "confirm-executed" })).toThrow();
    for (const original of originals) {
      expect(database.sqlite.prepare("SELECT status FROM command_audits WHERE id=?").get(original.id)).toMatchObject({ status: original.status });
    }

    await service.close();
    service = new CompetitionService(undefined, { database, dataRoot });
    expect(service.snapshot(record.id).runtime.unconfirmedCommands).toHaveLength(0);
    expect(service.snapshot(record.id).runtime.blockers.some((blocker) => blocker.code === "COMMAND_UNCONFIRMED")).toBe(false);
  });

  it("uses force restart to supersede unresolved real commands without rewriting their audit status", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-force-restart-commands-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Force restart commands", mode: "work", idempotencyKey: "force-restart-commands" });
    service.publish(record.id, 0, "publish-force-restart-commands");
    const manager = workRuntimeManager(service);
    const runtimeHolder: { current?: WorkRuntime } = {};
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, {
      write: async (command) => {
        if (command.startsWith("countdown ")) {
          runtimeHolder.current?.commands.observeLine("[7, *ContestConsole]: Level 01 - Get ready");
        }
      }
    });
    runtimeHolder.current = runtime;
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);
    runtime.client = {
      flushLog: () => ({ streamGeneration: 0, byteOffset: 0 })
    } as unknown as NonNullable<WorkRuntime["client"]>;
    runtime.runtime = { dispatch: async () => [] } as unknown as WorkRuntime["runtime"];
    const now = new Date().toISOString();
    const unresolved = {
      id: "old-uncertain-raw",
      idempotencyKey: "old-uncertain-raw",
      action: { type: "raw" as const, command: "status" },
      command: "status",
      status: "uncertain" as const,
      createdAt: now,
      updatedAt: now
    };
    database.sqlite.prepare("INSERT INTO command_audits(id,competition_id,idempotency_key,action_type,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(unresolved.id, record.id, unresolved.idempotencyKey, "raw", unresolved.status, JSON.stringify(unresolved), now, now);

    let snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.unconfirmedCommands).toEqual([]);
    expect(snapshot.runtime.availableActions).toContainEqual(expect.objectContaining({ action: "restart-stage", enabled: true }));
    const stageId = snapshot.runtime.currentStageId;
    if (!stageId) throw new Error("missing current stage");
    const confirmation = service.createConfirmation(record.id, { kind: "restart-stage", intent: "restart-stage", target: stageId });
    await service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "force-restart-with-unresolved-command",
      action: { type: "restart-stage", stageId, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }
    });

    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.phase).toBe("ready");
    expect(snapshot.runtime.unconfirmedCommands).toEqual([]);
    expect(database.sqlite.prepare("SELECT status FROM command_audits WHERE id=?").get(unresolved.id)).toMatchObject({ status: "uncertain" });
    manager.ingestLine(runtime, "[07-04 10:00:01] [7, *ContestConsole]: Level 01 - Go!");
    snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.attempts).toEqual([]);
    expect(snapshot.runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "已忽略旧发令周期的 Go 回显" }));
    delete runtime.client;
    await service.close();
  });

  it("rejects forcenextrestart at the real raw-command action boundary", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Reject global Go", mode: "work", idempotencyKey: "reject-global-go" });
    service.publish(record.id, 0, "publish-reject-global-go");
    const manager = workRuntimeManager(service);
    const writes: string[] = [];
    const runtime = manager.makeRuntime(
      record.id,
      service.snapshot(record.id).config,
      { write: async (command) => { writes.push(command); } }
    );
    manager.register(record.id, runtime);
    const snapshot = service.snapshot(record.id);
    const confirmation = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "raw-command",
      target: record.id,
      command: "forcenextrestart"
    });

    await expect(service.performAction(record.id, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "attempt-global-go",
      action: {
        type: "raw-command",
        command: " forcenextrestart ",
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    })).rejects.toThrow(/服务器所有地图/);
    expect(writes).toEqual([]);
  });

  it("treats a rejected stdin write as a transport failure even for read-only commands", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Read-only list failure", mode: "work", idempotencyKey: "read-only-list-failure" });
    service.publish(record.id, 0, "publish-read-only-list-failure");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, {
      write: async () => { throw new Error("transport unavailable"); }
    });
    manager.register(record.id, runtime);

    expect(await runtime.commands.enqueue({ type: "list" }, "failed-read-only-list"))
      .toMatchObject({ status: "timed_out" });
    const snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.unconfirmedCommands).toEqual([]);
    expect(snapshot.runtime.blockers.some((blocker) => blocker.code === "COMMAND_UNCONFIRMED")).toBe(false);
    expect(snapshot.runtime.attentionItems).toContainEqual(expect.objectContaining({ category: "command", severity: "critical" }));
    await service.close();
  });

  it("blocks on rejected stdin writes with connection recovery instead of command confirmation", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Rejected live writes", mode: "work", idempotencyKey: "rejected-live-writes" });
    service.publish(record.id, 0, "publish-rejected-live-writes");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, {
      write: async () => { throw new Error("stdin callback rejected after write attempt"); }
    });
    manager.register(record.id, runtime);

    const results = await Promise.all([
      runtime.commands.enqueue({ type: "ready", map: "level 1", mode: "sr" }, "rejected-ready"),
      runtime.commands.enqueue({ type: "cheat-off" }, "rejected-cheat-off"),
      runtime.commands.enqueue({ type: "set-map", mapHash: "a".repeat(32), displayName: "Recovery_Map" }, "rejected-custom-map"),
      runtime.commands.enqueue({ type: "set-official-map", level: 1, displayName: "Level_01" }, "rejected-official-map")
    ]);
    expect(results.map((result) => result.status)).toEqual(["uncertain", "uncertain", "uncertain", "uncertain"]);

    const snapshot = service.snapshot(record.id);
    expect(snapshot.runtime.unconfirmedCommands).toEqual([]);
    expect(snapshot.runtime.blockers.some(item => item.code === "INCIDENT_OPEN")).toBe(true);
    await service.close();
  });

  it("does not require referee confirmation or resend after missing work command replies", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Work resend", mode: "work", idempotencyKey: "work-resend" });
    service.publish(record.id, 0, "publish-work-resend");
    const writes: string[] = [];
    const runtimeHolder: { current?: WorkRuntime } = {};
    const transport: CommandTransport = {
      write: async (command) => {
        writes.push(command);
        setTimeout(() => runtimeHolder.current!.commands.observeLine("[7, *ContestConsole]: Level 01 - Get ready"), 0);
      }
    };
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, transport);
    runtimeHolder.current = runtime;
    manager.register(record.id, runtime);
    runtime.commands.setRefereeConnectionId("7");
    runtime.controller.enable(0);
    for (const initial of runtime.controller.drainActions()) runtime.controller.acknowledgeAction(initial.id, "acknowledged");
    runtime.controller.tick();
    const due = runtime.controller.drainActions();
    const ready = due.find((action) => action.kind === "ready");
    for (const action of due.filter((candidate) => candidate.id !== ready?.id)) runtime.controller.acknowledgeAction(action.id, "acknowledged");
    runtime.controller.acknowledgeAction(ready!.id, "uncertain");
    expect(() => service.createConfirmation(record.id, {
      kind: "automation-command-resolution", target: ready!.id, actionId: ready!.id, resolution: "resend"
    })).toThrow();
    expect(writes).toEqual([]);
    expect(runtime.controller.snapshot().actions.find(action => action.id === ready!.id)?.status).toBe("sent-unconfirmed");
    await service.close();
  });

  it("binds an idempotency key to one normalized action payload", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Action identity", mode: "work", idempotencyKey: "action-identity" });
    const firstInput = {
      expectedStateVersion: record.stateVersion,
      idempotencyKey: "one-action-only",
      action: {
        type: "player-alias-upsert" as const,
        playerId: "Player One",
        displayName: "Player One"
      }
    };

    const first = await service.performAction(record.id, firstInput);
    await expect(service.performAction(record.id, firstInput)).resolves.toEqual(first);
    await expect(service.performAction(record.id, {
      expectedStateVersion: service.snapshot(record.id).competition.stateVersion,
      idempotencyKey: firstInput.idempotencyKey,
      action: {
        type: "player-alias-upsert",
        playerId: "Player One",
        displayName: "Changed Name"
      }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(service.journal.after(0)?.filter((event) =>
      event.competitionId === record.id && event.type === "command.updated"
    )).toHaveLength(1);
    await service.close();
  });

  it("normalizes the server identity in lifecycle confirmation targets", async () => {
    const service = new CompetitionService();
    const record = service.create({ name: "Normalized lifecycle target", mode: "work", idempotencyKey: "normalized-lifecycle-target" });
    service.publish(record.id, 0, "publish-normalized-server");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).config, { write: async () => undefined });
    manager.register(record.id, runtime);
    runtime.server = " SAME.SERVER. ";

    const first = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "reconnect-work",
      target: record.id
    });
    runtime.server = "same.server";
    const second = service.createConfirmation(record.id, {
      kind: "high-risk",
      intent: "reconnect-work",
      target: record.id
    });

    expect(first.target).toBe(second.target);
    expect(first.target.startsWith("same.server ")).toBe(true);
    await service.close();
  });

  it("recalculates published scores with a live scoring map and restores it for later results", async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-live-scoring-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Live scoring", mode: "work", idempotencyKey: "live-scoring" });
    service.updateDraft(record.id, {
      expectedStateVersion: 0,
      idempotencyKey: "live-scoring-stage",
      scoring: { contestType: "custom", points: [5, 3], minimumScoringPlace: 2, allowNegative: false },
      stages: [{ id: "sr-1", order: 1, label: "SR1", level: 1, mode: "SR", mapKind: "official", timeLimitMs: 600_000, scoring: [5, 3], minimumScoringPlace: 2 }]
    });
    service.publish(record.id, 1, "publish-live-scoring");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);
    establishAuthenticatedReferee(runtime);
    manager.ingestLine(runtime, "[07-03 20:00:00] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-03 20:00:01] (#10, Alpha) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    manager.ingestLine(runtime, "[07-03 20:00:02] (#11, Beta) finished Level 01 in 2nd place (score: 90; real time: 00:00:02.000).");
    expect(service.snapshot(record.id).currentScoreboard.map((entry) => entry.points)).toEqual([5, 3]);

    const beforeUpdate = service.snapshot(record.id);
    const confirmation = service.createConfirmation(record.id, {
      kind: "scoreboard-override",
      intent: "scoreboard-update-scoring",
      target: `${record.id}:scoring`,
      points: [10, 7, 4]
    });
    const updateInput = {
      expectedStateVersion: beforeUpdate.competition.stateVersion,
      idempotencyKey: "update-live-scoring",
      points: [10, 7, 4],
      confirmationToken: confirmation.token,
      impactHash: confirmation.impactHash
    };
    const receiptWrite = vi.spyOn(service as unknown as {
      saveActionReceipt(...args: unknown[]): void;
    }, "saveActionReceipt").mockImplementationOnce(() => { throw new Error("simulated receipt failure"); });
    expect(() => service.updateScoreboardScoring(record.id, updateInput)).toThrow("simulated receipt failure");
    expect(service.snapshot(record.id)).toMatchObject({
      competition: { stateVersion: beforeUpdate.competition.stateVersion },
      activeScoring: { source: "published", points: [5, 3] }
    });
    expect(service.snapshot(record.id).currentScoreboard.map((entry) => entry.points)).toEqual([5, 3]);
    receiptWrite.mockRestore();

    const revised = service.updateScoreboardScoring(record.id, updateInput);
    expect(revised.entries.map((entry) => entry.points)).toEqual([10, 7]);
    expect(revised.entries.map((entry) => entry.change)).toEqual([null, null]);
    const updated = service.snapshot(record.id);
    expect(updated.activeScoring).toMatchObject({ source: "runtime-override", revision: 1, points: [10, 7, 4] });
    expect(updated.publishedConfig?.scoring.points).toEqual([5, 3]);
    expect(updated.scoreboardOverrides[0]).toMatchObject({ targetType: "scoring-config", targetId: "all-stages" });

    manager.saveSnapshot(runtime);
    await service.close();
    const restoredService = new CompetitionService(undefined, { database, dataRoot });
    const restoredManager = workRuntimeManager(restoredService);
    const replayed = restoredService.updateScoreboardScoring(record.id, {
      expectedStateVersion: beforeUpdate.competition.stateVersion,
      idempotencyKey: "update-live-scoring",
      points: [10, 7, 4],
      confirmationToken: confirmation.token,
      impactHash: confirmation.impactHash
    });
    expect(replayed.id).toBe(revised.id);
    expect(restoredService.snapshot(record.id).scoreboardVersions.filter((version) => version.id === revised.id)).toHaveLength(1);
    expect(() => restoredService.updateScoreboardScoring(record.id, {
      expectedStateVersion: beforeUpdate.competition.stateVersion,
      idempotencyKey: "update-live-scoring",
      points: [9, 6, 3],
      confirmationToken: confirmation.token,
      impactHash: confirmation.impactHash
    })).toThrow(/幂等键/);
    const restoredRuntime = restoredManager.makeRuntime(record.id, restoredService.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    restoredManager.register(record.id, restoredRuntime);
    const attempt = restoredRuntime.engine.snapshot().attempts[0];
    if (!attempt) throw new Error("missing restored attempt");
    restoredRuntime.engine.apply({
      type: "finish",
      sourceId: "finish-after-scoring-restore",
      atMs: attempt.goAtMs + 3_000,
      stageId: "sr-1",
      playerId: "Gamma",
      score: 80,
      elapsedMs: 3_000
    });
    expect(restoredRuntime.engine.snapshot().currentScoreboard.find((entry) => entry.playerId === "Gamma")?.points).toBe(4);
    expect(restoredService.snapshot(record.id).activeScoring.points).toEqual([10, 7, 4]);
    await restoredService.close();
  });

  it("allows multiple work competitions but blocks starting two on the same server", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-server-guard-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const first = service.create({ name: "Work A", mode: "work", idempotencyKey: "work-a" });
    const second = service.create({ name: "Work B", mode: "work", idempotencyKey: "work-b" });
    const third = service.create({ name: "Work C", mode: "work", idempotencyKey: "work-c" });
    service.updateDraft(second.id, { expectedStateVersion: 0, idempotencyKey: "work-b-server", server: " SAME.SERVER. " });
    service.updateDraft(third.id, { expectedStateVersion: 0, idempotencyKey: "work-c-server", server: "other.server" });
    service.publish(first.id, 0, "publish-work-a");
    service.publish(second.id, 1, "publish-work-b");
    service.publish(third.id, 1, "publish-work-c");

    const manager = workRuntimeManager(service);
    manager.register(first.id, { server: "same.server" } as WorkRuntime);

    expect(() => service.startWorkMode(second.id)).toThrowError(/已有比赛连接/);
    expect(() => manager.assertServerLeaseAvailable(third.id, "other.server")).not.toThrow();
  });
});
