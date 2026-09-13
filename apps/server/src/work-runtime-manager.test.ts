import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompetitionService } from "./competition-service.js";
import {
  ManagedMockClient,
  type MockClientLogBoundary,
  type MockClientLogFlushOptions,
  type MockClientLogLinePosition,
  type ManagedMockClientProcessRef,
  type MockClientExitInfo,
  type MockClientLaunchOptions
} from "./mock-client.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";
import {
  DEFAULT_RECOVERY_COOLDOWN_MS,
  type WorkRuntimeManager,
  type WorkRuntimeManagerDependencies
} from "./work-runtime-manager.js";

interface ControlledBehavior {
  connectionId: string;
  authenticate?: boolean;
  authenticationFailure?: "Login denied." | "The host hath bidden us farewell.  (1002: A player with the same username \"*ContestConsole\" already exists on this server.)";
  listEntries?: { connectionId: string; name: string }[];
  listSummary?: { clients: number; players: number; spectators: number };
  reconnectLinesBeforeConnected?: string[];
  reconnectLinesAfterConnected?: string[];
  disconnectBeforeReconnectConnected?: boolean;
  reconnectEvidenceAfterWrite?: boolean;
  denyMapRegistration?: boolean;
  reconnectConnectionId?: string;
  reconnectFails?: boolean;
  reconnectWriteRejectsAfterConnected?: boolean;
  gracefulStopFails?: boolean;
  gracefulStopGate?: Promise<void>;
  forceStopFails?: boolean;
  logBoundaryFailure?: "missing" | "unstable";
}

let nextPid = 45_000;

class ControlledManagedClient extends ManagedMockClient {
  private readonly controlledLineListeners = new Set<(line: string, position: MockClientLogLinePosition) => void>();
  private readonly controlledExitListeners = new Set<(info: MockClientExitInfo) => void>();
  private running = false;
  private controlledProcessRef: ManagedMockClientProcessRef | undefined;
  private activeConnectionId: string;
  private controlledLogStreamGeneration = 0;
  private controlledLogOffset = 0;
  private controlledLineStartByteOffset = 0;
  private controlledLogPending = "";
  public readonly writes: string[] = [];

  public constructor(
    options: MockClientLaunchOptions,
    public readonly behavior: ControlledBehavior,
    private readonly lifecycle: string[]
  ) {
    super(options, { spawn: () => { throw new Error("controlled client does not spawn a real process"); } });
    this.activeConnectionId = behavior.connectionId;
  }

  public override start(): void {
    this.running = true;
    this.controlledProcessRef = { generation: 1, pid: ++nextPid };
    this.controlledLogStreamGeneration += 1;
    this.controlledLogOffset = 0;
    this.controlledLineStartByteOffset = 0;
    this.controlledLogPending = "";
    this.lifecycle.push(`start:${this.activeConnectionId}`);
    this.emitConnectionEvidence();
  }

  public override get isRunning(): boolean { return this.running; }
  public override get processGeneration(): number | undefined { return this.controlledProcessRef?.generation; }
  public override get processId(): number | undefined { return this.controlledProcessRef?.pid; }
  public override captureProcess(): ManagedMockClientProcessRef | undefined { return this.controlledProcessRef; }
  public override isCurrentProcess(processRef: ManagedMockClientProcessRef): boolean { return this.controlledProcessRef === processRef; }

  public override onLine(listener: (line: string, position: MockClientLogLinePosition) => void): () => void {
    this.controlledLineListeners.add(listener);
    return () => this.controlledLineListeners.delete(listener);
  }

  public override onExit(listener: (info: MockClientExitInfo) => void): () => void {
    this.controlledExitListeners.add(listener);
    return () => this.controlledExitListeners.delete(listener);
  }

  public override flushLog(options: MockClientLogFlushOptions = {}): MockClientLogBoundary {
    if (options.requirePresentStable && this.behavior.logBoundaryFailure) {
      throw new Error(
        `STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE: controlled log is ${this.behavior.logBoundaryFailure}`
      );
    }
    return {
      streamGeneration: this.controlledLogStreamGeneration,
      byteOffset: this.controlledLogOffset
    };
  }

  public override async write(command: string): Promise<void> {
    if (!this.running) throw new Error("controlled client is not running");
    this.writes.push(command);
    if (command === "list" && this.behavior.authenticate !== false && !this.behavior.authenticationFailure) {
      this.emitAuthenticatedList();
    }
    if (command.startsWith("setmap ") && this.behavior.denyMapRegistration) {
      this.emitLine("[07-22 12:00:00] Action failed: you don't have the permission to run this action.");
    }
  }

  public override async reconnect(): Promise<void> {
    this.lifecycle.push("soft-reconnect");
    if (this.behavior.reconnectFails) {
      this.emitDisconnect();
      throw new Error("controlled soft reconnect failed");
    }
    const emitReconnectEvidence = (): void => {
      if (this.behavior.disconnectBeforeReconnectConnected || this.behavior.reconnectEvidenceAfterWrite) this.emitDisconnect();
      for (const line of this.behavior.reconnectLinesBeforeConnected ?? []) this.emitLine(line);
      this.activeConnectionId = this.behavior.reconnectConnectionId ?? this.activeConnectionId;
      this.emitConnectionEvidence();
      for (const line of this.behavior.reconnectLinesAfterConnected ?? []) this.emitLine(line);
    };
    if (this.behavior.reconnectEvidenceAfterWrite) {
      setTimeout(emitReconnectEvidence, 0);
      return;
    }
    emitReconnectEvidence();
    if (this.behavior.reconnectWriteRejectsAfterConnected) throw new Error("controlled reconnect stdin callback timed out");
  }

  public override async disconnectForReconnect(): Promise<string> {
    this.lifecycle.push("soft-disconnect");
    const line = "[07-22 12:00:01] The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (contest-console-soft-reconnect).)";
    this.emitLine(line);
    return line;
  }

  public override async stop(): Promise<void> {
    this.lifecycle.push("graceful-stop");
    await this.behavior.gracefulStopGate;
    if (this.behavior.gracefulStopFails) throw new Error("controlled graceful stop timed out");
    this.finishProcess(true);
  }

  public override async forceStopOwnedProcessTree(processRef: ManagedMockClientProcessRef): Promise<void> {
    if (!this.isCurrentProcess(processRef)) throw new Error("controlled ownership mismatch");
    this.lifecycle.push("force-stop");
    if (this.behavior.forceStopFails) throw new Error("controlled ownership verification failed");
    this.finishProcess(true);
  }

  public emitUnexpectedProcessError(): void { this.finishProcess(false); }

  public emitAuthenticatedList(): void {
    const entries = this.behavior.listEntries ?? [{ connectionId: this.activeConnectionId, name: "*ContestConsole" }];
    for (const entry of entries) this.emitLine(`[07-22 12:00:00] ${entry.connectionId}: ${entry.name}     0ms`);
    const players = entries.filter((entry) => !entry.name.startsWith("*")).length;
    const summary = this.behavior.listSummary ?? { clients: entries.length, players, spectators: entries.length - players };
    this.emitLine(`[07-22 12:00:00] ${summary.clients} client(s) online: ${summary.players} player(s), ${summary.spectators} spectator(s).`);
  }

  public emitRawLine(line: string): void { this.emitLine(line); }

