import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

const runtimeDirectory = resolve(".runtime");
const lockPath = join(runtimeDirectory, "dev-instance.json");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run the development launcher through npm run dev");

const portOpen = () => new Promise((resolveProbe) => {
  const socket = createConnection({ host: "127.0.0.1", port: 32113 });
  socket.setTimeout(500);
  socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
  socket.once("timeout", () => { socket.destroy(); resolveProbe(false); });
  socket.once("error", () => resolveProbe(false));
});

const stopPreviousDevInstance = async () => {
  if (!await portOpen()) return;
  let lock;
  try { lock = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* unknown process owns the port */ }
  if (typeof lock?.shutdownToken !== "string" || lock.shutdownToken.length < 32 || !Number.isInteger(lock.pid) || lock.pid < 1) {
    throw new Error("端口 32113 已被未知进程占用；为保护现场，开发启动器不会终止它");
  }
  let response;
  try {
    response = await fetch("http://127.0.0.1:32113/api/v1/dev/shutdown", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: lock.shutdownToken }), signal: AbortSignal.timeout(2_000)
    });
  } catch {
    throw new Error("端口 32113 上的进程未接受安全关闭请求；开发启动已中止");
  }
  if (!response.ok) throw new Error("现有实例拒绝安全关闭；开发启动已中止");
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(lock.pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true });
    await new Promise((resolveKill) => killer.once("exit", resolveKill));
  }
  for (let attempt = 0; attempt < 50 && await portOpen(); attempt += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (await portOpen()) throw new Error("现有开发实例未在 5 秒内释放端口 32113");
};

await mkdir(runtimeDirectory, { recursive: true });
await stopPreviousDevInstance();
const shutdownToken = randomBytes(32).toString("base64url");

const child = spawn(process.execPath, [npmCli, "exec", "concurrently", "--", "-k", "-n", "server,web", "npm:dev -w @ballance/server", "npm:dev -w @ballance/web"], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, BALLANCE_DEV_SHUTDOWN_TOKEN: shutdownToken }
});
await writeFile(lockPath, JSON.stringify({ shutdownToken, pid: child.pid, startedAt: new Date().toISOString() }, null, 2), "utf8");

const removeOwnLock = async () => {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    if (lock.shutdownToken === shutdownToken) await rm(lockPath, { force: true });
  } catch { /* already removed */ }
};

child.on("exit", (code) => {
  void removeOwnLock();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
