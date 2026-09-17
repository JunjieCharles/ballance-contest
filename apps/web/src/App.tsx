import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  LARGE_SCORING,
  MEDIUM_SCORING,
  SMALL_SCORING,
  createScoreboardTable,
  defaultHsStages,
  defaultSrStages,
  minimumScoringPlaceFor,
  scoreboardTableToHtml,
  scoreboardTableToTsv,
  stageDisplayName,
  stageMapKind,
  validateCompetitionConfigForPublish
} from "@ballance/contracts";
import type {
  ActionAvailability,
  CompetitionAction,
  CompetitionConfig,
  CompetitionMode,
  CompetitionRecordView,
  CompetitionSnapshot,
  ConfirmationIntent,
  ConfirmationKind,
  ConfirmationSummary,
  HealthResponse,
  NotificationChannel,
  RawClientLogLine,
  RefereeActionId,
  RuntimeSnapshot,
  ScenarioDefinition,
  ScoreboardTableCell,
  StageConfig,
  TestScenarioSummary,
  WorkConnectionStatus,
  WorkRecoveryStep
} from "@ballance/contracts";
import { formatUtc8DateTime, toUtc8Input, utc8InputToIso } from "./time.js";

interface Session { token: string; tabId: string; control: boolean }
interface JournalMessage { sequence?: number; type: string; competitionId?: string }
type ScoreDraft =
  | { playerId: string; stageId: string; operation: "set-place"; place: number; rankPolicy?: "tie" | "shift" }
  | { playerId: string; stageId: string; operation: "set-dnf"; rankPolicy?: "tie" | "shift" };

const sessionKey = "ballance-console-session";
const tabId = sessionStorage.getItem("ballance-console-tab") ?? crypto.randomUUID();
sessionStorage.setItem("ballance-console-tab", tabId);
const savedSession = sessionStorage.getItem(sessionKey);
const initialSession = savedSession ? JSON.parse(savedSession) as Session : null;

const request = async <T,>(path: string, session: Session | null, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...init?.headers
    }
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() as unknown : undefined;
  const envelope = typeof payload === "object" && payload !== null
    ? payload as { data?: T; error?: { message: string; details?: { issues?: unknown } } }
    : {};
  if (!response.ok) {
    const issues = envelope.error?.details?.issues;
    const issueText = Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === "string").join("；") : "";
    throw new Error(`${envelope.error?.message ?? `HTTP ${response.status}`}${issueText ? `：${issueText}` : ""}`);
  }
  return envelope.data !== undefined ? envelope.data : payload as T;
};