  public emitRawChunk(chunk: string): void {
    let remaining = chunk;
    while (remaining.length > 0) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex < 0) {
        this.controlledLogPending += remaining;
        this.controlledLogOffset += Buffer.byteLength(remaining, "utf8");
        return;
      }
      const segment = remaining.slice(0, newlineIndex);
      const line = `${this.controlledLogPending}${segment}`.replace(/\r$/, "");
      const consumed = remaining.slice(0, newlineIndex + 1);
      this.controlledLogOffset += Buffer.byteLength(consumed, "utf8");
      const position = {
        streamGeneration: this.controlledLogStreamGeneration,
        byteOffset: this.controlledLogOffset,
        startByteOffset: this.controlledLineStartByteOffset,
        endByteOffset: this.controlledLogOffset,
        trustedEvidence: true
      };
      this.controlledLogPending = "";
      this.controlledLineStartByteOffset = this.controlledLogOffset;
      if (line.length > 0) {
        for (const listener of this.controlledLineListeners) listener(line, position);
      }
      remaining = remaining.slice(newlineIndex + 1);
    }
  }

  public emitDiscontinuityPrefix(lines: readonly string[]): void {
    this.controlledLogStreamGeneration += 1;
    this.controlledLogOffset = 0;
    this.controlledLineStartByteOffset = 0;
    this.controlledLogPending = "";
    for (const line of lines) {
      const endByteOffset = Buffer.byteLength(`${line}\n`, "utf8") + this.controlledLogOffset;
      const position: MockClientLogLinePosition = {
        streamGeneration: this.controlledLogStreamGeneration,
        byteOffset: endByteOffset,
        startByteOffset: this.controlledLineStartByteOffset,
        endByteOffset,
        trustedEvidence: false,
        discontinuityPrefix: true
      };
      this.controlledLogOffset = endByteOffset;
      this.controlledLineStartByteOffset = endByteOffset;
      for (const listener of this.controlledLineListeners) listener(line, position);
    }
  }

  public emitReplacementConnection(connectionId: string): void {
    this.activeConnectionId = connectionId;
    this.emitConnectionEvidence();
  }

  public emitDisconnect(): void {
    this.emitLine("[07-22 12:00:01] The host hath bidden us farewell.  (5003: Connection dropped)");
  }

  private emitConnectionEvidence(): void {
    this.emitLine("[07-22 12:00:00] Connected to server OK");
    if (this.behavior.authenticationFailure) this.emitLine(`[07-22 12:00:00] ${this.behavior.authenticationFailure}`);
  }

  private emitLine(line: string): void {
    this.emitRawChunk(`${line}\n`);
  }

  private finishProcess(expected: boolean): void {
    if (!this.running) return;
    this.running = false;
    this.controlledProcessRef = undefined;
    for (const listener of this.controlledExitListeners) listener({ code: 0, signal: null, expected });
  }
}

const managerFor = (service: CompetitionService): WorkRuntimeManager =>
  (service as unknown as { workRuntimeManager: WorkRuntimeManager }).workRuntimeManager;

const mockLogTimestamp = (epochMs: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `[${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}]`;
};

const configureSingleStage = (service: CompetitionService, competitionId: string): void => {
  service.updateDraft(competitionId, {
    expectedStateVersion: 0,
    idempotencyKey: "single-stage",
    stages: [{
      id: "sr-1",
      order: 1,
      label: "SR1",
      level: 1,
      mode: "SR",
      mapKind: "official",
      timeLimitMs: 60_000,
      scoring: [20],
      minimumScoringPlace: 1
    }]
  });
  service.publish(competitionId, 1, "publish");
};

const configureTwoStages = (service: CompetitionService, competitionId: string): void => {
  service.updateDraft(competitionId, {
    expectedStateVersion: 0,
    idempotencyKey: "two-stages",
    stages: [1, 2].map((level) => ({
      id: `sr-${level}`,
      order: level,
      label: `SR${level}`,
      level,
      mode: "SR" as const,
      mapKind: "official" as const,
      timeLimitMs: 60_000,
      scoring: [20],
      minimumScoringPlace: 1
    }))
  });
  service.publish(competitionId, 1, "publish");
};

const configureCustomStages = (count: number) => (service: CompetitionService, competitionId: string): void => {
  service.updateDraft(competitionId, {
    expectedStateVersion: 0,
    idempotencyKey: `custom-stages-${count}`,
    stages: Array.from({ length: count }, (_, index) => ({
      id: `custom-${index + 1}`,
      order: index + 1,
      label: `Custom_${String(index + 1).padStart(2, "0")}`,
      level: 0,
      mode: "SR" as const,
      mapKind: "custom" as const,
      mapHash: `${(index + 1).toString(16).padStart(2, "0")}${"0".repeat(30)}`,
      timeLimitMs: 60_000,
      scoring: [20],
      minimumScoringPlace: 1
    }))
  });
  service.publish(competitionId, 1, "publish");
};

