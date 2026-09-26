import { createScoreboardTable, stageDisplayName, type CompetitionSnapshot, type ScoreboardTableCell } from "@ballance/contracts";

export interface PublicScoreData {
  competitionId: string;
  name: string;
  mode: "work" | "test";
  status: string;
  version: number;
  sequence: number;
  generatedAt: string;
  headers: readonly string[];
  rows: readonly { cells: readonly ScoreboardTableCell[] }[];
}

// Deliberate allowlist: no player IDs, logs, server addresses or control credentials.
export const publicScoreData = (snapshot: CompetitionSnapshot, sequence = 0, generatedAt = new Date().toISOString()): PublicScoreData => {
  const table = createScoreboardTable(snapshot.config.stages.map(stage => ({ id: stage.id, label: stageDisplayName(stage) })), snapshot.currentScoreboard);
  return {
    competitionId: snapshot.competition.id,
    name: snapshot.competition.name,
    mode: snapshot.competition.mode,
    status: snapshot.competition.status,
    version: snapshot.scoreboardVersions.at(-1)?.version ?? 0,
    sequence, generatedAt,
    headers: table.headers,
    rows: table.rows.map(row => ({ cells: row.cells.map(cell => ({ text: cell.text, style: cell.style })) }))
  };
};

export const renderPublicScorePage = (data: PublicScoreData): string => {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>比赛成绩</title>
<style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#182c3b;background:#f3f6fa;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:32px 20px}header{border-top:5px solid #1b7580;background:white;padding:24px;border-radius:8px;margin-bottom:20px}.eyebrow{color:#1b7580;font-size:13px;letter-spacing:2px}h1{font-size:28px;margin:10px 0;overflow-wrap:anywhere}.meta{color:#526577;font-size:14px;line-height:1.8}.table-wrap{overflow:auto;background:white;border:1px solid #dce4ed;border-radius:8px;max-height:75vh}table{border-collapse:separate;border-spacing:0;min-width:100%;white-space:nowrap;font-variant-numeric:tabular-nums}th,td{padding:13px 16px;text-align:center;border-bottom:1px solid #edf0f4}th{position:sticky;top:0;background:#e9eff5;z-index:2;font-size:13px}td:nth-child(4),th:nth-child(4){text-align:left;position:sticky;left:0;background:white;z-index:1;min-width:150px}th:nth-child(4){background:#e9eff5;z-index:3}td:nth-child(3){font-weight:700}.gold{background:#ffb700}.silver{background:#ffe1b2}.bronze{background:#fff2cc}.dnf{color:#727a84;text-decoration:line-through}.excluded{color:#8a2935;background:#fff0f1}.rank-up{color:#b51f2c}.rank-down{color:#1d7a43}#connection{min-height:24px;color:#526577;font-size:13px}#empty{padding:28px;text-align:center;color:#526577}footer{font-size:13px;color:#526577;padding:16px 0;line-height:1.8}@media(max-width:600px){main{padding:16px 10px}header{padding:18px}h1{font-size:23px}th,td{padding:11px 12px}}
td:nth-child(4),th:nth-child(4){width:180px;max-width:180px;overflow:hidden;text-overflow:ellipsis}@media(max-width:600px){td:nth-child(4),th:nth-child(4){min-width:120px;width:140px;max-width:140px}}
</style></head><body><main><header><div class="eyebrow">BALLANCE · 公开成绩</div><h1 id="name">比赛成绩</h1><div class="meta" id="meta"></div><div id="connection" role="status">正在读取成绩…</div></header><div class="table-wrap"><table aria-label="比赛成绩"><thead id="head"></thead><tbody id="rows"></tbody></table><p id="empty" hidden>暂无成绩，比赛结果发布后会自动出现。</p></div><footer>页面每 15 秒自动检查更新，无需手动刷新。GitHub Pages 发布可能延迟数分钟。<br>比赛中的成绩供参考，结束后的成绩仍可能经裁判复核修订。</footer></main>
<script id="score-data" type="application/json">${json}</script>
<script>
(() => {
  let current;
  const styles = new Set(['plain','gold','silver','bronze','dnf','excluded','rank-up','rank-down']);
  function valid(data) {
    return data && typeof data.competitionId === 'string' && typeof data.name === 'string' &&
      Number.isSafeInteger(data.sequence) && Number.isSafeInteger(data.version) && typeof data.generatedAt === 'string' &&
      Array.isArray(data.headers) && data.headers.every(x => typeof x === 'string') &&
      Array.isArray(data.rows) && data.rows.every(row => Array.isArray(row.cells) && row.cells.length === data.headers.length && row.cells.every(cell => typeof cell.text === 'string' && styles.has(cell.style)));
  }
  function render(data) {
    if (!valid(data)) throw new Error('invalid scoreboard');
    if (current && (data.competitionId !== current.competitionId || data.sequence <= current.sequence)) return;
    const wrap = document.querySelector('.table-wrap');
    const top = wrap.scrollTop, left = wrap.scrollLeft;
    document.getElementById('name').textContent = (data.mode === 'test' ? '【测试预览】' : '') + data.name;
    document.title = data.name + ' · 比赛成绩';
    const ended = data.status === 'finished' || data.status === 'archived';
    const historical = data.status === 'historical';
    document.getElementById('meta').textContent = (historical ? '历史成绩展示 · 按提供的原表呈现' : ended ? '比赛已结束 · 可复核修订' : '比赛成绩 · 非最终榜单') + ' ｜ 榜单 v' + data.version + (historical ? ' ｜ 页面生成时间：' : ' ｜ 数据更新时间：') + new Date(data.generatedAt).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) + '（UTC+8）';
    if (historical) document.querySelector('footer').textContent = '本页为历史比赛成绩展示示例。SR1–SR13 单元格表示各关名次，积分和并列排名保留原表，未重新计分或复核。页面每 15 秒自动检查更新，无需手动刷新。';
    const heading = document.createElement('tr');
    data.headers.forEach(text => { const th = document.createElement('th'); th.textContent = text; heading.append(th); });
    document.getElementById('head').replaceChildren(heading);
    const rows = data.rows.map(row => { const tr = document.createElement('tr'); row.cells.forEach(cell => { const td = document.createElement('td'); td.textContent = cell.text; td.title = cell.text; td.className = cell.style; tr.append(td); }); return tr; });
    document.getElementById('rows').replaceChildren(...rows);
    document.getElementById('empty').hidden = rows.length > 0;
    wrap.scrollTop = top; wrap.scrollLeft = left;
    current = data;
  }
  try { render(JSON.parse(document.getElementById('score-data').textContent)); }
  catch { document.getElementById('connection').textContent = '成绩文件无法读取，请稍后再试。'; return; }
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    document.getElementById('connection').textContent = '本地预览，仅展示当前快照；公开页面会自动更新。'; return;
  }
  document.getElementById('connection').textContent = '自动更新已开启';
  async function check() {
    try {
      const url = new URL(location.href); url.hash = ''; url.searchParams.set('_scoreCheck', String(Date.now()));
      const response = await fetch(url, {cache:'no-store', credentials:'omit', signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('fetch failed');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const data = JSON.parse(doc.getElementById('score-data').textContent);
      if (!valid(data) || data.competitionId !== current.competitionId) throw new Error('wrong scoreboard');
      render(data);
      document.getElementById('connection').textContent = '已检查更新 · ' + new Date().toLocaleTimeString('zh-CN', {hour12:false});
    } catch {
      document.getElementById('connection').textContent = '暂时无法检查更新，正在显示上次成绩；稍后自动重试。';
    } finally { setTimeout(check, 15000); }
  }
  setTimeout(check, 15000);
})();
</script></body></html>`;
};