const formatMs = (value?: number): string => {
  if (value === undefined) return "—";
  const seconds = Math.max(0, Math.round(value / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

const phaseLabel: Record<string, string> = {
  draft: "草稿", published: "已发布", lobby: "大厅/练习", preparing: "准备检查",
  ready: "Ready", countdown: "倒计时", running: "比赛中", "tail-intake": "成绩接收中",
  "pre-start-wait": "等待选手", incident: "事故暂停", "restart-preparing": "重赛准备",
  review: "比赛复核", paused: "已暂停", finished: "已结束", archived: "已归档"
};

const workConnectionStatusLabel: Record<WorkConnectionStatus, string> = {
  connecting: "正在连接",
  authenticating: "正在认证",
  healthy: "连接健康",
  suspect: "连接可疑",
  recovering: "正在恢复",
  blocked: "连接已阻断"
};

const workRecoveryStepLabel: Record<WorkRecoveryStep, string> = {
  "soft-reconnect": "软重新连接",
  "verify-soft-connection": "核验软重连",
  "graceful-stop": "正常关闭旧 MockClient",
  "force-stop": "强制关闭旧 MockClient",
  cooldown: "等待服务器冷却",
  restart: "启动新 MockClient",
  "verify-restarted-connection": "重新认证并核验名单",
  "register-maps": "注册比赛地图"
};

type WorkServerEvidenceKind = NonNullable<NonNullable<RuntimeSnapshot["workConnection"]>["recentServerEvidence"]>["kind"];

const workServerEvidenceLabel: Record<WorkServerEvidenceKind, string> = {
  connected: "收到服务器连接回显",
  "authentication-failed": "服务器拒绝认证",
  "list-verified": "裁判身份与名单核验完成",
  disconnected: "服务器连接断开",
  "process-exited": "MockClient 进程退出"
};

const stageTitle = (config: CompetitionConfig, stageId?: string): string => {
  const stage = config.stages.find((candidate) => candidate.id === stageId);
  return stage ? stageDisplayName(stage) : stageId ?? "—";
};

const eventLabel = (event: ScenarioDefinition["events"][number]): string => {
  switch (event.type) {
    case "login": return `${event.playerId} 上线`;
    case "disconnect": return `${event.playerId} 掉线`;
    case "ready": return `${event.stageId} Ready`;
    case "go": return `${event.stageId} Go`;
    case "finish": return `${event.playerId} 完赛 ${event.stageId}`;
    case "dnf": return `${event.playerId} DNF ${event.stageId}`;
    case "exclude": return `${event.playerId} 排除 ${event.stageId}`;
    case "cheat": return `${event.playerId} cheat ${event.enabled ? "on" : "off"}`;
    case "warning": return `Warning ${event.message}`;
    case "fault": return `故障 ${event.fault}`;
  }
};

const profileLabel = (profile: string): string => ({
  normal: "普通玩家", expert: "游戏高手", struggler: "游戏低手", disruptor: "捣乱分子"
})[profile] ?? profile;

const availabilityFor = (runtime: RuntimeSnapshot, action: RefereeActionId): ActionAvailability | undefined =>
  runtime.availableActions.find((candidate) => candidate.action === action);

const hasCurrentActiveAttempt = (runtime: RuntimeSnapshot): boolean => runtime.attempts.some((candidate) => {
  if (typeof candidate !== "object" || candidate === null) return false;
  const attempt = candidate as { stageId?: unknown; goAtMs?: unknown; voided?: unknown };
  return attempt.stageId === runtime.currentStageId
    && typeof attempt.goAtMs === "number"
    && attempt.voided !== true;
});

interface ConfirmButtonProps {
  label: string;
  kind: ConfirmationKind;
  target: string;
  versionKey: string;
  requestPayload?: unknown;
  disabled?: boolean;
  disabledReason?: string | undefined;
  description?: string | undefined;
  className?: string | undefined;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
  onConfirm(confirmation: ConfirmationSummary): Promise<void>;
}

function ConfirmButton(props: ConfirmButtonProps) {
  return <ConfirmButtonState {...props} />;
}

function ConfirmButtonState({
  label,
  kind,
  target,
  versionKey,
  requestPayload,
  disabled,
  disabledReason,
  description,
  className,
  requestConfirmation,
  onConfirm
}: ConfirmButtonProps) {
  const [confirmation, setConfirmation] = useState<ConfirmationSummary>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const prepareGeneration = useRef(0);
  const preparing = useRef(false);
  const invalidationKey = `${kind}:${target}:${versionKey}:${disabled ? "disabled" : "enabled"}`;
  const previousInvalidationKey = useRef(invalidationKey);
  useLayoutEffect(() => {
    if (previousInvalidationKey.current === invalidationKey) return;
    previousInvalidationKey.current = invalidationKey;
    const interruptedPreparation = preparing.current;
    prepareGeneration.current += 1;
    preparing.current = false;
    setConfirmation(undefined);
    setError(interruptedPreparation ? "现场状态已变化，请重新点击确认" : "");
    if (interruptedPreparation) setBusy(false);
  }, [invalidationKey]);
  const prepare = async () => {
    const generation = prepareGeneration.current + 1;
    prepareGeneration.current = generation;
    preparing.current = true;
    setBusy(true); setError("");
    try {
      const prepared = await requestConfirmation(kind, target, requestPayload);
      if (prepareGeneration.current === generation) setConfirmation(prepared);
    } catch (caught) {
      if (prepareGeneration.current === generation) setError(caught instanceof Error ? caught.message : "无法创建确认");
    } finally {
      if (prepareGeneration.current === generation) {
        preparing.current = false;
        setBusy(false);
      }
    }
  };
  const confirm = async () => {
    if (!confirmation || disabled) return;
    setBusy(true); setError("");
    try { await onConfirm(confirmation); setConfirmation(undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <div className="confirm-action" data-version={versionKey}>
    <button aria-label={busy && !confirmation ? label : undefined} className={className} disabled={disabled || busy} title={disabledReason} onClick={() => void prepare()}>{busy && !confirmation ? "准备中…" : label}</button>
    {description && <small className="action-effect">{description}</small>}
    {disabled && disabledReason && <small className="disabled-reason">{disabledReason}</small>}
    {confirmation && <div className="inline-confirm" role="group" aria-label={`${label}确认`}>
      {(() => {
        const effect = confirmation.effect as ConfirmationSummary["effect"] & { affectedPlayers?: readonly { playerId: string; displayName: string; beforePlace: number | null; afterPlace: number | null; beforePoints: number; afterPoints: number; }[] };
        return <>
      <strong>{confirmation.effect.title}</strong>
      <ul>{effect.consequences.map((item) => <li key={item}>{item}</li>)}</ul>
      {effect.affectedPlayers?.length ? <div className="affected-players"><strong>受影响玩家</strong><ul>{effect.affectedPlayers.map((item) => <li key={item.playerId}><span>{item.displayName}</span><small>{item.beforePlace === null ? "空成绩" : `第 ${item.beforePlace} 名`} → {item.afterPlace === null ? "空成绩" : `第 ${item.afterPlace} 名`} · {item.beforePoints} 分 → {item.afterPoints} 分</small></li>)}</ul></div> : null}
      {confirmation.effect.irreversible && <small>确认后无法撤销。</small>}
      <div className="button-row compact">
        <button className={className} disabled={disabled || busy} onClick={() => void confirm()}>确认</button>
        <button className="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>取消</button>
      </div>
      {error && <span className="inline-error">{error}</span>}
      </>;
      })()}
    </div>}
    {!confirmation && error && <small className="inline-error">{error}</small>}
  </div>;
}

function LocalConfirmButton({ label, summary, disabled, className, onConfirm }: {
  label: string; summary: string; disabled?: boolean; className?: string; onConfirm(): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = async () => {
    setBusy(true); setError("");
    try { await onConfirm(); setOpen(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <div className="confirm-action">
    <button className={className} disabled={disabled || busy} onClick={() => setOpen(true)}>{label}</button>
    {open && <div className="inline-confirm"><strong>{label}</strong><span>{summary}</span><div className="button-row compact">
      <button disabled={busy} onClick={() => void confirm()}>{busy ? "保存中…" : "确认"}</button>
      <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </div>{error && <small className="inline-error">{error}</small>}</div>}
  </div>;
}

function ActionButton({ runtime, action, canWrite, onClick, children, className, disabled = false, disabledReason: localDisabledReason }: {
  runtime: RuntimeSnapshot; action: RefereeActionId; canWrite: boolean; onClick(): void; children: ReactNode; className?: string;
  disabled?: boolean; disabledReason?: string;
}) {
  const availability = availabilityFor(runtime, action);
  const isDisabled = !canWrite || !availability?.enabled || disabled;
  const disabledReason = !canWrite ? "实时连接或控制权不可用" : disabled ? localDisabledReason : availability?.disabledReason;
  return <div className="action-control">
    <button className={className} disabled={isDisabled} title={disabledReason} onClick={onClick}>{children}</button>
    {isDisabled && <small className="disabled-reason">{disabledReason ?? "当前状态不可用"}</small>}
    {!isDisabled && availability?.enabled && <small className="action-effect">{availability.effect}</small>}
  </div>;
}

function WorkConnectionPanel({ connection }: { connection: NonNullable<RuntimeSnapshot["workConnection"]> }) {
  const evidence = connection.recentServerEvidence;
  return <section className={`work-connection-panel connection-${connection.status}`} aria-label="工作模式连接状态">
    <div className="work-connection-heading">
      <h3>MockClient 与服务器连接</h3>
      <strong>{workConnectionStatusLabel[connection.status]}</strong>
    </div>
    <dl className="work-connection-facts">
      <div><dt>进程代次</dt><dd>{connection.processGeneration}</dd></div>
      <div><dt>连接代次</dt><dd>{connection.connectionGeneration}</dd></div>
      <div><dt>当前裁判连接 ID</dt><dd>{connection.refereeConnectionId ?? "尚未由本次 list 确认"}</dd></div>
      <div><dt>恢复步骤</dt><dd>{connection.recoveryStep ? workRecoveryStepLabel[connection.recoveryStep] : "—"}</dd></div>
    </dl>
    {connection.recoveryStartedAt && <p className="work-connection-meta">恢复开始：{formatUtc8DateTime(connection.recoveryStartedAt)}</p>}
    {connection.cooldownUntil && <p className="work-connection-meta">冷却至：{formatUtc8DateTime(connection.cooldownUntil)}</p>}
    <div className="work-connection-evidence">
      <strong>最近服务端证据</strong>
      {evidence
        ? <><span>{workServerEvidenceLabel[evidence.kind]} · {formatUtc8DateTime(evidence.occurredAt)}</span>
          <p>{evidence.detail}</p>
          <small>进程代次 {evidence.processGeneration} · 连接代次 {evidence.connectionGeneration}</small></>
        : <span className="muted">尚无经过后端核验的服务端证据</span>}
    </div>
  </section>;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [competitions, setCompetitions] = useState<CompetitionRecordView[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [snapshot, setSnapshot] = useState<CompetitionSnapshot>();
  const [scenarios, setScenarios] = useState<TestScenarioSummary[]>([]);
  const [scenarioDetail, setScenarioDetail] = useState<ScenarioDefinition | null>(null);
  const [tab, setTab] = useState<"console" | "config" | "players" | "scoreboard" | "test" | "archive">("config");
  const [name, setName] = useState("小型比赛");
  const [mode, setMode] = useState<CompetitionMode>("work");
  const [message, setMessage] = useState("正在连接本机服务…");
  const [draftSaving, setDraftSaving] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [rawLogs, setRawLogs] = useState<RawClientLogLine[]>([]);
  const [rawLogsMinimized, setRawLogsMinimized] = useState(false);
  const lastSequence = useRef(0);
  const snapshotRequestSequence = useRef(0);
  const selectedIdRef = useRef(selectedId);
  const draftSaveInFlight = useRef(false);
  const canWrite = Boolean(session?.control && realtimeConnected);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const refreshCompetitions = async (current: Session) => {
    const records = await request<CompetitionRecordView[]>("/api/v1/competitions", current);
    setCompetitions(records);
    setSelectedId((old) => old ?? records[0]?.id);
  };
  const refreshSnapshot = async (current: Session, competitionId: string, requireApplied = false): Promise<CompetitionSnapshot> => {
    while (true) {
      const requestSequence = ++snapshotRequestSequence.current;
      const next = await request<CompetitionSnapshot>(`/api/v1/competitions/${competitionId}/snapshot`, current);
      if (requestSequence === snapshotRequestSequence.current && selectedIdRef.current === competitionId) {
        setSnapshot(next);
        return next;
      }
      if (!requireApplied || selectedIdRef.current !== competitionId) return next;
    }
  };
  const refreshRawLogs = async (current: Session, competitionId: string) =>
    setRawLogs(await request<RawClientLogLine[]>(`/api/v1/competitions/${competitionId}/logs/raw?limit=250`, current));

  const selectCompetition = (competitionId: string) => {
    if (competitionId === selectedId) {
      if (session) void refreshSnapshot(session, competitionId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "快照加载失败"));
      return;
    }
    selectedIdRef.current = competitionId;
    setSnapshot(undefined); setScenarioDetail(null); setRawLogs([]); setSelectedId(competitionId);
  };

  useEffect(() => {
    void (async () => {
      try {
        setHealth(await request<HealthResponse>("/api/v1/health", null));
        let current = initialSession;
        const bootstrapToken = new URLSearchParams(location.hash.slice(1)).get("token");
        if (bootstrapToken) {
          current = await request<Session>("/api/v1/sessions/bootstrap", null, { method: "POST", body: JSON.stringify({ bootstrapToken, tabId }) });
          sessionStorage.setItem(sessionKey, JSON.stringify(current));
          history.replaceState(null, "", location.pathname);
          setSession(current);
        }
        if (current) {
          await refreshCompetitions(current);
          setScenarios(await request<TestScenarioSummary[]>("/api/v1/test-scenarios", current));
          setMessage(current.control ? "已取得控制权" : "只读标签页");
        } else setMessage("请通过启动器打开控制台以取得本机会话");
      } catch (error) { setMessage(error instanceof Error ? error.message : "连接失败"); }
    })();
  }, []);

  useEffect(() => {
    if (!session || !selectedId) return;
    const timer = window.setTimeout(() => void refreshSnapshot(session, selectedId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "快照加载失败")), 0);
    return () => window.clearTimeout(timer);
  }, [session, selectedId]);

  useEffect(() => {
    if (!session || !selectedId) return;
    const initial = window.setTimeout(() => void refreshRawLogs(session, selectedId).catch(() => undefined), 0);
    const timer = window.setInterval(() => void refreshRawLogs(session, selectedId).catch(() => undefined), 2_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [session, selectedId]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;
    let refreshing = false;
    let pending = false;
    const refresh = async () => {
      if (refreshing) { pending = true; return; }
      refreshing = true;
      try {
        const snapshotSequence = selectedId ? ++snapshotRequestSequence.current : undefined;
        const [records, next] = await Promise.all([
          request<CompetitionRecordView[]>("/api/v1/competitions", session),
          selectedId ? request<CompetitionSnapshot>(`/api/v1/competitions/${selectedId}/snapshot`, session) : Promise.resolve(undefined)
        ]);
        if (!disposed) {
          setCompetitions(records);
          if (next && snapshotSequence === snapshotRequestSequence.current) setSnapshot((current) => {
            if (!current || current.competition.id !== next.competition.id) return next;
            if (next.competition.stateVersion < current.competition.stateVersion) return current;
            if (next.competition.stateVersion === current.competition.stateVersion && next.runtime.stateVersion < current.runtime.stateVersion) return current;
            return next;
          });
        }
      } catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : "实时快照刷新失败"); }
      finally {
        refreshing = false;
        if (pending && !disposed) { pending = false; schedule(); }
      }
    };
    const schedule = () => {
      if (refreshing) { pending = true; return; }
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void refresh(); }, 100);
    };
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws?token=${encodeURIComponent(session.token)}&after=${lastSequence.current}`);
      socket.addEventListener("open", () => void refresh().then(() => { if (!disposed) setRealtimeConnected(true); }));
      socket.addEventListener("message", (event) => {
        if (disposed || typeof event.data !== "string") return;
        const update = JSON.parse(event.data) as JournalMessage;
        if (update.sequence !== undefined) lastSequence.current = Math.max(lastSequence.current, update.sequence);
        if (update.type === "snapshot-required" || update.competitionId) schedule();
      });
      socket.addEventListener("close", () => { if (!disposed) { setRealtimeConnected(false); reconnectTimer = window.setTimeout(connect, 1_000); } });
      socket.addEventListener("error", () => socket?.close());
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      socket?.close();
    };
  }, [session, selectedId]);

  const run = async (operation: () => Promise<string | void>, ok: string) => {
    try {
      const target = await operation() ?? selectedId;
      if (session) await refreshCompetitions(session);
      if (target && target !== selectedId) { setSelectedId(target); }
      else if (session && target) await refreshSnapshot(session, target, true);
      setMessage(ok);
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); throw error; }
  };

  const createCompetition = () => run(async () => {
    if (!session) throw new Error("没有本机会话");
    const created = await request<CompetitionRecordView>("/api/v1/competitions", session, {
      method: "POST", body: JSON.stringify({ name, mode, idempotencyKey: crypto.randomUUID() })
    });
    setTab("config");
    return created.id;
  }, "比赛已创建");

  const saveDraft = async (patch: Partial<CompetitionConfig>) => {
    if (draftSaveInFlight.current) throw new Error("草稿正在保存，请等待当前修改落地后再继续");
    draftSaveInFlight.current = true;
    setDraftSaving(true);
    try {
      await run(async () => {
        if (!session || !snapshot) throw new Error("请选择比赛");
        await request(`/api/v1/competitions/${snapshot.competition.id}/draft`, session, {
          method: "PATCH",
          body: JSON.stringify({ ...patch, expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
        });
      }, "草稿已保存");
    } finally {
      draftSaveInFlight.current = false;
      setDraftSaving(false);
    }
  };

  const publish = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/publish`, session, {
      method: "POST", body: JSON.stringify({ expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "发布检查通过，比赛已发布");

  const saveConnection = (server: string) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request('/api/v1/competitions/' + snapshot.competition.id + '/connection', session, {
      method: "PATCH", body: JSON.stringify({ server, expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "服务器地址已保存");

  const startWork = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/work/start`, session, { method: "POST", body: JSON.stringify({ expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() }) });
  }, "已启动服务器连接，等待身份认证");

  const enableAutomation = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/automation/enable`, session, {
      method: "POST",
      body: JSON.stringify({
        runId: snapshot.testRun?.runId,
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(),
      })
    });
  }, snapshot?.runtime.phase === "paused" ? "自动化已恢复" : "自动化已启动");

  const pauseAutomation = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/automation/pause`, session, { method: "POST", body: "{}" });
  }, "自动化已暂停");

  const performAction = (action: CompetitionAction) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/actions`, session, {
      method: "POST",
      body: JSON.stringify({ expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID(), action })
    });
  }, snapshot?.competition.mode === "test" ? "模拟裁判动作已应用" : "裁判动作已提交");

  const requestConfirmation = async (kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary> => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    return request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
      method: "POST", body: JSON.stringify({ kind, target, ...(typeof requestPayload === "object" && requestPayload !== null ? requestPayload : {}) })
    });
  };

  const overrideScoreboard = (draft: ScoreDraft, confirmation: ConfirmationSummary) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/scoreboard/overrides`, session, {
      method: "POST",
      body: JSON.stringify({
        ...draft,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID()
      })
    });
  }, "成绩修订版本已生成");

  const updateScoreboardScoring = (points: readonly number[], confirmation: ConfirmationSummary) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/scoreboard/scoring`, session, {
      method: "POST",
      body: JSON.stringify({
        points,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID()
      })
    });
  }, "实时计分映射已更新，榜单已重算");

  const loadScenario = async (scenarioId: string) => {
    if (!session) return;
    setScenarioDetail(await request<ScenarioDefinition>(`/api/v1/test-scenarios/${scenarioId}`, session));
  };
  const createRun = (scenarioId: string) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择测试比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/test-runs/from-scenario`, session, {
      method: "POST", body: JSON.stringify({ scenarioId })
    });
    await loadScenario(scenarioId);
  }, "测试运行已创建");
  const advanceClock = (milliseconds: number) => run(async () => {
    if (!session || !snapshot?.testRun) throw new Error("尚未创建测试运行");
    await request(`/api/v1/competitions/${snapshot.competition.id}/test-runs/${snapshot.testRun.runId}/automation/advance`, session, {
      method: "POST", body: JSON.stringify({ milliseconds })
    });
  }, "虚拟时钟已快进");

  const downloadExport = async (format: "csv" | "xlsx") => {
    if (!session || !snapshot) return;
    try {
      const response = await fetch(`/api/v1/competitions/${snapshot.competition.id}/exports/${format}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!response.ok) throw new Error(`导出失败 ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      const version = snapshot.scoreboardVersions.at(-1)?.version ?? 0;
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
      link.href = url; link.download = encodedName ? decodeURIComponent(encodedName) : `${snapshot.competition.name}-${snapshot.competition.mode}-scoreboard-v${version}.${format}`; link.click(); URL.revokeObjectURL(url);
      setMessage(`已导出 ${format.toUpperCase()}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导出失败"); }
  };

  const archiveCompetition = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/archive`, session, {
      method: "POST", body: JSON.stringify({ version: snapshot.archives.length + 1 })
    });
  }, "归档已生成");

  const finishCompetition = (confirmation: ConfirmationSummary, archiveAfter: boolean) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/finish`, session, {
      method: "POST",
      body: JSON.stringify({
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(), confirmationToken: confirmation.token, impactHash: confirmation.impactHash,
        confirmationIntent: archiveAfter ? "finish-and-archive" : "finish"
      })
    });
    if (archiveAfter) await request(`/api/v1/competitions/${snapshot.competition.id}/archive`, session, {
      method: "POST", body: JSON.stringify({ version: snapshot.archives.length + 1 })
    });
  }, archiveAfter ? "比赛已结束并归档" : "比赛已结束");

  const deleteCompetition = (confirmation: ConfirmationSummary) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}`, session, {
      method: "DELETE",
      body: JSON.stringify({
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(), confirmationToken: confirmation.token, impactHash: confirmation.impactHash
      })
    });
    setSnapshot(undefined); setSelectedId(undefined); setRawLogs([]);
    return "";
  }, "比赛已删除");

  const runtime = snapshot?.runtime;
  const versionKey = snapshot ? `${snapshot.competition.stateVersion}:${snapshot.runtime.stateVersion}` : "none";
  const scoreboardVersionKey = snapshot ? `${snapshot.competition.id}:${snapshot.competition.stateVersion}` : "none";
  const visibleTabs = (["config", "console", "players", "scoreboard", "test", "archive"] as const)
    .filter((item) => snapshot?.competition.mode === "test" || item !== "test");
  const activeTab = snapshot?.competition.mode === "work" && tab === "test" ? "console" : tab;
  return <main className={snapshot?.competition.mode === "test" ? "test-mode" : "work-mode"}>
    {snapshot?.competition.mode === "test" && <div className="watermark">测试数据</div>}
    <header>
      <strong>Ballance 比赛控制台</strong>
      <span className="mode-badge">{snapshot?.competition.mode === "work" ? "工作模式" : snapshot?.competition.mode === "test" ? "测试模式" : "未选择比赛"}</span>
      <span>{health ? `服务 ${health.version}` : "离线"} · {realtimeConnected ? "实时已连接" : "实时重连中"} · {message}</span>
      {session && !session.control && <button className="header-button" onClick={() => void run(async () => {
        const next = await request<Session>("/api/v1/sessions/control", session, { method: "POST", body: "{}" });
        sessionStorage.setItem(sessionKey, JSON.stringify(next)); setSession(next);
      }, "已接管控制权")}>接管</button>}
    </header>
    <div className="shell">
      <aside className="sidebar">
        <section className="panel create-panel"><h2>比赛</h2>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>模式<select value={mode} onChange={(event) => setMode(event.target.value as CompetitionMode)}><option value="work">工作模式</option><option value="test">测试模式</option></select></label>
          <button disabled={!canWrite} onClick={() => void createCompetition()}>新建比赛</button>
        </section>
        <nav className="competition-list">{competitions.map((item) => <button className={item.id === selectedId ? "selected" : "ghost"} key={item.id} onClick={() => selectCompetition(item.id)}>
          <span>{item.name}</span><small>{item.mode === "work" ? "工作" : "测试"} · {item.status} · v{item.stateVersion}</small>
        </button>)}</nav>
      </aside>
      <section className="workspace">
        {snapshot && runtime ? <>
          <section className="status-strip">
            <div><span>阶段</span><strong>{phaseLabel[runtime.phase] ?? runtime.phase}</strong></div>
            <div><span>关卡</span><strong>{stageTitle(snapshot.config, runtime.currentStageId)}</strong></div>
            <div><span>本关 Ready（UTC+8）</span><strong>{formatUtc8DateTime(runtime.currentStageReadyAt)}</strong></div>
            <div><span>{hasCurrentActiveAttempt(runtime) ? "本关起跑（UTC+8）" : "预计起跑（UTC+8）"}</span><strong>{formatUtc8DateTime(runtime.plannedStageStartAt)}</strong></div>
            <div><span>本关最晚结束（UTC+8）</span><strong>{formatUtc8DateTime(runtime.stageDeadlineAt)}</strong></div>
            <div><span>下一关 T-60（UTC+8）</span><strong>{formatUtc8DateTime(runtime.nextStagePreparationAt)}</strong></div>
            <div><span>下一关 Ready（UTC+8）</span><strong>{formatUtc8DateTime(runtime.nextStageReadyAt)}</strong></div>
            <div><span>自动化 / 倒数</span><strong>{runtime.automationEnabled ? "启用" : "暂停"}{runtime.countdownValue ? ` · ${runtime.countdownValue}` : ""}</strong></div>
          </section>
          <div className="tabs">{visibleTabs.map((item) =>
            <button className={activeTab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{({ config: "比赛配置", console: "控制台", players: "玩家", scoreboard: "成绩", test: "测试", archive: "归档" })[item]}</button>)}</div>
          {activeTab === "console" && <ConsolePanel snapshot={snapshot} canWrite={canWrite} versionKey={versionKey}
            saveConnection={saveConnection} startWork={() => startWork()} enableAutomation={() => enableAutomation()} pauseAutomation={() => pauseAutomation()}
            performAction={(action) => performAction(action)} requestConfirmation={requestConfirmation} />}
          {activeTab === "config" && <ConfigPanel key={`${snapshot.competition.id}:${snapshot.competition.stateVersion}`} snapshot={snapshot} canWrite={canWrite}
            saving={draftSaving} saveDraft={(patch) => saveDraft(patch)} publish={() => publish()} />}
          {activeTab === "players" && <PlayersPanel snapshot={snapshot} canWrite={canWrite} performAction={(action) => performAction(action)} />}
          {activeTab === "scoreboard" && <ScoreboardPanel snapshot={snapshot} canWrite={canWrite} versionKey={scoreboardVersionKey}
            requestConfirmation={requestConfirmation} overrideScoreboard={overrideScoreboard} updateScoring={updateScoreboardScoring} downloadExport={downloadExport} />}
          {activeTab === "test" && <TestPanel snapshot={snapshot} scenarios={scenarios} scenarioDetail={scenarioDetail} canWrite={canWrite}
            loadScenario={loadScenario} createRun={createRun} advanceClock={(ms) => advanceClock(ms)} />}
          {activeTab === "archive" && <ArchivePanel snapshot={snapshot} canWrite={canWrite} versionKey={versionKey}
            requestConfirmation={requestConfirmation} archiveCompetition={archiveCompetition} finishCompetition={finishCompetition} deleteCompetition={deleteCompetition} />}
        </> : <section className="empty-state">请选择或新建比赛</section>}
      </section>
    </div>
    {snapshot && <RawLogWindow key={snapshot.competition.id} logs={rawLogs} minimized={rawLogsMinimized} setMinimized={setRawLogsMinimized}
      refresh={() => session && selectedId ? void refreshRawLogs(session, selectedId) : undefined} mode={snapshot.competition.mode} />}
  </main>;
}

function ConsolePanel({ snapshot, canWrite, versionKey, saveConnection, startWork, enableAutomation, pauseAutomation, performAction, requestConfirmation }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  saveConnection(server: string): Promise<void>;
  startWork(): Promise<void>; enableAutomation(): Promise<void>; pauseAutomation(): Promise<void>;
  performAction(action: CompetitionAction): Promise<void>;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
}) {
  const runtime = snapshot.runtime;
  const savedServer = snapshot.connectionSettings?.server ?? snapshot.config.server;
  const serverKey = `${snapshot.competition.id}:${savedServer}`;
  const [serverDraft, setServerDraft] = useState({ key: serverKey, value: savedServer });
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const connectionSaveInFlight = useRef(false);
  const addressLocked = snapshot.connectionSettings?.locked ?? Boolean(runtime.workConnection);
  const server = !addressLocked && serverDraft.key === serverKey ? serverDraft.value : savedServer;
  const serverDirty = server.trim() !== savedServer;
  const [channel, setChannel] = useState<NotificationChannel>("notice");
  const [notification, setNotification] = useState("比赛流程通知");
  const [participantId, setParticipantId] = useState(snapshot.config.participants[0]?.id ?? "");
  const [rawCommand, setRawCommand] = useState("");
  const [scheduleAt, setScheduleAt] = useState(() => toUtc8Input(new Date(Date.now() + 5 * 60_000)));
  const participant = snapshot.config.participants.find((candidate) => candidate.id === participantId);
  const startConnection = availabilityFor(runtime, "start-work");
  const workConnection = snapshot.competition.mode === "work" ? runtime.workConnection : undefined;
  const lifecycleVersionKey = workConnection
    ? `${versionKey}:${workConnection.status}:p${workConnection.processGeneration}:c${workConnection.connectionGeneration}:${workConnection.refereeConnectionId ?? "unverified"}`
    : versionKey;
  const mapsRegistering = workConnection?.status === "healthy" && workConnection.recoveryStep === "register-maps";
  const liveCommandUnavailable = snapshot.competition.mode === "work"
    && (workConnection?.status !== "healthy" || mapsRegistering);
  const liveCommandDisabledReason = liveCommandUnavailable
    ? mapsRegistering
      ? "当前 MockClient 正在完成地图注册；完成前不能重发真实命令"
      : `当前连接为${workConnection ? workConnectionStatusLabel[workConnection.status] : "未建立"}；完成服务器身份核验后才能重发真实命令`
    : undefined;
  const stageBoundConfirmationActions = new Set<RefereeActionId>([
    "start-ready-flow",
    "ready",
    "manual-go",
    "delay-ready",
    "extend-stage-deadline",
    "reschedule",
    "reschedule-stage-deadline",
    "end-stage",
    "restart-stage",
    "mark-stage-started",
    "force-reset-stage",
    "force-next-stage"
  ]);
  const confirmedAction = (
    label: string,
    actionId: RefereeActionId,
    kind: ConfirmationKind,
    target: string,
    build: (confirmation: ConfirmationSummary) => CompetitionAction,
    className?: string,
    extraDisabled = false,
    extraReason?: string,
    confirmationVersionKey = versionKey
  ) => {
    const availability = availabilityFor(runtime, actionId);
    const targetStageId = stageBoundConfirmationActions.has(actionId) ? availability?.targetStageId : undefined;
    const confirmationTarget = targetStageId ?? target;
    const confirmationPayload: Record<string, unknown> = {
      intent: actionId as ConfirmationIntent,
      stageId: targetStageId ?? runtime.currentStageId,
      ...(actionId === "delay-ready" || actionId === "extend-stage-deadline" ? { milliseconds: 60_000 } : {}),
      ...(actionId === "reschedule" ? { preparationAt: utc8InputToIso(scheduleAt) } : {}),
      ...(actionId === "reschedule-stage-deadline" ? { deadlineAt: utc8InputToIso(scheduleAt) } : {}),
      ...(actionId === "raw-command" ? { command: rawCommand.trim() } : {})
    };
    return <ConfirmButton label={label} kind={kind} target={confirmationTarget} versionKey={confirmationVersionKey} className={className}
      description={["mark-stage-started", "restart-stage", "force-reset-stage", "force-next-stage"].includes(actionId) ? availability?.effect : undefined}
      disabled={!canWrite || !availability?.enabled || extraDisabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : extraDisabled ? extraReason : availability?.disabledReason}
      requestPayload={confirmationPayload} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => performAction(build(confirmation))} />;
  };
  return <section className="grid two">
    <div className="panel"><h2>裁判操作</h2>
      <div className="button-row action-row">
        {snapshot.competition.mode === "work" && <div className="connection-settings">
          <label>服务器地址<input value={server} disabled={!canWrite || addressLocked || connectionSaving} onChange={event => setServerDraft({ key: serverKey, value: event.target.value })} /></label>
          {!addressLocked && <button disabled={!canWrite || connectionSaving || !serverDirty || !server.trim()} onClick={() => {
            if (connectionSaveInFlight.current) return;
            connectionSaveInFlight.current = true; setConnectionSaving(true); setConnectionError("");
            void saveConnection(server).catch(error => setConnectionError(error instanceof Error ? error.message : "地址保存失败")).finally(() => { connectionSaveInFlight.current = false; setConnectionSaving(false); });
          }}>保存地址</button>}
          <small>{addressLocked ? "手动断开后可修改地址" : serverDirty ? "请先保存地址，再连接服务器" : "发布前可连接服务器查看玩家；发布后才能启动自动化"}</small>
          {connectionError && <small role="alert">{connectionError}</small>}
        </div>}
        {snapshot.competition.mode === "test"
          ? confirmedAction(availabilityFor(runtime, "restart-work")?.label ?? "模拟恢复连接", "restart-work", "high-risk", snapshot.competition.id,
            (confirmation) => ({ type: "restart-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))
          : startConnection?.enabled
            ? <ActionButton runtime={runtime} action="start-work" canWrite={canWrite && !serverDirty && !connectionSaving}
              onClick={() => void startWork()}>{startConnection.label}</ActionButton>
            : workConnection
            ? <>
              {confirmedAction("手动断开", "disconnect-work", "high-risk", snapshot.competition.id,
                confirmation => ({ type: "disconnect-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, lifecycleVersionKey)}
              {confirmedAction("软重新连接", "reconnect-work", "high-risk", snapshot.competition.id,
                (confirmation) => ({ type: "reconnect-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, lifecycleVersionKey)}
              {confirmedAction("重启 MockClient", "restart-work", "high-risk", snapshot.competition.id,
                (confirmation) => ({ type: "restart-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, lifecycleVersionKey)}
            </>
            : <ActionButton runtime={runtime} action="start-work" canWrite={canWrite && !serverDirty && !connectionSaving}
              onClick={() => void startWork()}>{startConnection?.label ?? "连接比赛服务器"}</ActionButton>}
        <ActionButton runtime={runtime} action="enable-automation" canWrite={canWrite} onClick={() => void enableAutomation()}>{availabilityFor(runtime, "enable-automation")?.label ?? "启动自动化"}</ActionButton>
        <ActionButton runtime={runtime} action="pause-automation" canWrite={canWrite} className="secondary" onClick={() => void pauseAutomation()}>暂停自动化</ActionButton>
      </div>
      {workConnection && <WorkConnectionPanel connection={workConnection} />}
      <h3>面向玩家的通知</h3>
      <div className="inline-form notification-form"><select aria-label="通知类型" value={channel} onChange={(event) => setChannel(event.target.value as NotificationChannel)}>
        <option value="bulletin">Bulletin · 顶部状态</option><option value="notice">Notice · 普通通知</option><option value="announce">Announce · 中央重要通知</option><option value="s">s · 公共聊天发言</option>
      </select><input aria-label="通知文本" value={notification} onChange={(event) => setNotification(event.target.value)} /><ActionButton runtime={runtime} action="notification" canWrite={canWrite} disabled={!notification.trim()} disabledReason="请输入通知文本" onClick={() => void performAction({ type: "notification", channel, text: notification })}>发送</ActionButton></div>
      <h3>流程控制</h3>
      <div className="button-row action-row">
        {confirmedAction("进入 Ready+发令流程", "start-ready-flow", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "start-ready-flow", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("手动 Ready", "ready", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "ready", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        <ActionButton runtime={runtime} action="cheat-off" canWrite={canWrite} onClick={() => void performAction({ type: "cheat-off" })}>关闭 cheat</ActionButton>
        {confirmedAction("手动发令", "manual-go", "manual-go", snapshot.competition.id, (confirmation) => ({ type: "manual-go", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("提前结束本关", "end-stage", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "end-stage", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
        <p>起跑保护剩余 {runtime.startProtectionRemaining} 次{runtime.startProtectionRemaining === 1 ? "（仅保护 fatal error）" : runtime.startProtectionRemaining === 2 ? "（第一次保护任何掉线，第二次仅保护 fatal error）" : ""}</p>
        {confirmedAction("将起跑保护标记为已使用", "set-start-protection", "manual-action", `${snapshot.competition.id}:start-protection:${runtime.currentStageId}:true`, (confirmation) => ({ type: "set-start-protection", used: true, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger", runtime.startProtectionEnabled && runtime.startProtectionRemaining === 0, "本关两次保护均已使用", `${snapshot.competition.stateVersion}:${runtime.currentStageId}:${runtime.startProtectionRemaining}`)}
        {confirmedAction("将起跑保护重置为未使用", "set-start-protection", "manual-action", `${snapshot.competition.id}:start-protection:${runtime.currentStageId}:false`, (confirmation) => ({ type: "set-start-protection", used: false, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, runtime.startProtectionEnabled && runtime.startProtectionRemaining === 2, "本关两次保护均未使用", `${snapshot.competition.stateVersion}:${runtime.currentStageId}:${runtime.startProtectionRemaining}`)}
      </div>
      <h3 id="现场恢复">现场恢复</h3>
      <div className="button-row action-row" role="group" aria-labelledby="现场恢复">
        {confirmedAction(availabilityFor(runtime, "mark-stage-started")?.label ?? "设为本关已起跑", "mark-stage-started", "manual-action", snapshot.competition.id,
          (confirmation) => ({ type: "mark-stage-started", stageId: availabilityFor(runtime, "mark-stage-started")?.targetStageId ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
        {confirmedAction("重置本关到 Ready", "restart-stage", "restart-stage", availabilityFor(runtime, "restart-stage")?.targetStageId ?? snapshot.competition.id, (confirmation) => ({ type: "restart-stage", stageId: availabilityFor(runtime, "restart-stage")?.targetStageId ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
        {confirmedAction(availabilityFor(runtime, "force-reset-stage")?.label ?? "重置本关到 T-60", "force-reset-stage", "manual-action", snapshot.competition.id,
          (confirmation) => ({ type: "force-reset-stage", stageId: availabilityFor(runtime, "force-reset-stage")?.targetStageId ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
        {confirmedAction(availabilityFor(runtime, "force-next-stage")?.label ?? "进入下一关 T-60", "force-next-stage", "manual-action", snapshot.competition.id,
          (confirmation) => ({ type: "force-next-stage", stageId: availabilityFor(runtime, "force-next-stage")?.targetStageId ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
      </div>
      <h3>相对延时</h3>
      <div className="button-row action-row">
        {confirmedAction("Ready 延后 1 分钟", "delay-ready", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "delay-ready", milliseconds: 60_000, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("本关时限延长 1 分钟", "extend-stage-deadline", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "extend-stage-deadline", milliseconds: 60_000, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
      </div>
      <h3>改期（UTC+8）</h3><p className="muted">T-60 改期设置准备阶段的开始时间，第一条 Ready 在该时间后 60 秒发送。</p>
      <div className="schedule-editor"><input aria-label="改期时间（UTC+8）" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
        {confirmedAction("T-60 改期", "reschedule", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "reschedule", preparationAt: utc8InputToIso(scheduleAt), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, `${versionKey}:${scheduleAt}`)}
        {confirmedAction("关卡时限改期", "reschedule-stage-deadline", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "reschedule-stage-deadline", deadlineAt: utc8InputToIso(scheduleAt), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, `${versionKey}:${scheduleAt}`)}
      </div>
    </div>
    <div className="panel"><h2>流程动态与注意事项</h2>
      {runtime.unconfirmedAutomationActions.length > 0 && <section className="unconfirmed-command-panel critical"><h3>未确认流程命令</h3>
        <p className="muted">请逐条选择“确认已执行”或“执行重发”。原命令审计永不覆盖。</p>
        {runtime.unconfirmedAutomationActions.map((action) => <div className="unconfirmed-command-row" key={action.id}>
          <div><strong>{action.kind}</strong><small>{action.stageId} · {action.status}</small></div>
          <ConfirmButton key={`confirm-executed:${action.id}`} label="确认已执行" kind="automation-command-resolution" target={action.id} versionKey={versionKey}
            requestPayload={{ actionId: action.id, resolution: "confirm-executed" }} disabled={!canWrite} requestConfirmation={requestConfirmation}
            onConfirm={(confirmation) => performAction({ type: "resolve-automation-command", actionId: action.id, resolution: "confirm-executed", confirmationToken: confirmation.token, impactHash: confirmation.impactHash })} />
          <ConfirmButton key={`resend:${action.id}`} label="执行重发" kind="automation-command-resolution" target={action.id} versionKey={lifecycleVersionKey} className="danger"
            requestPayload={{ actionId: action.id, resolution: "resend" }} disabled={!canWrite || liveCommandUnavailable} disabledReason={!canWrite ? "实时连接或控制权不可用" : liveCommandDisabledReason} requestConfirmation={requestConfirmation}
            onConfirm={(confirmation) => performAction({ type: "resolve-automation-command", actionId: action.id, resolution: "resend", confirmationToken: confirmation.token, impactHash: confirmation.impactHash })} />
        </div>)}</section>}
      {runtime.unconfirmedCommands.length > 0 && <section className="unconfirmed-command-panel critical"><h3>未确认真实命令</h3>
        <p className="muted">这些命令可能失败或已经执行但缺少可靠结果。请逐条核对；原审计记录永久保留。</p>
        {runtime.unconfirmedCommands.map((command) => <div className="unconfirmed-command-row" key={command.id}>
          <div><strong>{command.actionType}</strong><small>{command.command} · {command.status}</small></div>
          <ConfirmButton key={`command-confirmed:${command.id}`} label={command.status === "failed" ? "确认不再执行" : "确认已执行"} kind="command-resolution" target={command.id} versionKey={versionKey}
            requestPayload={{ commandId: command.id, resolution: command.status === "failed" ? "dismiss-failed" : "confirm-executed" }} disabled={!canWrite} requestConfirmation={requestConfirmation}
            onConfirm={(confirmation) => performAction({ type: "resolve-command", commandId: command.id, resolution: command.status === "failed" ? "dismiss-failed" : "confirm-executed", confirmationToken: confirmation.token, impactHash: confirmation.impactHash })} />
          <ConfirmButton key={`command-resend:${command.id}`} label="执行重发" kind="command-resolution" target={command.id} versionKey={lifecycleVersionKey} className="danger"
            requestPayload={{ commandId: command.id, resolution: "resend" }} disabled={!canWrite || liveCommandUnavailable} disabledReason={!canWrite ? "实时连接或控制权不可用" : liveCommandDisabledReason} requestConfirmation={requestConfirmation}
            onConfirm={(confirmation) => performAction({ type: "resolve-command", commandId: command.id, resolution: "resend", confirmationToken: confirmation.token, impactHash: confirmation.impactHash })} />
        </div>)}</section>}
      {runtime.observationGaps.length > 0 && <section className="unconfirmed-command-panel critical"><h3>服务中断观察缺口</h3>
        <p className="muted">这些事项无法从日志或排行榜可靠补回。核对现场后可确认带缺口继续；当前尝试不可信时请使用“重置本关到 Ready”。</p>
        {runtime.observationGaps.map((gap) => <div className="unconfirmed-command-row" key={gap.id}>
          <div><strong>{gap.code}</strong><small>{gap.detail}</small></div>
          <ConfirmButton key={`gap-continue:${gap.id}`} label="确认带缺口继续" kind="observation-gap-resolution" target={gap.id} versionKey={versionKey}
            requestPayload={{ gapId: gap.id, resolution: "continue" }} disabled={!canWrite} requestConfirmation={requestConfirmation}
            onConfirm={(confirmation) => performAction({ type: "resolve-observation-gap", gapId: gap.id, resolution: "continue", confirmationToken: confirmation.token, impactHash: confirmation.impactHash })} />
        </div>)}</section>}
      {runtime.attentionItems.length === 0 && <p className="muted">暂无需要注意的流程动态。</p>}
      <div className="attention-list">{runtime.attentionItems.map((item) => <article className={`attention-card ${item.severity}`} key={item.id}>
        <div><strong>{item.title}</strong><time>{formatUtc8DateTime(item.occurredAt)}</time></div>
        <p>{[item.message, item.stageId ? `关卡 ${stageTitle(snapshot.config, item.stageId)}` : "", item.participantIds?.length ? `玩家 ${item.participantIds.join("、")}` : ""].filter(Boolean).join(" · ")}</p>
        {item.action === "restart-work" && confirmedAction(availabilityFor(runtime, "restart-work")?.label ?? "恢复连接", "restart-work", "high-risk", snapshot.competition.id,
          (confirmation) => ({ type: "restart-work", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), undefined, false, undefined, lifecycleVersionKey)}
        {item.action === "enable-automation" && <ActionButton runtime={runtime} action="enable-automation" canWrite={canWrite} onClick={() => void enableAutomation()}>核对后恢复自动化</ActionButton>}
      </article>)}</div>
      <h3>事故与尝试</h3><p className="muted">事故证据和历史尝试永久保留；重赛入口位于左侧流程控制。</p>
    </div>
    <div className="panel"><h2>玩家处置</h2>
      <p className="muted">这里只保留 Kick 和原始命令。DNF 请在成绩页修订。</p>
      <label>目标玩家<select value={participantId} onChange={(event) => setParticipantId(event.target.value)}><option value="">请选择</option>{snapshot.config.participants.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
      <div className="button-row action-row">{confirmedAction("Kick", "kick", "high-risk", participant?.displayName ?? "未选择玩家", (confirmation) => ({ type: "kick", playerName: participant?.displayName ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger", !participant, "请先选择目标玩家")}</div>
      <label>原始命令<input value={rawCommand} onChange={(event) => setRawCommand(event.target.value)} /></label>
      {confirmedAction("发送原始命令", "raw-command", "high-risk", snapshot.competition.id, (confirmation) => ({ type: "raw-command", command: rawCommand.trim(), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger", !rawCommand.trim(), "请输入原始命令", `${versionKey}:${rawCommand.trim()}`)}
    </div>
    <div className="panel"><h2>命令审计</h2><CommandTable commands={runtime.commands} /></div>
  </section>;
}

function ConfigPanel({ snapshot, canWrite, saving, saveDraft, publish }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; saving: boolean; saveDraft(patch: Partial<CompetitionConfig>): Promise<void>; publish(): Promise<void>;
}) {
  const config = snapshot.config;
  const editable = canWrite && snapshot.competition.status === "draft" && !saving;
  const [contestType, setContestType] = useState(config.scoring.contestType);
  const [startProtectionEnabled, setStartProtectionEnabled] = useState(config.flow.startProtectionEnabled);
  const [startProtectionSaving, setStartProtectionSaving] = useState(false);
  const [points, setPoints] = useState<number[]>([...config.scoring.points]);
  const [scoringDirty, setScoringDirty] = useState(false);
  const [stages, setStages] = useState<StageConfig[]>(config.stages.map((stage) => ({ ...stage, scoring: [...stage.scoring] })));
  const [stagesDirty, setStagesDirty] = useState(false);
  const stageDrag = useRef<{
    pointerId: number;
    sourceId: string;
    targetId: string;
    afterTarget: boolean;
    offsetX: number;
    offsetY: number;
    originTop: number;
    sourceHeight: number;
    rowGap: number;
    source: HTMLElement;
    ghost: HTMLElement;
    placeholder: HTMLElement;
  } | null>(null);
  const lastScoringPlace = minimumScoringPlaceFor(points);
  const draft = { ...config, contestType, flow: { ...config.flow, startProtectionEnabled }, scoring: { ...config.scoring, contestType, points, minimumScoringPlace: lastScoringPlace }, stages };
  const publishIssues = [...validateCompetitionConfigForPublish(draft), ...(stagesDirty ? ["请先保存关卡列表"] : [])];
  const selectScoringPreset = async (type: Exclude<CompetitionConfig["contestType"], "custom">) => {
    const nextPoints = [...({ small: SMALL_SCORING, medium: MEDIUM_SCORING, large: LARGE_SCORING }[type])];
    setContestType(type);
    setPoints(nextPoints);
    setScoringDirty(false);
    await saveDraft({ contestType: type, scoring: { ...config.scoring, contestType: type, points: nextPoints, minimumScoringPlace: minimumScoringPlaceFor(nextPoints) }, stages: stages.map((stage) => ({ ...stage, scoring: [...nextPoints], minimumScoringPlace: minimumScoringPlaceFor(nextPoints) })) });
  };
  const saveScoring = async (nextPoints: number[], nextContestType: CompetitionConfig["contestType"] = contestType) => {
    await saveDraft({ contestType: nextContestType, scoring: { ...config.scoring, contestType: nextContestType, points: nextPoints, minimumScoringPlace: minimumScoringPlaceFor(nextPoints) }, stages: stages.map((stage) => ({ ...stage, scoring: [...nextPoints], minimumScoringPlace: minimumScoringPlaceFor(nextPoints) })) });
    setScoringDirty(false);
  };
  const replaceStages = async (mode: "SR" | "HS") => {
    const replacement = (mode === "SR" ? defaultSrStages(points, lastScoringPlace) : defaultHsStages(points, lastScoringPlace)) as StageConfig[];
    setStages(replacement);
    setStagesDirty(false);
    await saveDraft({ stages: replacement });
  };
  const saveStages = async (nextStages: StageConfig[]) => {
    await saveDraft({ stages: nextStages });
    setStagesDirty(false);
  };
  const updateStage = (id: string, patch: Partial<StageConfig>) => {
    setStages((current) => current.map((stage) => stage.id === id ? { ...stage, ...patch } : stage));
    setStagesDirty(true);
  };
  const persistStage = (id: string, patch: Partial<StageConfig>) => {
    setStages((current) => current.map((stage) => stage.id === id ? { ...stage, ...patch } : stage));
    setStagesDirty(true);
  };
  const reorder = (sourceId: string, targetId: string, afterTarget = false) => setStages((current) => {
    const index = current.findIndex((stage) => stage.id === sourceId);
    if (index < 0 || current.every((stage) => stage.id !== targetId) || sourceId === targetId) return current;
    const copy = [...current];
    const [moved] = copy.splice(index, 1);
    const target = copy.findIndex((stage) => stage.id === targetId);
    copy.splice(target + (afterTarget ? 1 : 0), 0, moved as StageConfig);
    const nextStages = copy.map((stage, order) => ({ ...stage, order: order + 1 }));
    setStagesDirty(true);
    return nextStages;
  });
  const beginStageDrag = (event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) => {
    if (!editable || stageDrag.current) return;
    const source = event.currentTarget.closest<HTMLElement>(".stage-editor");
    const parent = source?.parentElement;
    if (!source || !parent) return;
    const bounds = source.getBoundingClientRect();
    const ghost = source.cloneNode(true) as HTMLElement;
    const sourceControls = source.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
    const ghostControls = ghost.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
    sourceControls.forEach((control, index) => {
      const cloned = ghostControls.item(index);
      if (cloned) cloned.value = control.value;
    });
    ghost.classList.add("stage-drag-ghost");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${bounds.width}px`;
    ghost.style.height = `${bounds.height}px`;
    ghost.style.left = `${bounds.left}px`;
    ghost.style.top = `${bounds.top}px`;
    const placeholder = document.createElement("div");
    placeholder.className = "stage-drop-placeholder";
    placeholder.style.height = `${bounds.height}px`;
    parent.insertBefore(placeholder, source);
    source.classList.add("stage-editor-drag-source");
    document.body.append(ghost);
    stageDrag.current = {
      pointerId: event.pointerId,
      sourceId,
      targetId: sourceId,
      afterTarget: false,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      originTop: bounds.top,
      sourceHeight: bounds.height,
      rowGap: Number.parseFloat(getComputedStyle(parent).rowGap) || 0,
      source,
      ghost,
      placeholder
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveStageDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = stageDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
    const parent = drag.placeholder.parentElement;
    if (!parent) return;
    drag.placeholder.remove();
    const candidates = [...parent.querySelectorAll<HTMLElement>(".stage-editor")]
      .filter((candidate) => candidate.dataset.stageId && candidate.dataset.stageId !== drag.sourceId);
    const listY = event.clientY > drag.originTop ? event.clientY - drag.sourceHeight - drag.rowGap : event.clientY;
    const before = candidates.find((candidate) => listY < candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().height / 2);
    if (before?.dataset.stageId) {
      drag.targetId = before.dataset.stageId;
      drag.afterTarget = false;
      parent.insertBefore(drag.placeholder, before);
      return;
    }
    const last = candidates.at(-1);
    if (last?.dataset.stageId) {
      drag.targetId = last.dataset.stageId;
      drag.afterTarget = true;
    }
    parent.append(drag.placeholder);
  };
  const finishStageDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const drag = stageDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    stageDrag.current = null;
    drag.ghost.remove();
    drag.placeholder.remove();
    drag.source.classList.remove("stage-editor-drag-source");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && drag.targetId !== drag.sourceId) reorder(drag.sourceId, drag.targetId, drag.afterTarget);
  };
  const addStage = () => {
    const order = stages.length + 1;
    const level = Math.min(13, order);
    const nextStages: StageConfig[] = [...stages, { id: `stage-${crypto.randomUUID()}`, order, label: `SR${level}`, level, mode: "SR", mapKind: "official", timeLimitMs: order === 13 ? 900_000 : 600_000, scoring: [...points], minimumScoringPlace: lastScoringPlace }];
    setStages(nextStages);
    setStagesDirty(true);
  };
  return <section className="grid two">
    <div className="panel"><h2>基本信息</h2>
      <label>比赛名称<input defaultValue={config.name} disabled={!editable} onBlur={(event) => { if (event.target.value !== config.name) void saveDraft({ name: event.target.value }); }} /></label>
      <label>服务器控制身份<input value="ContestConsole" disabled /></label>
      <p className="muted">MockClient 固定以 *ContestConsole 旁观登录，避免服务器权限因名称变化失效。参赛者会从 login、disconnect 和定期 list 自动登记，无需发布前名单。</p>
      <label className="score-policy-row">启用起跑保护<input aria-label="启用起跑保护" type="checkbox" checked={startProtectionEnabled} disabled={!editable || startProtectionSaving}
        onChange={async (event) => {
          const enabled = event.currentTarget.checked;
          setStartProtectionEnabled(enabled);
          setStartProtectionSaving(true);
          try { await saveDraft({ flow: { ...config.flow, startProtectionEnabled: enabled } }); }
          catch { setStartProtectionEnabled(config.flow.startProtectionEnabled); }
          finally { setStartProtectionSaving(false); }
        }} /><span>{startProtectionSaving ? "保存中…" : startProtectionEnabled ? "已启用（默认）" : "未启用"}</span></label>
      <p className="muted">启用后，每关从第一条 Ready 到 Go 后 {config.flow.protectionWindowMs / 1_000} 秒可自动使用一次保护；发布后仍可在控制台手动标记本关已使用或重置为未使用。</p>
      <div className={publishIssues.length ? "validation-summary invalid" : "validation-summary valid"}><strong>发布检查</strong>{publishIssues.length ? <ul>{publishIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <span>配置完整，可以发布。</span>}</div>
      <button disabled={!editable || publishIssues.length > 0} onClick={() => void publish()}>发布比赛</button>
    </div>
    <div className="panel"><h2>轮次与计分</h2>
      <div className="preset-summary"><strong>当前预设：{contestType === "small" ? "小型赛事" : contestType === "medium" ? "中型赛事" : contestType === "large" ? "大型赛事" : "自定义"}</strong><span>点击预设会覆盖当前计分，之后仍可直接修改每个名次。</span></div>
      <div className="scoring-presets">
        <LocalConfirmButton label="小型赛事预设" summary="用小型赛事预设覆盖当前计分，并同步应用到全部关卡。" disabled={!editable} onConfirm={() => selectScoringPreset("small")} />
        <LocalConfirmButton label="中型赛事预设" summary="用中型赛事预设覆盖当前计分，并同步应用到全部关卡。" disabled={!editable} onConfirm={() => selectScoringPreset("medium")} />
        <LocalConfirmButton label="大型赛事预设" summary="用大型赛事预设覆盖当前计分，并同步应用到全部关卡。" disabled={!editable} onConfirm={() => selectScoringPreset("large")} />
      </div>
      <div className="points-editor">{points.map((point, index) => <label key={index}>第 {index + 1} 名计分<input aria-label={`第 ${index + 1} 名计分`} type="number" value={point} disabled={!editable} onChange={(event) => { const next = points.map((value, pointIndex) => pointIndex === index ? Number(event.target.value) : value); setPoints(next); setContestType("custom"); setScoringDirty(true); }} /></label>)}</div>
      <div className="button-row"><button className="ghost" disabled={!editable} onClick={() => { const next = [...points, 0]; setPoints(next); setContestType("custom"); setScoringDirty(true); }}>增加名次</button><button className="ghost" disabled={!editable || points.length <= 1} onClick={() => { const next = points.slice(0, -1); setPoints(next); setContestType("custom"); setScoringDirty(true); }}>删除末位</button></div>
      <div className="scoring-summary"><strong>最低计分名次：第 {lastScoringPlace} 名</strong><span>第 {lastScoringPlace + 1} 名起得分为 0</span></div>
      <button disabled={!editable || !scoringDirty} onClick={() => void saveScoring(points, contestType)}>保存计分规则并覆盖单关配置</button>
      <p className="muted">预设会覆盖当前计分，并同步应用到全部关卡；你仍然可以直接修改每个名次。</p>
    </div>
    <div className="panel wide"><div className="panel-title-row"><div><h2>单关配置</h2><p className="muted">预设会整体替换草稿；自定义模式保留当前列表。</p></div><div className="button-row compact">
      <LocalConfirmButton label="SR1–13 预设" summary="用 SR 1–13 整体替换当前关卡草稿。SR13 默认 15 分钟，其余 10 分钟。" disabled={!editable} onConfirm={() => replaceStages("SR")} />
      <LocalConfirmButton label="HS1–13 预设" summary="用 HS 1–13 整体替换当前关卡草稿。HS12/13 默认 15 分钟，其余 10 分钟。" disabled={!editable} onConfirm={() => replaceStages("HS")} />
      <button className="ghost" disabled={!editable} onClick={addStage}>添加关卡</button>
      <button disabled={!editable || !stagesDirty || stages.length === 0} onClick={() => void saveStages(stages)}>保存关卡列表</button>
    </div></div>
      <div className="stage-editor-list">{stages.map((stage, index) => <div className={`stage-editor ${stageMapKind(stage)}-stage`} data-stage-id={stage.id} key={stage.id}>
        <div className="stage-order"><button type="button" className="drag-handle" aria-label={`拖拽第 ${index + 1} 关`} title="拖拽调整顺序" disabled={!editable}
          onPointerDown={(event) => beginStageDrag(event, stage.id)} onPointerMove={moveStageDrag}
          onPointerUp={(event) => finishStageDrag(event, true)} onPointerCancel={(event) => finishStageDrag(event, false)}>
          <span className="drag-bars" aria-hidden="true"><i /><i /><i /></span></button><strong>#{index + 1}</strong></div>
        <label>关卡模式<select aria-label={`第 ${index + 1} 关关卡模式`} value={`${stageMapKind(stage)}-${stage.mode}`} disabled={!editable} onChange={(event) => {
          const [mapKind, mode] = event.target.value.split("-") as ["official" | "custom", "SR" | "HS"];
          if (mapKind === "official") {
            const level = stage.level > 0 ? stage.level : Math.min(13, index + 1);
            persistStage(stage.id, { mapKind, mode, level, label: `${mode}${level}`, mapHash: "" });
          } else {
            persistStage(stage.id, { mapKind, mode, level: 0, label: stageMapKind(stage) === "custom" ? stage.label : `自制图 ${index + 1}`, mapHash: stage.mapHash ?? "" });
          }
        }}><option value="official-SR">官图 SR</option><option value="official-HS">官图 HS</option><option value="custom-SR">自制图 SR</option><option value="custom-HS">自制图 HS</option></select></label>
        {stageMapKind(stage) === "official"
          ? <label>关卡号<input type="number" min="0" max="13" value={stage.level} disabled={!editable} onChange={(event) => { const level = Number(event.target.value); updateStage(stage.id, { level, label: `${stage.mode}${level}` }); }} onBlur={(event) => { const level = Number(event.target.value); persistStage(stage.id, { level, label: `${stage.mode}${level}` }); }} /></label>
          : <><label>自制图名称<input value={stage.label} disabled={!editable} onChange={(event) => updateStage(stage.id, { label: event.target.value })} onBlur={(event) => persistStage(stage.id, { label: event.target.value })} /></label><label>关卡哈希<input value={stage.mapHash ?? ""} maxLength={32} spellCheck={false} disabled={!editable} onChange={(event) => updateStage(stage.id, { mapHash: event.target.value })} onBlur={(event) => persistStage(stage.id, { mapHash: event.target.value.trim().toLowerCase(), level: 0 })} /></label></>}
        <label>时限（分钟）<input type="number" min="1" value={Math.round(stage.timeLimitMs / 60_000)} disabled={!editable} onChange={(event) => updateStage(stage.id, { timeLimitMs: Number(event.target.value) * 60_000 })} onBlur={(event) => persistStage(stage.id, { timeLimitMs: Number(event.target.value) * 60_000 })} /></label>
        <label className="stage-scoring">单关计分<input defaultValue={stage.scoring.join(",")} disabled={!editable} onBlur={(event) => {
          const scoring = event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
          persistStage(stage.id, { scoring, minimumScoringPlace: minimumScoringPlaceFor(scoring) });
        }} /></label>
        <div className="button-row compact stage-actions"><button className="ghost" disabled={!editable} onClick={() => {
          const copy = { ...stage, id: `copy-${crypto.randomUUID()}`, label: stageMapKind(stage) === "custom" ? `${stage.label} 副本` : stageDisplayName(stage), scoring: [...stage.scoring] };
          const nextStages = [...stages.slice(0, index + 1), copy, ...stages.slice(index + 1)].map((item, order) => ({ ...item, order: order + 1 }));
          setStages(nextStages);
          setStagesDirty(true);
        }}>复制</button><button className="danger" disabled={!editable} onClick={() => { const nextStages = stages.filter((candidate) => candidate.id !== stage.id).map((item, order) => ({ ...item, order: order + 1 })); setStages(nextStages); setStagesDirty(true); }}>删除</button></div>
      </div>)}</div>
    </div>
  </section>;
}

