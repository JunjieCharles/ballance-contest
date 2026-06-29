import { useEffect, useState } from "react";
import type { HealthResponse } from "@ballance/contracts";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    void fetch("/api/v1/health").then(async (response) => {
      if (!response.ok) throw new Error(`Health request failed: ${response.status}`);
      setHealth(await response.json() as HealthResponse);
    });
  }, []);

  return (
    <main>
      <header><strong>Ballance 比赛控制台</strong><span>工作模式 / 测试模式</span></header>
      <section className="panel">
        <h1>本机服务</h1>
        <p>{health ? `已连接 · ${health.version}` : "正在连接 127.0.0.1:32113…"}</p>
      </section>
    </main>
  );
}
