import { spawnSync } from "node:child_process";

// Explicit one-time setup; never called by builds, tests, or the referee service.
const repository = process.argv[2];
if (!repository || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
  console.error("用法：node scripts/setup-public-scores.mjs 用户名/仓库名");
  process.exit(1);
}
const branch = "public-scores";
function api(path, method = "GET", body, allowMissing = false) {
  const args = ["api", path, "--method", method];
  if (body) args.push("--input", "-");
  const result = spawnSync("gh", args, { input: body ? JSON.stringify(body) : undefined, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw new Error("无法运行 GitHub CLI，请安装 gh 并执行 gh auth login");
  if (result.status !== 0) {
    if (allowMissing && result.stderr?.includes("HTTP 404")) return undefined;
    throw new Error(`GitHub ${method} ${path} 失败，请检查 gh 登录状态及仓库管理权限`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}
try {
  const repo = api(`repos/${repository}`);
  if (repo.private || !repo.permissions?.admin) throw new Error("需要公开仓库及仓库管理员权限");
  // Never replace an existing website or custom-domain setup.
  const pages = api(`repos/${repository}/pages`, "GET", undefined, true);
  if (pages && (pages.source?.branch !== branch || pages.source?.path !== "/" || pages.build_type !== "legacy")) {
    throw new Error("仓库已有其他 Pages 发布配置，已停止；请使用单独的成绩仓库，或先人工确认现有网站的迁移安排");
  }
  let reference = api(`repos/${repository}/git/ref/heads/${branch}`, "GET", undefined, true);
  if (!reference) {
    const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ballance 比赛成绩</title><style>body{font:18px system-ui;max-width:720px;margin:12vh auto;padding:24px;color:#182c3b;background:#f3f6fa}h1{color:#1b7580}</style><h1>Ballance 比赛成绩</h1><p>请使用裁判分享的具体比赛链接查看成绩。</p><p>比赛成绩页会自动检查更新，无需手动刷新。</p></html>';
    const tree = api(`repos/${repository}/git/trees`, "POST", { tree: [
      { path: "index.html", mode: "100644", type: "blob", content: html },
      { path: ".nojekyll", mode: "100644", type: "blob", content: "" },
      { path: "README.md", mode: "100644", type: "blob", content: "# Ballance 公开成绩\n\n此分支仅保存公开成绩网页，由本地比赛控制台更新 scores/<比赛ID>/index.html。\n请勿上传凭据、日志或原始比赛归档。\n" }
    ] });
    const commit = api(`repos/${repository}/git/commits`, "POST", { message: "Initialize public scoreboard website", tree: tree.sha, parents: [] });
    reference = api(`repos/${repository}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  if (!pages) api(`repos/${repository}/pages`, "POST", { build_type: "legacy", source: { branch, path: "/" } });
  const current = api(`repos/${repository}/pages`);
  console.log(`公开成绩分支已准备：${repository}/${branch}`);
  console.log(`Pages 地址：${current.html_url}（首次发布可能需要数分钟）`);
  console.log("请在控制台成绩页填写此仓库、public-scores 分支和仅限此仓库的 Contents 读写凭据。");
} catch (error) {
  console.error(error instanceof Error ? error.message : "初始化失败");
  process.exitCode = 1;
}