function PlayersPanel({ snapshot, canWrite, performAction }: { snapshot: CompetitionSnapshot; canWrite: boolean; performAction(action: CompetitionAction): Promise<void> }) {
  const [playerId, setPlayerId] = useState("");
  const [displayName, setDisplayName] = useState("");
  return <section className="panel"><h2>玩家与显示名</h2>
    <p className="muted">游戏内玩家 ID 与排行榜显示名分离；显示名只影响展示和导出，不改变成绩归属。</p>
    <div className="alias-form"><label>玩家 ID（游戏内名称）<input value={playerId} onChange={(event) => setPlayerId(event.target.value)} /></label><label>排行榜显示名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><button disabled={!canWrite || !playerId.trim() || !displayName.trim()} onClick={() => void performAction({ type: "player-alias-upsert", playerId: playerId.trim(), displayName: displayName.trim() }).then(() => { setPlayerId(""); setDisplayName(""); })}>保存映射</button></div>
    <table><thead><tr><th>玩家 ID</th><th>显示名</th><th>在线</th><th>连接历史</th></tr></thead><tbody>{snapshot.config.participants.map((participant) => <tr key={participant.id}><td>{participant.id}</td><td>{participant.displayName}</td><td>{participant.online ? "在线" : "离线"}</td><td>{participant.connectionIds.join(", ") || "—"}</td></tr>)}</tbody></table>
    {snapshot.config.participants.length === 0 && <p className="muted">尚未观察到普通玩家；无需在比赛开始前手工登记。</p>}
    <h3>待上线显示名映射</h3><table><thead><tr><th>玩家 ID</th><th>显示名</th><th>登记状态</th></tr></thead><tbody>{snapshot.config.playerAliases.map((alias) => <tr key={alias.playerId}><td>{alias.playerId}</td><td>{alias.displayName}</td><td>{snapshot.config.participants.some((participant) => participant.id.toLowerCase() === alias.playerId.toLowerCase()) ? "已登记" : "等待上线"}</td></tr>)}</tbody></table>
  </section>;
}

