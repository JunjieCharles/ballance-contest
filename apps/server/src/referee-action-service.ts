import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  AttentionItem,
  CommandRecordView,
  CompetitionAction,
  CompetitionConfig,
  CompetitionMode
} from "@ballance/contracts";
import type { AutomationAction, AutomationSnapshot, CompetitionController, ScoreboardVersion } from "@ballance/core";
import type { CommandAction } from "./command-queue.js";
import type { ServiceSnapshotPayload } from "./runtime-types.js";
import { ServiceError } from "./service-error.js";
import type { TestRuntimeManager } from "./test-runtime-manager.js";
import type { WorkRuntime, WorkRuntimeManager } from "./work-runtime-manager.js";
import { stageCommandTarget } from "@ballance/contracts";

interface RefereeActionHost {
  getCompetition(competitionId: string): { mode: CompetitionMode };
  getPayload(competitionId: string): ServiceSnapshotPayload;
  getDraftConfig(competitionId: string): CompetitionConfig;
  getPublishedConfig(competitionId: string): CompetitionConfig | undefined;
  upsertConfig(competitionId: string, config: CompetitionConfig): void;
  controllerFor(competitionId: string): CompetitionController;
  saveScoreboards(competitionId: string, versions: readonly ScoreboardVersion[]): void;
  completeCompetitionOnReview(competitionId: string, snapshot: AutomationSnapshot): void;
  appendAttention(competitionId: string, item: AttentionItem): void;
  testRuntimeManager: TestRuntimeManager;
  workRuntimeManager: WorkRuntimeManager;
}

export class RefereeActionService {
  public constructor(private readonly host: RefereeActionHost) {}

