import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["exec", "concurrently", "--", "-k", "-n", "server,web", "npm:dev -w @ballance/server", "npm:dev -w @ballance/web"], {
  stdio: "inherit",
  shell: false
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