describe("WorkRuntimeManager connection lifecycle", () => {
  let dataRoot = "";
  let database: OpenedDatabase | undefined;
  let service: CompetitionService | undefined;

  afterEach(async () => {
    if (service) await service.close();
    service = undefined;
    database?.close();
    database = undefined;
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
    dataRoot = "";
  });

  it("uses the referee-selected 20 second hard-restart cooldown", () => {
    expect(DEFAULT_RECOVERY_COOLDOWN_MS).toBe(20_000);
  });

  const setup = (
    behaviors: ControlledBehavior[],
    dependencyOverrides: Partial<WorkRuntimeManagerDependencies> = {},
    configure: (service: CompetitionService, competitionId: string) => void = configureSingleStage
  ) => {
    dataRoot = mkdtempSync(join(tmpdir(), "ballance-work-connection-"));
    database = openDatabase(join(dataRoot, "console.sqlite"));
    const clients: ControlledManagedClient[] = [];
    const lifecycle: string[] = [];
    let nextBehavior = 0;
    service = new CompetitionService(undefined, {
      database,
      dataRoot,
      workRuntimeManagerDependencies: {
        authenticationRejectWindowMs: 1,
        connectionTimeoutMs: 4_000,
        gracefulStopTimeoutMs: 1,
        forceStopTimeoutMs: 1,
        recoveryCooldownMs: 1,
        commandTimeoutMs: (action) => action.type === "list" ? 250 : 2_000,
        sleep: async () => { lifecycle.push("cooldown"); },
        ...dependencyOverrides,
        createClient: (options) => {
          const behavior = behaviors[Math.min(nextBehavior, behaviors.length - 1)];
          if (!behavior) throw new Error("missing controlled behavior");
          nextBehavior += 1;
          const client = new ControlledManagedClient(options, behavior, lifecycle);
          clients.push(client);
          return client;
        }
      }
    });
    const competition = service.create({ name: "Connection lifecycle", mode: "work", idempotencyKey: "create" });
    configure(service, competition.id);
    return { service, competitionId: competition.id, clients, lifecycle };
  };

  it("connects a draft for players, publishes the final configuration, and unlocks the independent address only after manual disconnect", async () => {
    const context = setup([{ connectionId: "101", listEntries: [{ connectionId: "11", name: "Alice" }, { connectionId: "101", name: "*ContestConsole" }] }], {}, () => {});
    const { service: active, competitionId: id } = context;
    active.updateConnectionSettings(id, { server: "2.bmmo.win", expectedStateVersion: 0, idempotencyKey: "address" });
    const connect = { expectedStateVersion: 1, idempotencyKey: "connect" };
    active.startWorkMode(id, connect);
    active.startWorkMode(id, connect);
    expect(context.clients).toHaveLength(1);
    await vi.waitFor(() => expect(active.snapshot(id).runtime.workConnection?.status).toBe("healthy"));
    expect(active.snapshot(id).config.participants).toEqual(expect.arrayContaining([expect.objectContaining({ id: "Alice", online: true })]));
    expect(active.snapshot(id).connectionSettings).toEqual({ server: "2.bmmo.win", locked: true });
    expect(context.clients[0]?.writes.every(command => command === "list")).toBe(true);
    await expect(active.enableAutomation(id, {})).rejects.toThrow("发布");
    expect(() => active.updateConnectionSettings(id, { server: "1.bmmo.win", expectedStateVersion: 1, idempotencyKey: "locked" })).toThrow("手动断开");
    context.clients[0]?.emitRawLine("[07-22 12:00:01] *ContestConsole [101]: Level 01 - Go!");
    expect(managerFor(active).get(id)?.controller.snapshot().attempts).toHaveLength(0);
    await managerFor(active).reconcileParticipantsNow(id);
    expect(context.clients[0]?.writes.filter(command => command === "list").length).toBeGreaterThan(1);

    const stages = [{ ...active.snapshot(id).config.stages[0]!, id: "final-stage", timeLimitMs: 123_000, mapKind: "custom" as const, mapName: "Final map", mapHash: "a".repeat(32) }];
    active.updateDraft(id, { stages, expectedStateVersion: 1, idempotencyKey: "final-config" });
    active.publish(id, 2, "publish");
    expect(active.snapshot(id).runtime.currentStageId).toBe("final-stage");
    expect(active.snapshot(id).runtime.automationEnabled).toBe(false);
    await vi.waitFor(() => expect(context.clients[0]?.writes.some(command => command.startsWith("setmap "))).toBe(true));
    await vi.waitFor(() => expect(managerFor(active).get(id)?.mapRegistration).toBeUndefined(), { timeout: 5_000 });
    const published = active.snapshot(id).publishedConfig;
    const confirmation = active.createConfirmation(id, { kind: "high-risk", intent: "disconnect-work", target: id });
    const runtime = managerFor(active).get(id)!;
    await vi.waitFor(() => expect(runtime.automationDispatching).not.toBe(true));
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
    vi.spyOn(runtime.runtime, "dispatch").mockImplementationOnce(async () => { await dispatchGate; return []; });
    const oldTick = managerFor(active).tickRealtime(runtime);
    const input = { expectedStateVersion: active.get(id).stateVersion, idempotencyKey: "disconnect", action: { type: "disconnect-work" as const, confirmationToken: confirmation.token, impactHash: confirmation.impactHash } };
    await Promise.all([active.performAction(id, input), active.performAction(id, input)]);
    releaseDispatch();
    await oldTick;
    expect(context.clients[0]?.isRunning).toBe(false);
    expect(active.snapshot(id).connectionSettings).toEqual({ server: "2.bmmo.win", locked: false });
    expect(active.snapshot(id).runtime.workConnection).toBeUndefined();
    expect(managerFor(active).get(id)).toBeUndefined();
    active.updateConnectionSettings(id, { server: "1.bmmo.win", expectedStateVersion: active.get(id).stateVersion, idempotencyKey: "new-address" });
    expect(active.snapshot(id).publishedConfig).toEqual(published);
    await active.close();
    database?.close();
    database = openDatabase(join(dataRoot, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot });
    expect(service.snapshot(id).connectionSettings).toEqual({ server: "1.bmmo.win", locked: false });
    expect(service.snapshot(id).publishedConfig).toEqual(published);
    service.updateConnectionSettings(id, { server: "2.bmmo.win", expectedStateVersion: service.get(id).stateVersion, idempotencyKey: "after-reopen" });
    expect(service.snapshot(id).connectionSettings?.server).toBe("2.bmmo.win");
  });

  it("keeps Connected in authenticating until the explicit list closes with exactly one referee ID", async () => {
    const context = setup([{ connectionId: "101", authenticate: false }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("authenticating"));
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.refereeConnectionId).toBeUndefined();

    await vi.waitFor(() => expect(context.clients[0]?.writes).toContain("list"));
    context.clients[0]?.emitAuthenticatedList();
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "101"
    }), { timeout: 3_000 });
  });

  it("keeps a draft address locked when managed shutdown fails and releases it on a later successful disconnect", async () => {
    const behavior = { connectionId: "101", gracefulStopFails: true, forceStopFails: true };
    const context = setup([behavior], {}, () => {});
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"));
    await expect(managerFor(context.service).disconnect(context.competitionId)).rejects.toThrow();
    expect(context.service.snapshot(context.competitionId).connectionSettings?.locked).toBe(true);
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked");
    expect(() => context.service.updateConnectionSettings(context.competitionId, { server: "2.bmmo.win", expectedStateVersion: 0, idempotencyKey: "still-locked" })).toThrow("手动断开");
    behavior.gracefulStopFails = false;
    await managerFor(context.service).disconnect(context.competitionId);
    context.service.updateConnectionSettings(context.competitionId, { server: "2.bmmo.win", expectedStateVersion: 0, idempotencyKey: "unlocked" });
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"));
    expect(managerFor(context.service).get(context.competitionId)?.server).toBe("2.bmmo.win");
    expect(context.clients).toHaveLength(2);
    await context.service.close();
    database?.close();
    database = openDatabase(join(dataRoot, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot });
    expect(service.snapshot(context.competitionId).connectionSettings).toEqual({ server: "2.bmmo.win", locked: true });
    expect(() => service!.updateConnectionSettings(context.competitionId, { server: "1.bmmo.win", expectedStateVersion: 1, idempotencyKey: "restart-locked" })).toThrow("手动断开");
  });

  it("does not start a second authentication when Connected is repeated during the same authentication window", async () => {
    const context = setup([{ connectionId: "101", authenticate: false }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.clients[0]?.writes.filter((command) => command === "list")).toHaveLength(1));

    context.clients[0]?.emitRawLine("[07-22 12:00:00] Connected to server OK");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(context.clients[0]?.writes.filter((command) => command === "list")).toHaveLength(1);
    expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "authenticating",
      connectionGeneration: 1
    });

    context.clients[0]?.emitAuthenticatedList();
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "101"
    }), { timeout: 3_000 });
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.recoveryStep).toBeUndefined(), { timeout: 3_000 });
    expect(context.clients[0]?.writes.filter((command) => command === "list")).toHaveLength(1);
    expect(context.clients[0]?.writes.filter((command) => command.startsWith("setmap "))).toHaveLength(1);
  });

  it("ends the authentication deadline at identity verification and lets 30 map registrations finish separately", async () => {
    vi.useFakeTimers();
    try {
      const context = setup(
        [{ connectionId: "101" }],
        { authenticationRejectWindowMs: 1, connectionTimeoutMs: 25, listSettleDelayMs: 1 },
        configureCustomStages(30)
      );
      context.service.startWorkMode(context.competitionId);

      await vi.advanceTimersByTimeAsync(2);
      expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
        status: "healthy",
        refereeConnectionId: "101",
        recoveryStep: "register-maps"
      });
      expect(() => managerFor(context.service).requireHealthy(context.competitionId)).toThrow(/地图注册/);
      expect(context.service.snapshot(context.competitionId).runtime.availableActions).toContainEqual(expect.objectContaining({
        action: "enable-automation",
        enabled: false,
        disabledReason: expect.stringContaining("地图注册")
      }));

      await vi.advanceTimersByTimeAsync(30);
      expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy");
      expect(context.clients).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(16_000);
      expect(context.clients[0]?.writes.filter((command) => command.startsWith("setmap "))).toHaveLength(30);
      expect(context.clients[0]?.writes.filter((command) => command === "listmap")).toHaveLength(1);
      expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
        status: "healthy",
        refereeConnectionId: "101"
      });
      expect(context.service.snapshot(context.competitionId).runtime.workConnection?.recoveryStep).toBeUndefined();
      expect(managerFor(context.service).requireHealthy(context.competitionId)).toBeDefined();
      expect(context.lifecycle).toEqual(["start:101"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Login denied as authentication failure and never registers maps", async () => {
    const context = setup([
      { connectionId: "101", authenticationFailure: "Login denied.", reconnectFails: true },
      { connectionId: "102", authenticationFailure: "Login denied." }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked"), { timeout: 7_000 });
    expect(context.clients.flatMap((client) => client.writes).some((command) => command.startsWith("setmap "))).toBe(false);
    expect(context.clients).toHaveLength(2);
  });

  it("rejects an explicit list containing more than one exact *ContestConsole identity", async () => {
    const duplicatedIdentity = [
      { connectionId: "101", name: "*ContestConsole" },
      { connectionId: "202", name: "*ContestConsole" }
    ];
    const context = setup([
      { connectionId: "101", listEntries: duplicatedIdentity, reconnectFails: true },
      { connectionId: "303", listEntries: duplicatedIdentity }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked"), { timeout: 8_000 });
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.refereeConnectionId).toBeUndefined();
    expect(context.clients.flatMap((client) => client.writes).some((command) => command.startsWith("setmap "))).toBe(false);
  });

  it("rejects a list batch that repeats a connection ID", async () => {
    const repeatedConnectionId = [
      { connectionId: "101", name: "*ContestConsole" },
      { connectionId: "101", name: "*Observer" }
    ];
    const context = setup([
      { connectionId: "101", listEntries: repeatedConnectionId, reconnectFails: true },
      { connectionId: "303", listEntries: repeatedConnectionId }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked"), { timeout: 8_000 });

    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.refereeConnectionId).toBeUndefined();
    expect(context.clients.flatMap((client) => client.writes).some((command) => command.startsWith("setmap "))).toBe(false);
  });

  it("rejects an incomplete list without registering or changing player state", async () => {
    const incomplete = {
      listEntries: [
        { connectionId: "101", name: "*ContestConsole" },
        { connectionId: "102", name: "UncommittedPlayer" }
      ],
      listSummary: { clients: 3, players: 1, spectators: 2 }
    };
    const context = setup([
      { connectionId: "101", ...incomplete, reconnectFails: true },
      { connectionId: "303", ...incomplete }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked"), { timeout: 5_000 });

    expect(context.service.snapshot(context.competitionId).config.participants)
      .not.toContainEqual(expect.objectContaining({ id: "UncommittedPlayer" }));
  });

  it("blocks on explicit map-registration permission denial without restarting the process", async () => {
    const context = setup([{ connectionId: "101", denyMapRegistration: true }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked"), { timeout: 3_000 });

    expect(context.clients).toHaveLength(1);
    expect(context.lifecycle).not.toContain("soft-reconnect");
    expect(context.service.snapshot(context.competitionId).runtime.blockers)
      .toContainEqual(expect.objectContaining({ code: "PERMISSION_DENIED", severity: "critical" }));
  });

  it("resets every participant stage status when T-60 changes the current work stage", async () => {
    const context = setup([{ connectionId: "101" }], {}, configureTwoStages);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "101"
    }), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    if (!runtime) throw new Error("missing work runtime");

    manager.ingestLine(runtime, "[07-22 12:00:01] [101, *ContestConsole]: Level 01 - Go!");
    manager.ingestLine(runtime, "[07-22 12:00:02] (#41, DnfRunner) did not finish Level 01 (furthest reach: sector 4).");
    manager.ingestLine(runtime, "[07-22 12:00:03] [CHEAT] (#42, Cheater) finished Level 01 in 1st place (score: 100; real time: 00:00:02.000).");
    manager.ingestLine(runtime, "[07-22 12:00:04] (#43, Finisher) finished Level 01 in 2nd place (score: 90; real time: 00:00:03.000).");

    expect(context.service.snapshot(context.competitionId).config.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "DnfRunner", currentStageStatus: "dnf", online: true, connectionIds: ["41"] }),
      expect.objectContaining({ id: "Cheater", currentStageStatus: "excluded", online: true, connectionIds: ["42"] }),
      expect.objectContaining({ id: "Finisher", currentStageStatus: "finished", online: true, connectionIds: ["43"] })
    ]));
    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "tail-intake",
      currentStageId: "sr-1",
      plannedReadyStageId: "sr-2"
    });

    runtime.controller.reschedule(performance.now() + 60_000);
    manager.saveSnapshot(runtime);

    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "preparing",
      currentStageId: "sr-2",
      plannedReadyStageId: "sr-2"
    });
    expect(runtime.engine.snapshot().attempts[0]).toMatchObject({
      stageId: "sr-1",
      open: false,
      voided: false
    });
    expect((context.service as unknown as {
      getPayload(competitionId: string): {
        work?: { engine?: { attempts: Array<{ stageId: string; open: boolean }> } };
      };
    }).getPayload(context.competitionId).work?.engine?.attempts[0]).toMatchObject({
      stageId: "sr-1",
      open: false
    });
    expect(context.service.snapshot(context.competitionId).config.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "DnfRunner", currentStageStatus: "waiting", online: true, connectionIds: ["41"] }),
      expect.objectContaining({ id: "Cheater", currentStageStatus: "waiting", online: true, connectionIds: ["42"] }),
      expect.objectContaining({ id: "Finisher", currentStageStatus: "waiting", online: true, connectionIds: ["43"] })
    ]));
  });

  it("isolates a planned next-stage action when force-reset starts a new current-stage cycle", async () => {
    const context = setup([{ connectionId: "101" }], {}, configureTwoStages);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    if (!runtime) throw new Error("missing work runtime");

    const restartConfirmation = runtime.controller.issueStageRestartConfirmation("sr-1");
    manager.restartCurrentStage(runtime, {
      stageId: "sr-1",
      impactHash: restartConfirmation.impactHash,
      token: restartConfirmation.token,
      reason: "prepare manager recovery test",
      sourceId: "prepare-manager-recovery-test"
    });
    const marked = manager.markCurrentStageStarted(runtime, "sr-1");
    runtime.controller.registerParticipant("ThresholdRunner");
    expect(runtime.controller.recordResult({
      stageId: "sr-1",
      playerId: "ThresholdRunner",
      status: "finished",
      sourceId: "threshold-result",
      receivedAtMs: marked.goAtMs
    })).toBe("accepted");
    const plannedNextAction = runtime.controller.snapshot().actions.findLast((action) =>
      action.stageId === "sr-2" && action.kind === "bulletin" && action.status === "pending");
    if (!plannedNextAction) throw new Error("missing planned next-stage bulletin");

    manager.forceResetCurrentStage(runtime, "force-reset-cross-stage", "sr-1");

    expect(runtime.controller.snapshot()).toMatchObject({
      currentStageId: "sr-1",
      phase: "preparing",
      plannedReadyStageId: "sr-1"
    });
    expect(runtime.controller.snapshot().actions).toContainEqual(expect.objectContaining({
      id: plannedNextAction.id,
      stageId: "sr-2",
      status: "cancelled",
      isolated: true
    }));
  });

  it("keeps delayed pre-attempt result evidence raw-only and accepts a post-mark line from the same second", async () => {
    const context = setup([{ connectionId: "101" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    const client = context.clients[0];
    if (!runtime || !client) throw new Error("missing work runtime");

    const restartConfirmation = runtime.controller.issueStageRestartConfirmation("sr-1");
    manager.restartCurrentStage(runtime, {
      stageId: "sr-1",
      impactHash: restartConfirmation.impactHash,
      token: restartConfirmation.token,
      reason: "prepare evidence boundary",
      sourceId: "prepare-evidence-boundary"
    });
    const marked = manager.markCurrentStageStarted(runtime, "sr-1");
    const engineAttempt = runtime.engine.snapshot().attempts.find((attempt) => attempt.id === marked.id);
    if (!engineAttempt) throw new Error("missing marked engine attempt");
    const timeZone = context.service.snapshot(context.competitionId).config.timezone;
    const oldTimestamp = mockLogTimestamp(engineAttempt.goAtMs - 2_000, timeZone);
    const sameSecondTimestamp = mockLogTimestamp(engineAttempt.goAtMs, timeZone);

    client.emitRawLine(`${oldTimestamp} OldWarning (#41) logged in with cheat mode off.`);
    client.emitRawLine(`${oldTimestamp} OldCheat (#42) logged in with cheat mode off.`);
    client.emitRawLine(`${oldTimestamp} (#43, OldFinish) finished Level 01 in 1st place (score: 999; real time: 00:00:01.000).`);
    client.emitRawLine(`${oldTimestamp} (#44, OldDnf) did not finish Level 01 (furthest reach: sector 2).`);
    client.emitRawLine(`${oldTimestamp} [Warning] OldWarning just pressed the Reset hotkey at Level 01!`);
    client.emitRawLine(`${oldTimestamp} (42, OldCheat) turned cheat on.`);
    client.emitRawLine(`${oldTimestamp} [CHEAT] (#45, OldCheatFinish) finished Level 01 in 2nd place (score: 998; real time: 00:00:01.500).`);
    client.emitRawLine(`${sameSecondTimestamp} (#46, FreshFinish) finished Level 01 in 3rd place (score: 100; real time: 00:00:00.100).`);

    const controlledAttempt = runtime.controller.snapshot().attempts.find((attempt) => attempt.id === marked.id);
    expect(controlledAttempt?.results).toEqual([
      expect.objectContaining({ playerId: "FreshFinish", status: "finished" })
    ]);
    expect(runtime.engine.snapshot().currentScoreboard).toContainEqual(expect.objectContaining({
      playerId: "FreshFinish",
      stages: { "sr-1": expect.objectContaining({ sourceId: expect.any(String) }) }
    }));
    expect(runtime.engine.snapshot().currentScoreboard.some((entry) =>
      ["OldFinish", "OldDnf", "OldWarning", "OldCheat", "OldCheatFinish"].includes(entry.playerId)
      && entry.stages["sr-1"] !== undefined)).toBe(false);
    expect(context.service.journal.after(0)?.filter((event) => event.type === "work.pre-attempt-evidence-ignored").length)
      .toBeGreaterThanOrEqual(5);

    const writesBeforeReset = [...client.writes];
    const versionsBeforeReset = runtime.engine.snapshot().scoreboardVersions.length;
    const resetStarted = manager.markCurrentStageStarted(runtime, "sr-1");
    expect(client.writes).toEqual(writesBeforeReset);
    expect(runtime.controller.snapshot()).toMatchObject({ phase: "running", automationEnabled: true });
    expect(runtime.engine.snapshot().attempts).toContainEqual(expect.objectContaining({ id: marked.id, voided: true, open: false }));
    expect(runtime.engine.snapshot().attempts).toContainEqual(expect.objectContaining({ id: resetStarted.id, attemptNumber: 2, voided: false, open: true }));
    expect(runtime.engine.snapshot().currentScoreboard.every(entry => entry.stages["sr-1"] === undefined)).toBe(true);
    expect(runtime.engine.snapshot().scoreboardVersions.length).toBeGreaterThan(versionsBeforeReset);
    client.emitRawLine(`${mockLogTimestamp(Date.now(), timeZone)} (#46, FreshFinish) finished Level 01 in 1st place (score: 100; real time: 00:00:00.100).`);
    expect(runtime.engine.snapshot().currentScoreboard).toContainEqual(expect.objectContaining({
      playerId: "FreshFinish", stages: { "sr-1": expect.objectContaining({ status: "finished", place: 1 }) }
    }));
    expect(runtime.controller.snapshot().attempts.find(attempt => attempt.id === resetStarted.id)?.results)
      .toContainEqual(expect.objectContaining({ playerId: "FreshFinish", status: "finished" }));
  });

  it("keeps half-written old results raw-only across mark, reset, restart and force-next boundaries", async () => {
    const context = setup([{ connectionId: "101" }], {}, configureTwoStages);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    const client = context.clients[0];
    if (!runtime || !client) throw new Error("missing work runtime");

    const enterReady = (stageId: string, sourceId: string): void => {
      const confirmation = runtime.controller.issueStageRestartConfirmation(stageId);
      manager.restartCurrentStage(runtime, {
        stageId,
        impactHash: confirmation.impactHash,
        token: confirmation.token,
        reason: sourceId,
        sourceId
      });
    };
    const splitAcrossBoundary = (line: string, action: () => void): void => {
      const splitAt = Math.max(1, Math.floor(line.length / 2));
      client.emitRawChunk(line.slice(0, splitAt));
      action();
      client.emitRawChunk(`${line.slice(splitAt)}\n`);
    };
    const timeZone = context.service.snapshot(context.competitionId).config.timezone;

    enterReady("sr-1", "prepare-first-half-line-boundary");
    const oldAcrossMark = `${mockLogTimestamp(Date.now() + 10_000, timeZone)} (#51, OldAcrossMark) finished Level 01 in 1st place (score: 999; real time: 00:00:00.001).`;
    let firstAttemptId = "";
    splitAcrossBoundary(oldAcrossMark, () => {
      firstAttemptId = manager.markCurrentStageStarted(runtime, "sr-1").id;
    });
    const firstAttemptGoAt = runtime.engine.snapshot().attempts.find((attempt) => attempt.id === firstAttemptId)?.goAtMs;
    client.emitRawLine(`${mockLogTimestamp(firstAttemptGoAt ?? Date.now(), timeZone)} (#52, FreshAfterMark) finished Level 01 in 1st place (score: 100; real time: 00:00:00.002).`);

    const firstAttempt = runtime.controller.snapshot().attempts.find((attempt) => attempt.id === firstAttemptId);
    expect(firstAttempt?.results).toEqual([
      expect.objectContaining({ playerId: "FreshAfterMark", status: "finished" })
    ]);

    const oldAcrossReset = `${mockLogTimestamp(Date.now() + 10_000, timeZone)} (#53, OldAcrossReset) finished Level 01 in 1st place (score: 998; real time: 00:00:00.003).`;
    splitAcrossBoundary(oldAcrossReset, () => {
      manager.forceResetCurrentStage(runtime, "force-reset-half-line-boundary", "sr-1");
    });
    const oldAcrossRestart = `${mockLogTimestamp(Date.now() + 10_000, timeZone)} (#54, OldAcrossRestart) finished Level 01 in 1st place (score: 997; real time: 00:00:00.004).`;
    splitAcrossBoundary(oldAcrossRestart, () => {
      enterReady("sr-1", "prepare-second-half-line-boundary");
    });
    const secondAttempt = manager.markCurrentStageStarted(runtime, "sr-1");
    const secondTimestamp = mockLogTimestamp(
      runtime.engine.snapshot().attempts.find((attempt) => attempt.id === secondAttempt.id)?.goAtMs ?? Date.now(),
      timeZone
    );
    client.emitRawLine(`${secondTimestamp} (#55, FreshAfterReset) finished Level 01 in 1st place (score: 97; real time: 00:00:00.005).`);

    expect(runtime.controller.snapshot().attempts.find((attempt) => attempt.id === secondAttempt.id)?.results).toEqual([
      expect.objectContaining({ playerId: "FreshAfterReset", status: "finished" })
    ]);

    const oldAcrossForceNext = `${mockLogTimestamp(Date.now() + 10_000, timeZone)} (#56, OldAcrossForceNext) finished Level 01 in 1st place (score: 996; real time: 00:00:00.006).`;
    splitAcrossBoundary(oldAcrossForceNext, () => {
      manager.forceAdvanceToNextStage(runtime, "sr-1", "sr-2");
    });
    expect(runtime.controller.snapshot()).toMatchObject({
      currentStageId: "sr-2",
      phase: "preparing"
    });
    enterReady("sr-2", "prepare-force-next-stage-attempt");
    const thirdAttempt = manager.markCurrentStageStarted(runtime, "sr-2");
    const thirdTimestamp = mockLogTimestamp(
      runtime.engine.snapshot().attempts.find((attempt) => attempt.id === thirdAttempt.id)?.goAtMs ?? Date.now(),
      timeZone
    );
    client.emitRawLine(`${thirdTimestamp} (#57, FreshAfterForceNext) finished Level 02 in 1st place (score: 95; real time: 00:00:00.007).`);
    expect(runtime.controller.snapshot().attempts.find((attempt) => attempt.id === thirdAttempt.id)?.results).toEqual([
      expect.objectContaining({ playerId: "FreshAfterForceNext", status: "finished" })
    ]);

    expect(runtime.engine.snapshot().currentScoreboard.some((entry) =>
      ["OldAcrossMark", "OldAcrossReset", "OldAcrossRestart", "OldAcrossForceNext"].includes(entry.playerId)
      && Object.keys(entry.stages).length > 0)).toBe(false);
    expect(context.service.journal.after(0)?.filter((event) =>
      event.type === "work.pre-stage-cycle-log-line-ignored")).toHaveLength(4);

    const persistedWork = (context.service as unknown as {
      getPayload(competitionId: string): {
        work?: {
          stageCycleEvidenceLogBoundary?: { byteOffset: number };
          attemptEvidenceLogBoundaries?: Record<string, { byteOffset: number }>;
        };
      };
    }).getPayload(context.competitionId).work;
    expect(persistedWork?.stageCycleEvidenceLogBoundary).toEqual(
      persistedWork?.attemptEvidenceLogBoundaries?.[thirdAttempt.id]
    );
    expect(persistedWork?.stageCycleEvidenceLogBoundary?.byteOffset).toBeGreaterThan(0);
  });

  it("fails a stage recovery closed when no stable log boundary exists and leaves restart confirmation reusable", async () => {
    const behavior: ControlledBehavior = {
      connectionId: "101",
      logBoundaryFailure: "missing"
    };
    const context = setup([behavior]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() =>
      expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"),
    { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    if (!runtime) throw new Error("missing work runtime");
    const confirmation = runtime.controller.issueStageRestartConfirmation("sr-1");
    const input = {
      stageId: "sr-1",
      impactHash: confirmation.impactHash,
      token: confirmation.token,
      reason: "strict log boundary",
      sourceId: "strict-log-boundary"
    };

    expect(() => manager.restartCurrentStage(runtime, input))
      .toThrow(/STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE.*missing/);
    expect(runtime.controller.snapshot().phase).toBe("lobby");

    delete behavior.logBoundaryFailure;
    expect(() => manager.restartCurrentStage(runtime, input)).not.toThrow();
    expect(runtime.controller.snapshot()).toMatchObject({
      phase: "ready",
      currentStageId: "sr-1"
    });
  });

  it("keeps a replaced-file Ready and Go prefix raw-only before observing a genuinely appended Go", async () => {
    const context = setup([{ connectionId: "101" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() =>
      expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"),
    { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    const client = context.clients[0];
    if (!runtime || !client) throw new Error("missing work runtime");

    const restartConfirmation = runtime.controller.issueStageRestartConfirmation("sr-1");
    manager.restartCurrentStage(runtime, {
      stageId: "sr-1",
      impactHash: restartConfirmation.impactHash,
      token: restartConfirmation.token,
      reason: "prepare discontinuity evidence",
      sourceId: "prepare-discontinuity-evidence"
    });
    const go = runtime.commands.enqueue(
      { type: "go", map: "level 1", mode: "sr" },
      "go-after-log-replacement"
    );
    let goSettled = false;
    void go.then(() => { goSettled = true; });
    await vi.waitFor(() => expect(client.writes).toContain("countdown level 1 sr"));

    const oldReady = "[07-22 12:01:00] [101, *ContestConsole]: Level 01 - Get ready";
    const oldGo = "[07-22 12:01:01] [101, *ContestConsole]: Level 01 - Go!";
    client.emitDiscontinuityPrefix([oldReady, oldGo]);

    await Promise.resolve();
    expect(goSettled).toBe(false);
    expect(runtime.controller.snapshot().attempts).toEqual([]);
    expect(context.service.getRawClientLogs(context.competitionId).map((entry) => entry.rawLine))
      .toEqual(expect.arrayContaining([oldReady, oldGo]));
    expect(context.service.journal.after(0)?.filter((event) =>
      event.type === "work.log-discontinuity-prefix-ignored")).toHaveLength(2);

    client.emitRawLine("[07-22 12:01:02] [101, *ContestConsole]: Level 01 - Get ready");
    client.emitRawLine("[07-22 12:01:03] [101, *ContestConsole]: Level 01 - Go!");
    await expect(go).resolves.toMatchObject({ status: "acknowledged" });
    client.emitRawLine("[07-22 12:01:04] FreshAfterReplace (#202) logged in with cheat mode off.");
    expect(context.service.snapshot(context.competitionId).config.participants)
      .toContainEqual(expect.objectContaining({
        id: "FreshAfterReplace",
        online: true,
        connectionIds: ["202"]
      }));
  });

  it("does not let a late old-cycle cheat-off echo clear current-cycle cheat state", async () => {
    const context = setup([{ connectionId: "101" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() =>
      expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"),
    { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    const client = context.clients[0];
    if (!runtime || !client) throw new Error("missing work runtime");
    const restartConfirmation = runtime.controller.issueStageRestartConfirmation("sr-1");
    manager.restartCurrentStage(runtime, {
      stageId: "sr-1",
      impactHash: restartConfirmation.impactHash,
      token: restartConfirmation.token,
      reason: "prepare cheat-off evidence cycle",
      sourceId: "prepare-cheat-off-evidence-cycle"
    });
    runtime.controller.registerParticipant("Cheater");
    runtime.controller.observeCheat("Cheater", true, "current-cycle-cheat");
    const echo = "[07-22 12:02:00] (#101, *ContestConsole) toggled cheat off globally!";

    client.emitRawLine(echo);
    expect(runtime.controller.snapshot().participantStates)
      .toContainEqual(expect.objectContaining({ participantId: "Cheater", cheatEnabled: true }));

    const currentCheatOff = runtime.commands.enqueue({ type: "cheat-off" }, "current-cycle-cheat-off");
    await vi.waitFor(() => expect(client.writes).toContain("cheat off"));
    client.emitRawLine(echo);
    await expect(currentCheatOff).resolves.toMatchObject({ status: "acknowledged" });
    expect(runtime.controller.snapshot().participantStates)
      .toContainEqual(expect.objectContaining({ participantId: "Cheater", cheatEnabled: false }));
  });

  it("cuts over queued and sent commands and accepts only the new soft-reconnect identity", async () => {
    const context = setup([{ connectionId: "101", reconnectConnectionId: "202" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const runtime = manager.get(context.competitionId);
    if (!runtime) throw new Error("missing work runtime");
    const oldGeneration = runtime.commands.generation;
    const sent = runtime.commands.enqueue({ type: "raw", command: "status" }, "old-sent");
    const queued = runtime.commands.enqueue({ type: "ready", map: "level 1", mapName: "Level_01", mode: "sr" }, "old-queued");
    await vi.waitFor(() => expect(context.clients[0]?.writes).toContain("status"));

    await manager.reconnectClient(context.competitionId);
    await expect(sent).resolves.toMatchObject({ status: "uncertain", generation: oldGeneration });
    await expect(queued).resolves.toMatchObject({ status: "cancelled", generation: oldGeneration });
    expect(runtime.commands.generation).toBeGreaterThan(oldGeneration);
    expect(runtime.connection).toMatchObject({ status: "healthy", refereeConnectionId: "202", processGeneration: 1, connectionGeneration: 2 });
    expect(context.clients[0]?.writes.filter((command) => command.startsWith("setmap "))).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "soft-disconnect")).toHaveLength(1);
  });

  it("accepts authoritative re-authentication when the reconnect stdin callback rejects late", async () => {
    const context = setup([{
      connectionId: "101",
      reconnectConnectionId: "202",
      reconnectWriteRejectsAfterConnected: true
    }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    await expect(managerFor(context.service).reconnectClient(context.competitionId)).resolves.toBeDefined();
    expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "202"
    });
    expect(context.clients).toHaveLength(1);
  });

  it("keeps the soft-reconnect attempt alive across its expected disconnect boundary", async () => {
    const context = setup([{
      connectionId: "101",
      reconnectConnectionId: "202",
      reconnectEvidenceAfterWrite: true
    }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    await expect(managerFor(context.service).reconnectClient(context.competitionId)).resolves.toBeDefined();
    expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "202",
      processGeneration: 1,
      connectionGeneration: 2
    });
    expect(context.lifecycle.filter((item) => item === "soft-reconnect")).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "soft-disconnect")).toHaveLength(1);
    expect(context.lifecycle).not.toContain("graceful-stop");
    expect(context.clients).toHaveLength(1);
  });

  it("bounds duplicate disconnect evidence and still falls back after authentication rejection", async () => {
    const duplicateDisconnect = "[07-22 12:00:01] The host hath bidden us farewell.  (5003: Connection dropped)";
    const context = setup([
      {
        connectionId: "101",
        reconnectConnectionId: "202",
        reconnectEvidenceAfterWrite: true,
        reconnectLinesBeforeConnected: [duplicateDisconnect]
      },
      { connectionId: "303" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const first = context.clients[0];
    if (!first) throw new Error("missing initial client");
    first.behavior.authenticationFailure = "Login denied.";

    first.emitDisconnect();

    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "303",
      processGeneration: 2
    }), { timeout: 6_000 });
    expect(context.lifecycle.filter((item) => item === "soft-reconnect")).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "graceful-stop")).toHaveLength(1);
    expect(context.clients).toHaveLength(2);
  });

  it("coalesces concurrent lifecycle requests with the same idempotency key", async () => {
    const context = setup([{ connectionId: "101", reconnectConnectionId: "202" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const snapshot = context.service.snapshot(context.competitionId);
    const confirmation = context.service.createConfirmation(context.competitionId, {
      kind: "high-risk",
      intent: "reconnect-work",
      target: context.competitionId
    });
    const input = {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey: "same-soft-reconnect",
      action: {
        type: "reconnect-work" as const,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash
      }
    };

    const [first, second] = await Promise.all([
      context.service.performAction(context.competitionId, input),
      context.service.performAction(context.competitionId, input)
    ]);
    expect(second).toEqual(first);
    expect(context.lifecycle.filter((item) => item === "soft-reconnect")).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "soft-disconnect")).toHaveLength(1);
  });

  it("rejects reusing a lifecycle idempotency key for a different recovery action", async () => {
    const context = setup([{ connectionId: "101", reconnectConnectionId: "202" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const snapshot = context.service.snapshot(context.competitionId);
    const reconnectConfirmation = context.service.createConfirmation(context.competitionId, {
      kind: "high-risk",
      intent: "reconnect-work",
      target: context.competitionId
    });
    const restartConfirmation = context.service.createConfirmation(context.competitionId, {
      kind: "high-risk",
      intent: "restart-work",
      target: context.competitionId
    });
    const idempotencyKey = "conflicting-lifecycle-action";

    const reconnecting = context.service.performAction(context.competitionId, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey,
      action: {
        type: "reconnect-work",
        confirmationToken: reconnectConfirmation.token,
        impactHash: reconnectConfirmation.impactHash
      }
    });
    await expect(context.service.performAction(context.competitionId, {
      expectedStateVersion: snapshot.competition.stateVersion,
      idempotencyKey,
      action: {
        type: "restart-work",
        confirmationToken: restartConfirmation.token,
        impactHash: restartConfirmation.impactHash
      }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(reconnecting).resolves.toBeDefined();

    expect(context.lifecycle.filter((item) => item === "soft-reconnect")).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "soft-disconnect")).toHaveLength(1);
    expect(context.lifecycle).not.toContain("graceful-stop");
    expect(context.clients).toHaveLength(1);
  });

  it("quarantines old-generation Go, list and permission lines across a soft reconnect", async () => {
    const oldLines = [
      "[07-22 12:01:00] [101, *ContestConsole]: Level 01 - Go!",
      "[07-22 12:01:00] 101: *ContestConsole     0ms",
      "[07-22 12:01:00] 1 client(s) online: 0 player(s), 1 spectator(s).",
      "[07-22 12:01:00] Action failed: you don't have the permission to run this action."
    ];
    const context = setup([{
      connectionId: "101",
      reconnectConnectionId: "202",
      reconnectLinesBeforeConnected: oldLines,
      reconnectLinesAfterConnected: oldLines
    }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    await managerFor(context.service).reconnectClient(context.competitionId);
    context.clients[0]?.emitRawLine("[07-22 12:01:01] [101, *ContestConsole]: Level 01 - Go!");
    context.clients[0]?.emitRawLine("[07-22 12:01:01] Action failed: you don't have the permission to run this action.");

    const snapshot = context.service.snapshot(context.competitionId);
    expect(snapshot.runtime.workConnection).toMatchObject({ status: "healthy", refereeConnectionId: "202" });
    expect(snapshot.runtime.attempts).toEqual([]);
    expect(snapshot.runtime.blockers.some((blocker) => blocker.code === "PERMISSION_DENIED")).toBe(false);
  });

  it("re-authenticates an unexpected Connected while healthy and ignores Connected while blocked", async () => {
    const context = setup([{ connectionId: "101" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.recoveryStep).toBeUndefined(), { timeout: 3_000 });
    const previousGeneration = context.service.snapshot(context.competitionId).runtime.workConnection?.connectionGeneration ?? 0;

    context.clients[0]?.emitReplacementConnection("202");
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "202",
      connectionGeneration: previousGeneration + 1
    }), { timeout: 3_000 });

    const runtime = managerFor(context.service).get(context.competitionId);
    if (!runtime) throw new Error("missing runtime");
    runtime.connection.status = "blocked";
    runtime.commands.advanceGeneration();
    const blockedGeneration = runtime.connection.connectionGeneration;
    const writesBefore = context.clients[0]?.writes.length ?? 0;
    context.clients[0]?.emitReplacementConnection("303");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.connection).toMatchObject({ status: "blocked", connectionGeneration: blockedGeneration });
    expect(runtime.connection.recentServerEvidence).toMatchObject({
      kind: "connected",
      detail: expect.stringContaining("仅保留")
    });
    expect(context.clients[0]?.writes).toHaveLength(writesBefore);
  });

  it("forces an owned process after bounded graceful stop, cools down, and starts one new generation", async () => {
    const context = setup([
      { connectionId: "101", gracefulStopFails: true },
      { connectionId: "303" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    await managerFor(context.service).restartClient(context.competitionId);
    expect(context.lifecycle).toEqual(expect.arrayContaining(["graceful-stop", "force-stop", "cooldown", "start:303"]));
    expect(context.lifecycle.indexOf("graceful-stop")).toBeLessThan(context.lifecycle.indexOf("force-stop"));
    expect(context.lifecycle.indexOf("force-stop")).toBeLessThan(context.lifecycle.indexOf("cooldown"));
    expect(context.lifecycle.indexOf("cooldown")).toBeLessThan(context.lifecycle.indexOf("start:303"));
    expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      processGeneration: 2,
      connectionGeneration: 2,
      refereeConnectionId: "303"
    });
    expect(context.clients).toHaveLength(2);
    expect(context.clients.map((client) => client.writes.filter((command) => command.startsWith("setmap ")).length)).toEqual([1, 1]);
  });

  it("does not repeat an interrupted map registration in the same process generation", async () => {
    const context = setup([
      { connectionId: "101", reconnectConnectionId: "202" },
      { connectionId: "303" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.clients[0]?.writes.some((command) => command.startsWith("setmap "))).toBe(true), { timeout: 3_000 });
    context.clients[0]?.emitDisconnect();

    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "303"
    }), { timeout: 6_000 });
    expect(context.clients).toHaveLength(2);
    expect(context.clients[0]?.writes.filter((command) => command.startsWith("setmap "))).toHaveLength(1);
    expect(context.clients[1]?.writes.filter((command) => command.startsWith("setmap "))).toHaveLength(1);
  });

  it("performs only one automatic recovery after a managed process error", async () => {
    const context = setup([
      { connectionId: "101" },
      { connectionId: "202" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    context.clients[0]?.emitUnexpectedProcessError();

    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "202"
    }), { timeout: 3_000 });
    expect(context.clients).toHaveLength(2);
    expect(context.lifecycle.filter((item) => item === "cooldown")).toHaveLength(1);
    expect(context.lifecycle.filter((item) => item === "start:202")).toHaveLength(1);
  });

  it("does not start a replacement process when the service closes during recovery cooldown", async () => {
    let releaseCooldown!: () => void;
    const cooldown = new Promise<void>((resolve) => { releaseCooldown = resolve; });
    const context = setup([
      { connectionId: "101", gracefulStopFails: true },
      { connectionId: "303" }
    ], { sleep: async () => cooldown });
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    const restart = managerFor(context.service).restartClient(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "recovering",
      recoveryStep: "cooldown"
    }));
    const closing = context.service.close();
    releaseCooldown();

    await closing;
    service = undefined;
    await expect(restart).rejects.toThrow();
    expect(context.clients).toHaveLength(1);
    expect(context.lifecycle).not.toContain("start:303");
  });

  it("force-stops an owned MockClient when service shutdown cannot complete gracefully", async () => {
    const context = setup([{ connectionId: "101", gracefulStopFails: true }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    await context.service.close();
    service = undefined;
    expect(context.lifecycle).toContain("force-stop");
    expect(context.clients[0]?.isRunning).toBe(false);
  });

  it("does not report service close complete before the managed process exits", async () => {
    let releaseGracefulStop!: () => void;
    const gracefulStopGate = new Promise<void>((resolve) => { releaseGracefulStop = resolve; });
    const context = setup([{ connectionId: "101", gracefulStopGate }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });

    let settled = false;
    const closing = context.service.close().finally(() => { settled = true; });
    await vi.waitFor(() => expect(context.lifecycle).toContain("graceful-stop"));
    expect(settled).toBe(false);
    expect(context.clients[0]?.isRunning).toBe(true);

    releaseGracefulStop();
    await closing;
    service = undefined;
    expect(context.clients[0]?.isRunning).toBe(false);
    expect(managerFor(context.service).has(context.competitionId)).toBe(false);
  });

  it("retains a blocked managed runtime after remove failure and permits a later safe hard recovery", async () => {
    const context = setup([
      { connectionId: "101", gracefulStopFails: true, forceStopFails: true },
      { connectionId: "202" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);

    await expect(manager.remove(context.competitionId)).rejects.toThrow("ownership verification failed");
    expect(manager.has(context.competitionId)).toBe(true);
    expect(context.clients[0]?.isRunning).toBe(true);
    expect(context.clients[0]?.captureProcess()).toBeDefined();
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked");
    expect(manager.get(context.competitionId)?.automationTimer).toBeDefined();

    context.clients[0]!.behavior.forceStopFails = false;
    await manager.restartClient(context.competitionId);
    expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({ status: "healthy", refereeConnectionId: "202" });
    await manager.remove(context.competitionId);
    expect(manager.has(context.competitionId)).toBe(false);
    expect(context.clients[0]?.isRunning).toBe(false);
  });

  it("propagates close failure while retaining the managed runtime for a safe retry", async () => {
    const context = setup([{ connectionId: "101", gracefulStopFails: true, forceStopFails: true }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);

    await expect(context.service.close()).rejects.toThrow("Failed to stop 1 managed MockClient");
    expect(manager.has(context.competitionId)).toBe(true);
    expect(context.clients[0]?.isRunning).toBe(true);
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked");
    expect(manager.get(context.competitionId)?.automationTimer).toBeDefined();

    context.clients[0]!.behavior.forceStopFails = false;
    await context.service.close();
    service = undefined;
    expect(manager.has(context.competitionId)).toBe(false);
    expect(context.clients[0]?.isRunning).toBe(false);
  });

  it("automatically recovers one missing periodic list and blocks when the first post-recovery list also has no echo", async () => {
    const context = setup([
      { connectionId: "101" },
      { connectionId: "202" }
    ]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const manager = managerFor(context.service);
    const first = context.clients[0];
    if (!first) throw new Error("missing initial client");
    first.behavior.authenticate = false;
    first.behavior.reconnectFails = true;

    await manager.reconcileParticipantsNow(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "healthy",
      refereeConnectionId: "202"
    }), { timeout: 7_000 });
    expect(context.clients).toHaveLength(2);

    const recovered = context.clients[1];
    if (!recovered) throw new Error("missing recovered client");
    recovered.behavior.authenticate = false;
    await manager.reconcileParticipantsNow(context.competitionId);
    expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("blocked");
    expect(context.clients).toHaveLength(2);
    expect(context.service.snapshot(context.competitionId).runtime.attentionItems).toContainEqual(expect.objectContaining({
      title: "自动恢复连接失败",
      severity: "critical"
    }));
  });

  it("persists generations and evidence but exposes a restored offline runtime as blocked without the old ID", async () => {
    const context = setup([{ connectionId: "404" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    const online = context.service.snapshot(context.competitionId).runtime.workConnection;
    expect(online).toMatchObject({ refereeConnectionId: "404", processGeneration: 1, connectionGeneration: 1 });
    await context.service.close();
    service = new CompetitionService(undefined, { database: database as OpenedDatabase, dataRoot });

    expect(service.snapshot(context.competitionId).runtime.workConnection).toMatchObject({
      status: "blocked",
      processGeneration: 1,
      connectionGeneration: 1,
      recentServerEvidence: expect.objectContaining({ kind: "list-verified" })
    });
    expect(service.snapshot(context.competitionId).runtime.workConnection?.refereeConnectionId).toBeUndefined();
  });

  it("restores a legacy work snapshot without connection metadata using generation zero defaults", async () => {
    const context = setup([{ connectionId: "505" }]);
    context.service.startWorkMode(context.competitionId);
    await vi.waitFor(() => expect(context.service.snapshot(context.competitionId).runtime.workConnection?.status).toBe("healthy"), { timeout: 3_000 });
    await context.service.close();
    service = undefined;

    const row = (database as OpenedDatabase).sqlite.prepare("SELECT payload FROM runtime_snapshots WHERE competition_id=?")
      .get(context.competitionId) as { payload: string };
    const payload = JSON.parse(row.payload) as { work?: { connection?: unknown } };
    if (payload.work) delete payload.work.connection;
    (database as OpenedDatabase).sqlite.prepare("UPDATE runtime_snapshots SET payload=? WHERE competition_id=?")
      .run(JSON.stringify(payload), context.competitionId);
    service = new CompetitionService(undefined, { database: database as OpenedDatabase, dataRoot });

    expect(service.snapshot(context.competitionId).runtime.workConnection).toEqual({
      status: "blocked",
      processGeneration: 0,
      connectionGeneration: 0
    });
  });
});
