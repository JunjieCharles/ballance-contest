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
import type {
  WorkRuntime,
  WorkRuntimeManager,
  WorkStageRecoveryOptions
} from "./work-runtime-manager.js";
import { stageCommandTarget, stageDisplayName } from "@ballance/contracts";

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

export type StageRecoveryAction = Extract<
  CompetitionAction,
  { type: "restart-stage" | "mark-stage-started" | "force-reset-stage" | "force-next-stage" }
>;

export const assertRawCommandAllowed = (command: string): void => {
  if (/^forcenextrestart$/i.test(command.trim())) {
    throw new ServiceError("CAPABILITY_UNSUPPORTED", "forcenextrestart 会让下一次 Go 作用于服务器所有地图，比赛控制台禁止发送", 409);
  }
};

export class RefereeActionService {
  public constructor(private readonly host: RefereeActionHost) {}

  /**
   * Synchronous stage-recovery path used by the service-level SQLite unit of
   * work. It must not dispatch server commands or cross an async boundary.
   */
  public applyStageRecoveryLocal(
    competitionId: string,
    action: StageRecoveryAction,
    confirmation?: { runtimeToken?: string },
    workOptions: WorkStageRecoveryOptions = {}
  ): void {
    const competition = this.host.getCompetition(competitionId);
    const controller = this.host.controllerFor(competitionId);
    switch (action.type) {
      case "restart-stage": {
        if (!confirmation?.runtimeToken) {
          throw new ServiceError("CONFIRMATION_INVALID", "重赛确认缺少运行时凭据", 409);
        }
        const before = controller.snapshot();
        if (before.currentStageId !== action.stageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "当前关卡已变化，不能使用旧确认重赛", 409);
        }
        const controlledAttempt = before.attempts.findLast((attempt) =>
          attempt.stageId === action.stageId && !attempt.voided);
        const sourceId = `restart-stage:${action.stageId}:${controlledAttempt?.id ?? "before-go"}:${randomUUID()}`;
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          this.host.testRuntimeManager.restartCurrentStage(
            this.host.testRuntimeManager.getRuntime(competitionId, runId),
            {
              stageId: action.stageId,
              impactHash: action.impactHash,
              token: confirmation.runtimeToken,
              reason: "裁判重赛本关",
              sourceId
            }
          );
        } else {
          const runtime = this.host.workRuntimeManager.get(competitionId);
          if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
          this.host.workRuntimeManager.restartCurrentStage(runtime, {
            stageId: action.stageId,
            impactHash: action.impactHash,
            token: confirmation.runtimeToken,
            reason: "裁判重赛本关",
            sourceId
          }, workOptions);
        }
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制重赛本关",
          message: controlledAttempt
            ? `第 ${controlledAttempt.attemptNumber} 次尝试已作废并退出榜单；旧流程阻断已隔离，原始证据保留，当前关已重新进入 Ready。`
            : "本关尚未 Go；旧流程阻断已隔离，原始证据保留，当前关已重新进入 Ready。",
          occurredAt: new Date().toISOString(),
          stageId: action.stageId
        });
        return;
      }
      case "mark-stage-started": {
        const before = controller.snapshot();
        if (before.currentStageId !== action.stageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "当前 Ready 关卡已变化，不能使用旧确认标记起跑", 409);
        }
        const attempt = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.markCurrentReadyStageStarted(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.markCurrentReadyStageStarted(
                runtime,
                action.stageId,
                workOptions
              );
            })();
        this.host.appendAttention(competitionId, {
          id: `mark-stage-started:${attempt.id}:${randomUUID()}`,
          category: "flow",
          severity: "critical",
          title: "裁判已将当前关标记为已起跑",
          message: `本关尝试 #${attempt.attemptNumber} 以裁判确认时刻作为 goAt 并开始关卡时限；未发送服务器命令，标记前的比赛事件不会回补。自动化保持暂停。`,
          occurredAt: new Date().toISOString(),
          stageId: attempt.stageId
        });
        return;
      }
      case "force-reset-stage": {
        const before = controller.snapshot();
        if (before.currentStageId !== action.stageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "当前关卡已变化，不能使用旧确认强制重置", 409);
        }
        const sourceId = `force-reset-stage:${action.stageId}:${randomUUID()}`;
        const result = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.forceResetCurrentStage(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                sourceId,
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.forceResetCurrentStage(
                runtime,
                sourceId,
                action.stageId,
                workOptions
              );
            })();
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制重置本关",
          message: result.voidedAttempts.length > 0
            ? `${result.voidedAttempts.length} 个有效尝试和本关有效成绩已作废；本关已从当前时刻重新进入 T-60 准备，旧证据与榜单版本永久保留。`
            : "本关尚无有效尝试；已取消旧计划并从当前时刻重新进入 T-60 准备，旧证据永久保留。",
          occurredAt: new Date().toISOString(),
          stageId: result.stageId
        });
        return;
      }
      case "force-next-stage": {
        const before = controller.snapshot();
        const stages = [...(this.host.getPublishedConfig(competitionId) ?? this.host.getDraftConfig(competitionId)).stages]
          .sort((left, right) => left.order - right.order);
        const currentIndex = stages.findIndex((stage) => stage.id === before.currentStageId);
        const expectedNextStageId = currentIndex >= 0 ? stages[currentIndex + 1]?.id : undefined;
        if (!expectedNextStageId || action.stageId !== expectedNextStageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "下一关目标已变化，不能使用旧确认强制切关", 409);
        }
        const result = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.forceAdvanceToNextStage(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                before.currentStageId,
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.forceAdvanceToNextStage(
                runtime,
                before.currentStageId,
                action.stageId,
                workOptions
              );
            })();
        if (before.currentStageId !== result.fromStageId || expectedNextStageId !== result.toStageId) {
          throw new Error("FORCE_NEXT_STAGE_RESULT_MISMATCH");
        }
        const sourceId = `force-next-stage:${result.fromStageId}:${result.toStageId}:${randomUUID()}`;
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制进入下一关",
          message: `${result.fromStageId} 的成绩窗口已关闭且已有成绩保留；当前关已原子切换为 ${result.toStageId}，并从当前时刻进入 T-60 准备。`,
          occurredAt: new Date().toISOString(),
          stageId: result.toStageId
        });
        return;
      }
    }
  }

  public async applyLocal(
    competitionId: string,
    action: CompetitionAction,
    confirmation?: { runtimeToken?: string }
  ): Promise<boolean> {
    const competition = this.host.getCompetition(competitionId);
    if (competition.mode === "work") {
      const runtime = this.host.workRuntimeManager.get(competitionId);
      if (runtime) this.host.workRuntimeManager.synchronizeStageBoundary(runtime);
    }
    const controller = (): CompetitionController => this.host.controllerFor(competitionId);
    switch (action.type) {
      case "disconnect-work": {
        await this.host.workRuntimeManager.disconnect(competitionId);
        break;
      }
      case "reconnect-work": {
        if (competition.mode !== "work") throw new ServiceError("CAPABILITY_UNSUPPORTED", "测试模式没有真实 MockClient 可软重连", 409);
        await this.host.workRuntimeManager.reconnectClient(competitionId);
        break;
      }
      case "restart-work": {
        if (competition.mode === "work") await this.host.workRuntimeManager.restartClient(competitionId);
        else controller().observeServerConnected();
        break;
      }
      case "start-ready-flow": {
        controller().startReadyFlow();
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          this.host.testRuntimeManager.settle(this.host.testRuntimeManager.getRuntime(competitionId, runId));
        }
        break;
      }
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
      case "cheat-off": {
        controller().manualCheatOff();
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          this.host.testRuntimeManager.settle(this.host.testRuntimeManager.getRuntime(competitionId, runId));
        }
        break;
      }
      case "set-start-protection": {
        const snapshot = controller().snapshot();
        if (competition.mode === "test") this.host.testRuntimeManager.setStartProtectionUsed(competitionId, action.used);
        else {
          const runtime = this.host.workRuntimeManager.get(competitionId);
          if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
          runtime.controller.setStartProtectionUsed(action.used);
          this.host.workRuntimeManager.saveSnapshot(runtime);
        }
        this.host.appendAttention(competitionId, {
          id: `start-protection-manual:${snapshot.currentStageId}:${action.used}:${randomUUID()}`,
          category: "flow",
          severity: "warning",
          title: action.used ? "起跑保护已手动标记为已使用" : "起跑保护已手动重置为未使用",
          message: action.used
            ? "本关后续敏感期掉线不会再触发自动延时或作废。"
            : "本关后续首次有效敏感期掉线可以再次触发起跑保护。",
          occurredAt: new Date().toISOString(),
          stageId: snapshot.currentStageId
        });
        break;
      }
      case "reschedule": {
        const target = Date.parse(action.preparationAt);
        if (!Number.isFinite(target)) throw new ServiceError("VALIDATION_FAILED", "T-60 改期时间无效", 400);
        const preparationAt = this.wallTimeToRuntimeMs(competitionId, target);
        if (preparationAt < (controller().snapshot().clockNowMs ?? 0)) throw new ServiceError("VALIDATION_FAILED", "T-60 改期时间不能早于比赛当前时间", 400);
        controller().reschedule(preparationAt + 60_000);
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
        if (competition.mode === "work") {
          const runtime = this.host.workRuntimeManager.get(competitionId) as WorkRuntime;
          this.host.workRuntimeManager.mirrorSystemResults(runtime);
          this.host.workRuntimeManager.mirrorClosedAttempts(runtime);
        }
        break;
      case "restart-stage": {
        if (!confirmation?.runtimeToken) throw new ServiceError("CONFIRMATION_INVALID", "重赛确认缺少运行时凭据", 409);
        const before = controller().snapshot();
        if (before.currentStageId !== action.stageId) throw new ServiceError("ACTION_UNAVAILABLE", "当前关卡已变化，不能使用旧确认重赛", 409);
        const controlledAttempt = before.attempts.findLast((attempt) => attempt.stageId === action.stageId && !attempt.voided);
        const sourceId = `restart-stage:${action.stageId}:${controlledAttempt?.id ?? "before-go"}:${randomUUID()}`;
        if (competition.mode === "test") {
          const runId = this.host.getPayload(competitionId).activeRunId as string;
          const runtime = this.host.testRuntimeManager.getRuntime(competitionId, runId);
          this.host.testRuntimeManager.restartCurrentStage(runtime, {
            stageId: action.stageId,
            impactHash: action.impactHash,
            token: confirmation.runtimeToken,
            reason: "裁判重赛本关",
            sourceId
          });
        } else {
          const runtime = this.host.workRuntimeManager.get(competitionId);
          if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
          this.host.workRuntimeManager.restartCurrentStage(runtime, {
            stageId: action.stageId,
            impactHash: action.impactHash,
            token: confirmation.runtimeToken,
            reason: "裁判重赛本关",
            sourceId
          });
        }
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制重赛本关",
          message: controlledAttempt
            ? `第 ${controlledAttempt.attemptNumber} 次尝试已作废并退出榜单；旧流程阻断已隔离，原始证据保留，当前关已重新进入 Ready。`
            : "本关尚未 Go；旧流程阻断已隔离，原始证据保留，当前关已重新进入 Ready。",
          occurredAt: new Date().toISOString(),
          stageId: action.stageId
        });
        break;
      }
      case "mark-stage-started": {
        const before = controller().snapshot();
        if (before.currentStageId !== action.stageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "当前 Ready 关卡已变化，不能使用旧确认标记起跑", 409);
        }
        const attempt = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.markCurrentReadyStageStarted(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.markCurrentReadyStageStarted(runtime, action.stageId);
            })();
        this.host.appendAttention(competitionId, {
          id: `mark-stage-started:${attempt.id}:${randomUUID()}`,
          category: "flow",
          severity: "critical",
          title: "裁判已将当前关标记为已起跑",
          message: `本关尝试 #${attempt.attemptNumber} 以裁判确认时刻作为 goAt，关卡时限从该时刻开始；未发送服务器命令，标记前的比赛事件不会回补。自动化保持暂停。`,
          occurredAt: new Date().toISOString(),
          stageId: attempt.stageId
        });
        break;
      }
      case "force-reset-stage": {
        const before = controller().snapshot();
        if (before.currentStageId !== action.stageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "当前关卡已变化，不能使用旧确认强制重置", 409);
        }
        const sourceId = `force-reset-stage:${action.stageId}:${randomUUID()}`;
        const result = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.forceResetCurrentStage(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                sourceId,
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.forceResetCurrentStage(runtime, sourceId, action.stageId);
            })();
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制重置本关",
          message: result.voidedAttempts.length > 0
            ? `${result.voidedAttempts.length} 个有效尝试和本关有效成绩已作废；本关已从当前时刻重新进入 T-60 准备，旧证据与榜单版本永久保留。`
            : "本关尚无有效尝试；已取消旧计划并从当前时刻重新进入 T-60 准备，旧证据永久保留。",
          occurredAt: new Date().toISOString(),
          stageId: result.stageId
        });
        break;
      }
      case "force-next-stage": {
        const before = controller().snapshot();
        const stages = [...(this.host.getPublishedConfig(competitionId) ?? this.host.getDraftConfig(competitionId)).stages]
          .sort((left, right) => left.order - right.order);
        const currentIndex = stages.findIndex((stage) => stage.id === before.currentStageId);
        const expectedNextStageId = currentIndex >= 0 ? stages[currentIndex + 1]?.id : undefined;
        if (!expectedNextStageId || action.stageId !== expectedNextStageId) {
          throw new ServiceError("ACTION_UNAVAILABLE", "下一关目标已变化，不能使用旧确认强制切关", 409);
        }
        const result = competition.mode === "test"
          ? (() => {
              const runId = this.host.getPayload(competitionId).activeRunId as string;
              return this.host.testRuntimeManager.forceAdvanceToNextStage(
                this.host.testRuntimeManager.getRuntime(competitionId, runId),
                before.currentStageId,
                action.stageId
              );
            })()
          : (() => {
              const runtime = this.host.workRuntimeManager.get(competitionId);
              if (!runtime) throw new ServiceError("NOT_FOUND", "比赛连接尚未建立", 404);
              return this.host.workRuntimeManager.forceAdvanceToNextStage(runtime, before.currentStageId, action.stageId);
            })();
        if (before.currentStageId !== result.fromStageId || expectedNextStageId !== result.toStageId) {
          throw new Error("FORCE_NEXT_STAGE_RESULT_MISMATCH");
        }
        const sourceId = `force-next-stage:${result.fromStageId}:${result.toStageId}:${randomUUID()}`;
        this.host.appendAttention(competitionId, {
          id: sourceId,
          category: "flow",
          severity: "critical",
          title: "裁判已强制进入下一关",
          message: `${result.fromStageId} 的成绩窗口已关闭且已有成绩保留；当前关已原子切换为 ${result.toStageId}，并从当前时刻进入 T-60 准备。`,
          occurredAt: new Date().toISOString(),
          stageId: result.toStageId
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
        this.host.workRuntimeManager.synchronizeStageBoundary(runtime);
        const lifecycleAction = action.type === "reconnect-work" || action.type === "restart-work";
        if (!lifecycleAction && this.host.workRuntimeManager.businessCommandsReady(runtime)) {
          await runtime.runtime.dispatch();
        }
        const synchronized = this.host.workRuntimeManager.synchronizeStageBoundary(runtime);
        this.host.completeCompetitionOnReview(competitionId, synchronized);
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
    const snapshot = runtime?.controller.snapshot();
    const targetStageId = snapshot?.plannedReadyStageId ?? snapshot?.currentStageId;
    const stage = config.stages.find((candidate) => candidate.id === targetStageId) ?? config.stages[0];
    if (!stage) throw new ServiceError("STATE_CONFLICT", "比赛没有可执行动作的轮次", 409);
    switch (action.type) {
      case "notification": return { type: "notification", channel: action.channel, text: action.text };
      case "ready": return { type: "ready", map: stageCommandTarget(stage), mapName: stageDisplayName(stage), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "cheat-off": return { type: "cheat-off" };
      case "manual-go": return { type: "go", map: stageCommandTarget(stage), mapName: stageDisplayName(stage), mode: stage.mode.toLowerCase() as "sr" | "hs" };
      case "kick": return { type: "kick", playerName: action.playerName, reason: "referee-kick" };
      case "raw-command": {
        assertRawCommandAllowed(action.command);
        return { type: "raw", command: action.command };
      }
      default: throw new ServiceError("CAPABILITY_UNSUPPORTED", `动作 ${action.type} 不需要或不支持 MockClient 命令`, 409);
    }
  }

  public toAutomationCommand(action: AutomationAction): CommandAction {
    switch (action.kind) {
      case "bulletin":
      case "notice":
      case "announce":
        return { type: "notification", channel: action.kind, text: action.message ?? "比赛流程通知" };
      case "ready": return { type: "ready", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
      case "cheat-off": return { type: "cheat-off" };
      case "go": return { type: "go", map: action.map, ...(action.mapName === undefined ? {} : { mapName: action.mapName }), mode: action.mode };
    }
  }

  public describe(action: CompetitionAction): string {
    switch (action.type) {
      case "notification": return `${action.channel}: ${action.text}`;
      case "disconnect-work": return "手动断开服务器并暂停自动化";
      case "reconnect-work": return "通过当前 MockClient 软重新连接服务器";
      case "restart-work": return "重启 MockClient 并重新认证服务器连接";
      case "set-start-protection": return action.used ? "将本关起跑保护标记为已使用" : "将本关起跑保护重置为未使用";
      case "kick": return `kick ${action.playerName}`;
      case "raw-command": return action.command;
      case "participant-associate": return `${action.participantId} <- ${action.connectionId}`;
      case "participant-split": return action.connectionId;
      case "participant-edit": return action.participantId;
      case "player-alias-upsert": return `${action.playerId} -> ${action.displayName}`;
      case "resolve-automation-command": return `${action.resolution}:${action.actionId}`;
      case "resolve-command": return `${action.resolution}:${action.commandId}`;
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