function ScoreboardPanel({ snapshot, canWrite, versionKey, requestConfirmation, overrideScoreboard, updateScoring, downloadExport }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
  overrideScoreboard(draft: ScoreDraft, confirmation: ConfirmationSummary): Promise<void>;
  updateScoring(points: readonly number[], confirmation: ConfirmationSummary): Promise<void>;
  downloadExport(format: "csv" | "xlsx"): Promise<void>;
}) {
  const editPermissions = new Map(snapshot.runtime.scoreEditPermissions.map((permission) => [permission.stageId, permission]));
  const table = createScoreboardTable(snapshot.config.stages.map((stage) => ({ id: stage.id, label: stageDisplayName(stage) })), snapshot.currentScoreboard);
  const entries = new Map(snapshot.currentScoreboard.map((entry) => [entry.playerId, entry]));
  const [copyFallback, setCopyFallback] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const copyScoreboard = async () => {
    const plain = scoreboardTableToTsv(table);
    const rich = scoreboardTableToHtml(table);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("CLIPBOARD_WRITE_UNAVAILABLE");
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([rich], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" })
      })]);
      setCopyFallback("");
      setCopyMessage("表格已复制，可直接粘贴到 Excel 或在线表格");
    } catch {
      setCopyFallback(plain);
      setCopyMessage("浏览器未允许写入剪贴板，请从下方手工复制");
    }
  };
  return <section className="panel"><div className="panel-title-row"><h2>实时成绩</h2><div className="button-row compact"><button onClick={() => void copyScoreboard()}>复制表格</button><button onClick={() => void downloadExport("xlsx")}>XLSX</button><button onClick={() => void downloadExport("csv")}>CSV</button></div></div>
    <p className="muted">当前关成绩由现场事件持续接收；进入下一关 Ready 前 1 分钟的准备阶段后可修订此前关卡，比赛结束后可修订全部关卡。</p>
    <LiveScoringEditor key={`${snapshot.competition.id}:${snapshot.activeScoring.revision}:${snapshot.activeScoring.points.join(",")}`}
      snapshot={snapshot} canWrite={canWrite} versionKey={versionKey} requestConfirmation={requestConfirmation} updateScoring={updateScoring} />
    {copyMessage && <p className="copy-message" role="status">{copyMessage}</p>}
    {copyFallback && <label className="copy-fallback">手工复制表格<textarea aria-label="手工复制表格" readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
    <table className="scoreboard"><thead><tr>{table.headers.map((header, index) => <th key={`${index}:${header}`}>{header}</th>)}</tr></thead><tbody>{table.rows.map((row) => {
      const entry = entries.get(row.playerId);
      if (!entry) return null;
      return <tr key={entry.playerId}>
      {row.cells.slice(0, 4).map((cell, index) => <td className={cell.style === "plain" ? "" : cell.style} key={`${entry.playerId}:fixed:${index}`}>{cell.text}</td>)}
      {snapshot.config.stages.map((stage, index) => {
        const permission = editPermissions.get(stage.id);
        return <EditableScoreCell key={stage.id} value={entry.stages[stage.id] as { status?: string; place?: number; points?: number; reason?: string } | undefined} stage={{ ...stage, scoring: snapshot.activeScoring.points, minimumScoringPlace: snapshot.activeScoring.minimumScoringPlace }} playerId={entry.playerId} playerName={entry.displayName}
          display={row.cells[index + 4] as ScoreboardTableCell}
          canWrite={canWrite && Boolean(permission?.editable)} {...(!canWrite ? { disabledReason: "实时连接或控制权不可用" } : permission?.reason ? { disabledReason: permission.reason } : {})}
          versionKey={versionKey} requestConfirmation={requestConfirmation} save={(draft, confirmation) => overrideScoreboard(draft, confirmation)} />;
      })}
    </tr>; })}</tbody></table>
    {snapshot.currentScoreboard.length === 0 && <p className="muted">暂无榜单版本。选手有首条有效或排除结果后会出现在这里。</p>}
    <div className="score-override"><h3>修订记录</h3><p className="muted">成绩页只提交“设置名次”或“设置 DNF”。得分由已发布的单关计分规则重算，并生成新榜单版本。</p>
      <table><thead><tr><th>目标</th><th>修改前</th><th>修改后</th><th>审计原因</th><th>时间</th></tr></thead><tbody>{snapshot.scoreboardOverrides.map((record) => <tr key={record.id}><td>{record.targetId}</td><td>{formatOverrideValue(record.beforeValue)}</td><td>{formatOverrideValue(record.afterValue)}</td><td>{record.reason}</td><td>{formatUtc8DateTime(record.createdAt)}</td></tr>)}</tbody></table>
    </div>
  </section>;
}

