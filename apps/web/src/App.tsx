import { useEffect, useRef, useState } from "react";
import {
  LARGE_SCORING,
  minimumScoringPlaceFor,
  SMALL_SCORING,
  validateCompetitionConfigForPublish
} from "@ballance/contracts";
import type {
  CompetitionAction,
  CompetitionConfig,
  CompetitionMode,
  CompetitionRecordView,
  CompetitionSnapshot,
  ConfirmationKind,
  ConfirmationSummary,
  HealthResponse,
  RawClientLogLine,
  RuntimeSnapshot,
  ScenarioDefinition,
  ScoreboardOverrideInput,
  TestScenarioSummary
} from "@ballance/contracts";
import { formatUtc8DateTime, toUtc8Input, utc8InputToIso } from "./time.js";

interface Session { token: string; tabId: string; control: boolean }
interface JournalMessage { sequence?: number; type: string; competitionId?: string }
type ScoreboardOverrideDraft = Omit<ScoreboardOverrideInput, "confirmationToken" | "impactHash">;

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
  const seconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

const phaseLabel: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  lobby: "大厅/练习",
  preparing: "准备检查",
  ready: "Ready",
  countdown: "倒计时",
  running: "比赛中",
  "tail-intake": "成绩接收中",
  incident: "事故/暂停",
  review: "比赛复核",
  paused: "已暂停"
};

const eventLabel = (event: ScenarioDefinition["events"][number]): string => {
  switch (event.type) {
    case "login": return `${event.playerId} 上线`;
    case "disconnect": return `${event.playerId} 掉线`;
    case "ready": return `${event.stageId} Ready`;
    case "go": return `${event.stageId} Go`;
    case "finish": return `${event.playerId} 完赛 ${event.stageId}`;
    case "dnf": return `${event.playerId} DNF ${event.stageId}`;
    case "cheat": return `${event.playerId} cheat ${event.enabled ? "on" : "off"}`;
    case "fault": return `故障 ${event.fault}`;
    case "warning": return `Warning ${event.message}`;
  }
};