  public async applyLocal(
    competitionId: string,
    action: CompetitionAction,
    confirmation?: { runtimeToken?: string }
  ): Promise<boolean> {
    const competition = this.host.getCompetition(competitionId);
    const controller = (): CompetitionController => this.host.controllerFor(competitionId);
    switch (action.type) {
      case "manual-go": {
        controller().requestManualGo();
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          this.host.testRuntimeManager.settle(this.host.testRuntimeManager.getRuntime(competitionId, runId));
        }
        break;
      }
      case "ready": {
        controller().manualReady();
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          this.host.testRuntimeManager.settle(this.host.testRuntimeManager.getRuntime(competitionId, runId));
        }
        break;
      }
      case "reschedule": {
        const target = Date.parse(action.plannedReadyAt);
        if (!Number.isFinite(target)) throw new ServiceError("VALIDATION_FAILED", "Ready 改期时间无效", 400);
        controller().reschedule(this.wallTimeToRuntimeMs(competitionId, target));
        break;
      }
      case "reschedule-stage-deadline": {
        const target = Date.parse(action.deadlineAt);
        if (!Number.isFinite(target)) throw new ServiceError("VALIDATION_FAILED", "关卡时限改期时间无效", 400);
        controller().rescheduleStageDeadline(this.wallTimeToRuntimeMs(competitionId, target));
        break;
      }
      case "delay-ready":
        controller().delayReady(action.milliseconds);
        break;
      case "extend-stage-deadline":
        controller().extendStageDeadline(action.milliseconds);
        break;
      case "end-stage":
        controller().endStage("referee-ended-stage");
        if (competition.mode === "work") this.host.workRuntimeManager.mirrorSystemResults(this.host.workRuntimeManager.get(competitionId) as WorkRuntime);
        break;
      case "restart-stage": {
        if (!confirmation?.runtimeToken) throw new ServiceError("CONFIRMATION_INVALID", "重赛确认缺少运行时凭据", 409);
        const controlledAttempt = controller().snapshot().attempts.find((attempt) => attempt.id === action.attemptId && !attempt.voided);
        if (!controlledAttempt) throw new ServiceError("ACTION_UNAVAILABLE", "当前尝试已变化，不能重赛", 409);
        controller().confirmStageRestart({
          attemptId: action.attemptId,
          impactHash: action.impactHash,
          token: confirmation.runtimeToken,
          reason: "裁判重赛本关"
        });
        const sourceId = `restart-stage:${controlledAttempt.id}:${randomUUID()}`;
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          const runtime = this.host.testRuntimeManager.getRuntime(competitionId, runId);
          runtime.engine.voidAttempt(controlledAttempt.stageId, controlledAttempt.attemptNumber, sourceId);
          this.host.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
        } else {
          const runtime = this.host.workRuntimeManager.get(competitionId);
          if (!runtime) throw new ServiceError("NOT_FOUND", "工作运行时尚未启动", 404);
          runtime.engine.voidAttempt(controlledAttempt.stageId, controlledAttempt.attemptNumber, sourceId);
          this.host.saveScoreboards(competitionId, runtime.engine.snapshot().scoreboardVersions);
        }
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已重赛本关",
          message: `第 ${controlledAttempt.attemptNumber} 次尝试已作废并退出榜单；原始证据保留，等待新 Go 创建下一次尝试。`,
          occurredAt: new Date().toISOString(),
          stageId: controlledAttempt.stageId
        });
        break;
      }
      case "notification":
        if (competition.mode === "work") return false;
        this.host.testRuntimeManager.recordManualNotification(competitionId, action.channel, action.text);
        break;
      case "participant-associate":
        this.updateParticipantConnections(competitionId, action.participantId, (connections) => [...new Set([...connections, action.connectionId])]);
        break;
      case "participant-split":
        this.updateParticipantConnections(competitionId, undefined, (connections) => connections.filter((connectionId) => connectionId !== action.connectionId));
        break;
      case "participant-edit":
        this.editParticipant(competitionId, action);
        break;
      case "player-alias-upsert":
        this.upsertPlayerAlias(competitionId, action.playerId, action.displayName);
        break;
      case "scoreboard-override":
        throw new ServiceError("CAPABILITY_UNSUPPORTED", "请使用榜单修订接口提交该动作", 409);
      default:
        return false;
    }
    if (competition.mode === "test") {
      const runId = this.host.getPayload(competitionId).activeRunId;
      if (runId) {
        const runtime = this.host.testRuntimeManager.getRuntime(competitionId, runId);
        this.host.testRuntimeManager.settle(runtime);
        this.host.completeCompetitionOnReview(competitionId, runtime.automation.snapshot());
        this.host.testRuntimeManager.persist(runtime);
      }
    } else {
      const runtime = this.host.workRuntimeManager.get(competitionId);
      if (runtime) {
        await runtime.runtime.dispatch();
        this.host.completeCompetitionOnReview(competitionId, runtime.controller.snapshot());
        this.host.workRuntimeManager.saveSnapshot(runtime);
      }
    }
    return true;
  }

  public localActionRecord(actionType: string, command: string, simulated: boolean): CommandRecordView {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      actionType,
      status: simulated ? "simulated" : "acknowledged",
      createdAt: now,
      updatedAt: now,
      command,
      responseLine: simulated ? "模拟结果已应用" : "本地裁判状态已更新",
      ...(simulated ? { simulated: true } : {})
    };
  }

  public toCommandAction(competitionId: string, action: CompetitionAction): CommandAction {
    const runtime = this.host.workRuntimeManager.get(competitionId);
    const config = this.host.getPublishedConfig(competitionId) ?? this.host.getDraftConfig(competitionId);
    const currentStageId = runtime?.controller.snapshot().currentStageId;
    const stage = config.stages.find((candidate) => candidate.id === currentStageId) ?? config.stages[0];
    if (!stage) throw new ServiceError("STATE_CONFLICT", "比赛没有可执行动作的轮次", 409);
    switch (action.type) {
      case "notification": return { type: "notification", channel: action.channel, text: action.text };
      case "ready": return { type: "ready", map: stageCommandTarget(stage), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "cheat-off": return { type: "cheat-off" };
      case "manual-go": return { type: "go", map: stageCommandTarget(stage), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "kick": return { type: "kick", playerName: action.playerName, reason: "referee-kick" };
      case "raw-command": return { type: "raw", command: action.command };
      default: throw new ServiceError("CAPABILITY_UNSUPPORTED", `动作 ${action.type} 不需要或不支持 MockClient 命令`, 409);
    }
  }

  public toAutomationCommand(action: AutomationAction): CommandAction {
    switch (action.kind) {
      case "bulletin":
      case "notice":
      case "announce":
        return { type: "notification", channel: action.kind, text: action.message ?? "比赛流程通知" };
      case "ready": return { type: "ready", map: action.map, mode: action.mode };
      case "cheat-off": return { type: "cheat-off" };
      case "go": return { type: "go", map: action.map, mode: action.mode };
      case "force-next-restart": return { type: "force-next-restart" };
    }
  }

  public describe(action: CompetitionAction): string {
    switch (action.type) {
      case "notification": return `${action.channel}: ${action.text}`;
      case "kick": return `kick ${action.playerName}`;
      case "raw-command": return action.command;
      case "participant-associate": return `${action.participantId} <- ${action.connectionId}`;
      case "participant-split": return action.connectionId;
      case "participant-edit": return action.participantId;
      case "player-alias-upsert": return `${action.playerId} -> ${action.displayName}`;
      case "resolve-automation-command": return `${action.resolution}:${action.actionId}`;
      case "scoreboard-override": return `${action.playerId}:${action.stageId ?? "total"}`;
      default: return action.type;
    }
  }

  private wallTimeToRuntimeMs(competitionId: string, wallTimeMs: number): number {
    const competition = this.host.getCompetition(competitionId);
    if (competition.mode === "work") return performance.now() + (wallTimeMs - Date.now());
    const runId = this.host.getPayload(competitionId).activeRunId;
    if (!runId) throw new ServiceError("NOT_FOUND", "请先创建测试运行", 404);
    const runtime = this.host.testRuntimeManager.getRuntime(competitionId, runId);
    return wallTimeMs - Date.parse(runtime.createdAt);
  }

  private updateParticipantConnections(
    competitionId: string,
    participantId: string | undefined,
    update: (connections: readonly string[]) => string[]
  ): void {
    const config = this.host.getDraftConfig(competitionId);
    const participants = config.participants.map((participant) =>
      participantId === undefined || participant.id === participantId
        ? { ...participant, connectionIds: update(participant.connectionIds) }
        : participant);
    if (participantId !== undefined && !participants.some((participant) => participant.id === participantId)) {
      throw new ServiceError("NOT_FOUND", "参赛者不存在", 404);
    }
    this.host.upsertConfig(competitionId, { ...config, participants });
  }

  private editParticipant(competitionId: string, action: Extract<CompetitionAction, { type: "participant-edit" }>): void {
    const config = this.host.getDraftConfig(competitionId);
    let found = false;
    const participants = config.participants.map((participant) => {
      if (participant.id !== action.participantId) return participant;
      found = true;
      return {
        ...participant,
        ...(action.displayName === undefined ? {} : { displayName: action.displayName.trim() }),
        ...(action.notes === undefined ? {} : { notes: action.notes })
      };
    });
    if (!found) throw new ServiceError("NOT_FOUND", "参赛者不存在", 404);
    this.host.upsertConfig(competitionId, { ...config, participants });
  }

  private upsertPlayerAlias(competitionId: string, rawPlayerId: string, rawDisplayName: string): void {
    const playerId = rawPlayerId.trim();
    const displayName = rawDisplayName.trim();
    if (!playerId || playerId.startsWith("*")) throw new ServiceError("VALIDATION_FAILED", "玩家 ID 必须是非旁观模式的游戏内名称", 400);
    if (!displayName) throw new ServiceError("VALIDATION_FAILED", "排行榜显示名不能为空", 400);
    const config = this.host.getDraftConfig(competitionId);
    const normalizedPlayerId = playerId.toLocaleLowerCase("en-US");
    const aliases = [
      ...config.playerAliases.filter((alias) => alias.playerId.toLocaleLowerCase("en-US") !== normalizedPlayerId),
      { playerId, displayName }
    ];
    const participants = config.participants.map((participant) =>
      participant.id.toLocaleLowerCase("en-US") === normalizedPlayerId ? { ...participant, displayName } : participant);
    this.host.upsertConfig(competitionId, { ...config, playerAliases: aliases, participants });
    const workRuntime = this.host.workRuntimeManager.get(competitionId);
    const participant = participants.find((candidate) => candidate.id.toLocaleLowerCase("en-US") === normalizedPlayerId);
    if (workRuntime && participant) workRuntime.engine.registerPlayer(participant.id, displayName);
    const runId = this.host.getPayload(competitionId).activeRunId;
    if (runId && this.host.getCompetition(competitionId).mode === "test" && participant) {
      this.host.testRuntimeManager.getRuntime(competitionId, runId).engine.registerPlayer(participant.id, displayName);
    }
  }
}