function LiveScoringEditor({ snapshot, canWrite, versionKey, requestConfirmation, updateScoring }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
  updateScoring(points: readonly number[], confirmation: ConfirmationSummary): Promise<void>;
}) {
  const activeScoringSignature = snapshot.activeScoring.points.join(",");
  const [livePoints, setLivePoints] = useState<number[]>([...snapshot.activeScoring.points]);
  const liveScoringValid = livePoints.length > 0 && livePoints.every(Number.isFinite)
    && (snapshot.config.scoring.allowNegative || livePoints.every((point) => point >= 0));
  const liveScoringDirty = activeScoringSignature !== livePoints.join(",");
  return <section className="live-scoring-editor">
    <div className="panel-title-row"><div><h3>实时计分映射</h3><p className="muted">发布后可调整全部关卡的名次—分数映射。保存会立即重算已有成绩并生成新榜单版本，不改写发布快照或旧榜单。</p></div><span className="mode-badge">{snapshot.activeScoring.source === "runtime-override" ? `运行期修订 r${snapshot.activeScoring.revision}` : "发布配置"}</span></div>
    <div className="scoring-point-grid">{livePoints.map((point, index) => <label key={index}>第 {index + 1} 名<input aria-label={`第 ${index + 1} 名分数`} type="number" value={Number.isFinite(point) ? point : ""} onChange={(event) => {
      const next = [...livePoints];
      next[index] = event.target.value === "" ? Number.NaN : Number(event.target.value);
      setLivePoints(next);
    }} /></label>)}</div>
    <div className="button-row compact">
      <button className="ghost" disabled={!canWrite || snapshot.competition.status === "draft"} onClick={() => setLivePoints([...livePoints, 0])}>增加名次</button>
      <button className="ghost" disabled={!canWrite || snapshot.competition.status === "draft" || livePoints.length <= 1} onClick={() => setLivePoints(livePoints.slice(0, -1))}>删除末位</button>
      <ConfirmButton label="保存并实时重算" kind="scoreboard-override" target={`${snapshot.competition.id}:scoring`}
        versionKey={`${versionKey}:${livePoints.join(",")}`} requestPayload={{ intent: "scoreboard-update-scoring", points: livePoints }}
        disabled={!canWrite || snapshot.competition.status === "draft" || !liveScoringValid || !liveScoringDirty}
        disabledReason={snapshot.competition.status === "draft" ? "请先发布比赛" : !liveScoringValid ? "至少保留一个名次，分数必须有效且符合负分设置" : !liveScoringDirty ? "计分映射没有变化" : !canWrite ? "实时连接或控制权不可用" : undefined}
        requestConfirmation={requestConfirmation} onConfirm={(confirmation) => updateScoring(livePoints, confirmation)} />
    </div>
  </section>;
}

