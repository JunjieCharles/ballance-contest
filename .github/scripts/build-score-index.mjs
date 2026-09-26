// Managed by Ballance Contest Console public scores index
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const scoreRootRedirect = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=./scores/"><title>Ballance 比赛成绩</title><p>比赛目录已迁移，请<a href="./scores/">查看所有公开比赛</a>。</p></html>\n';

export async function buildScoreIndex(root) {
  const directory = join(root, "scores");
  await mkdir(directory, { recursive: true });
  const competitions = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let html;
    try { html = await readFile(join(directory, entry.name, "index.html"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const match = html.match(/<script\b[^>]*\bid="score-data"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error(`Missing public score data: ${entry.name}`);
    const data = JSON.parse(match[1]);
    if (data.competitionId !== entry.name || typeof data.name !== "string" || typeof data.status !== "string") {
      throw new Error(`Invalid public score data: ${entry.name}`);
    }
    if (data.mode === "test") continue;
    const ended = ["historical", "finished", "archived"].includes(data.status);
    competitions.push({ id: entry.name, name: data.name, ended });
  }
  competitions.sort((a, b) => Number(a.ended) - Number(b.ended) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  const items = competitions.map(item => `<li><a href="./${escape(encodeURIComponent(item.id))}/">${escape(item.name)}</a><span class="status${item.ended ? " ended" : ""}">${item.ended ? "已结束" : "进行中"}</span></li>`).join("\n");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公开比赛 · Ballance 比赛成绩</title>
<style>body{font:18px system-ui,sans-serif;max-width:900px;margin:10vh auto;padding:24px;color:#182c3b;background:#f3f6fa}h1{color:#1b7580;margin-bottom:12px}p{line-height:1.7;color:#506674}ul{list-style:none;padding:0;margin-top:32px}li{display:flex;align-items:center;gap:20px;justify-content:space-between;padding:24px;background:white;border:1px solid #dbe5e8;border-radius:8px;margin:12px 0}a{color:#185e70;font-size:21px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;text-decoration:none}a:hover{text-decoration:underline}a:focus-visible{outline:3px solid #1b7580;outline-offset:5px}.status{white-space:nowrap;font-size:15px;padding:6px 10px;border-radius:4px;background:#e4f4ea;color:#176342}.ended{background:#edf0f2;color:#526571}@media(max-width:600px){body{margin:24px auto;padding:16px}h1{font-size:28px}li{padding:18px;gap:12px}a{font-size:18px}}</style></head>
<body><main><h1>Ballance 比赛成绩</h1><p>当前所有公开比赛 · 共 ${competitions.length} 场</p>${competitions.length ? `<ul aria-label="公开比赛">${items}</ul>` : "<p>暂无公开比赛。</p>"}<p>进入比赛后，成绩会自动更新，无需手动刷新。</p></main></body></html>\n`;
  await writeFile(join(directory, "index.html"), html, "utf8");
  return competitions;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const competitions = await buildScoreIndex(resolve(process.argv[2] ?? "."));
  console.log(`Generated public competition index: ${competitions.length} competitions`);
}
