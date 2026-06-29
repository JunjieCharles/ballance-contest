import { randomUUID } from "node:crypto";
import { assertScenarioDefinition, capabilitiesFor, type CompetitionMode, type ScenarioDefinition } from "@ballance/contracts";
import { CompetitionEngine, type EngineSnapshot } from "@ballance/core";
import { ScenarioRunner } from "@ballance/testkit";
import { EventJournal } from "./event-journal.js";

export interface CompetitionRecord {
  id: string;
  name: string;
  mode: CompetitionMode;
  status: "draft" | "published";
  stateVersion: number;
  capabilities: ReturnType<typeof capabilitiesFor>;
  createdAt: string;
  updatedAt: string;
}

interface TestRuntime {
  id: string;
  competitionId: string;
  definition: ScenarioDefinition;
  runner: ScenarioRunner;
  engine: CompetitionEngine;
}

export class ServiceError extends Error {
  public constructor(public readonly code: string, message: string, public readonly statusCode: number, public readonly details?: unknown) { super(message); }
}

export class CompetitionService {
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly testRuns = new Map<string, TestRuntime>();
  private readonly idempotency = new Map<string, unknown>();

  public constructor(public readonly journal = new EventJournal()) {}

  public list(): readonly CompetitionRecord[] { return [...this.competitions.values()]; }

  public create(input: { name: string; mode: CompetitionMode; idempotencyKey: string }): CompetitionRecord {
    const old = this.idempotency.get(`create:${input.idempotencyKey}`);
    if (old) return old as CompetitionRecord;
    if (!input.name.trim()) throw new ServiceError("VALIDATION_FAILED", "比赛名称不能为空", 400);
    if (input.mode !== "work" && input.mode !== "test") throw new ServiceError("VALIDATION_FAILED", "无效比赛模式", 400);
    const now = new Date().toISOString();
    const record: CompetitionRecord = { id: randomUUID(), name: input.name.trim(), mode: input.mode, status: "draft", stateVersion: 0, capabilities: capabilitiesFor(input.mode), createdAt: now, updatedAt: now };
    this.competitions.set(record.id, record);
    this.idempotency.set(`create:${input.idempotencyKey}`, record);
    this.journal.append({ type: "competition.created", competitionId: record.id, stateVersion: 0, data: record });
    return record;
  }

  public get(id: string): CompetitionRecord {
    const record = this.competitions.get(id);
    if (!record) throw new ServiceError("NOT_FOUND", "比赛不存在", 404);
    return record;
  }

  public publish(id: string, expectedStateVersion: number, idempotencyKey: string): CompetitionRecord {
    const key = `${id}:publish:${idempotencyKey}`;
    const old = this.idempotency.get(key);
    if (old) return old as CompetitionRecord;
    const current = this.get(id);
    if (current.stateVersion !== expectedStateVersion) throw new ServiceError("STATE_CONFLICT", "状态版本已变化", 409, { latestStateVersion: current.stateVersion });
    const updated = { ...current, status: "published" as const, stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
    this.competitions.set(id, updated);
    this.idempotency.set(key, updated);
    this.journal.append({ type: "competition.published", competitionId: id, stateVersion: updated.stateVersion, data: updated });
    return updated;
  }

  public createTestRun(competitionId: string, input: unknown): { runId: string; snapshot: EngineSnapshot } {
    const competition = this.get(competitionId);
    if (competition.mode !== "test") throw new ServiceError("CAPABILITY_UNSUPPORTED", "工作模式不支持测试运行", 409);
    const definition = assertScenarioDefinition(input);
    const runtime: TestRuntime = { id: randomUUID(), competitionId, definition, runner: new ScenarioRunner(definition), engine: new CompetitionEngine(definition) };
    this.testRuns.set(runtime.id, runtime);
    this.journal.append({ type: "test-run.created", competitionId, stateVersion: competition.stateVersion, data: { runId: runtime.id, scenarioId: definition.id } });
    return { runId: runtime.id, snapshot: runtime.engine.snapshot() };
  }

  public advanceTestRun(competitionId: string, runId: string, all: boolean): EngineSnapshot {
    const runtime = this.testRuns.get(runId);
    if (!runtime || runtime.competitionId !== competitionId) throw new ServiceError("NOT_FOUND", "测试运行不存在", 404);
    const events = all ? runtime.runner.playAll() : [runtime.runner.next()].filter((event) => event !== undefined);
    for (const event of events) {
      runtime.engine.apply(event);
      this.journal.append({ type: "test-run.event", competitionId, data: event });
    }
    const snapshot = runtime.engine.snapshot();
    this.journal.append({ type: "scoreboard.snapshot", competitionId, data: snapshot });
    return snapshot;
  }

  public resetTestRun(competitionId: string, runId: string): EngineSnapshot {
    const runtime = this.testRuns.get(runId);
    if (!runtime || runtime.competitionId !== competitionId) throw new ServiceError("NOT_FOUND", "测试运行不存在", 404);
    runtime.runner = new ScenarioRunner(runtime.definition);
    runtime.engine = new CompetitionEngine(runtime.definition);
    this.journal.append({ type: "test-run.reset", competitionId, data: { runId } });
    return runtime.engine.snapshot();
  }
}