const formatOverrideValue = (value: unknown): string => {
  if (!value) return "空成绩";
  if (typeof value === "object" && value !== null && Array.isArray((value as { points?: unknown }).points)) {
    return (value as { points: readonly number[] }).points.map((point, index) => `第 ${index + 1} 名 ${point} 分`).join("，");
  }
  const result = value as { status?: string; place?: number; points?: number };
  if (result.status === "dnf") return "DNF";
  if (result.status === "excluded") return "排除计分";
  return result.place ? `第 ${result.place} 名 · ${result.points ?? 0} 分` : "已修改";
};

function EditableScoreCell({ value, display, stage, playerId, playerName, canWrite, disabledReason, versionKey, requestConfirmation, save }: {
  value: { status?: string; place?: number; points?: number; reason?: string } | undefined;
  display: ScoreboardTableCell;
  stage: StageConfig; playerId: string; playerName: string; canWrite: boolean; disabledReason?: string; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
  save(draft: ScoreDraft, confirmation: ConfirmationSummary): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [place, setPlace] = useState(String(value?.place || 1));
  const [shiftOthers, setShiftOthers] = useState(true);
  const numericPlace = Number(place);
  const calculatedPoints = Number.isInteger(numericPlace) && numericPlace > 0 ? stage.scoring[numericPlace - 1] ?? 0 : 0;
  const className = display.style === "plain" ? "" : display.style;
  if (!editing) return <td className={`${className} editable-score-cell`}><button className="cell-button" disabled={!canWrite} title={canWrite ? `修改 ${playerName} 的 ${stageDisplayName(stage)} 成绩` : disabledReason} onClick={() => { setPlace(String(value?.place || 1)); setShiftOthers(true); setEditing(true); }}>{display.text}</button></td>;
  const target = `${playerId}:${stage.id}`;
  const rankPolicy = shiftOthers ? "shift" : "tie";
  return <td className="score-cell-editor"><label>新名次<input aria-label={`${playerId} ${stage.label} 新名次`} type="number" min="1" value={place} onChange={(event) => setPlace(event.target.value)} /></label><label className="score-policy-row">其他玩家是否顺延<input aria-label="其他玩家是否顺延" type="checkbox" checked={shiftOthers} onChange={(event) => setShiftOthers(event.target.checked)} /><span>{shiftOthers ? "顺延" : "不顺延"}</span></label><small>{shiftOthers ? `会顺延其他玩家并按本关规则自动计 ${calculatedPoints} 分` : `不会顺延其他玩家，按本关规则直接计 ${calculatedPoints} 分`}</small>
    <div className="score-editor-actions">
      <ConfirmButton key={`save:${target}`} label="保存名次" kind="scoreboard-override" target={target} versionKey={`${versionKey}:${place}:${rankPolicy}`} requestPayload={{ intent: "scoreboard-set-place", playerId, stageId: stage.id, operation: "set-place", place: numericPlace, rankPolicy }} disabled={!Number.isInteger(numericPlace) || numericPlace < 1} requestConfirmation={requestConfirmation} onConfirm={async (confirmation) => { await save({ playerId, stageId: stage.id, operation: "set-place", place: numericPlace, rankPolicy }, confirmation); setEditing(false); }} />
      <ConfirmButton key={`dnf:${target}`} label="设为 DNF" kind="scoreboard-override" target={target} versionKey={`${versionKey}:${rankPolicy}`} requestPayload={{ intent: "scoreboard-set-dnf", playerId, stageId: stage.id, operation: "set-dnf", rankPolicy }} className="danger" requestConfirmation={requestConfirmation} onConfirm={async (confirmation) => { await save({ playerId, stageId: stage.id, operation: "set-dnf", rankPolicy }, confirmation); setEditing(false); }} />
      <button className="ghost" onClick={() => setEditing(false)}>取消</button>
    </div>
  </td>;
}

function TestPanel({ snapshot, scenarios, scenarioDetail, canWrite, loadScenario, createRun, advanceClock }: {
  snapshot: CompetitionSnapshot; scenarios: readonly TestScenarioSummary[]; scenarioDetail: ScenarioDefinition | null; canWrite: boolean;
  loadScenario(id: string): Promise<void>; createRun(id: string): Promise<void>; advanceClock(milliseconds: number): Promise<void>;
}) {
  const run = snapshot.testRun;
  if (snapshot.competition.mode !== "test") return <section className="panel"><h2>测试</h2><p className="muted">工作模式不提供测试运行控制。</p></section>;
  return <section className="grid two">
    <div className="panel"><h2>场景库</h2><p className="muted">普通场景只定义玩家阵容、行为模型和固定种子的故障计划；Ready、Go、换轮和结束由同一裁判状态机推进。</p>
      <div className="scenario-grid">{scenarios.map((scenario) => <button className={run?.scenario.id === scenario.id ? "scenario selected-card" : "scenario"} key={scenario.id} onClick={() => void loadScenario(scenario.id)}><strong>{scenario.name}</strong><span>{scenario.players} 人 · {scenario.faults ? `${scenario.faults} 个场景故障` : "无故障"}</span><small>{scenario.playerProfiles.map(profileLabel).join("、")}</small><small>固定种子 {scenario.randomSeed}</small></button>)}</div>
      {scenarioDetail && <button disabled={!canWrite} onClick={() => void createRun(scenarioDetail.id)}>创建测试运行</button>}
    </div>
    <div className="panel"><h2>演练播放</h2><p><strong>虚拟时钟：{formatMs(run?.automation.virtualNowMs)}</strong> · {run ? phaseLabel[run.automation.phase] ?? run.automation.phase : "尚未创建运行"}</p>
      <p className="muted">自动化仅在“控制台”启停。这里保留裁判显式快进，不提供手工故障按钮。</p>
      <div className="button-row"><button disabled={!canWrite || !run} onClick={() => void advanceClock(15_000)}>+15 秒</button><button disabled={!canWrite || !run} onClick={() => void advanceClock(180_000)}>+3 分钟</button><button disabled={!canWrite || !run} onClick={() => void advanceClock(600_000)}>+10 分钟</button></div>
      {scenarioDetail?.faultPlan?.length ? <><h3>场景故障计划</h3><div className="fault-plan">{scenarioDetail.faultPlan.map((fault) => <article key={fault.id}><strong>{fault.fault}</strong><span>第 {fault.stageOrder} 关 · {fault.trigger} 后 {formatMs(fault.offsetMs)}</span><small>{fault.playerId ?? "全局"}{fault.recoverAfterMs ? ` · ${formatMs(fault.recoverAfterMs)} 后恢复` : ""}</small></article>)}</div></> : <p className="muted">此场景没有故障计划。</p>}
    </div>
    <div className="panel wide"><h2>{scenarioDetail?.kind === "player-behavior" ? "玩家行为" : "高级日志回放时间线"}</h2>
      {scenarioDetail?.kind === "player-behavior" ? <div className="behavior-grid">{scenarioDetail.players.map((player) => <div className="behavior-card" key={player.id}><strong>{player.displayName}</strong><span>{profileLabel(player.profile ?? "normal")}</span><small>{player.profile === "struggler" ? "可能主动 DNF，也可能保持未完成直到关卡时限" : player.profile === "disruptor" ? "会产生违规，但真实完赛证据仍保留" : "完赛时刻由固定种子派生"}</small></div>)}</div>
        : <div className="timeline">{(scenarioDetail?.events ?? []).map((event, index) => <div className={run && index < run.nextEventIndex ? "timeline-row played" : "timeline-row"} key={event.sourceId}><span>{formatMs(event.atMs)}</span><strong>{eventLabel(event)}</strong><small>{event.sourceId}</small></div>)}</div>}
    </div>
  </section>;
}

function ArchivePanel({ snapshot, canWrite, versionKey, requestConfirmation, archiveCompetition, finishCompetition, deleteCompetition }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string, requestPayload?: unknown): Promise<ConfirmationSummary>;
  archiveCompetition(): Promise<void>; finishCompetition(confirmation: ConfirmationSummary, archiveAfter: boolean): Promise<void>; deleteCompetition(confirmation: ConfirmationSummary): Promise<void>;
}) {
  const finish = availabilityFor(snapshot.runtime, "finish");
  const archive = availabilityFor(snapshot.runtime, "archive");
  const remove = availabilityFor(snapshot.runtime, "delete");
  return <section className="panel"><div className="panel-title-row"><h2>结束与归档</h2><div className="button-row compact action-row">
    <ConfirmButton key="finish" label="结束比赛" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} requestPayload={{ intent: "finish" }} disabled={!canWrite || !finish?.enabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : finish?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => finishCompetition(confirmation, false)} />
    <ConfirmButton key="finish-archive" label="结束并生成归档" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} requestPayload={{ intent: "finish-and-archive" }} disabled={!canWrite || !finish?.enabled || snapshot.currentScoreboard.length === 0} disabledReason={snapshot.currentScoreboard.length === 0 ? "暂无可归档榜单" : finish?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => finishCompetition(confirmation, true)} />
    <div className="action-control"><button disabled={!canWrite || !archive?.enabled || snapshot.currentScoreboard.length === 0} title={archive?.disabledReason} onClick={() => void archiveCompetition()}>仅生成归档</button>{!archive?.enabled && <small className="disabled-reason">{archive?.disabledReason}</small>}</div>
    <ConfirmButton key="delete" label="删除比赛" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} requestPayload={{ intent: "delete" }} className="danger" disabled={!canWrite || !remove?.enabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : remove?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={deleteCompetition} />
  </div></div><p className="muted">确认面板只说明当前按钮会执行什么、会造成什么结果；无需填写操作原因。</p>
    <table><thead><tr><th>版本</th><th>目录</th><th>Manifest Hash</th><th>时间</th></tr></thead><tbody>{snapshot.archives.map((item) => <tr key={`${item.version}:${item.manifestHash}`}><td>v{item.version}</td><td>{item.directory}</td><td><code>{item.manifestHash}</code></td><td>{formatUtc8DateTime(item.createdAt)}</td></tr>)}</tbody></table>
    {snapshot.archives.length === 0 && <p className="muted">暂无归档版本。</p>}
  </section>;
}

