import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LARGE_SCORING,
  SMALL_SCORING,
  defaultHsStages,
  defaultSrStages,
  minimumScoringPlaceFor,
  validateCompetitionConfigForPublish
} from "@ballance/contracts";
import type {
  ActionAvailability,
  CompetitionAction,
  CompetitionConfig,
  CompetitionMode,
  CompetitionRecordView,
  CompetitionSnapshot,
  ConfirmationKind,
  ConfirmationSummary,
  HealthResponse,
  NotificationChannel,
  RawClientLogLine,
  RefereeActionId,
  RuntimeSnapshot,
  ScenarioDefinition,
  StageConfig,
  TestScenarioSummary
} from "@ballance/contracts";
import { formatUtc8DateTime, toUtc8Input, utc8InputToIso } from "./time.js";

interface Session { token: string; tabId: string; control: boolean }
interface JournalMessage { sequence?: number; type: string; competitionId?: string }
type ScoreDraft =
  | { playerId: string; stageId: string; operation: "set-place"; place: number; rankPolicy?: "tie" | "shift" }
  | { playerId: string; stageId: string; operation: "set-dnf" };

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

const stageTitle = (config: CompetitionConfig, stageId?: string): string =>
  config.stages.find((stage) => stage.id === stageId)?.label ?? stageId ?? "—";

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