const stageTitle = (config: CompetitionConfig, stageId?: string): string =>
  config.stages.find((stage) => stage.id === stageId)?.label ?? stageId ?? "—";

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
  const [aliasPlayerId, setAliasPlayerId] = useState("");
  const [aliasDisplayName, setAliasDisplayName] = useState("");
  const [announcement, setAnnouncement] = useState("比赛流程通知");
  const [message, setMessage] = useState("正在连接本机服务...");
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [rawLogs, setRawLogs] = useState<RawClientLogLine[]>([]);
  const [rawLogsMinimized, setRawLogsMinimized] = useState(false);
  const lastSequence = useRef(0);

  const canWrite = Boolean(session?.control && realtimeConnected);
  const runtime = snapshot?.runtime;

  const refreshSnapshot = async (current: Session, competitionId: string) => {
    const next = await request<CompetitionSnapshot>(`/api/v1/competitions/${competitionId}/snapshot`, current);
    setSnapshot(next);
  };

  const refreshRawLogs = async (current: Session, competitionId: string) => {
    setRawLogs(await request<RawClientLogLine[]>(`/api/v1/competitions/${competitionId}/logs/raw?limit=250`, current));
  };

  const selectCompetition = (competitionId: string) => {
    if (competitionId === selectedId) {
      if (session) void refreshSnapshot(session, competitionId)
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "快照加载失败"));
      return;
    }
    setSnapshot(undefined);
    setScenarioDetail(null);
    setRawLogs([]);
    setSelectedId(competitionId);
  };

  const refreshCompetitions = async (current: Session) => {
    const records = await request<CompetitionRecordView[]>("/api/v1/competitions", current);
    setCompetitions(records);
    setSelectedId((old) => old ?? records[0]?.id);
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
    void request<CompetitionSnapshot>(`/api/v1/competitions/${selectedId}/snapshot`, session)
      .then(setSnapshot)
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "快照加载失败"));
  }, [session, selectedId]);

  useEffect(() => {
    if (!session || !selectedId) return;
    const initial = window.setTimeout(() => void refreshRawLogs(session, selectedId).catch(() => undefined), 0);
    const timer = window.setInterval(() => void refreshRawLogs(session, selectedId).catch(() => undefined), 2_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [session, selectedId]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;
    let refreshRunning = false;
    let refreshPending = false;
    const runRealtimeRefresh = async () => {
      if (refreshRunning) {
        refreshPending = true;
        return;
      }
      refreshRunning = true;
      try {
        const [records, nextSnapshot] = await Promise.all([
          request<CompetitionRecordView[]>("/api/v1/competitions", session),
          selectedId ? request<CompetitionSnapshot>(`/api/v1/competitions/${selectedId}/snapshot`, session) : Promise.resolve(undefined)
        ]);
        if (!disposed) {
          setCompetitions(records);
          if (nextSnapshot) setSnapshot(nextSnapshot);
        }
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : "实时快照刷新失败");
      } finally {
        refreshRunning = false;
        if (refreshPending && !disposed) {
          refreshPending = false;
          scheduleRealtimeRefresh();
        }
      }
    };
    const scheduleRealtimeRefresh = () => {
      if (refreshRunning) {
        refreshPending = true;
        return;
      }
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void runRealtimeRefresh();
      }, 100);
    };
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws?token=${encodeURIComponent(session.token)}&after=${lastSequence.current}`);
      socket.addEventListener("open", () => {
        if (!disposed) setRealtimeConnected(true);
      });
      socket.addEventListener("message", (event) => {
        if (disposed || typeof event.data !== "string") return;
        const update = JSON.parse(event.data) as JournalMessage;
        if (update.sequence !== undefined) lastSequence.current = Math.max(lastSequence.current, update.sequence);
        if (update.type === "snapshot-required" || update.competitionId) scheduleRealtimeRefresh();
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setRealtimeConnected(false);
        reconnectTimer = window.setTimeout(connect, 1_000);
      });
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

  const act = async (operation: () => Promise<string | void>, ok = "操作完成") => {
    try {
      const targetId = await operation() ?? selectedId;
      if (targetId && targetId !== selectedId) selectCompetition(targetId);
      if (session) await refreshCompetitions(session);
      if (session && targetId) await refreshSnapshot(session, targetId);
      setMessage(ok);
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
  };

  const createCompetition = () => act(async () => {
    if (!session) throw new Error("没有本机会话");
    const created = await request<CompetitionRecordView>("/api/v1/competitions", session, {
      method: "POST",
      body: JSON.stringify({ name, mode, idempotencyKey: crypto.randomUUID() })
    });
    setTab("config");
    return created.id;
  }, "比赛已创建");

  const saveDraft = (patch: Partial<CompetitionConfig>) => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<CompetitionRecordView>(`/api/v1/competitions/${snapshot.competition.id}/draft`, session, {
      method: "PATCH",
      body: JSON.stringify({ ...patch, expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "草稿已保存");

  const publish = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<CompetitionRecordView>(`/api/v1/competitions/${snapshot.competition.id}/publish`, session, {
      method: "POST",
      body: JSON.stringify({ expectedStateVersion: snapshot.competition.stateVersion, idempotencyKey: crypto.randomUUID() })
    });
  }, "发布检查通过，比赛已发布");

  const startWork = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<RuntimeSnapshot>(`/api/v1/competitions/${snapshot.competition.id}/work/start`, session, { method: "POST", body: "{}" });
  }, "工作模式已启动");

  const enableAutomation = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<RuntimeSnapshot>(`/api/v1/competitions/${snapshot.competition.id}/automation/enable`, session, {
      method: "POST",
      body: JSON.stringify({ runId: snapshot.testRun?.runId, readyInMs: 0 })
    });
  }, "自动化已启用");

  const pauseAutomation = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<RuntimeSnapshot>(`/api/v1/competitions/${snapshot.competition.id}/automation/pause`, session, { method: "POST", body: "{}" });
  }, "自动化已暂停");

  const performRefereeAction = (action: CompetitionAction) => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}/actions`, session, {
      method: "POST",
      body: JSON.stringify({
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(),
        action
      })
    });
  }, snapshot?.competition.mode === "test" ? "模拟裁判动作已应用" : "裁判动作已提交");

  const performConfirmedAction = async (
    kind: ConfirmationKind,
    target: string,
    build: (confirmation: ConfirmationSummary) => CompetitionAction
  ) => {
    try {
      if (!session || !snapshot) throw new Error("请选择比赛");
      const confirmation = await request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
        method: "POST",
        body: JSON.stringify({ kind, target })
      });
      if (!window.confirm(`${confirmation.summary}\n\n该操作会写入审计记录，是否继续？`)) return;
      await performRefereeAction(build(confirmation));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认操作失败");
    }
  };

  const sendAnnouncement = () => performRefereeAction({ type: "announcement", text: announcement });

  const loadScenario = async (scenarioId: string) => {
    if (!session) return;
    const detail = await request<ScenarioDefinition>(`/api/v1/test-scenarios/${scenarioId}`, session);
    setScenarioDetail(detail);
  };

  const createRunFromScenario = (scenarioId: string) => act(async () => {
    if (!session || !snapshot) throw new Error("请选择测试比赛");
    const result = await request<{ runId: string; run: CompetitionSnapshot["testRun"] }>(`/api/v1/competitions/${snapshot.competition.id}/test-runs/from-scenario`, session, {
      method: "POST",
      body: JSON.stringify({ scenarioId })
    });
    if (result.run?.scenario.id) await loadScenario(result.run.scenario.id);
  }, "测试运行已创建");

  const advanceClock = (milliseconds: number) => act(async () => {
    if (!session || !snapshot?.testRun) throw new Error("尚未创建测试运行");
    await request<RuntimeSnapshot>(`/api/v1/competitions/${snapshot.competition.id}/test-runs/${snapshot.testRun.runId}/automation/advance`, session, {
      method: "POST",
      body: JSON.stringify({ milliseconds })
    });
  }, "虚拟时钟已推进");

  const injectFault = (fault: string, playerId?: string) => act(async () => {
    if (!session || !snapshot?.testRun) throw new Error("尚未创建测试运行");
    await request<RuntimeSnapshot>(`/api/v1/competitions/${snapshot.competition.id}/test-runs/${snapshot.testRun.runId}/faults`, session, {
      method: "POST",
      body: JSON.stringify({ fault, ...(playerId ? { playerId } : {}) })
    });
  }, "故障已注入");

  const downloadExport = async (format: "html" | "tsv" | "csv" | "xlsx") => {
    if (!session || !snapshot) return;
    try {
      const response = await fetch(`/api/v1/competitions/${snapshot.competition.id}/exports/${format}`, { headers: { authorization: `Bearer ${session.token}` } });
      if (!response.ok) throw new Error(`导出失败 ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${snapshot.competition.name}-scoreboard.${format}`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`已导出 ${format.toUpperCase()}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导出失败"); }
  };

  const archiveCompetition = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}/archive`, session, {
      method: "POST",
      body: JSON.stringify({ version: snapshot.archives.length + 1 })
    });
  }, "归档已生成");

  const finishCompetition = (archiveAfterFinish: boolean) => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    const reason = window.prompt("请输入结束比赛的裁判原因", "比赛流程结束，进入复核/归档")?.trim();
    if (!reason) throw new Error("已取消：结束比赛必须填写原因");
    const confirmation = await request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
      method: "POST",
      body: JSON.stringify({ kind: "high-risk", target: snapshot.competition.id })
    });
    if (!window.confirm(`${confirmation.summary}\n\n结束后将停止当前工作运行。是否继续？`)) return;
    await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}/finish`, session, {
      method: "POST",
      body: JSON.stringify({
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(),
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        reason
      })
    });
    if (archiveAfterFinish) {
      await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}/archive`, session, {
        method: "POST",
        body: JSON.stringify({ version: snapshot.archives.length + 1 })
      });
    }
  }, archiveAfterFinish ? "比赛已结束并归档" : "比赛已结束");

  const deleteCompetition = () => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    const reason = window.prompt("删除会移除比赛业务记录和运行目录；已生成的归档包会保留。请输入原因", "删除不再需要的比赛")?.trim();
    if (!reason) throw new Error("已取消：删除比赛必须填写原因");
    const confirmation = await request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
      method: "POST",
      body: JSON.stringify({ kind: "high-risk", target: snapshot.competition.id })
    });
    if (!window.confirm(`${confirmation.summary}\n\n此操作不可撤销。是否删除？`)) return;
    await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}`, session, {
      method: "DELETE",
      body: JSON.stringify({
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID(),
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        reason
      })
    });
    setSnapshot(undefined);
    setSelectedId(undefined);
    setRawLogs([]);
    return "";
  }, "比赛已删除");

  const overrideScoreboard = (draft: ScoreboardOverrideDraft) => act(async () => {
    if (!session || !snapshot) throw new Error("请选择比赛");
    const confirmation = await request<ConfirmationSummary>(`/api/v1/competitions/${snapshot.competition.id}/confirmations`, session, {
      method: "POST",
      body: JSON.stringify({ kind: "scoreboard-override", target: `${draft.playerId}:${draft.stageId ?? "total"}` })
    });
    if (!window.confirm(`${confirmation.summary}\n\n修订会生成新的榜单版本，原始成绩不会被覆盖。是否继续？`)) return;
    await request<unknown>(`/api/v1/competitions/${snapshot.competition.id}/scoreboard/overrides`, session, {
      method: "POST",
      body: JSON.stringify({
        ...draft,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        expectedStateVersion: snapshot.competition.stateVersion,
        idempotencyKey: crypto.randomUUID()
      })
    });
  }, "榜单修订版本已生成");

  return (
    <main className={snapshot?.competition.mode === "test" ? "test-mode" : "work-mode"}>
      {snapshot?.competition.mode === "test" && <div className="watermark">测试数据</div>}
      <header>
        <strong>Ballance 比赛控制台</strong>
        <span className="mode-badge">{snapshot?.competition.mode === "work" ? "工作模式" : snapshot?.competition.mode === "test" ? "测试模式" : "未选择比赛"}</span>
        <span>{health ? `服务 ${health.version}` : "离线"} · {realtimeConnected ? "实时已连接" : "实时重连中"} · {message}</span>
        {session && !session.control && <button className="header-button" onClick={() => void act(async () => {
          const next = await request<Session>("/api/v1/sessions/control", session, { method: "POST", body: "{}" });
          sessionStorage.setItem(sessionKey, JSON.stringify(next));
          setSession(next);
        }, "已接管控制权")}>接管</button>}
      </header>

      <div className="shell">
        <aside className="sidebar">
          <section className="panel create-panel">
            <h2>比赛</h2>
            <label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>模式<select value={mode} onChange={(event) => setMode(event.target.value as CompetitionMode)}><option value="work">工作模式（默认）</option><option value="test">测试模式</option></select></label>
            <button disabled={!canWrite} onClick={() => void createCompetition()}>新建比赛</button>
          </section>
          <nav className="competition-list">
            {competitions.map((item) => <button className={item.id === selectedId ? "selected" : "ghost"} key={item.id} onClick={() => selectCompetition(item.id)}>
              <span>{item.name}</span>
              <small>{item.mode === "work" ? "工作" : "测试"} · {item.status} · v{item.stateVersion}</small>
            </button>)}
          </nav>
        </aside>

        <section className="workspace">
          {snapshot ? <>
            <section className="status-strip">
              <div><span>阶段</span><strong>{phaseLabel[runtime?.phase ?? snapshot.competition.status] ?? runtime?.phase ?? snapshot.competition.status}</strong></div>
              <div><span>轮次</span><strong>{stageTitle(snapshot.config, runtime?.currentStageId)}</strong></div>
              <div><span>本轮计划起跑（UTC+8）</span><strong>{formatUtc8DateTime(runtime?.plannedStageStartAt ?? snapshot.config.stages.find((stage) => stage.id === runtime?.currentStageId)?.plannedStartAt)}</strong></div>
              <div><span>自动化</span><strong>{runtime?.automationEnabled ? "启用" : "暂停"}</strong></div>
              <div><span>下一 Ready（UTC+8）</span><strong>{formatUtc8DateTime(runtime?.plannedReadyAt)}</strong></div>
            </section>
            <div className="tabs">
              {(["config", "console", "players", "scoreboard", "test", "archive"] as const).map((item) =>
                <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>{({ config: "比赛配置", console: "控制台", players: "玩家", scoreboard: "成绩", test: "测试", archive: "归档" })[item]}</button>)}
            </div>
            {tab === "console" && <ConsolePanel snapshot={snapshot} announcement={announcement} setAnnouncement={setAnnouncement} canWrite={canWrite}
              enableAutomation={() => void enableAutomation()} pauseAutomation={() => void pauseAutomation()} startWork={() => void startWork()} sendAnnouncement={() => void sendAnnouncement()}
              performAction={(action) => void performRefereeAction(action)}
              performConfirmedAction={(kind, target, build) => void performConfirmedAction(kind, target, build)} />}
            {tab === "config" && <ConfigPanel key={`${snapshot.competition.id}:${snapshot.competition.stateVersion}`} snapshot={snapshot} canWrite={canWrite} saveDraft={(patch) => void saveDraft(patch)} publish={() => void publish()} />}
            {tab === "players" && <PlayersPanel snapshot={snapshot} playerId={aliasPlayerId} displayName={aliasDisplayName}
              setPlayerId={setAliasPlayerId} setDisplayName={setAliasDisplayName} canWrite={canWrite} saveAlias={(playerId, displayName) => {
                void performRefereeAction({ type: "player-alias-upsert", playerId, displayName, reason: "更新排行榜显示名" });
                setAliasPlayerId("");
                setAliasDisplayName("");
              }} />}
            {tab === "scoreboard" && <ScoreboardPanel snapshot={snapshot} canWrite={canWrite} downloadExport={(format) => void downloadExport(format)} overrideScoreboard={(draft) => void overrideScoreboard(draft)} />}
            {tab === "test" && <TestPanel snapshot={snapshot} scenarios={scenarios} scenarioDetail={scenarioDetail} loadScenario={(id) => void loadScenario(id)} createRun={createRunFromScenario}
              enableAutomation={() => void enableAutomation()} advanceClock={(ms) => void advanceClock(ms)} injectFault={(fault, playerId) => void injectFault(fault, playerId)} canWrite={canWrite} />}
            {tab === "archive" && <ArchivePanel snapshot={snapshot} archiveCompetition={() => void archiveCompetition()} finishCompetition={(archive) => void finishCompetition(archive)} deleteCompetition={() => void deleteCompetition()} canWrite={canWrite} />}
          </> : <section className="empty-state">请选择或新建比赛</section>}
        </section>
      </div>
      {snapshot && <RawLogWindow logs={rawLogs} minimized={rawLogsMinimized} setMinimized={setRawLogsMinimized} refresh={() => session && selectedId ? void refreshRawLogs(session, selectedId) : undefined} mode={snapshot.competition.mode} />}
    </main>
  );
}

function ConsolePanel({
  snapshot,
  announcement,
  setAnnouncement,
  canWrite,
  enableAutomation,
  pauseAutomation,
  startWork,
  sendAnnouncement,
  performAction,
  performConfirmedAction
}: {
  snapshot: CompetitionSnapshot; announcement: string; setAnnouncement(value: string): void; canWrite: boolean;
  enableAutomation(): void; pauseAutomation(): void; startWork(): void; sendAnnouncement(): void;
  performAction(action: CompetitionAction): void;
  performConfirmedAction(
    kind: ConfirmationKind,
    target: string,
    build: (confirmation: ConfirmationSummary) => CompetitionAction
  ): void;
}) {
  const [reason, setReason] = useState("现场裁判操作");
  const [participantId, setParticipantId] = useState(snapshot.config.participants[0]?.id ?? "");
  const [rawCommand, setRawCommand] = useState("");
  const [plannedReadyAt, setPlannedReadyAt] = useState(() => toUtc8Input(new Date(Date.now() + 5 * 60_000)));
  const effectiveParticipantId = participantId || snapshot.config.participants[0]?.id || "";
  const participant = snapshot.config.participants.find((candidate) => candidate.id === effectiveParticipantId);
  const incident = snapshot.runtime.incidents[0] as { id?: string } | undefined;
  const attempt = snapshot.runtime.attempts.at(-1) as { id?: string; voided?: boolean } | undefined;
  const runtimeReady = snapshot.competition.mode === "test"
    ? Boolean(snapshot.testRun)
    : snapshot.competition.status !== "draft";
  const confirmed = (
    kind: ConfirmationKind,
    target: string,
    build: (confirmation: ConfirmationSummary) => CompetitionAction
  ) => performConfirmedAction(kind, target, build);

  return <section className="grid two">
    <div className="panel">
      <h2>裁判操作</h2>
      <div className="button-row">
        {snapshot.competition.mode === "work" && <button disabled={!canWrite || snapshot.competition.status === "draft"} onClick={startWork}>启动 MockClient</button>}
        <button disabled={!canWrite || !runtimeReady} onClick={enableAutomation}>启用自动化</button>
        <button disabled={!canWrite} className="secondary" onClick={pauseAutomation}>暂停</button>
      </div>
      <label>通知文本<input value={announcement} onChange={(event) => setAnnouncement(event.target.value)} /></label>
      <button disabled={!canWrite} onClick={sendAnnouncement}>发送通知</button>
      <h3>流程控制</h3>
      <div className="button-row wrap">
        <button disabled={!canWrite || !runtimeReady} onClick={() => performAction({ type: "ready" })}>Ready</button>
        <button disabled={!canWrite || !runtimeReady} onClick={() => performAction({ type: "cheat-off" })}>关闭 cheat</button>
        <button disabled={!canWrite || !runtimeReady} onClick={() => confirmed("manual-go", snapshot.competition.id, (confirmation) => ({
          type: "manual-go",
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>手动 Go</button>
        <button disabled={!canWrite || !runtimeReady} onClick={() => confirmed("manual-action", snapshot.competition.id, (confirmation) => ({
          type: "extend-wait",
          milliseconds: 60_000,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>延长 1 分钟</button>
        <button disabled={!canWrite || !runtimeReady} onClick={() => confirmed("manual-action", snapshot.competition.id, (confirmation) => ({
          type: "end-stage",
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>提前结束本轮</button>
      </div>
      <div className="inline-form">
        <input aria-label="改期时间（UTC+8）" type="datetime-local" value={plannedReadyAt} onChange={(event) => setPlannedReadyAt(event.target.value)} />
        <button disabled={!canWrite || !runtimeReady} onClick={() => confirmed("manual-action", snapshot.competition.id, (confirmation) => ({
          type: "reschedule",
          plannedReadyAt: utc8InputToIso(plannedReadyAt),
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>改期</button>
      </div>
      <label>操作原因<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    </div>
    <div className="panel">
      <h2>阻断与事故</h2>
      {snapshot.runtime.blockers.length === 0 && snapshot.runtime.incidents.length === 0 ? <p className="muted">当前没有阻断或事故。</p> : null}
      {snapshot.runtime.blockers.map((blocker) => <div className="notice critical" key={`${blocker.code}:${blocker.participantId ?? "all"}`}>
        <strong>{blocker.code}</strong><span>{blocker.suggestion}</span>
      </div>)}
      {snapshot.runtime.incidents.map((incident, index) => <pre className="event-json" key={index}>{JSON.stringify(incident, null, 2)}</pre>)}
      <div className="button-row wrap">
        <button disabled={!canWrite || !incident?.id} onClick={() => incident?.id && confirmed("restart", incident.id, (confirmation) => ({
          type: "restart",
          incidentId: incident.id as string,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>确认重赛</button>
        <button disabled={!canWrite || !attempt?.id || attempt.voided} onClick={() => attempt?.id && confirmed("high-risk", attempt.id, (confirmation) => ({
          type: "void-attempt",
          attemptId: attempt.id as string,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>作废尝试</button>
        <button disabled={!canWrite || !attempt?.id || !attempt.voided} onClick={() => attempt?.id && confirmed("high-risk", attempt.id, (confirmation) => ({
          type: "restore-attempt",
          attemptId: attempt.id as string,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>恢复尝试</button>
      </div>
    </div>
    <div className="panel">
      <h2>玩家处置</h2>
      <label>目标玩家<select value={effectiveParticipantId} onChange={(event) => setParticipantId(event.target.value)}>
        <option value="">请选择</option>
        {snapshot.config.participants.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}
      </select></label>
      <div className="button-row wrap">
        <button disabled={!canWrite || !participant} onClick={() => participant && confirmed("manual-action", participant.id, (confirmation) => ({
          type: "mark-dnf",
          participantId: participant.id,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>标记 DNF</button>
        <button disabled={!canWrite || !participant || snapshot.competition.mode === "test"} onClick={() => participant && confirmed("high-risk", participant.displayName, (confirmation) => ({
          type: "kick",
          playerName: participant.displayName,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>Kick</button>
        <button disabled={!canWrite || !participant || snapshot.competition.mode === "test"} onClick={() => participant && confirmed("high-risk", participant.displayName, (confirmation) => ({
          type: "crash",
          playerName: participant.displayName,
          confirmationToken: confirmation.token,
          impactHash: confirmation.impactHash,
          reason
        }))}>Crash</button>
      </div>
      <label>高级原始命令<input value={rawCommand} onChange={(event) => setRawCommand(event.target.value)} /></label>
      <button disabled={!canWrite || snapshot.competition.mode === "test" || !rawCommand.trim()} onClick={() => confirmed("high-risk", snapshot.competition.id, (confirmation) => ({
        type: "raw-command",
        command: rawCommand,
        confirmationToken: confirmation.token,
        impactHash: confirmation.impactHash,
        reason
      }))}>发送原始命令</button>
    </div>
    <div className="panel">
      <h2>命令审计</h2>
      <CommandTable commands={snapshot.runtime.commands} />
    </div>
  </section>;
}

function ConfigPanel({ snapshot, canWrite, saveDraft, publish }: {
  snapshot: CompetitionSnapshot; canWrite: boolean; saveDraft(patch: Partial<CompetitionConfig>): void; publish(): void;
}) {
  const config = snapshot.config;
  const [contestType, setContestType] = useState(config.scoring.contestType);
  const [points, setPoints] = useState<number[]>([...config.scoring.points]);
  const publishIssues = validateCompetitionConfigForPublish(config);
  const editable = canWrite && snapshot.competition.status === "draft";
  const selectScoringPreset = (nextType: CompetitionConfig["scoring"]["contestType"]) => {
    setContestType(nextType);
    if (nextType === "small") setPoints([...SMALL_SCORING]);
    if (nextType === "large") setPoints([...LARGE_SCORING]);
  };
  const lastScoringPlace = minimumScoringPlaceFor(points);
  const saveScoring = () => {
    const scoring = { ...config.scoring, contestType, points, minimumScoringPlace: lastScoringPlace };
    saveDraft({
      contestType,
      scoring,
      stages: config.stages.map((stage) => ({ ...stage, scoring: points, minimumScoringPlace: lastScoringPlace }))
    });
  };
  return <section className="grid two">
    <div className="panel">
      <h2>基本信息</h2>
      <label>比赛名称<input key={`${snapshot.competition.stateVersion}:name`} defaultValue={config.name} onBlur={(event) => {
        if (event.target.value !== config.name) saveDraft({ name: event.target.value });
      }} disabled={!canWrite || snapshot.competition.status !== "draft"} /></label>
      <label>服务器<input key={`${snapshot.competition.stateVersion}:server`} defaultValue={config.server} onBlur={(event) => {
        if (event.target.value !== config.server) saveDraft({ server: event.target.value });
      }} disabled={!canWrite || snapshot.competition.status !== "draft"} /></label>
      <label>裁判名<input key={`${snapshot.competition.stateVersion}:referee`} defaultValue={config.refereeName} onBlur={(event) => {
        if (event.target.value !== config.refereeName) saveDraft({ refereeName: event.target.value });
      }} disabled={!canWrite || snapshot.competition.status !== "draft"} /></label>
      <p className="muted">MockClient 会自动强制使用旁观模式登录，无需单独配置登录名。</p>
      <p className="muted">参赛者无需预登记，系统会根据玩家上下线和 MockClient 列表自动登记。</p>
      <div className={publishIssues.length > 0 ? "validation-summary invalid" : "validation-summary valid"} aria-live="polite">
        <strong>发布检查</strong>
        {publishIssues.length > 0
          ? <><span>还需处理 {publishIssues.length} 项：</span><ul>{publishIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></>
          : <span>配置完整，可以发布。</span>}
      </div>
      <button disabled={!canWrite || snapshot.competition.status !== "draft"} onClick={publish}>发布比赛</button>
    </div>
    <div className="panel">
      <h2>轮次与计分</h2>
      <p className="muted">积分方案默认统一应用到所有关卡；最后一个非零分对应“最后计分名次”，其后完赛仍有效但计 0 分。</p>
      <div className="scoring-presets" role="group" aria-label="积分方案">
        <button className={contestType === "small" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => selectScoringPreset("small")}>小型赛事</button>
        <button className={contestType === "large" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => selectScoringPreset("large")}>大型赛事</button>
        <button className={contestType === "custom" ? "selected-preset" : "ghost"} disabled={!editable} onClick={() => setContestType("custom")}>自定义</button>
      </div>
      <div className="points-editor">
        {points.map((point, index) => <label key={index}>第 {index + 1} 名
          <input aria-label={`第 ${index + 1} 名积分`} type="number" value={point} disabled={!editable || contestType !== "custom"} onChange={(event) => {
            const next = [...points];
            next[index] = Number(event.target.value);
            setPoints(next);
          }} />
        </label>)}
      </div>
      {contestType === "custom" && <div className="button-row">
        <button className="ghost" disabled={!editable} onClick={() => setPoints([...points, 0])}>增加名次</button>
        <button className="ghost" disabled={!editable || points.length <= 1} onClick={() => setPoints(points.slice(0, -1))}>删除末位</button>
      </div>}
      <div className="scoring-summary"><strong>最后计分名次：第 {lastScoringPlace} 名</strong><span>第 {lastScoringPlace + 1} 名起为 0 分</span></div>
      <button disabled={!editable || points.some((point) => !Number.isFinite(point))} onClick={saveScoring}>保存积分方案并应用全部关卡</button>
      <h3>关卡配置</h3>
      <div className="stage-list">{config.stages.slice(0, 13).map((stage) => <div className="stage-row" key={stage.id}>
        <strong>{stage.label}</strong><span>{stage.mode} · Level {stage.level} · {Math.round(stage.timeLimitMs / 60000)} 分钟 · 计分至第 {stage.minimumScoringPlace} 名</span>
      </div>)}</div>
    </div>
  </section>;
}

function PlayersPanel({ snapshot, playerId, displayName, setPlayerId, setDisplayName, saveAlias, canWrite }: {
  snapshot: CompetitionSnapshot;
  playerId: string;
  displayName: string;
  setPlayerId(value: string): void;
  setDisplayName(value: string): void;
  saveAlias(playerId: string, displayName: string): void;
  canWrite: boolean;
}) {
  return <section className="panel">
    <h2>玩家与显示名</h2>
    <p className="muted">普通玩家首次出现在上线、下线或 MockClient 列表中时自动登记；数字连接 ID 只用于现场追踪。</p>
    <h3>排行榜显示名映射（可选）</h3>
    <div className="alias-form">
      <label>玩家 ID（游戏内名称）<input placeholder="Silent_Snow" value={playerId} onChange={(event) => setPlayerId(event.target.value)} /></label>
      <label>排行榜显示名<input placeholder="渴望新地图" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <button disabled={!canWrite || !playerId.trim() || !displayName.trim()} onClick={() => saveAlias(playerId.trim(), displayName.trim())}>保存映射</button>
    </div>
    <table><thead><tr><th>玩家 ID</th><th>排行榜显示名</th><th>登记状态</th></tr></thead><tbody>
      {snapshot.config.playerAliases.map((alias) => <tr key={alias.playerId}><td>{alias.playerId}</td><td>{alias.displayName}</td><td>{snapshot.config.participants.some((participant) => participant.id.toLocaleLowerCase("en-US") === alias.playerId.toLocaleLowerCase("en-US")) ? "已登记" : "等待上线"}</td></tr>)}
    </tbody></table>
    {snapshot.config.playerAliases.length === 0 && <p className="muted">未设置显示名映射，排行榜将直接显示玩家 ID。</p>}
    <h3>自动登记的参赛者</h3>
    <table><thead><tr><th>玩家 ID</th><th>排行榜显示名</th><th>在线</th><th>数字连接记录</th><th>状态</th></tr></thead><tbody>
      {snapshot.config.participants.map((participant) => <tr key={participant.id}><td>{participant.id}</td><td>{participant.displayName}</td><td>{participant.online ? "在线" : "离线"}</td><td>{participant.connectionIds.join(", ") || "—"}</td><td>{participant.currentStageStatus}</td></tr>)}
    </tbody></table>
    {snapshot.config.participants.length === 0 && <p className="muted">尚未观察到普通玩家；无需在比赛开始前手工登记。</p>}
  </section>;
}

function ScoreboardPanel({ snapshot, canWrite, downloadExport, overrideScoreboard }: {
  snapshot: CompetitionSnapshot;
  canWrite: boolean;
  downloadExport(format: "html" | "tsv" | "csv" | "xlsx"): void;
  overrideScoreboard(draft: ScoreboardOverrideDraft): void;
}) {
  const [reason, setReason] = useState("裁判复核修订");
  return <section className="panel">
    <div className="panel-title-row"><h2>实时成绩</h2><div className="button-row compact">
      <button onClick={() => downloadExport("xlsx")}>XLSX</button>
      <button onClick={() => downloadExport("csv")}>CSV</button>
      <button onClick={() => downloadExport("html")}>HTML</button>
      <button onClick={() => downloadExport("tsv")}>TSV</button>
    </div></div>
    <table className="scoreboard"><thead><tr><th>变化</th><th>名次</th><th>积分</th><th>选手</th>{snapshot.config.stages.map((stage) => <th key={stage.id}>{stage.label}</th>)}</tr></thead><tbody>
      {snapshot.currentScoreboard.map((entry) => <tr key={entry.playerId}>
        <td className={entry.change === null ? "" : entry.change > 0 ? "rank-up" : entry.change < 0 ? "rank-down" : ""}>{entry.change === null ? "—" : entry.change > 0 ? `▲${entry.change}` : entry.change < 0 ? `▼${Math.abs(entry.change)}` : "="}</td>
        <td>{entry.rank}</td><td>{entry.points}</td><td>{entry.displayName}</td>
        {snapshot.config.stages.map((stage) => {
          const value = entry.stages[stage.id] as { status?: string; place?: number; points?: number; reason?: string } | undefined;
          return <EditableScoreCell key={stage.id} value={value} stage={stage} playerId={entry.playerId} playerName={entry.displayName}
            canWrite={canWrite} reason={reason} save={(newPlace) => overrideScoreboard({
              playerId: entry.playerId,
              stageId: stage.id,
              stage: { place: newPlace },
              rankPolicy: "shift",
              actor: "local-referee",
              reason
            })} />;
        })}
      </tr>)}
    </tbody></table>
    {snapshot.currentScoreboard.length === 0 && <p className="muted">暂无有效榜单版本。</p>}
    <div className="score-override">
      <h3>名次修订</h3>
      <p className="muted">直接点击关卡成绩单元格修改名次。积分按比赛配置自动重算，不能在成绩页单独修改。</p>
      <label>本次修订原因<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <h3>修订记录</h3>
      <table><thead><tr><th>目标</th><th>修改前</th><th>修改后</th><th>原因</th><th>时间</th></tr></thead><tbody>
        {snapshot.scoreboardOverrides.map((record) => <tr key={record.id}><td>{record.targetId}</td><td><code>{JSON.stringify(record.beforeValue)}</code></td><td><code>{JSON.stringify(record.afterValue)}</code></td><td>{record.reason}</td><td>{record.createdAt}</td></tr>)}
      </tbody></table>
      {snapshot.scoreboardOverrides.length === 0 && <p className="muted">暂无人工修订记录。</p>}
    </div>
  </section>;
}

function EditableScoreCell({ value, stage, playerId, playerName, canWrite, reason, save }: {
  value: { status?: string; place?: number; points?: number; reason?: string } | undefined;
  stage: CompetitionConfig["stages"][number];
  playerId: string;
  playerName: string;
  canWrite: boolean;
  reason: string;
  save(place: number): void;
}) {
  const [editing, setEditing] = useState(false);
  const [place, setPlace] = useState(String(value?.place ?? 1));
  const numericPlace = Number(place);
  const calculatedPoints = Number.isInteger(numericPlace) && numericPlace > 0 ? stage.scoring[numericPlace - 1] ?? 0 : 0;
  const className = value?.status === "dnf" ? "dnf" : value?.place === 1 ? "gold" : value?.place === 2 ? "silver" : value?.place === 3 ? "bronze" : "";
  if (!editing) return <td className={`${className} editable-score-cell`}>
    <button className="cell-button" disabled={!canWrite || !value} title={`修改 ${playerName} 的 ${stage.label} 名次`} onClick={() => {
      setPlace(String(value?.place ?? 1));
      setEditing(true);
    }}>{value ? value.status === "dnf" ? `DNF ${value.reason ?? ""}` : `#${value.place} / ${value.points} 分` : "—"}</button>
  </td>;
  return <td className="score-cell-editor">
    <label>新名次<input aria-label={`${playerId} ${stage.label} 新名次`} type="number" min="1" step="1" value={place} onChange={(event) => setPlace(event.target.value)} /></label>
    <small>自动计 {calculatedPoints} 分</small>
    <div className="cell-actions"><button disabled={!reason.trim() || !Number.isInteger(numericPlace) || numericPlace < 1} onClick={() => { save(numericPlace); setEditing(false); }}>保存</button><button className="ghost" onClick={() => setEditing(false)}>取消</button></div>
  </td>;
}

