import { useEffect, useState } from "react";
import type { PublicScoreStatus } from "@ballance/contracts";
import { formatUtc8DateTime } from "./time.js";

export function PublicScorePanel({ competitionId, mode, published, canWrite, sessionToken }: {
  competitionId: string; mode: "work" | "test"; published: boolean; canWrite: boolean; sessionToken: string;
}) {
  const [status, setStatus] = useState<PublicScoreStatus>();
  const [formRevision, setFormRevision] = useState(0);
  const [owner, setOwner] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("public-scores");
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string>();
  const path = `/api/v1/competitions/${competitionId}/public-score`;

  useEffect(() => {
    let disposed = false;
    let first = true;
    const abort = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(path, { headers: { authorization: `Bearer ${sessionToken}` }, signal: abort.signal });
        const body = await response.json() as { data?: PublicScoreStatus; error?: { message: string } };
        if (!response.ok || !body.data) throw new Error(body.error?.message ?? "读取公开成绩状态失败");
        if (disposed) return;
        setStatus(body.data);
        if (first) {
          const settings = body.data.settings;
          setOwner(settings.owner); setRepository(settings.repository); setBranch(settings.branch); setEnabled(settings.enabled);
          setFormRevision(body.data.revision);
          first = false;
        }
      } catch (failure) { if (!disposed) setError(failure instanceof Error ? failure.message : "读取状态失败"); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);
    return () => { disposed = true; abort.abort(); clearInterval(timer); };
  }, [path, sessionToken]);

  const mutate = async (retry = false) => {
    if (!status) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(retry ? `${path}/retry` : path, {
        method: retry ? "POST" : "PUT",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: retry ? status.revision : formRevision, idempotencyKey: crypto.randomUUID(),
          ...(!retry ? { owner: owner.trim(), repository: repository.trim(), branch: branch.trim(), enabled, ...(token ? { token } : {}) } : {}) })
      });
      const body = await response.json() as { data?: PublicScoreStatus; error?: { message: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "保存失败");
      setStatus(body.data); setToken("");
      if (!retry || formRevision === status.revision) setFormRevision(body.data.revision);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const showPreview = async () => {
    setError("");
    try {
      const response = await fetch(`${path}/preview`, { headers: { authorization: `Bearer ${sessionToken}` } });
      if (!response.ok) throw new Error("生成公开成绩预览失败");
      setPreview(await response.text());
    } catch (failure) { setError(failure instanceof Error ? failure.message : "预览失败"); }
  };
  const disabled = !canWrite || busy || status?.uploading || !published || mode === "test";
  return <section className="panel public-score-panel">
    <div className="panel-title-row"><h2>公开成绩 · GitHub Pages</h2><button onClick={() => void showPreview()}>预览公开成绩</button></div>
    <p className="muted">观众无需刷新页面，每 15 秒自动检查更新。成绩变更自动合并上传，同一仓库两次上传至少间隔 6 分钟；GitHub Pages 发布还可能延迟数分钟。</p>
    {mode === "test" ? <p>测试模式仅支持本地预览，不上传 GitHub。</p> : <>
      <details><summary>首次设置方法</summary><ol>
        <li>准备公开仓库中的独立 public-scores 分支。可按 README 使用初始化脚本创建只含公开网页的分支。</li>
        <li>仓库 Settings → Pages → Deploy from a branch，选择 public-scores 分支和 / (root)，保存。</li>
        <li>创建仅授权此仓库的 fine-grained personal access token，将 Contents 设为 Read and write。</li>
        <li>填写下方信息并开启自动发布。凭据只保存在本次服务内存中，重启或关闭自动发布后需要重新填写。</li>
      </ol><p>仅上传比赛名称、展示名、名次、分数和比赛状态。公开仓库会保留历史提交。关闭自动发布或删除本地比赛不会删除网上已有成绩。</p></details>
      {!published && <p>请先发布比赛配置。</p>}
      <fieldset disabled={Boolean(disabled)} className="public-score-fields">
        <label>GitHub 用户名 / 组织<input value={owner} onChange={e => setOwner(e.target.value)} autoComplete="off" /></label>
        <label>公开成绩仓库<input value={repository} onChange={e => setRepository(e.target.value)} autoComplete="off" /></label>
        <label>发布分支<input value={branch} onChange={e => setBranch(e.target.value)} autoComplete="off" /></label>
        <label>GitHub 上传凭据<input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="new-password" placeholder={status?.hasCredential ? "已设置，留空保留" : "仅保存在本次服务内存"} /></label>
        <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />开启自动发布到公开仓库</label>
        <button disabled={!status} onClick={() => void mutate()}>保存公开成绩设置</button>
      </fieldset>
      {status && <div className="public-score-status" role="status">
        <p>{!status.settings.enabled ? "自动发布未开启" : status.uploading ? "正在同步 GitHub…" : !status.hasCredential ? "等待填写上传凭据（服务重启后需重新填写）" : status.pending ? "有最新成绩等待上传" : "当前成绩已上传到 GitHub"}</p>
        {status.uploadedAt && <p>最近上传：榜单 v{status.uploadedVersion} · {formatUtc8DateTime(status.uploadedAt)}。网页是否已更新，请以公开页的数据时间为准。</p>}
        {status.nextUploadAt && status.pending && <p>下次最早上传：{formatUtc8DateTime(status.nextUploadAt)}</p>}
        {status.error && <p className="error">{status.error}</p>}
        {status.pageUrl && <p><a href={status.pageUrl} target="_blank" rel="noreferrer">打开公开成绩页</a> <span className="muted">首次发布完成前可能显示 404</span><br /><code>{status.pageUrl}</code></p>}
        <button disabled={Boolean(disabled || !status.settings.enabled || !status.hasCredential)} onClick={() => void mutate(true)}>{status.uncertain ? "核对并重试" : "立即发布最新成绩"}</button>
        <small> 遵守 6 分钟上传间隔；若结果不确定，请先在 GitHub 核对文件，再重试。</small>
      </div>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
    {preview && <div><button onClick={() => setPreview(undefined)}>关闭公开成绩预览</button><iframe title="公开成绩预览" sandbox="allow-scripts" srcDoc={preview} style={{ width: "100%", height: 540, border: "1px solid #dce4ed", marginTop: 12 }} /></div>}
  </section>;
}
