import { useEffect, useMemo, useState } from "react";
import type { Capabilities, CompetitionMode, HealthResponse } from "@ballance/contracts";

interface Session { token: string; tabId: string; control: boolean }
interface CompetitionRecord {
  id: string; name: string; mode: CompetitionMode; status: string; stateVersion: number;
  capabilities: Capabilities; updatedAt: string;
}
interface EngineSnapshot { attempts: readonly unknown[]; scoreboardVersions: readonly unknown[]; anomalies: readonly unknown[]; currentScoreboard: ReadonlyArray<{ rank: number; displayName: string; points: number }> }

const sessionKey = "ballance-console-session";
const tabId = sessionStorage.getItem("ballance-console-tab") ?? crypto.randomUUID();
sessionStorage.setItem("ballance-console-tab", tabId);
const savedSession = sessionStorage.getItem(sessionKey);
const initialSession = savedSession ? JSON.parse(savedSession) as Session : null;

const request = async <T,>(path: string, session: Session | null, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...init?.headers }
  });
  const payload = await response.json() as unknown;
  const envelope = typeof payload === "object" && payload !== null ? payload as { data?: T; error?: { message: string } } : {};
  if (!response.ok) throw new Error(envelope.error?.message ?? `HTTP ${response.status}`);
  return envelope.data !== undefined ? envelope.data : payload as T;
};

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [competitions, setCompetitions] = useState<CompetitionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("测试比赛");
  const [mode, setMode] = useState<CompetitionMode>("test");
  const [scenario, setScenario] = useState("{\n  \"schemaVersion\": 1\n}");
  const [runId, setRunId] = useState<string>();
  const [snapshot, setSnapshot] = useState<EngineSnapshot>();
  const [message, setMessage] = useState("正在连接本机服务…");
  const selected = useMemo(() => competitions.find((item) => item.id === selectedId), [competitions, selectedId]);

  const refresh = async (current: Session) => {
    const records = await request<CompetitionRecord[]>("/api/v1/competitions", current);
    setCompetitions(records);
    setSelectedId((old) => old ?? records[0]?.id);
  };

  useEffect(() => {
    void (async () => {
      try {
        setHealth(await request<HealthResponse>("/api/v1/health", null));
        let current = initialSession;
        const bootstrapToken = new URLSearchParams(location.hash.slice(1)).get("token");
        if (!current && bootstrapToken) {
          current = await request<Session>("/api/v1/sessions/bootstrap", null, { method: "POST", body: JSON.stringify({ bootstrapToken, tabId }) });
          sessionStorage.setItem(sessionKey, JSON.stringify(current));
          history.replaceState(null, "", location.pathname);
          setSession(current);
        }
        if (current) { await refresh(current); setMessage(current.control ? "已取得控制权" : "只读标签页"); }
        else setMessage("请通过启动器打开控制台以取得本机会话");
      } catch (error) { setMessage(error instanceof Error ? error.message : "连接失败"); }
    })();
  }, []);

  const act = async (operation: () => Promise<void>) => {
    try { await operation(); setMessage("操作完成"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
  };

  const createCompetition = () => act(async () => {
    if (!session) throw new Error("没有本机会话");
    const created = await request<CompetitionRecord>("/api/v1/competitions", session, { method: "POST", body: JSON.stringify({ name, mode, idempotencyKey: crypto.randomUUID() }) });
    await refresh(session); setSelectedId(created.id);
  });

  const createRun = () => act(async () => {
    if (!session || !selected) throw new Error("请选择测试比赛");
    const result = await request<{ runId: string; snapshot: EngineSnapshot }>(`/api/v1/competitions/${selected.id}/test-runs`, session, { method: "POST", body: JSON.stringify(JSON.parse(scenario) as unknown) });
    setRunId(result.runId); setSnapshot(result.snapshot);
  });

  const controlRun = (action: "step" | "play" | "reset") => act(async () => {
    if (!session || !selected || !runId) throw new Error("尚未创建测试运行");
    setSnapshot(await request<EngineSnapshot>(`/api/v1/competitions/${selected.id}/test-runs/${runId}/${action}`, session, { method: "POST", body: "{}" }));
  });

  return (
    <main className={selected?.mode === "test" ? "test-mode" : "work-mode"}>
      {selected?.mode === "test" && <div className="watermark">测试数据</div>}
      <header>
        <strong>Ballance 比赛控制台</strong>
        <span className="mode-badge">{selected?.mode === "work" ? "工作模式" : selected?.mode === "test" ? "测试模式" : "未选择比赛"}</span>
        <span>{health ? `服务 ${health.version}` : "离线"} · {message}</span>
      </header>
      <div className="layout">
        <aside className="panel">
          <h2>比赛</h2>
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>模式<select value={mode} onChange={(event) => setMode(event.target.value as CompetitionMode)}><option value="test">测试模式</option><option value="work">工作模式</option></select></label>
          <button disabled={!session?.control} onClick={() => void createCompetition()}>新建比赛</button>
          <nav>{competitions.map((item) => <button className={item.id === selectedId ? "selected" : "ghost"} key={item.id} onClick={() => setSelectedId(item.id)}>{item.name}<small>{item.mode === "work" ? "工作" : "测试"} · v{item.stateVersion}</small></button>)}</nav>
        </aside>
        <section className="content">
          <div className="panel status-grid">
            <div><span>状态</span><strong>{selected?.status ?? "—"}</strong></div>
            <div><span>真实进程</span><strong>{selected?.capabilities.realProcess ? "可用" : "禁用"}</strong></div>
            <div><span>真实命令</span><strong>{selected?.capabilities.realCommands ? "可用" : "禁用"}</strong></div>
            <div><span>虚拟时钟</span><strong>{selected?.capabilities.virtualClock ? "可用" : "禁用"}</strong></div>
          </div>
          {selected?.mode === "test" ? <div className="panel">
            <h2>测试场景</h2>
            <p>粘贴人工维护的 ScenarioDefinition；测试模式不会启动真实 MockClient 或联网。</p>
            <textarea value={scenario} onChange={(event) => setScenario(event.target.value)} spellCheck={false} />
            <div className="actions"><button disabled={!session?.control} onClick={() => void createRun()}>创建测试运行</button><button disabled={!runId} onClick={() => void controlRun("step")}>逐事件</button><button disabled={!runId} onClick={() => void controlRun("play")}>播放到底</button><button disabled={!runId} onClick={() => void controlRun("reset")}>重置</button></div>
          </div> : <div className="panel"><h2>工作控制台</h2><p>工作模式由本服务托管真实 MockClient，并通过串行命令队列等待服务器回显；测试专属操作在此不可用。</p></div>}
          {snapshot && <div className="panel"><h2>实时成绩</h2><p>{snapshot.attempts.length} 次尝试 · {snapshot.scoreboardVersions.length} 个榜单版本 · {snapshot.anomalies.length} 条异常</p><table><thead><tr><th>名次</th><th>选手</th><th>积分</th></tr></thead><tbody>{snapshot.currentScoreboard.map((entry) => <tr key={entry.displayName}><td>{entry.rank}</td><td>{entry.displayName}</td><td>{entry.points}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
    </main>
  );
}