function TestPanel({ snapshot, scenarios, scenarioDetail, loadScenario, createRun, enableAutomation, advanceClock, injectFault, canWrite }: {
  snapshot: CompetitionSnapshot; scenarios: readonly TestScenarioSummary[]; scenarioDetail: ScenarioDefinition | null;
  loadScenario(id: string): void; createRun(id: string): void; enableAutomation(): void; advanceClock(ms: number): void; injectFault(fault: string, playerId?: string): void; canWrite: boolean;
}) {
  const run = snapshot.testRun;
  const playerId = scenarioDetail?.players[0]?.id;
  if (snapshot.competition.mode !== "test") return <section className="panel"><h2>测试</h2><p className="muted">工作模式不提供测试运行控制。</p></section>;
  return <section className="grid two">
    <div className="panel">
      <h2>场景库</h2>
      <p className="muted">场景只定义玩家的行为模型；Ready、Go、轮次切换和结束始终由裁判状态机按当前比赛配置推进。</p>
      <div className="scenario-grid">{scenarios.map((scenario) => <button className={run?.scenario.id === scenario.id ? "scenario selected-card" : "scenario"} key={scenario.id} onClick={() => loadScenario(scenario.id)}>
        <strong>{scenario.name}</strong><span>{scenario.players} 名独立玩家 · 比赛流程沿用当前配置</span>
        <small>玩家类型：{scenario.playerProfiles.map(profileLabel).join("、")}</small>
        <small>固定随机种子：{scenario.randomSeed}</small>
        <small>点击查看时间线</small>
      </button>)}</div>
      {scenarioDetail && <button disabled={!canWrite} onClick={() => createRun(scenarioDetail.id)}>创建测试运行</button>}
    </div>
    <div className="panel">
      <h2>裁判流程控制</h2>
      <p><strong>虚拟时钟：{formatMs(run?.automation.virtualNowMs)}</strong> · {run?.automation.phase === "review" ? "已到比赛复核" : run?.automation.automationEnabled ? "1× 实时运行中" : "已暂停"}</p>
      <div className="button-row">
        <button disabled={!canWrite || !run} onClick={enableAutomation}>启用自动化</button>
        <button disabled={!canWrite || !run} onClick={() => advanceClock(15_000)}>+15 秒</button>
        <button disabled={!canWrite || !run} onClick={() => advanceClock(180_000)}>+3 分钟</button>
      </div>
      <p className="muted">启用自动化后按 1× 真实时间运行：15 秒 Ready 缓冲就是实际 15 秒，玩家也会在固定种子生成的各自时刻行动。上方按钮仅用于裁判主动快进演练；低手可能提前 DNF，也可能一直无动作到关卡时限。</p>
      <h3>故障注入</h3>
      <div className="button-row wrap">
        <button disabled={!canWrite || !run} onClick={() => injectFault("server-disconnect")}>服务器断线</button>
        <button disabled={!canWrite || !run} onClick={() => injectFault("process-exit")}>进程退出</button>
        <button disabled={!canWrite || !run || !playerId} onClick={() => injectFault("participant-disconnect", playerId)}>选手掉线</button>
        <button disabled={!canWrite || !run || !playerId} onClick={() => injectFault("player-crash", playerId)}>选手崩溃</button>
        <button disabled={!canWrite || !run} onClick={() => injectFault("clock-jump")}>时钟跳变</button>
      </div>
    </div>
    <div className="panel wide">
      <h2>{scenarioDetail?.kind === "player-behavior" ? "玩家行为" : "高级回放时间线"}</h2>
      {scenarioDetail?.kind === "player-behavior"
        ? <div className="behavior-grid">{scenarioDetail.players.map((player) => <div className="behavior-card" key={player.id}><strong>{player.displayName}</strong><span>{profileLabel(player.profile ?? "normal")}</span><small>{player.profile === "expert" ? "较快完赛，具体用时由固定种子决定" : player.profile === "struggler" ? "可能提前 DNF，也可能等待关卡超时" : player.profile === "disruptor" ? "在固定种子决定的时刻开启 cheat" : "按普通区间随机完赛"}</small></div>)}</div>
        : <div className="timeline">{(scenarioDetail?.events ?? []).map((event, index) => <div className={run && index < run.nextEventIndex ? "timeline-row played" : "timeline-row"} key={event.sourceId}>
          <span>{formatMs(event.atMs)}</span><strong>{eventLabel(event)}</strong><small>{event.sourceId}</small>
        </div>)}</div>}
    </div>
  </section>;
}

