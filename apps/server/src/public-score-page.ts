import assets from "./public-score-assets.json" with { type: "json" };
import titleFont from "./public-title-font.json" with { type: "json" };
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
  const titlePoints = new Set(Array.from(data.name + "【测试预览】比赛成绩", char => char.codePointAt(0)!));
  const titleFaces = titleFont.filter(chunk => chunk.points.some(point => titlePoints.has(point))).map(chunk =>
    `@font-face{font-family:BallanceTitle;src:url("${chunk.url}") format("woff2");font-weight:400;font-style:normal;font-display:swap;unicode-range:${chunk.points.map(point => `U+${point.toString(16)}`).join(",")}}`
  ).join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>比赛成绩</title>
<style id="title-font">/* ${assets.titleLicense} */
${titleFaces}</style>
<style>
@font-face{font-family:BallanceBank;src:url("${assets.bank}") format("truetype");font-weight:400 800;font-display:swap}
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#ece9db;color-scheme:dark;background:#101923;--line:#7a7560;--row-height:56px;--number-size:36px}
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:linear-gradient(110deg,#0c1521aa,#18243770),url("${assets.sky}") center/cover fixed}body::before{content:"";position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 180px #070c16bb}main{position:relative;width:100%;max-width:2400px;margin:auto;padding:28px 36px 32px}
header{display:flex;align-items:center;gap:22px;min-height:84px;padding:4px 4px 22px}header::before{content:"";flex:0 0 50px;height:50px;background:url("${assets.icon}") center/contain no-repeat;filter:drop-shadow(0 3px 4px #0008)}
.title-wrap{flex:1;min-width:0}h1{width:calc(100% / 1.12);transform:scaleX(1.12);transform-origin:left center;font-family:BallanceTitle,"Microsoft YaHei",sans-serif;font-size:clamp(26px,2.4vw,46px);font-weight:400;letter-spacing:1px;line-height:1.3;margin:0;flex:1;min-width:0;overflow-wrap:anywhere;text-shadow:0 2px 3px #000}
#status{display:flex;align-items:center;gap:10px;flex-shrink:0;color:#e7d9b4;font-size:20px;letter-spacing:3px;padding:10px 16px;border:1px solid #95846570;background:#14202dbb;box-shadow:inset 0 0 12px #0005}#status::before{content:"";width:7px;height:7px;border-radius:50%;background:#dfbb72;box-shadow:0 0 8px #d6a75466}#status[data-ended="true"]::before{background:#a6b4be;box-shadow:none}
.frame{padding:7px;border:1px solid #a7a082;border-radius:3px;background:linear-gradient(110deg,#e3d9b344,#050b11aa),url("${assets.metal}");box-shadow:0 12px 40px #0006,inset 0 0 0 1px #212c33,inset 0 2px 0 #e5ddbb60}
.table-wrap{overflow:auto;max-height:calc(100svh - 164px);border:1px solid #080f16;background:#15222e;scrollbar-width:auto;scrollbar-gutter:stable;scrollbar-color:#777866 #14202a}
.table-wrap::-webkit-scrollbar{width:12px;height:12px}.table-wrap::-webkit-scrollbar-track{background:#14202a}.table-wrap::-webkit-scrollbar-thumb{background:#898a76;border:2px solid #14202a;border-radius:6px}
table{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%;min-width:1200px;white-space:nowrap;font-variant-numeric:tabular-nums}
th,td{text-align:center;padding:0 6px;border-right:1px solid #abb9c214;border-bottom:1px solid #abb9c21b;overflow:hidden;text-overflow:ellipsis}th{position:sticky;top:0;height:56px;z-index:2;background:linear-gradient(#444b4a,#2b3439);color:#c6c5b4;font-size:22px;font-weight:400;letter-spacing:1px;border-bottom:2px solid #998360}th:nth-child(n+5){font-family:BallanceBank,sans-serif;font-size:24px;letter-spacing:0;padding:0 2px}
td{height:var(--row-height);font-family:BallanceBank,"Microsoft YaHei",sans-serif;font-size:var(--number-size);background:#192733}tr:nth-child(even) td{background:#202e38}
.player-name{display:inline-block;max-width:100%;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td:nth-child(3){color:#f2d798;font-size:calc(var(--number-size) + 3px);background:#283237}tr:nth-child(even) td:nth-child(3){background:#2e383c}
td:nth-child(4),th:nth-child(4){position:sticky;left:0;z-index:1;text-align:left;padding-left:18px;border-right:1px solid #a9a58566}td:nth-child(4){font-family:Arial,"Microsoft YaHei",sans-serif;font-size:calc(var(--number-size) - 6px);letter-spacing:-.5px;color:#f0eee5}th:nth-child(4){z-index:3}
td:nth-child(n+5){font-size:calc(var(--number-size) - 2px)}td.gold{color:#ffe1a0;background:#62553b!important;box-shadow:inset 0 1px #c9a76c40}td.silver{color:#edf0eb;background:#414c54!important}td.bronze{color:#e1b597;background:#4b3c37!important}.dnf{color:#b4c0c9;text-decoration:line-through;font-size:calc(var(--number-size) - 8px)!important}.excluded{color:#e59c9b;background:#523039!important}.rank-up,.rank-down{font-family:BallanceBank,"Microsoft YaHei",sans-serif;font-size:calc(var(--number-size) - 10px)}.rank-up{color:#ee9e86}.rank-down{color:#91bda8}
#empty{padding:28px;text-align:center;color:#b7bbb8;font-size:14px}[hidden]{display:none!important}
@media(min-width:1600px){main{padding-top:30px}.table-wrap{max-height:calc(100svh - 172px)}}
@media(max-width:900px){main{padding:16px 12px}header{gap:12px;min-height:76px;padding-bottom:16px}header::before{flex-basis:32px;height:32px}h1{font-size:23px}#status{font-size:12px;letter-spacing:1px;padding:8px}td:nth-child(4),th:nth-child(4){padding-left:10px}.table-wrap{max-height:calc(100svh - 124px)}}
body.transparent{background:transparent}html:has(body.transparent){background:transparent}body.transparent::before{display:none}
</style></head><body><main><header><div class="title-wrap"><h1 id="name">比赛成绩</h1></div><div id="status"></div><div id="meta" hidden></div><div id="connection" hidden></div></header><div class="frame"><div class="table-wrap"><table aria-label="比赛成绩"><colgroup id="columns"></colgroup><thead id="head"></thead><tbody id="rows"></tbody></table><p id="empty" hidden>等待成绩</p></div></div></main>
<script id="score-data" type="application/json">${json}</script>
<script>
(() => {
  let current;
  document.body.classList.toggle('transparent', new URLSearchParams(location.search).get('transparent') === '1');
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
    // Historical provenance remains in embedded metadata, outside the broadcast layout.
    document.getElementById('status').textContent = ended || historical ? '已结束' : '进行中';
    document.getElementById('status').dataset.ended = String(ended || historical);
    sizeTable();
    // Live cells include rank and points; allow horizontal scrolling before truncating them.
    document.querySelector('table').style.minWidth = Math.max(1600, historical ? 1600 : Math.max(0, data.headers.length - 4) * 90 / .64) + 'px';
    const widths = [5, 5, 8, 18];
    document.getElementById('columns').replaceChildren(...data.headers.map((_, index) => {
      const col = document.createElement('col');
      col.style.width = (widths[index] ?? 64 / Math.max(1, data.headers.length - 4)) + '%';
      return col;
    }));
    const heading = document.createElement('tr');
    data.headers.forEach(text => { const th = document.createElement('th'); th.textContent = text; heading.append(th); });
    document.getElementById('head').replaceChildren(heading);
    const rows = data.rows.map(row => { const tr = document.createElement('tr'); row.cells.forEach((cell, index) => { const td = document.createElement('td'); if (index === 3) { const name = document.createElement('span'); name.className = 'player-name'; name.textContent = cell.text; td.append(name); } else { td.textContent = cell.text; } td.title = cell.text; td.className = cell.style; tr.append(td); }); return tr; });
    document.getElementById('rows').replaceChildren(...rows);
    document.getElementById('empty').hidden = rows.length > 0;
    wrap.scrollTop = top; wrap.scrollLeft = left;
    current = data;
    fitPlayerNames();
    document.fonts.ready.then(fitPlayerNames);
  }
  function sizeTable() {
    const wrap = document.querySelector('.table-wrap');
    const available = Math.max(220, innerHeight - wrap.getBoundingClientRect().top - 40);
    const height = Math.max(44, Math.min(72, Math.floor((available - 58) / 15)));
    document.documentElement.style.setProperty('--row-height', height + 'px');
    document.documentElement.style.setProperty('--number-size', Math.max(30, Math.min(42, height * .66)) + 'px');
    wrap.style.maxHeight = Math.min(available, 58 + height * 15) + 'px';
  }
  function fitPlayerNames() {
    document.querySelectorAll('.player-name').forEach(name => {
      name.style.fontSize = '';
      const base = parseFloat(getComputedStyle(name).fontSize);
      const available = name.clientWidth;
      if (available > 0 && name.scrollWidth > available) {
        name.style.fontSize = Math.max(16, Math.floor(base * available / name.scrollWidth * 10) / 10 - .2) + 'px';
      }
    });
  }
  addEventListener('resize', () => { sizeTable(); fitPlayerNames(); });
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
      if (data.sequence > current.sequence) {
        const face = doc.getElementById('title-font');
        if (face) document.getElementById('title-font').textContent = face.textContent;
      }
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
