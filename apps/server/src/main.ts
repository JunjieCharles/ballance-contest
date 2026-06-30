import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { buildApp } from "./app.js";

const bootstrapToken = randomBytes(32).toString("base64url");
const effectiveBootstrapToken = process.env.BALLANCE_BOOTSTRAP_TOKEN ?? bootstrapToken;
const appPromise = buildApp({
  bootstrapToken: effectiveBootstrapToken,
  ...(process.env.BALLANCE_DATA_ROOT ? { dataRoot: process.env.BALLANCE_DATA_ROOT } : {}),
  ...(process.env.BALLANCE_DEV_SHUTDOWN_TOKEN
    ? { devShutdown: { token: process.env.BALLANCE_DEV_SHUTDOWN_TOKEN, onShutdown: async () => (await appPromise).close() } }
    : {})
});
const app = await appPromise;

try {
  await app.listen({ host: "127.0.0.1", port: 32113 });
  const url = `http://127.0.0.1:32113/#token=${effectiveBootstrapToken}`;
  console.log(`Open ${url}`);
  if (process.platform === "win32" && process.env.BALLANCE_OPEN_BROWSER === "1") {
    spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url], {
      detached: true, stdio: "ignore", shell: false, windowsHide: true
    }).unref();
  }
} catch (error) {
  app.log.error(error);
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    console.error("启动失败：本机端口 32113 已被占用。请关闭已经运行的控制台或占用该端口的程序后重试。");
  } else {
    console.error("启动失败：", error);
  }
  process.exitCode = 1;
}