const profileLabel = (profile: string): string => ({ normal: "普通玩家", expert: "游戏高手", struggler: "游戏低手", disruptor: "捣乱分子" })[profile] ?? profile;

function ArchivePanel({ snapshot, archiveCompetition, finishCompetition, deleteCompetition, canWrite }: {
  snapshot: CompetitionSnapshot;
  archiveCompetition(): void;
  finishCompetition(archive: boolean): void;
  deleteCompetition(): void;
  canWrite: boolean;
}) {
  const canDelete = ["draft", "finished", "archived"].includes(snapshot.competition.status);
  return <section className="panel">
    <div className="panel-title-row"><h2>结束与归档</h2><div className="button-row compact">
      <button disabled={!canWrite || snapshot.competition.status === "finished" || snapshot.competition.status === "archived"} onClick={() => finishCompetition(false)}>结束比赛</button>
      <button disabled={!canWrite || snapshot.currentScoreboard.length === 0 || snapshot.competition.status === "finished" || snapshot.competition.status === "archived"} onClick={() => finishCompetition(true)}>结束并生成归档</button>
      <button disabled={!canWrite || snapshot.currentScoreboard.length === 0 || !["finished", "archived"].includes(snapshot.competition.status)} onClick={archiveCompetition}>仅生成归档</button>
      <button className="danger" disabled={!canWrite || !canDelete} onClick={deleteCompetition}>删除比赛</button>
    </div></div>
    <p className="muted">结束比赛会停止当前工作运行并进入只读复核状态；删除仅允许用于草稿、已结束或已归档比赛，已生成的独立归档包不会随比赛记录删除。</p>
    <table><thead><tr><th>版本</th><th>目录</th><th>Manifest Hash</th><th>时间</th></tr></thead><tbody>
      {snapshot.archives.map((archive) => <tr key={`${archive.version}:${archive.manifestHash}`}><td>v{archive.version}</td><td>{archive.directory}</td><td><code>{archive.manifestHash}</code></td><td>{archive.createdAt}</td></tr>)}
    </tbody></table>
    {snapshot.archives.length === 0 && <p className="muted">暂无归档版本。</p>}
  </section>;
}