function RawLogWindow({ logs, minimized, setMinimized, refresh, mode }: { logs: readonly RawClientLogLine[]; minimized: boolean; setMinimized(value: boolean): void; refresh(): void; mode: CompetitionMode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number; startWidth: number; startHeight: number } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!minimized && body && stickToBottom.current) body.scrollTo({ top: body.scrollHeight });
  }, [logs, minimized]);
  const windowClass = ["raw-log-window", minimized ? "minimized" : "", logs.length === 0 ? "empty" : ""].filter(Boolean).join(" ");
  return <aside className={windowClass} aria-label="原始客户端日志" style={box ? { left: box.x, top: box.y, width: box.width, ...(minimized ? {} : { height: box.height }), right: "auto", bottom: "auto" } : undefined}>
    <button className="raw-log-resize-handle" aria-label="拖动左上角缩放原始客户端日志" onPointerDown={(event) => {
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: bounds.left, startTop: bounds.top, startWidth: bounds.width, startHeight: bounds.height };
      setBox({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation();
    }} onPointerMove={(event) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const minWidth = 420;
      const minHeight = 220;
      const right = drag.startLeft + drag.startWidth;
      const bottom = drag.startTop + drag.startHeight;
      const nextLeft = Math.max(0, Math.min(right - minWidth, drag.startLeft + (event.clientX - drag.startX)));
      const nextTop = Math.max(0, Math.min(bottom - minHeight, drag.startTop + (event.clientY - drag.startY)));
      const nextWidth = Math.max(minWidth, Math.min(window.innerWidth - nextLeft, right - nextLeft));
      const nextHeight = Math.max(minHeight, Math.min(window.innerHeight - nextTop, bottom - nextTop));
      setBox({ x: nextLeft, y: nextTop, width: nextWidth, height: nextHeight });
    }} onPointerUp={(event) => {
      if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }} />
    <div className="raw-log-title" onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
      setBox({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height });
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    }} onPointerMove={(event) => {
      const drag = dragRef.current; const element = event.currentTarget.parentElement;
      if (!drag || drag.pointerId !== event.pointerId || !element) return;
      setBox({ x: Math.max(0, Math.min(window.innerWidth - element.offsetWidth, event.clientX - drag.offsetX)), y: Math.max(0, Math.min(window.innerHeight - element.offsetHeight, event.clientY - drag.offsetY)), width: element.offsetWidth, height: element.offsetHeight });
    }} onPointerUp={(event) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}>
      <strong>原始 Client 日志</strong><span>{mode === "work" ? "真实 MockClient" : "模拟玩家/裁判"} · {logs.length} 行</span><button className="ghost" onClick={refresh}>刷新</button><button onClick={() => setMinimized(!minimized)}>{minimized ? "展开" : "最小化"}</button>
    </div>
    {!minimized && <div className="raw-log-body" ref={bodyRef} onScroll={(event) => {
      const body = event.currentTarget;
      stickToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight <= 4;
    }}>{logs.map((line) => <div className="raw-log-line" key={line.id}><time>{new Date(line.occurredAt).toLocaleTimeString()}</time><span>{line.source}</span><code>{line.rawLine}</code></div>)}{logs.length === 0 && <p>当前暂无客户端日志。</p>}</div>}
  </aside>;
}

function CommandTable({ commands }: { commands: RuntimeSnapshot["commands"] }) {
  return <table><thead><tr><th>动作</th><th>状态</th><th>命令</th><th>回显</th><th>时间</th></tr></thead><tbody>{commands.map((command) => <tr key={command.id}><td>{command.actionType}</td><td>{command.status}</td><td>{command.command ?? "—"}</td><td>{command.responseLine ?? "—"}</td><td>{formatUtc8DateTime(command.updatedAt)}</td></tr>)}</tbody></table>;
}