function ConfirmButton({
  label,
  kind,
  target,
  versionKey,
  disabled,
  disabledReason,
  className,
  requestConfirmation,
  onConfirm
}: {
  label: string;
  kind: ConfirmationKind;
  target: string;
  versionKey: string;
  disabled?: boolean;
  disabledReason?: string | undefined;
  className?: string | undefined;
  requestConfirmation(kind: ConfirmationKind, target: string): Promise<ConfirmationSummary>;
  onConfirm(confirmation: ConfirmationSummary): Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState<ConfirmationSummary>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const prepare = async () => {
    setBusy(true); setError("");
    try { setConfirmation(await requestConfirmation(kind, target)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "无法创建确认"); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!confirmation) return;
    setBusy(true); setError("");
    try { await onConfirm(confirmation); setConfirmation(undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <div className="confirm-action" data-version={versionKey}>
    <button className={className} disabled={disabled || busy} title={disabledReason} onClick={() => void prepare()}>{busy && !confirmation ? "准备中…" : label}</button>
    {disabled && disabledReason && <small className="disabled-reason">{disabledReason}</small>}
    {confirmation && <div className="inline-confirm" role="group" aria-label={`${label}确认`}>
      <strong>{confirmation.effect.title}</strong>
      <span>目标：{confirmation.effect.target}</span>
      <span>当前阶段：{phaseLabel[confirmation.effect.currentPhase] ?? confirmation.effect.currentPhase} · 状态版本 v{confirmation.stateVersion}</span>
      <ul>{confirmation.effect.consequences.map((item) => <li key={item}>{item}</li>)}</ul>
      <small>令牌有效至 {formatUtc8DateTime(confirmation.expiresAt)}{confirmation.effect.irreversible ? " · 此操作不可撤销" : ""}</small>
      <div className="button-row compact">
        <button className={className} disabled={busy} onClick={() => void confirm()}>确认</button>
        <button className="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>取消</button>
      </div>
      {error && <span className="inline-error">{error}</span>}
    </div>}
    {!confirmation && error && <small className="inline-error">{error}</small>}
  </div>;
}

function LocalConfirmButton({ label, summary, disabled, className, onConfirm }: {
  label: string; summary: string; disabled?: boolean; className?: string; onConfirm(): void;
}) {
  const [open, setOpen] = useState(false);
  return <div className="confirm-action">
    <button className={className} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
    {open && <div className="inline-confirm"><strong>{label}</strong><span>{summary}</span><div className="button-row compact">
      <button onClick={() => { onConfirm(); setOpen(false); }}>确认</button>
      <button className="ghost" onClick={() => setOpen(false)}>取消</button>
    </div></div>}
  </div>;
}

function ActionButton({ runtime, action, canWrite, onClick, children, className }: {
  runtime: RuntimeSnapshot; action: RefereeActionId; canWrite: boolean; onClick(): void; children: ReactNode; className?: string;
}) {
  const availability = availabilityFor(runtime, action);
  const disabledReason = !canWrite ? "实时连接或控制权不可用" : availability?.disabledReason;
  return <div className="action-control">
    <button className={className} disabled={!canWrite || !availability?.enabled} title={disabledReason} onClick={onClick}>{children}</button>
    {(!canWrite || !availability?.enabled) && <small className="disabled-reason">{disabledReason ?? "当前状态不可用"}</small>}
    {availability?.enabled && <small className="action-effect">{availability.effect}</small>}
  </div>;
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
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [rawLogs, setRawLogs] = useState<RawClientLogLine[]>([]);
  const [rawLogsMinimized, setRawLogsMinimized] = useState(false);
  const lastSequence = useRef(0);
  const canWrite = Boolean(session?.control && realtimeConnected);

  const refreshCompetitions = async (current: Session) => {
    const records = await request<CompetitionRecordView[]>("/api/v1/competitions", current);
    setCompetitions(records);
    setSelectedId((old) => old ?? records[0]?.id);
  };
  const refreshSnapshot = async (current: Session, competitionId: string) => {
    const next = await request<CompetitionSnapshot>(`/api/v1/competitions/${competitionId}/snapshot`, current);
    setSnapshot(next);
    return next;
  };
  const refreshRawLogs = async (current: Session, competitionId: string) =>
    setRawLogs(await request<RawClientLogLine[]>(`/api/v1/competitions/${competitionId}/logs/raw?limit=250`, current));

  const selectCompetition = (competitionId: string) => {
    if (competitionId === selectedId) {
      if (session) void refreshSnapshot(session, competitionId).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "快照加载失败"));
      return;
    }
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
        const [records, next] = await Promise.all([
          request<CompetitionRecordView[]>("/api/v1/competitions", session),
          selectedId ? request<CompetitionSnapshot>(`/api/v1/competitions/${selectedId}/snapshot`, session) : Promise.resolve(undefined)
        ]);
        if (!disposed) {
          setCompetitions(records);
          if (next) setSnapshot((current) => {
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
      else if (session && target) await refreshSnapshot(session, target);
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

  const saveDraft = (patch: Partial<CompetitionConfig>) => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/draft`, session, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "草稿已保存");

  const publish = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/publish`, session, {
      method: "POST", body: JSON.stringify({ expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "发布检查通过，比赛已发布");

  const startWork = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/work/start`, session, { method: "POST", body: "{}" });
  }, "工作运行已启动");

  const enableAutomation = () => run(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request(`/api/v1/competitions/${snapshot.competition.id}/automation/enable`, session, {
      method: "POST", body: JSON.stringify({ runId: snapshot.testRun?.runId, readyInMs: 0 })
    });
  }, "自动化已启用");

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

  const requestConfirmation = async (kind: ConfirmationKind, target: string): Promise<ConfirmationSummary> => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    return request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
      method: "POST", body: JSON.stringify({ kind, target })
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

  const downloadExport = async (format: "html" | "tsv" | "csv" | "xlsx") => {
    if (!session || !snapshot) return;
    try {
      const response = await fetch(`/api/v1/competitions/${snapshot.competition.id}/exports/${format}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!response.ok) throw new Error(`导出失败 ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `${snapshot.competition.name}-scoreboard.${format}`; link.click(); URL.revokeObjectURL(url);
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
        idempotencyKey: crypto.randomUUID(), confirmationToken: confirmation.token, impactHash: confirmation.impactHash
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
          <label>模式<select value={mode} onChange={(event) => setMode(event.target.value as CompetitionMode)}><option value="work">工作模式（默认）</option><option value="test">测试模式</option></select></label>
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
            <div><span>本关发令（UTC+8）</span><strong>{formatUtc8DateTime(runtime.plannedStageStartAt)}</strong></div>
            <div><span>本关最晚结束（UTC+8）</span><strong>{formatUtc8DateTime(runtime.stageDeadlineAt)}</strong></div>
            <div><span>下一 Ready（UTC+8）</span><strong>{formatUtc8DateTime(runtime.plannedReadyAt)}</strong></div>
            <div><span>自动化 / 倒数</span><strong>{runtime.automationEnabled ? "启用" : "暂停"}{runtime.countdownValue ? ` · ${runtime.countdownValue}` : ""}</strong></div>
          </section>
          <div className="tabs">{(["config", "console", "players", "scoreboard", "test", "archive"] as const).map((item) =>
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{({ config: "比赛配置", console: "控制台", players: "玩家", scoreboard: "成绩", test: "测试", archive: "归档" })[item]}</button>)}</div>
          {tab === "console" && <ConsolePanel snapshot={snapshot} canWrite={canWrite} versionKey={versionKey}
            startWork={() => startWork()} enableAutomation={() => enableAutomation()} pauseAutomation={() => pauseAutomation()}
            performAction={(action) => performAction(action)} requestConfirmation={requestConfirmation} />}
          {tab === "config" && <ConfigPanel key={`${snapshot.competition.id}:${snapshot.competition.stateVersion}`} snapshot={snapshot} canWrite={canWrite}
            saveDraft={(patch) => saveDraft(patch)} publish={() => publish()} />}
          {tab === "players" && <PlayersPanel snapshot={snapshot} canWrite={canWrite} performAction={(action) => performAction(action)} />}
          {tab === "scoreboard" && <ScoreboardPanel snapshot={snapshot} canWrite={canWrite} versionKey={versionKey}
            requestConfirmation={requestConfirmation} overrideScoreboard={overrideScoreboard} downloadExport={downloadExport} />}
          {tab === "test" && <TestPanel snapshot={snapshot} scenarios={scenarios} scenarioDetail={scenarioDetail} canWrite={canWrite}
            loadScenario={loadScenario} createRun={createRun} advanceClock={(ms) => advanceClock(ms)} />}
          {tab === "archive" && <ArchivePanel snapshot={snapshot} canWrite={canWrite} versionKey={versionKey}
            requestConfirmation={requestConfirmation} archiveCompetition={archiveCompetition} finishCompetition={finishCompetition} deleteCompetition={deleteCompetition} />}
        </> : <section className="empty-state">请选择或新建比赛</section>}
      </section>
    </div>
    {snapshot && <RawLogWindow logs={rawLogs} minimized={rawLogsMinimized} setMinimized={setRawLogsMinimized}
      refresh={() => session && selectedId ? void refreshRawLogs(session, selectedId) : undefined} mode={snapshot.competition.mode} />}
  </main>;
}

function ConsolePanel({ snapshot, canWrite, versionKey, startWork, enableAutomation, pauseAutomation, performAction, requestConfirmation }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  startWork(): Promise<void>; enableAutomation(): Promise<void>; pauseAutomation(): Promise<void>;
  performAction(action: CompetitionAction): Promise<void>;
  requestConfirmation(kind: ConfirmationKind, target: string): Promise<ConfirmationSummary>;
}) {
  const runtime = snapshot.runtime;
  const [channel, setChannel] = useState<NotificationChannel>("notice");
  const [notification, setNotification] = useState("比赛流程通知");
  const [participantId, setParticipantId] = useState(snapshot.config.participants[0]?.id ?? "");
  const [rawCommand, setRawCommand] = useState("");
  const [scheduleAt, setScheduleAt] = useState(() => toUtc8Input(new Date(Date.now() + 5 * 60_000)));
  const participant = snapshot.config.participants.find((candidate) => candidate.id === participantId);
  const incident = (runtime.incidents as Array<{ id?: string; status?: string; recommendedRestart?: boolean }>).find((candidate) => candidate.status === "open" && candidate.recommendedRestart);
  const attempt = runtime.attempts.at(-1) as { id?: string; voided?: boolean } | undefined;
  const confirmedAction = (label: string, actionId: RefereeActionId, kind: ConfirmationKind, target: string, build: (confirmation: ConfirmationSummary) => CompetitionAction, className?: string, extraDisabled = false, extraReason?: string) => {
    const availability = availabilityFor(runtime, actionId);
    return <ConfirmButton key={`${label}:${target}:${versionKey}`} label={label} kind={kind} target={target} versionKey={versionKey} className={className}
      disabled={!canWrite || !availability?.enabled || extraDisabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : extraDisabled ? extraReason : availability?.disabledReason}
      requestConfirmation={requestConfirmation} onConfirm={(confirmation) => performAction(build(confirmation))} />;
  };
  return <section className="grid two">
    <div className="panel"><h2>裁判操作</h2>
      <div className="button-row action-row">
        {snapshot.competition.mode === "work" && <ActionButton runtime={runtime} action="start-work" canWrite={canWrite} onClick={() => void startWork()}>启动 MockClient</ActionButton>}
        <ActionButton runtime={runtime} action="enable-automation" canWrite={canWrite} onClick={() => void enableAutomation()}>启用自动化</ActionButton>
        <ActionButton runtime={runtime} action="pause-automation" canWrite={canWrite} className="secondary" onClick={() => void pauseAutomation()}>暂停自动化</ActionButton>
      </div>
      <h3>面向玩家的通知</h3>
      <div className="inline-form notification-form"><select aria-label="通知类型" value={channel} onChange={(event) => setChannel(event.target.value as NotificationChannel)}>
        <option value="bulletin">Bulletin · 顶部状态</option><option value="notice">Notice · 普通通知</option><option value="announce">Announce · 中央重要通知</option>
      </select><input aria-label="通知文本" value={notification} onChange={(event) => setNotification(event.target.value)} /><button disabled={!canWrite || !notification.trim()} onClick={() => void performAction({ type: "notification", channel, text: notification })}>发送</button></div>
      <h3>流程控制</h3>
      <div className="button-row action-row">
        {confirmedAction("Ready", "ready", "manual-action", snapshot.competition.id, () => ({ type: "ready" }))}
        <ActionButton runtime={runtime} action="cheat-off" canWrite={canWrite} onClick={() => void performAction({ type: "cheat-off" })}>关闭 cheat</ActionButton>
        {confirmedAction("手动发令", "manual-go", "manual-go", snapshot.competition.id, (confirmation) => ({ type: "manual-go", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("提前结束本关", "end-stage", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "end-stage", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
      </div>
      <h3>相对延时</h3>
      <div className="button-row action-row">
        {confirmedAction("Ready 延后 1 分钟", "delay-ready", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "delay-ready", milliseconds: 60_000, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("本关时限延长 1 分钟", "extend-stage-deadline", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "extend-stage-deadline", milliseconds: 60_000, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
      </div>
      <h3>改期（UTC+8）</h3>
      <div className="schedule-editor"><input aria-label="改期时间（UTC+8）" type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} />
        {confirmedAction("Ready 改期", "reschedule", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "reschedule", plannedReadyAt: utc8InputToIso(scheduleAt), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {confirmedAction("关卡时限改期", "reschedule-stage-deadline", "manual-action", snapshot.competition.id, (confirmation) => ({ type: "reschedule-stage-deadline", deadlineAt: utc8InputToIso(scheduleAt), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
      </div>
    </div>
    <div className="panel"><h2>流程动态与注意事项</h2>
      {runtime.attentionItems.length === 0 && <p className="muted">暂无需要注意的流程动态。</p>}
      <div className="attention-list">{runtime.attentionItems.map((item) => <article className={`attention-card ${item.severity}`} key={item.id}>
        <div><strong>{item.title}</strong><time>{formatUtc8DateTime(item.occurredAt)}</time></div><p>{item.message}</p>
        {(item.stageId || item.participantIds?.length) && <small>{item.stageId ? `关卡 ${stageTitle(snapshot.config, item.stageId)}` : ""}{item.participantIds?.length ? ` · 玩家 ${item.participantIds.join("、")}` : ""}</small>}
      </article>)}</div>
      <h3>事故与尝试</h3>
      <div className="button-row action-row">
        {incident?.id && confirmedAction("确认重赛", "restart", "restart", incident.id, (confirmation) => ({ type: "restart", incidentId: incident.id as string, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
        {attempt?.id && !attempt.voided && confirmedAction("作废尝试", "void-attempt", "high-risk", attempt.id, (confirmation) => ({ type: "void-attempt", attemptId: attempt.id as string, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger")}
        {attempt?.id && attempt.voided && confirmedAction("恢复尝试", "restore-attempt", "high-risk", attempt.id, (confirmation) => ({ type: "restore-attempt", attemptId: attempt.id as string, confirmationToken: confirmation.token, impactHash: confirmation.impactHash }))}
      </div>
    </div>
    <div className="panel"><h2>玩家处置</h2>
      <p className="muted">这里只保留 Kick 和原始命令。DNF 请在成绩页修订。</p>
      <label>目标玩家<select value={participantId} onChange={(event) => setParticipantId(event.target.value)}><option value="">请选择</option>{snapshot.config.participants.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
      <div className="button-row action-row">{confirmedAction("Kick", "kick", "high-risk", participant?.displayName ?? "未选择玩家", (confirmation) => ({ type: "kick", playerName: participant?.displayName ?? "", confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger", !participant, "请先选择目标玩家")}</div>
      <label>原始命令<input value={rawCommand} onChange={(event) => setRawCommand(event.target.value)} /></label>
      {confirmedAction("发送原始命令", "raw-command", "high-risk", snapshot.competition.id, (confirmation) => ({ type: "raw-command", command: rawCommand.trim(), confirmationToken: confirmation.token, impactHash: confirmation.impactHash }), "danger", !rawCommand.trim(), "请输入原始命令")}
    </div>
    <div className="panel"><h2>命令审计</h2><CommandTable commands={runtime.commands} /></div>
  </section>;
}

function ConfigPanel({ snapshot, canWrite, saveDraft, publish }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; saveDraft(patch: Partial<CompetitionConfig>): Promise<void>; publish(): Promise<void>;
}) {
  const config = snapshot.config;
  const editable = canWrite && snapshot.competition.status === "draft";
  const [contestType, setContestType] = useState(config.scoring.contestType);
  const [points, setPoints] = useState<number[]>([...config.scoring.points]);
  const [stages, setStages] = useState<StageConfig[]>(config.stages.map((stage) => ({ ...stage, scoring: [...stage.scoring] })));
  const lastScoringPlace = minimumScoringPlaceFor(points);
  const draft = { ...config, contestType, scoring: { ...config.scoring, contestType, points, minimumScoringPlace: lastScoringPlace }, stages };
  const publishIssues = validateCompetitionConfigForPublish(draft);
  const selectScoringPreset = (type: CompetitionConfig["contestType"]) => {
    setContestType(type);
    if (type === "small") setPoints([...SMALL_SCORING]);
    if (type === "large") setPoints([...LARGE_SCORING]);
  };
  const replaceStages = (mode: "SR" | "HS") => {
    const replacement = mode === "SR" ? defaultSrStages(points, lastScoringPlace) : defaultHsStages(points, lastScoringPlace);
    setStages(replacement);
    void saveDraft({ stages: replacement });
  };
  const updateStage = (id: string, patch: Partial<StageConfig>) => setStages((current) => current.map((stage) => stage.id === id ? { ...stage, ...patch } : stage));
  const reorder = (id: string, delta: number) => setStages((current) => {
    const index = current.findIndex((stage) => stage.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const copy = [...current];
    [copy[index], copy[target]] = [copy[target] as StageConfig, copy[index] as StageConfig];
    return copy.map((stage, order) => ({ ...stage, order: order + 1 }));
  });
  const addStage = () => {
    const order = stages.length + 1;
    setStages([...stages, { id: `custom-${crypto.randomUUID()}`, order, label: `SR ${order}`, level: Math.min(13, order), mode: "SR", timeLimitMs: order === 13 ? 900_000 : 600_000, scoring: [...points], minimumScoringPlace: lastScoringPlace }]);
  };
  return <section className="grid two">
    <div className="panel"><h2>基本信息</h2>
      <label>比赛名称<input defaultValue={config.name} disabled={!editable} onBlur={(event) => { if (event.target.value !== config.name) void saveDraft({ name: event.target.value }); }} /></label>
      <label>服务器<input defaultValue={config.server} disabled={!editable} onBlur={(event) => { if (event.target.value !== config.server) void saveDraft({ server: event.target.value }); }} /></label>
      <label>裁判名<input defaultValue={config.refereeName} disabled={!editable} onBlur={(event) => { if (event.target.value !== config.refereeName) void saveDraft({ refereeName: event.target.value }); }} /></label>
      <p className="muted">MockClient 登录名由裁判名派生，并强制使用一个 * 旁观标记。参赛者会从 login、disconnect 和定期 list 自动登记，无需发布前名单。</p>
      <div className={publishIssues.length ? "validation-summary invalid" : "validation-summary valid"}><strong>发布检查</strong>{publishIssues.length ? <ul>{publishIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <span>配置完整，可以发布。</span>}</div>
      <button disabled={!editable || publishIssues.length > 0} onClick={() => void publish()}>发布比赛</button>
    </div>
    <div className="panel"><h2>轮次与计分</h2>
      <div className="scoring-presets"><button className={contestType === "small" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => selectScoringPreset("small")}>小型赛事</button><button className={contestType === "large" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => selectScoringPreset("large")}>大型赛事</button><button className={contestType === "custom" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => setContestType("custom")}>自定义</button></div>
      <div className="points-editor">{points.map((point, index) => <label key={index}>第 {index + 1} 名计分<input aria-label={`第 ${index + 1} 名计分`} type="number" value={point} disabled={!editable || contestType !== "custom"} onChange={(event) => setPoints(points.map((value, pointIndex) => pointIndex === index ? Number(event.target.value) : value))} /></label>)}</div>
      {contestType === "custom" && <div className="button-row"><button className="ghost" disabled={!editable} onClick={() => setPoints([...points, 0])}>增加名次</button><button className="ghost" disabled={!editable || points.length <= 1} onClick={() => setPoints(points.slice(0, -1))}>删除末位</button></div>}
      <div className="scoring-summary"><strong>最低计分名次：第 {lastScoringPlace} 名</strong><span>第 {lastScoringPlace + 1} 名起得分为 0</span></div>
      <button disabled={!editable} onClick={() => void saveDraft({ contestType, scoring: draft.scoring, stages: stages.map((stage) => ({ ...stage, scoring: [...points], minimumScoringPlace: lastScoringPlace })) })}>保存计分方案并应用到全部关卡</button>
      <p className="muted">此操作会覆盖每关的自定义计分规则。</p>
    </div>
    <div className="panel wide"><div className="panel-title-row"><div><h2>单关配置</h2><p className="muted">预设会整体替换草稿；自定义模式保留当前列表。</p></div><div className="button-row compact">
      <LocalConfirmButton label="SR1–13 预设" summary="用 SR 1–13 整体替换当前关卡草稿。SR13 默认 15 分钟，其余 10 分钟。" disabled={!editable} onConfirm={() => replaceStages("SR")} />
      <LocalConfirmButton label="HS1–13 预设" summary="用 HS 1–13 整体替换当前关卡草稿。HS12/13 默认 15 分钟，其余 10 分钟。" disabled={!editable} onConfirm={() => replaceStages("HS")} />
      <button className="ghost" disabled={!editable} title="保留当前关卡列表并继续逐关编辑">自定义（保留当前）</button>
      <button className="ghost" disabled={!editable} onClick={addStage}>添加关卡</button>
      <button disabled={!editable || stages.length === 0} onClick={() => void saveDraft({ stages })}>保存关卡列表</button>
    </div></div>
      <div className="stage-editor-list">{stages.map((stage, index) => <div className="stage-editor" key={stage.id}>
        <div className="stage-order"><strong>#{index + 1}</strong><button className="ghost" disabled={!editable || index === 0} onClick={() => reorder(stage.id, -1)}>↑</button><button className="ghost" disabled={!editable || index === stages.length - 1} onClick={() => reorder(stage.id, 1)}>↓</button></div>
        <label>模式<select value={stage.mode} disabled={!editable} onChange={(event) => updateStage(stage.id, { mode: event.target.value as "SR" | "HS" })}><option>SR</option><option>HS</option></select></label>
        <label>关卡号<input type="number" min="0" max="13" value={stage.level} disabled={!editable} onChange={(event) => updateStage(stage.id, { level: Number(event.target.value) })} /></label>
        <label>名称<input value={stage.label} disabled={!editable} onChange={(event) => updateStage(stage.id, { label: event.target.value })} /></label>
        <label>时限（分钟）<input type="number" min="1" value={Math.round(stage.timeLimitMs / 60_000)} disabled={!editable} onChange={(event) => updateStage(stage.id, { timeLimitMs: Number(event.target.value) * 60_000 })} /></label>
        <label className="stage-scoring">单关计分<input defaultValue={stage.scoring.join(",")} disabled={!editable} onBlur={(event) => {
          const scoring = event.target.value.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
          updateStage(stage.id, { scoring, minimumScoringPlace: minimumScoringPlaceFor(scoring) });
        }} /></label>
        <div className="button-row compact"><button className="ghost" disabled={!editable} onClick={() => {
          const copy = { ...stage, id: `copy-${crypto.randomUUID()}`, label: `${stage.label} 副本`, scoring: [...stage.scoring] };
          setStages([...stages.slice(0, index + 1), copy, ...stages.slice(index + 1)].map((item, order) => ({ ...item, order: order + 1 })));
        }}>复制</button><button className="danger" disabled={!editable} onClick={() => setStages(stages.filter((candidate) => candidate.id !== stage.id).map((item, order) => ({ ...item, order: order + 1 })))}>删除</button></div>
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
    <table><thead><tr><th>玩家 ID</th><th>显示名</th><th>在线</th><th>连接历史</th><th>本关状态</th></tr></thead><tbody>{snapshot.config.participants.map((participant) => <tr key={participant.id}><td>{participant.id}</td><td>{participant.displayName}</td><td>{participant.online ? "在线" : "离线"}</td><td>{participant.connectionIds.join(", ") || "—"}</td><td>{participant.currentStageStatus}</td></tr>)}</tbody></table>
    {snapshot.config.participants.length === 0 && <p className="muted">尚未观察到普通玩家；无需在比赛开始前手工登记。</p>}
    <h3>待上线显示名映射</h3><table><thead><tr><th>玩家 ID</th><th>显示名</th><th>登记状态</th></tr></thead><tbody>{snapshot.config.playerAliases.map((alias) => <tr key={alias.playerId}><td>{alias.playerId}</td><td>{alias.displayName}</td><td>{snapshot.config.participants.some((participant) => participant.id.toLowerCase() === alias.playerId.toLowerCase()) ? "已登记" : "等待上线"}</td></tr>)}</tbody></table>
  </section>;
}

function ScoreboardPanel({ snapshot, canWrite, versionKey, requestConfirmation, overrideScoreboard, downloadExport }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string): Promise<ConfirmationSummary>;
  overrideScoreboard(draft: ScoreDraft, confirmation: ConfirmationSummary): Promise<void>;
  downloadExport(format: "html" | "tsv" | "csv" | "xlsx"): Promise<void>;
}) {
  return <section className="panel"><div className="panel-title-row"><h2>实时成绩</h2><div className="button-row compact"><button onClick={() => void downloadExport("xlsx")}>XLSX</button><button onClick={() => void downloadExport("csv")}>CSV</button><button onClick={() => void downloadExport("html")}>HTML</button><button onClick={() => void downloadExport("tsv")}>TSV</button></div></div>
    <table className="scoreboard"><thead><tr><th>变化</th><th>名次</th><th>总分</th><th>选手</th>{snapshot.config.stages.map((stage) => <th key={stage.id}>{stage.label}</th>)}</tr></thead><tbody>{snapshot.currentScoreboard.map((entry) => <tr key={entry.playerId}>
      <td className={entry.change === null ? "" : entry.change > 0 ? "rank-up" : entry.change < 0 ? "rank-down" : ""}>{entry.change === null ? "—" : entry.change > 0 ? `▲${entry.change}` : entry.change < 0 ? `▼${Math.abs(entry.change)}` : "="}</td><td>{entry.rank}</td><td>{entry.points}</td><td>{entry.displayName}</td>
      {snapshot.config.stages.map((stage) => <EditableScoreCell key={`${stage.id}:${versionKey}`} value={entry.stages[stage.id] as { status?: string; place?: number; points?: number; reason?: string } | undefined} stage={stage} playerId={entry.playerId} playerName={entry.displayName} canWrite={canWrite} versionKey={versionKey} requestConfirmation={requestConfirmation} save={(draft, confirmation) => overrideScoreboard(draft, confirmation)} />)}
    </tr>)}</tbody></table>
    {snapshot.currentScoreboard.length === 0 && <p className="muted">暂无榜单版本。选手有首条有效或排除结果后会出现在这里。</p>}
    <div className="score-override"><h3>修订记录</h3><p className="muted">成绩页只提交“设置名次”或“设置 DNF”。得分由已发布的单关计分规则重算，并生成新榜单版本。</p>
      <table><thead><tr><th>目标</th><th>修改前</th><th>修改后</th><th>审计原因</th><th>时间</th></tr></thead><tbody>{snapshot.scoreboardOverrides.map((record) => <tr key={record.id}><td>{record.targetId}</td><td>{formatOverrideValue(record.beforeValue)}</td><td>{formatOverrideValue(record.afterValue)}</td><td>{record.reason}</td><td>{formatUtc8DateTime(record.createdAt)}</td></tr>)}</tbody></table>
    </div>
  </section>;
}

const formatOverrideValue = (value: unknown): string => {
  if (!value) return "空成绩";
  const result = value as { status?: string; place?: number; points?: number };
  if (result.status === "dnf") return "DNF";
  if (result.status === "excluded") return "排除计分";
  return result.place ? `第 ${result.place} 名 · ${result.points ?? 0} 分` : "已修改";
};

function EditableScoreCell({ value, stage, playerId, playerName, canWrite, versionKey, requestConfirmation, save }: {
  value: { status?: string; place?: number; points?: number; reason?: string } | undefined;
  stage: StageConfig; playerId: string; playerName: string; canWrite: boolean; versionKey: string;
  requestConfirmation(kind: ConfirmationKind, target: string): Promise<ConfirmationSummary>;
  save(draft: ScoreDraft, confirmation: ConfirmationSummary): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [place, setPlace] = useState(String(value?.place || 1));
  const numericPlace = Number(place);
  const calculatedPoints = Number.isInteger(numericPlace) && numericPlace > 0 ? stage.scoring[numericPlace - 1] ?? 0 : 0;
  const className = value?.status === "dnf" ? "dnf" : value?.status === "excluded" ? "excluded" : value?.place === 1 ? "gold" : value?.place === 2 ? "silver" : value?.place === 3 ? "bronze" : "";
  if (!editing) return <td className={`${className} editable-score-cell`}><button className="cell-button" disabled={!canWrite} title={`修改 ${playerName} 的 ${stage.label} 成绩`} onClick={() => { setPlace(String(value?.place || 1)); setEditing(true); }}>{!value ? "—" : value.status === "dnf" ? "DNF" : value.status === "excluded" ? `排除 · 0 分` : `#${value.place} / ${value.points} 分`}</button></td>;
  const target = `${playerId}:${stage.id}`;
  return <td className="score-cell-editor"><label>新名次<input aria-label={`${playerId} ${stage.label} 新名次`} type="number" min="1" value={place} onChange={(event) => setPlace(event.target.value)} /></label><small>按本关规则自动计 {calculatedPoints} 分</small>
    <div className="score-editor-actions">
      <ConfirmButton label="保存名次" kind="scoreboard-override" target={target} versionKey={versionKey} disabled={!Number.isInteger(numericPlace) || numericPlace < 1} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => save({ playerId, stageId: stage.id, operation: "set-place", place: numericPlace, rankPolicy: "shift" }, confirmation)} />
      <ConfirmButton label="设为 DNF" kind="scoreboard-override" target={target} versionKey={versionKey} className="danger" requestConfirmation={requestConfirmation} onConfirm={(confirmation) => save({ playerId, stageId: stage.id, operation: "set-dnf" }, confirmation)} />
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
  requestConfirmation(kind: ConfirmationKind, target: string): Promise<ConfirmationSummary>;
  archiveCompetition(): Promise<void>; finishCompetition(confirmation: ConfirmationSummary, archiveAfter: boolean): Promise<void>; deleteCompetition(confirmation: ConfirmationSummary): Promise<void>;
}) {
  const finish = availabilityFor(snapshot.runtime, "finish");
  const archive = availabilityFor(snapshot.runtime, "archive");
  const remove = availabilityFor(snapshot.runtime, "delete");
  return <section className="panel"><div className="panel-title-row"><h2>结束与归档</h2><div className="button-row compact action-row">
    <ConfirmButton key={`finish:${versionKey}`} label="结束比赛" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} disabled={!canWrite || !finish?.enabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : finish?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => finishCompetition(confirmation, false)} />
    <ConfirmButton key={`finish-archive:${versionKey}`} label="结束并生成归档" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} disabled={!canWrite || !finish?.enabled || snapshot.currentScoreboard.length === 0} disabledReason={snapshot.currentScoreboard.length === 0 ? "暂无可归档榜单" : finish?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={(confirmation) => finishCompetition(confirmation, true)} />
    <div className="action-control"><button disabled={!canWrite || !archive?.enabled || snapshot.currentScoreboard.length === 0} title={archive?.disabledReason} onClick={() => void archiveCompetition()}>仅生成归档</button>{!archive?.enabled && <small className="disabled-reason">{archive?.disabledReason}</small>}</div>
    <ConfirmButton key={`delete:${versionKey}`} label="删除比赛" kind="high-risk" target={snapshot.competition.id} versionKey={versionKey} className="danger" disabled={!canWrite || !remove?.enabled} disabledReason={!canWrite ? "实时连接或控制权不可用" : remove?.disabledReason} requestConfirmation={requestConfirmation} onConfirm={deleteCompetition} />
  </div></div><p className="muted">确认面板会展示目标、阶段、状态版本、具体影响和令牌有效期；无需填写操作原因。</p>
    <table><thead><tr><th>版本</th><th>目录</th><th>Manifest Hash</th><th>时间</th></tr></thead><tbody>{snapshot.archives.map((item) => <tr key={`${item.version}:${item.manifestHash}`}><td>v{item.version}</td><td>{item.directory}</td><td><code>{item.manifestHash}</code></td><td>{formatUtc8DateTime(item.createdAt)}</td></tr>)}</tbody></table>
    {snapshot.archives.length === 0 && <p className="muted">暂无归档版本。</p>}
  </section>;
}

function RawLogWindow({ logs, minimized, setMinimized, refresh, mode }: { logs: readonly RawClientLogLine[]; minimized: boolean; setMinimized(value: boolean): void; refresh(): void; mode: CompetitionMode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (!minimized) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [logs, minimized]);
  return <aside className={minimized ? "raw-log-window minimized" : "raw-log-window"} aria-label="原始客户端日志" style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}>
    <div className="raw-log-title" onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    }} onPointerMove={(event) => {
      const drag = dragRef.current; const element = event.currentTarget.parentElement;
      if (!drag || drag.pointerId !== event.pointerId || !element) return;
      setPosition({ x: Math.max(0, Math.min(window.innerWidth - element.offsetWidth, event.clientX - drag.offsetX)), y: Math.max(0, Math.min(window.innerHeight - element.offsetHeight, event.clientY - drag.offsetY)) });
    }} onPointerUp={(event) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}>
      <strong>原始 Client 日志</strong><span>{mode === "work" ? "真实 MockClient" : "模拟玩家/裁判"} · {logs.length} 行</span><button className="ghost" onClick={refresh}>刷新</button><button onClick={() => setMinimized(!minimized)}>{minimized ? "展开" : "最小化"}</button>
    </div>
    {!minimized && <div className="raw-log-body" ref={bodyRef}>{logs.map((line) => <div className="raw-log-line" key={line.id}><time>{new Date(line.occurredAt).toLocaleTimeString()}</time><span>{line.source}</span><code>{line.rawLine}</code></div>)}{logs.length === 0 && <p>当前暂无客户端日志。</p>}</div>}
  </aside>;
}

function CommandTable({ commands }: { commands: RuntimeSnapshot["commands"] }) {
  return <table><thead><tr><th>动作</th><th>状态</th><th>命令</th><th>回显</th><th>时间</th></tr></thead><tbody>{commands.map((command) => <tr key={command.id}><td>{command.actionType}</td><td>{command.status}</td><td>{command.command ?? "—"}</td><td>{command.responseLine ?? "—"}</td><td>{formatUtc8DateTime(command.updatedAt)}</td></tr>)}</tbody></table>;
}
