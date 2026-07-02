import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionConfig, ScenarioDefinition, ScenarioEvent } from "@ballance/contracts";
import { CompetitionController } from "@ballance/core";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandTransport } from "./mock-client.js";
import { CompetitionService, seededBehaviorRandom } from "./competition-service.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";
import type { TestRuntime, TestRuntimeManager } from "./test-runtime-manager.js";
import type { WorkRuntimeManager, WorkRuntime } from "./work-runtime-manager.js";

const workRuntimeManager = (service: CompetitionService): WorkRuntimeManager =>
  (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;

const testRuntimeManager = (service: CompetitionService): TestRuntimeManager =>
  (service as unknown as { testRuntimeManager: TestRuntimeManager }).testRuntimeManager;

describe("CompetitionService dynamic participants", () => {
  it("uses a fixed seed for varied but reproducible player behavior", () => {
    const first = seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time");
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "expert", "finish-time")).toBe(first);
    expect(seededBehaviorRandom(20_260_632, "sr-1", 1, "expert", "finish-time")).not.toBe(first);
    expect(seededBehaviorRandom(20_260_631, "sr-1", 1, "normal", "finish-time")).not.toBe(first);
  });

  it("resets simulated server finish ordinals on every authoritative Go", () => {
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
    service.close();
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
      },
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

    const manager = workRuntimeManager(service);
    const transport: CommandTransport = { write: async () => undefined };
    const published = service.snapshot(record.id).publishedConfig as CompetitionConfig;
    const runtime = manager.makeRuntime(record.id, published, transport);
    manager.register(record.id, runtime);

    manager.ingestLine(runtime, "[06-30 12:00:00] 2 player(s) online:");
    manager.ingestLine(runtime, "[06-30 12:00:00] Silent_Snow (#42)");
    manager.ingestLine(runtime, "[06-30 12:00:00] *Observer (#99)");
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
    manager.ingestLine(runtime, "[06-30 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[06-30 12:00:02] (#42, Silent_Snow) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");

    expect(service.getRawClientLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mock-client", rawLine: expect.stringContaining("Silent_Snow") })
    ]));

    expect(service.snapshot(record.id).currentScoreboard).toMatchObject([{
      playerId: "Silent_Snow",
      displayName: "渴望新地图",
      points: 20
    }]);
    manager.ingestLine(runtime, "[06-30 12:00:03] 0 player(s) online:");
    expect(service.snapshot(record.id).config.participants[0]?.online).toBe(false);

    manager.beginListReconciliation(runtime);
    manager.ingestLine(runtime, "[06-30 12:00:04] 314: Modern_Player     28ms");
    manager.ingestLine(runtime, "[06-30 12:00:04] 99: *Observer     0ms");
    manager.ingestLine(runtime, "[06-30 12:00:04] 2 client(s) online: 1 player(s), 1 spectator(s).");
    expect(service.snapshot(record.id).config.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Silent_Snow", online: false }),
      expect.objectContaining({ id: "Modern_Player", connectionIds: ["314"], online: true })
    ]));
  });

  it("uses a live fatal-error line once and mirrors the voided protected attempt into scoring", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-fatal-protection-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Fatal protection", mode: "work", idempotencyKey: "create-fatal" });
    service.publish(record.id, 0, "publish-fatal");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

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
      .toContain("\n本关起跑保护已被使用，后续不再延时。");
    expect(runtime.engine.snapshot().attempts).toMatchObject([{ attemptNumber: 1, voided: true, open: false }]);
    expect(runtime.engine.snapshot().currentScoreboard.every((entry) => Object.keys(entry.stages).length === 0)).toBe(true);
    expect(service.snapshot(record.id).config.participants).toContainEqual(expect.objectContaining({ id: "Player One", online: false }));
    const restoredRuntime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    expect(restoredRuntime.controller.snapshot().startProtectionUsedStageIds).toEqual(["sr-1"]);
    service.close();
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
    manager.ingestLine(runtime, "[07-01 19:25:39] Connected to server OK");
    await runtime.customMapRegistration;
    manager.ingestLine(runtime, "[07-01 19:25:39] Connected to server OK");
    await runtime.customMapRegistration;
    expect(writes).toEqual([`setmap ${hash} 0 云端决赛图`, "listmap"]);
    const prefix = hash.slice(0, 20);
    manager.ingestLine(runtime, "[07-01 19:25:40] Alpha (#11) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-01 19:25:40] Beta (#12) logged in with cheat mode off.");
    manager.ingestLine(runtime, `[07-01 19:25:43] [7, *ContestConsole]: "${prefix}.." - Get ready`);
    manager.ingestLine(runtime, "[07-01 19:25:46] [7, *ContestConsole]: \"云端决赛图\" - Go!");
    manager.ingestLine(runtime, "[07-01 19:26:19] (#11, Alpha) finished \"云端决赛图\" in 1st place (score: 120 [20]; real time: 00:00:02.045).");
    manager.ingestLine(runtime, "[07-01 19:26:46] (#12, Beta) did not finish \"云端决赛图\" (furthest reach: sector 1).");

    const snapshot = service.snapshot(record.id);
    expect(snapshot.config.stages[0]).toMatchObject({ mapKind: "custom", mapHash: hash, level: 0, label: "云端决赛图" });
    expect(snapshot.runtime.attempts).toContainEqual(expect.objectContaining({ stageId: "custom-hs-final", attemptNumber: 1 }));
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Alpha")?.stages["custom-hs-final"])
      .toMatchObject({ status: "finished", score: 120, points: 20 });
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Beta")?.stages["custom-hs-final"])
      .toMatchObject({ status: "dnf", points: 0 });
    expect(service.getRawClientLogs(record.id).filter((line) => line.rawLine.includes("云端决赛图") || line.rawLine.includes(`"${prefix}.."`))).toHaveLength(4);
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
    manager.ingestLine(runtime, "[07-01 19:30:00] Alpha (#11) logged in with cheat mode off.");
    manager.ingestLine(runtime, `[07-01 19:30:01] [7, *ContestConsole]: ${prefix}.. - Get ready`);
    manager.ingestLine(runtime, `[07-01 19:30:16] [7, *ContestConsole]: ${prefix}.. - Go!`);
    manager.ingestLine(runtime, `[07-01 19:30:20] (#11, Alpha) finished ${prefix}.. in 1st place (score: 100; real time: 00:00:04.000).`);

    expect(service.snapshot(record.id).currentScoreboard.find((entry) => entry.playerId === "Alpha")?.stages["sr-1"])
      .toMatchObject({ status: "finished", score: 100, points: 20 });
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
        id: "custom-sr", order: 1, label: "云端竞速图", level: 0, mode: "SR", mapKind: "custom", mapHash: hash,
        timeLimitMs: 600_000, scoring: [20, 15, 12], minimumScoringPlace: 3
      }]
    });
    service.publish(record.id, 1, "publish-custom-test-stage");
    const runId = service.createTestRunFromScenario(record.id, "normal-player-roster").runId;
    service.startTestAutomation(record.id, runId, 0);
    service.advanceTestAutomation(record.id, runId, 240_000);
    const mapEcho = `"云端竞速图"`;
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
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Valid")?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 20 });
    expect(service.getRawClientLogs(record.id).some((line) => line.rawLine.includes("did not finish"))).toBe(false);
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(2);
    expect(runtime.engine.snapshot().anomalies.filter((item) => item.code === "duplicate-event" || item.code === "post-completion-result")).toHaveLength(0);
  });

  it("warns once after cheat-off and mirrors a cheat-on reconnect into the live scoreboard at Go", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-cheat-reconnect-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Cheat reconnect", mode: "work", idempotencyKey: "create-cheat-reconnect" });
    service.publish(record.id, 0, "publish-cheat-reconnect");
    const manager = workRuntimeManager(service);
    const runtime = manager.makeRuntime(record.id, service.snapshot(record.id).publishedConfig as CompetitionConfig, { write: async () => undefined });
    manager.register(record.id, runtime);

    manager.ingestLine(runtime, "[07-02 20:00:00] OfflineCheater (#41) logged in with cheat mode off.");
    runtime.controller.manualCheatOff();
    const cheatOff = runtime.controller.drainActions().find((item) => item.kind === "cheat-off");
    if (!cheatOff) throw new Error("missing cheat-off action");
    runtime.controller.acknowledgeAction(cheatOff.id, "acknowledged");
    manager.ingestLine(runtime, "[07-02 20:00:01] OfflineCheater (#41) disconnected.");
    manager.ingestLine(runtime, "[07-02 20:00:02] 42: OfflineCheater [CHEAT]    34ms");
    manager.ingestLine(runtime, "[07-02 20:00:03] 42: OfflineCheater [CHEAT]    34ms");

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
    expect(snapshot.currentScoreboard.find((entry) => entry.playerId === "Valid")?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 20 });
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

    manager.ingestLine(runtime, "[07-01 12:00:00] Practicing (#21) logged in with cheat mode off.");
    manager.ingestLine(runtime, "[07-01 12:00:01] [7, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-01 12:00:02] (#21, Practicing) finished Level 01 in 1st place (score: 100; real time: 00:00:01.000).");
    manager.ingestLine(runtime, "[07-01 12:00:03] (21, Practicing) turned cheat on.");
    manager.ingestLine(runtime, "[07-01 12:00:04] [Warning] Practicing just pressed the Reset hotkey at Level 02!");
    manager.ingestLine(runtime, "[07-01 12:00:05] [CHEAT] (#21, Practicing) finished Level 02 in 1st place (score: 999; real time: 00:00:01.000).");

    const snapshot = service.snapshot(record.id);
    const player = snapshot.currentScoreboard.find((entry) => entry.playerId === "Practicing");
    expect(player?.stages["sr-1"]).toMatchObject({ status: "finished", place: 1, points: 20 });
    expect(player?.stages["sr-2"]).toBeUndefined();
    expect(snapshot.runtime.attentionItems.filter((item) => item.title === "违规成绩已排除")).toHaveLength(0);
    expect(snapshot.runtime.blockers.some((blocker) => blocker.code === "PARTICIPANT_CHEAT")).toBe(false);
    expect(service.getRawClientLogs(record.id).some((line) => line.rawLine.includes("finished Level 02"))).toBe(true);
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
    expect(restored.runtime.attentionItems).toContainEqual(expect.objectContaining({ title: "命令结果待核实", severity: "warning" }));
    expect(restored.runtime.automationEnabled).toBe(false);
  });

  it("recovers a sent Go as acknowledged when the persisted authoritative attempt proves execution", () => {
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
    first.close();

    const restored = new CompetitionService(undefined, { database, dataRoot }).snapshot(record.id);
    expect(restored.runtime.commands).toContainEqual(expect.objectContaining({ id: "sent-go", status: "acknowledged" }));
    expect(restored.runtime.attentionItems).not.toContainEqual(expect.objectContaining({ title: "命令结果待核实" }));
  });

  it("reads legacy stages as official maps without rewriting immutable published snapshots", () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-stage-map-migration-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const service = new CompetitionService(undefined, { database, dataRoot });
    const record = service.create({ name: "Legacy maps", mode: "test", idempotencyKey: "legacy-maps" });
    service.publish(record.id, 0, "publish-legacy-maps");
    const stored = database.sqlite.prepare("SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1").get(record.id) as { payload: string };
    const legacy = JSON.parse(stored.payload) as { stages: Array<{ mapKind?: string; label: string }> };
    for (const [index, stage] of legacy.stages.entries()) {
      delete stage.mapKind;
      stage.label = `SR ${index + 1}`;
    }
    const immutablePayload = JSON.stringify(legacy);
    database.sqlite.prepare("UPDATE config_versions SET payload=? WHERE competition_id=? AND immutable=1").run(immutablePayload, record.id);

    expect(service.snapshot(record.id).publishedConfig?.stages[0]).toMatchObject({ mapKind: "official", label: "SR1", level: 1 });
    const afterRead = database.sqlite.prepare("SELECT payload FROM config_versions WHERE competition_id=? AND immutable=1").get(record.id) as { payload: string };
    expect(afterRead.payload).toBe(immutablePayload);
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

  it("keeps accepting post-threshold finishes before the next Ready starts", () => {
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

  it("writes a new audited command when a work-mode referee explicitly resends", async () => {
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
    runtime.controller.enable(0);
    for (const initial of runtime.controller.drainActions()) runtime.controller.acknowledgeAction(initial.id, "acknowledged");
    runtime.controller.tick();
    const due = runtime.controller.drainActions();
    const ready = due.find((action) => action.kind === "ready");
    for (const action of due.filter((candidate) => candidate.id !== ready?.id)) runtime.controller.acknowledgeAction(action.id, "acknowledged");
    runtime.controller.acknowledgeAction(ready!.id, "uncertain");
    const confirmation = service.createConfirmation(record.id, {
      kind: "automation-command-resolution",
      target: ready!.id,
      actionId: ready!.id,
      resolution: "resend"
    });
    const result = await service.performAction(record.id, {
      expectedStateVersion: 1,
      idempotencyKey: "work-ready-resend",
      action: {
        type: "resolve-automation-command",
        actionId: ready!.id,
        resolution: "resend",
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    });
    expect(result).toMatchObject({ status: "acknowledged", command: "countdown level 1 sr 4" });
    expect(writes).toHaveLength(1);
    expect(runtime.controller.snapshot().actions.find((action) => action.id === ready!.id)?.status).toBe("acknowledged");
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

    expect(() => service.startWorkMode(second.id)).toThrowError(/已有工作运行/);
    expect(() => manager.assertServerLeaseAvailable(third.id, "other.server")).not.toThrow();
  });
});
