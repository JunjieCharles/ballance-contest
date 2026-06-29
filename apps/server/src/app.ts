import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { HealthResponseSchema, type HealthResponse } from "@ballance/contracts";
import { APPLICATION_VERSION } from "@ballance/core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { CompetitionService, ServiceError } from "./competition-service.js";
import { createCompetitionArchive } from "./archive.js";
import { createScoreboardExports } from "./scoreboard-export.js";
import { SessionManager, type LocalSession } from "./session.js";
import { defaultDataRoot } from "./storage/database.js";

export interface BuildAppOptions {
  bootstrapToken: string;
  serveStatic?: boolean;
  service?: CompetitionService;
  dataRoot?: string;
}

const bearer = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
};

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const service = options.service ?? new CompetitionService();
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot());
  const sessions = new SessionManager(options.bootstrapToken);
  await app.register(websocket);

  const requireSession = (request: FastifyRequest, control = false): LocalSession => {
    const origin = request.headers.origin;
    if (origin && origin !== "http://127.0.0.1:32113" && origin !== "http://localhost:32113") throw new ServiceError("ORIGIN_REJECTED", "请求来源不受信任", 403);
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

  app.get<{ Reply: HealthResponse }>("/api/v1/health", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({
    status: "ok", version: APPLICATION_VERSION, now: new Date().toISOString(), modes: ["work", "test"]
  }));

  app.post<{ Body: { bootstrapToken: string; tabId: string } }>("/api/v1/sessions/bootstrap", async (request) => {
    try { return sessions.exchange(request.body.bootstrapToken, request.body.tabId); }
    catch { throw new ServiceError("UNAUTHORIZED", "启动令牌无效", 401); }
  });
  app.post("/api/v1/sessions/control", async (request) => sessions.acquire(requireSession(request).token));

  app.get("/api/v1/competitions", async (request) => { requireSession(request); return { data: service.list() }; });
  app.post<{ Body: { name: string; mode: "work" | "test"; idempotencyKey: string } }>("/api/v1/competitions", async (request) => {
    requireSession(request, true);
    return { data: service.create(request.body) };
  });
  app.get<{ Params: { competitionId: string } }>("/api/v1/competitions/:competitionId", async (request) => {
    requireSession(request);
    return { data: service.get(request.params.competitionId) };
  });
  app.post<{ Params: { competitionId: string }; Body: { expectedStateVersion: number; idempotencyKey: string } }>("/api/v1/competitions/:competitionId/publish", async (request) => {
    requireSession(request, true);
    return { data: service.publish(request.params.competitionId, request.body.expectedStateVersion, request.body.idempotencyKey) };
  });

  app.post<{ Params: { competitionId: string }; Body: unknown }>("/api/v1/competitions/:competitionId/test-runs", async (request) => {
    requireSession(request, true);
    return { data: service.createTestRun(request.params.competitionId, request.body) };
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
  app.post<{ Params: { competitionId: string; runId: string }; Body: { fault: string; playerId?: string; milliseconds?: number } }>("/api/v1/competitions/:competitionId/test-runs/:runId/faults", async (request) => {
    requireSession(request, true);
    return { data: service.injectTestFault(request.params.competitionId, request.params.runId, request.body) };
  });
  app.get<{ Params: { competitionId: string; runId: string; format: string }; Querystring: { version?: string } }>("/api/v1/competitions/:competitionId/test-runs/:runId/exports/:format", async (request, reply) => {
    requireSession(request, false);
    const requestedVersion = request.query.version === undefined ? undefined : Number(request.query.version);
    if (requestedVersion !== undefined && !Number.isInteger(requestedVersion)) throw new ServiceError("VALIDATION_FAILED", "榜单版本必须是整数", 400);
    const fixed = service.getTestScoreboardVersion(request.params.competitionId, request.params.runId, requestedVersion);
    const bundle = createScoreboardExports({
      competitionName: fixed.competition.name, mode: fixed.competition.mode, version: fixed.scoreboard.version,
      generatedAt: new Date().toISOString(), entries: fixed.scoreboard.entries,
      scoringRules: fixed.definition.stages.map((stage) => ({ stage: stage.id, rule: stage.scoring.join("/") }))
    });
    const formats = {
      html: { contentType: "text/html; charset=utf-8", body: bundle.html },
      tsv: { contentType: "text/tab-separated-values; charset=utf-8", body: bundle.tsv },
      csv: { contentType: "text/csv; charset=utf-8", body: bundle.csv },
      xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: bundle.xlsx }
    } as const;
    const selected = formats[request.params.format as keyof typeof formats];
    if (!selected) throw new ServiceError("VALIDATION_FAILED", "不支持的导出格式", 400);
    const encodedName = encodeURIComponent(`${bundle.basename}.${request.params.format}`);
    return reply.header("Content-Type", selected.contentType)
      .header("Content-Disposition", `attachment; filename="scoreboard-v${fixed.scoreboard.version}.${request.params.format}"; filename*=UTF-8''${encodedName}`)
      .send(selected.body);
  });
  app.post<{ Params: { competitionId: string; runId: string }; Body: { version: number } }>("/api/v1/competitions/:competitionId/test-runs/:runId/archive", async (request) => {
    requireSession(request, true);
    const fixed = service.getTestScoreboardVersion(request.params.competitionId, request.params.runId);
    const generatedAt = new Date().toISOString();
    const exports = createScoreboardExports({
      competitionName: fixed.competition.name, mode: fixed.competition.mode, version: fixed.scoreboard.version,
      generatedAt, entries: fixed.scoreboard.entries,
      scoringRules: fixed.definition.stages.map((stage) => ({ stage: stage.id, rule: stage.scoring.join("/") }))
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
        "audit/overrides.json": []
      },
      exports
    });
    service.journal.append({ type: "test-run.archived", competitionId: fixed.competition.id, data: { runId: request.params.runId, version: request.body.version, manifestHash: archive.manifestHash } });
    return { data: { directory: archive.directory, packagePath: archive.packagePath, manifestHash: archive.manifestHash } };
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