function RawLogWindow({ logs, minimized, setMinimized, refresh, mode }: {
  logs: readonly RawClientLogLine[];
  minimized: boolean;
  setMinimized(value: boolean): void;
  refresh(): void;
  mode: CompetitionMode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!minimized) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [logs, minimized]);
  return <aside className={minimized ? "raw-log-window minimized" : "raw-log-window"} aria-label="原始客户端日志"
    style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}>
    <div className="raw-log-title" onPointerDown={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }} onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const windowElement = event.currentTarget.parentElement;
      if (!windowElement) return;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - windowElement.offsetWidth, event.clientX - drag.offsetX)),
        y: Math.max(0, Math.min(window.innerHeight - windowElement.offsetHeight, event.clientY - drag.offsetY))
      });
    }} onPointerUp={(event) => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}>
      <strong>原始 Client 日志</strong>
      <span>{mode === "work" ? "真实 MockClient" : "模拟玩家/裁判"} · {logs.length} 行</span>
      <button className="ghost" onClick={refresh}>刷新</button>
      <button onClick={() => setMinimized(!minimized)}>{minimized ? "展开" : "最小化"}</button>
    </div>
    {!minimized && <div className="raw-log-body" ref={bodyRef}>
      {logs.map((line) => <div className="raw-log-line" key={line.id}><time>{new Date(line.occurredAt).toLocaleTimeString()}</time><span>{line.source}</span><code>{line.rawLine}</code></div>)}
      {logs.length === 0 && <p>当前尚无客户端日志。工作模式启动 MockClient、或测试玩家开始行动后会实时显示。</p>}
    </div>}
  </aside>;
}

function CommandTable({ commands }: { commands: RuntimeSnapshot["commands"] }) {
  return <table><thead><tr><th>动作</th><th>状态</th><th>命令</th><th>回显</th><th>时间</th></tr></thead><tbody>
    {commands.map((command) => <tr key={command.id}><td>{command.actionType}</td><td>{command.status}</td><td>{command.command ?? "—"}</td><td>{command.responseLine ?? "—"}</td><td>{command.updatedAt}</td></tr>)}
  </tbody></table>;
}
