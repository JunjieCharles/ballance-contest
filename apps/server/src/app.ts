import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  HealthResponseSchema,
  stageDisplayName,
  type CompetitionAction,
  type CompetitionConfig,
  type HealthResponse,
  type ScoreboardOverrideInput
} from "@ballance/contracts";
import { APPLICATION_VERSION } from "@ballance/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { CompetitionService, ServiceError } from "./competition-service.js";
import { createCompetitionArchive } from "./archive.js";
import { createScoreboardExports } from "./scoreboard-export.js";
import { SessionManager, type LocalSession } from "./session.js";
import { defaultDataRoot, openDatabase } from "./storage/database.js";

export interface BuildAppOptions {
  bootstrapToken: string;
  serveStatic?: boolean;
  service?: CompetitionService;
  dataRoot?: string;
  devShutdown?: { token: string; onShutdown: () => void | Promise<void> };
  trustedOrigins?: readonly string[];
}

const bearer = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
};

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot());
  const database = options.service ? undefined : openDatabase(join(dataRoot, "console.sqlite"));
  const service = options.service ?? new CompetitionService(undefined, { ...(database ? { database } : {}), dataRoot });
  const sessions = new SessionManager(options.bootstrapToken);
  await app.register(websocket);
  app.addHook("onClose", async () => {
    service.close();
    database?.close();
  });

  const requireSession = (request: FastifyRequest, control = false): LocalSession => {
    const origin = request.headers.origin;
    const trustedOrigins = new Set(["http://127.0.0.1:32113", "http://localhost:32113", ...(options.trustedOrigins ?? [])]);
    if (origin && !trustedOrigins.has(origin)) throw new ServiceError("ORIGIN_REJECTED", "请求来源不受信任", 403);
    const session = sessions.get(bearer(request));
    if (!session) throw new ServiceError("UNAUTHORIZED", "缺少有效本机会话", 401);
    if (control && !session.control) throw new ServiceError("READ_ONLY_SESSION", "当前标签页没有控制权", 403);
    return session;
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error instanceof TypeError) {
      void reply.status(400).send({ error: { code: "VALIDATION_FAILED", message: error.message } });
      return;
    }
    void reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "内部错误" } });
  });

  const sendCompetitionExport = (
    competitionId: string,
    format: string,
    requestedVersion: number | undefined,
    reply: FastifyReply
  ) => {
    if (format !== "csv" && format !== "xlsx") throw new ServiceError("VALIDATION_FAILED", "不支持的导出格式", 400);
    const fixed = service.getLatestScoreboard(competitionId, requestedVersion);
    const competition = service.get(competitionId);
    const snapshot = service.snapshot(competitionId);
    const bundle = createScoreboardExports({
      competitionName: competition.name,
      mode: competition.mode,
      version: fixed.version,
      generatedAt: new Date().toISOString(),
      entries: fixed.entries,
      stages: snapshot.config.stages.map((stage) => ({ id: stage.id, label: stageDisplayName(stage) }))
    });
    const formats = {
      csv: { contentType: "text/csv; charset=utf-8", body: bundle.csv },
      xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bundle.xlsx }
    } as const;
    const selected = formats[format];
    const encodedName = encodeURIComponent(`${bundle.basename}.${format}`);
    return reply.header("Content-Type", selected.contentType)
      .header("Content-Disposition", `attachment; filename="scoreboard-${competition.mode}-v${fixed.version}.${format}"; filename*=UTF-8''${encodedName}`)
      .send(selected.body);
  };

  app.get<{ Reply: HealthResponse }>("/api/v1/health", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({
    status: "ok", version: APPLICATION_VERSION, now: new Date().toISOString(), modes: ["work", "test"]
  }));

  app.post<{ Body: { bootstrapToken: string; tabId: string } }>("/api/v1/sessions/bootstrap", async (request) => {
    try { return sessions.exchange(request.body.bootstrapToken, request.body.tabId); }
    catch { throw new ServiceError("UNAUTHORIZED", "启动令牌无效", 401); }
  });
  if (options.devShutdown) {
    app.post<{ Body: { token: string } }>("/api/v1/dev/shutdown", async (request) => {
      if (request.body.token !== options.devShutdown?.token) throw new ServiceError("DEV_SHUTDOWN_REJECTED", "开发实例关闭令牌无效", 403);
      setImmediate(() => { void options.devShutdown?.onShutdown(); });
      return { accepted: true };
    });
  }
  app.post("/api/v1/sessions/control", async (request) => sessions.acquire(requireSession(request).token));

  app.get("/api/v1/competitions", async (request) => { requireSession(request); return { data: service.list() }; });
  app.post<{ Body: { name: string; mode?: "work" | "test"; idempotencyKey: string } }>("/api/v1/competitions", async (request) => {
    requireSession(request, true);
    return { data: service.create(request.body) };
  });
  app.get("/api/v1/test-scenarios", async (request) => {
    requireSession(request);
    return { data: service.listTestScenarios() };
  });
  app.get<{ Params: { scenarioId: string } }>("/api/v1/test-scenarios/:scenarioId", async (request) => {
    requireSession(request);
    return { data: service.getTestScenario(request.params.scenarioId) };
  });
  app.get<{ Params: { competitionId: string } }>("/api/v1/competitions/:competitionId", async (request) => {
    requireSession(request);
    return { data: service.get(request.params.competitionId) };
  });
  app.get<{ Params: { competitionId: string } }>("/api/v1/competitions/:competitionId/snapshot", async (request) => {
    requireSession(request);
    return { data: service.snapshot(request.params.competitionId) };
  });
  app.get<{ Params: { competitionId: string }; Querystring: { limit?: string } }>("/api/v1/competitions/:competitionId/logs/raw", async (request) => {
    requireSession(request);
    const limit = request.query.limit === undefined ? 200 : Number(request.query.limit);
    if (!Number.isFinite(limit)) throw new ServiceError("VALIDATION_FAILED", "日志条数必须是数字", 400);
    return { data: service.getRawClientLogs(request.params.competitionId, limit) };
  });
  app.patch<{ Params: { competitionId: string }; Body: Partial<CompetitionConfig> & { expectedStateVersion: number; idempotencyKey: string } }>("/api/v1/competitions/:competitionId/draft", async (request) => {
    requireSession(request, true);
    return { data: service.updateDraft(request.params.competitionId, request.body) };
  });
  app.post<{ Params: { competitionId: string }; Body: { expectedStateVersion: number; idempotencyKey: string } }>("/api/v1/competitions/:competitionId/publish", async (request) => {
    requireSession(request, true);
    return { data: service.publish(request.params.competitionId, request.body.expectedStateVersion, request.body.idempotencyKey) };
  });
  app.post<{ Params: { competitionId: string } }>("/api/v1/competitions/:competitionId/work/start", async (request) => {
    requireSession(request, true);
    return { data: service.startWorkMode(request.params.competitionId) };
  });
  app.post<{ Params: { competitionId: string }; Body: {
    runId?: string;
    readyInMs?: number;
    expectedStateVersion?: number;
    idempotencyKey?: string;
    confirmationToken?: string;
    impactHash?: string;
  } }>("/api/v1/competitions/:competitionId/automation/enable", async (request) => {
    requireSession(request, true);
    return { data: await service.enableAutomation(request.params.competitionId, request.body ?? {}) };
  });
  app.post<{ Params: { competitionId: string } }>("/api/v1/competitions/:competitionId/automation/pause", async (request) => {
    requireSession(request, true);
    return { data: service.pauseAutomation(request.params.competitionId) };
  });
  app.post<{ Params: { competitionId: string }; Body: {
    kind: "restart-stage" | "manual-action" | "manual-go" | "scoreboard-override" | "automation-command-resolution" | "high-risk";
    target?: string;
    playerId?: string;
    stageId?: string;
    operation?: "set-place" | "set-dnf";
    place?: number;
    rankPolicy?: "tie" | "shift";
    actionId?: string;
    resolution?: "confirm-executed" | "resend";
  } }>("/api/v1/competitions/:competitionId/confirmations", async (request) => {
    requireSession(request, true);
    return { data: service.createConfirmation(request.params.competitionId, request.body) };
  });
  app.post<{ Params: { competitionId: string }; Body: { expectedStateVersion: number; idempotencyKey: string; action: CompetitionAction } }>("/api/v1/competitions/:competitionId/actions", async (request) => {
    requireSession(request, true);
    return { data: await service.performAction(request.params.competitionId, request.body) };
  });
  app.get<{ Params: { competitionId: string }; Querystring: { version?: string } }>("/api/v1/competitions/:competitionId/scoreboard", async (request) => {
    requireSession(request);
    const version = request.query.version === undefined ? undefined : Number(request.query.version);
    return { data: service.getLatestScoreboard(request.params.competitionId, version) };
  });
  app.post<{
    Params: { competitionId: string };
    Body: ScoreboardOverrideInput & { expectedStateVersion: number; idempotencyKey: string };
  }>("/api/v1/competitions/:competitionId/scoreboard/overrides", async (request) => {
    requireSession(request, true);
    return { data: service.applyScoreboardOverride(request.params.competitionId, request.body) };
  });

  app.post<{ Params: { competitionId: string }; Body: unknown }>("/api/v1/competitions/:competitionId/test-runs", async (request) => {
    requireSession(request, true);
    return { data: service.createTestRun(request.params.competitionId, request.body) };
  });
  app.post<{ Params: { competitionId: string }; Body: { scenarioId: string } }>("/api/v1/competitions/:competitionId/test-runs/from-scenario", async (request) => {
    requireSession(request, true);
    return { data: service.createTestRunFromScenario(request.params.competitionId, request.body.scenarioId) };
  });
  app.post<{ Params: { competitionId: string; runId: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/step", async (request) => {
    requireSession(request, true);
    return { data: service.advanceTestRun(request.params.competitionId, request.params.runId, false) };
  });
  app.post<{ Params: { competitionId: string; runId: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/play", async (request) => {
    requireSession(request, true);
    return { data: service.advanceTestRun(request.params.competitionId, request.params.runId, true) };
  });
  app.post<{ Params: { competitionId: string; runId: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/reset", async (request) => {
    requireSession(request, true);
    return { data: service.resetTestRun(request.params.competitionId, request.params.runId) };
  });
  app.post<{ Params: { competitionId: string; runId: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/players/act", async (request) => {
    requireSession(request, true);
    return { data: service.actTestPlayers(request.params.competitionId, request.params.runId) };
  });
  app.get<{ Params: { competitionId: string; runId: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/automation", async (request) => {
    requireSession(request, false);
    return { data: service.getTestAutomation(request.params.competitionId, request.params.runId) };
  });
  app.post<{ Params: { competitionId: string; runId: string }; Body: { readyInMs?: number } }>("/api/v1/competitions/:competitionId/test-runs/:runId/automation/start", async (request) => {
    requireSession(request, true);
    return { data: service.startTestAutomation(request.params.competitionId, request.params.runId, request.body.readyInMs ?? 0) };
  });
  app.post<{ Params: { competitionId: string; runId: string }; Body: { milliseconds: number } }>("/api/v1/competitions/:competitionId/test-runs/:runId/automation/advance", async (request) => {
    requireSession(request, true);
    return { data: service.advanceTestAutomation(request.params.competitionId, request.params.runId, request.body.milliseconds) };
  });
  app.get<{ Params: { competitionId: string; runId: string; format: string }; Querystring: { version?: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/exports/:format", async (request, reply) => {
    requireSession(request, false);
    if (request.params.format !== "csv" && request.params.format !== "xlsx") throw new ServiceError("VALIDATION_FAILED", "不支持的导出格式", 400);
    const requestedVersion = request.query.version === undefined ? undefined : Number(request.query.version);
    if (requestedVersion !== undefined && !Number.isInteger(requestedVersion)) throw new ServiceError("VALIDATION_FAILED", "榜单版本必须是整数", 400);
    const fixed = service.getTestScoreboardVersion(request.params.competitionId, request.params.runId, requestedVersion);
    const bundle = createScoreboardExports({
      competitionName: fixed.competition.name, mode: fixed.competition.mode, version: fixed.scoreboard.version,
      generatedAt: new Date().toISOString(), entries: fixed.scoreboard.entries,
      stages: fixed.definition.stages.map((stage) => ({ id: stage.id, label: stage.displayName?.trim() || (stage.mapKind === "custom" ? stage.id : `${stage.mode}${stage.level}`) }))
    });
    const formats = {
      csv: { contentType: "text/csv; charset=utf-8", body: bundle.csv },
      xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bundle.xlsx }
    } as const;
    const selected = formats[request.params.format];
    const encodedName = encodeURIComponent(`${bundle.basename}.${request.params.format}`);
    return reply.header("Content-Type", selected.contentType)
      .header("Content-Disposition", `attachment; filename="scoreboard-${fixed.competition.mode}-v${fixed.scoreboard.version}.${request.params.format}"; filename*=UTF-8''${encodedName}`)
      .send(selected.body);
  });
  app.post<{ Params: { competitionId: string; runId: string }; Body: { version: number } }>("/api/v1/competitions/:competitionId/test-runs/:runId/archive", async (request) => {
    requireSession(request, true);
    service.assertArchiveAvailable(request.params.competitionId);
    const fixed = service.getTestScoreboardVersion(request.params.competitionId, request.params.runId);
    const generatedAt = new Date().toISOString();
    const exports = createScoreboardExports({
      competitionName: fixed.competition.name, mode: fixed.competition.mode, version: fixed.scoreboard.version,
      generatedAt, entries: fixed.scoreboard.entries,
      stages: fixed.definition.stages.map((stage) => ({ id: stage.id, label: stage.displayName?.trim() || (stage.mapKind === "custom" ? stage.id : `${stage.mode}${stage.level}`) }))
    });
    mkdirSync(dataRoot, { recursive: true });
    const archive = createCompetitionArchive({
      dataRoot, sourceRoot: dataRoot,
      competition: { id: fixed.competition.id, name: fixed.competition.name, mode: fixed.competition.mode, timezone: fixed.definition.timezone },
      version: request.body.version, generatedAt, applicationVersion: APPLICATION_VERSION, parserVersion: "1", mockClientVersion: "test-double",
      sourceFiles: [],
      records: {
        "config/scenario.json": fixed.definition,
        "participants/participants.json": fixed.definition.players,
        "events/standard-events.json": fixed.definition.events,
        "results/scoreboard.json": fixed.scoreboard,
        "runtime/automation.json": fixed.automation,
        "audit/commands.json": fixed.automation.actions,
        "audit/incidents.json": fixed.automation.incidents,
        "audit/attention-items.json": service.snapshot(fixed.competition.id).runtime.attentionItems,
        "audit/overrides.json": []
      },
      exports
    });
    service.journal.append({ type: "test-run.archived", competitionId: fixed.competition.id, data: { runId: request.params.runId, version: request.body.version, manifestHash: archive.manifestHash } });
    service.recordArchive(fixed.competition.id, archive);
    return { data: { directory: archive.directory, packagePath: archive.packagePath, manifestHash: archive.manifestHash } };
  });
  app.get<{ Params: { competitionId: string; format: string }; Querystring: { version?: string } }>("/api/v1/competitions/:competitionId/exports/:format", async (request, reply) => {
    requireSession(request, false);
    const requestedVersion = request.query.version === undefined ? undefined : Number(request.query.version);
    return sendCompetitionExport(request.params.competitionId, request.params.format, requestedVersion, reply);
  });
  app.post<{
    Params: { competitionId: string; format: string };
    Body: { version?: number };
  }>("/api/v1/competitions/:competitionId/exports/:format", async (request, reply) => {
    requireSession(request, true);
    return sendCompetitionExport(request.params.competitionId, request.params.format, request.body.version, reply);
  });
  app.post<{ Params: { competitionId: string }; Body: { version: number } }>("/api/v1/competitions/:competitionId/archive", async (request) => {
    requireSession(request, true);
    service.assertArchiveAvailable(request.params.competitionId);
    const competition = service.get(request.params.competitionId);
    const snapshot = service.snapshot(request.params.competitionId);
    const fixed = service.getLatestScoreboard(request.params.competitionId);
    const generatedAt = new Date().toISOString();
    const exports = createScoreboardExports({
      competitionName: competition.name, mode: competition.mode, version: fixed.version, generatedAt, entries: fixed.entries,
      stages: snapshot.config.stages.map((stage) => ({ id: stage.id, label: stageDisplayName(stage) }))
    });
    mkdirSync(dataRoot, { recursive: true });
    const archive = createCompetitionArchive({
      dataRoot, sourceRoot: dataRoot,
      competition: { id: competition.id, name: competition.name, mode: competition.mode, timezone: snapshot.config.timezone },
      version: request.body.version, generatedAt, applicationVersion: APPLICATION_VERSION, parserVersion: "1",
      mockClientVersion: competition.mode === "test" ? "test-double" : "managed-mockclient",
      sourceFiles: [],
      records: {
        "config/config.json": snapshot.config,
        "runtime/snapshot.json": snapshot.runtime,
        "results/scoreboard.json": fixed,
        "audit/commands.json": snapshot.runtime.commands,
        "audit/incidents.json": snapshot.runtime.incidents,
        "audit/attention-items.json": snapshot.runtime.attentionItems
      },
      exports
    });
    service.recordArchive(competition.id, archive);
    service.journal.append({ type: "competition.archived", competitionId: competition.id, data: { version: request.body.version, manifestHash: archive.manifestHash } });
    return { data: { directory: archive.directory, packagePath: archive.packagePath, manifestHash: archive.manifestHash } };
  });
  app.post<{
    Params: { competitionId: string };
    Body: { expectedStateVersion: number; idempotencyKey: string; confirmationToken: string; impactHash: string };
  }>("/api/v1/competitions/:competitionId/finish", async (request) => {
    requireSession(request, true);
    return { data: await service.finishCompetition(request.params.competitionId, request.body) };
  });
  app.delete<{
    Params: { competitionId: string };
    Body: { expectedStateVersion: number; idempotencyKey: string; confirmationToken: string; impactHash: string };
  }>("/api/v1/competitions/:competitionId", async (request) => {
    requireSession(request, true);
    return { data: await service.deleteCompetition(request.params.competitionId, request.body) };
  });

  type WebSocketRequest = FastifyRequest<{ Querystring: { token?: string; after?: string } }>;
  type RegisterWebSocket = (path: string, options: { websocket: true }, handler: (socket: WebSocket, request: WebSocketRequest) => void) => void;
  const registerWebSocket = app.get.bind(app) as unknown as RegisterWebSocket;
  registerWebSocket("/api/v1/ws", { websocket: true }, (socket, request) => {
    const session = sessions.get(request.query.token);
    if (!session) { socket.close(1008, "unauthorized"); return; }
    const after = Number(request.query.after ?? 0);
    const backlog = service.journal.after(Number.isFinite(after) ? after : 0);
    if (backlog === null) socket.send(JSON.stringify({ type: "snapshot-required" }));
    else for (const event of backlog) socket.send(JSON.stringify(event));
    const unsubscribe = service.journal.subscribe((event) => socket.send(JSON.stringify(event)));
    socket.on("close", unsubscribe);
  });

  if (options.serveStatic !== false) {
    const webRoot = [resolve(import.meta.dirname, "../web"), resolve(import.meta.dirname, "../../web/dist")].find((candidate) => existsSync(candidate));
    if (webRoot) await app.register(staticPlugin, { root: webRoot, wildcard: false });
  }
  return app;
};
