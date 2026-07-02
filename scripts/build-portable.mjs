import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist", "portable", "BallanceContestConsole");
const runtime = process.env.NODE_RUNTIME_DIR ?? join(root, ".tools", "node-v24.18.0-win-x64");
const requiredServerFiles = [
  "BallanceMMOMockClient.exe", "GameNetworkingSockets.dll", "libcrypto-3-x64.dll", "libprotobuf.dll", "yaml-cpp.dll", "LICENSE"
];
for (const file of requiredServerFiles) {
  try { await stat(join(root, "server-windows", file)); }
  catch { throw new Error(`Missing server-windows/${file}; provision the pinned BallanceMMO artifact before packaging`); }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(runtime, join(output, "runtime"), { recursive: true });
await cp(join(root, "apps", "server", "dist"), join(output, "app", "server"), { recursive: true });
await cp(join(root, "apps", "web", "dist"), join(output, "app", "web"), { recursive: true });
await cp(join(root, "server-windows"), join(output, "server-windows"), {
  recursive: true,
  filter: (source) => !source.endsWith("server_docs_zh.md")
});
await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));
await cp(join(root, "scripts", "Prepare-ContestConsolePort.ps1"), join(output, "Prepare-ContestConsolePort.ps1"));
await mkdir(join(output, "licenses"), { recursive: true });
await cp(join(runtime, "LICENSE"), join(output, "licenses", "Node.js-LICENSE.txt"));
await cp(join(root, "server-windows", "LICENSE"), join(output, "licenses", "BallanceMMO-LICENSE.txt"));

const serverPackage = JSON.parse(await readFile(join(root, "apps", "server", "package.json"), "utf8"));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
delete serverPackage.devDependencies;
serverPackage.main = "app/server/main.js";
serverPackage.scripts = { start: "node app/server/main.js" };
for (const name of ["@ballance/contracts", "@ballance/core", "@ballance/testkit"]) delete serverPackage.dependencies[name];
serverPackage.allowScripts = rootPackage.allowScripts;
await writeFile(join(output, "package.json"), JSON.stringify(serverPackage, null, 2));

const node = join(runtime, "node.exe");
const npmCli = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
const install = spawnSync(node, [npmCli, "install", "--workspaces=false", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: output,
  env: { ...process.env, npm_config_workspaces: "false", PATH: `${runtime};${process.env.PATH ?? ""}` },
  encoding: "utf8",
  stdio: "inherit"
});
if (install.status !== 0) process.exit(install.status ?? 1);

const portableLock = JSON.parse(await readFile(join(output, "package-lock.json"), "utf8"));
const thirdPartyPackages = Object.entries(portableLock.packages ?? {})
  .filter(([path, metadata]) => path.includes("node_modules/") && metadata && typeof metadata === "object")
  .map(([path, metadata]) => ({
    name: metadata.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: metadata.version ?? "unknown",
    license: metadata.license ?? "SEE PACKAGE",
    resolved: metadata.resolved ?? null
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
await writeFile(join(output, "THIRD_PARTY_PACKAGES.json"), `${JSON.stringify(thirdPartyPackages, null, 2)}\n`);

for (const packageName of ["contracts", "core", "testkit"]) {
  const target = join(output, "node_modules", "@ballance", packageName);
  await mkdir(target, { recursive: true });
  await cp(join(root, "packages", packageName, "dist"), join(target, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, "packages", packageName, "package.json"), "utf8"));
  manifest.dependencies = {};
  await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2));
}

await writeFile(
  join(output, "Start-ContestConsole.cmd"),
  "@echo off\r\n" +
    "cd /d %~dp0\r\n" +
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0Prepare-ContestConsolePort.ps1\"\r\n" +
    "if errorlevel 1 (\r\n" +
    "  echo.\r\n" +
    "  echo Contest Console could not prepare port 38623.\r\n" +
    "  pause\r\n" +
    "  exit /b 1\r\n" +
    ")\r\n" +
    "if not defined BALLANCE_OPEN_BROWSER set BALLANCE_OPEN_BROWSER=1\r\n" +
    "runtime\\node.exe app\\server\\main.js\r\n" +
    "set EXIT_CODE=%ERRORLEVEL%\r\n" +
    "if not %EXIT_CODE%==0 (\r\n" +
    "  echo.\r\n" +
    "  echo Contest Console failed to start. Exit code: %EXIT_CODE%\r\n" +
    "  pause\r\n" +
    ")\r\n" +
    "exit /b %EXIT_CODE%\r\n"
);
const mockVersion = spawnSync(join(output, "server-windows", "BallanceMMOMockClient.exe"), ["-v"], { encoding: "utf8", windowsHide: true });
if (mockVersion.status !== 0) throw new Error("Packaged MockClient version probe failed");
const criticalFiles = [
  "runtime/node.exe", "app/server/main.js", "app/web/index.html", "server-windows/BallanceMMOMockClient.exe",
  "Start-ContestConsole.cmd", "Prepare-ContestConsolePort.ps1", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_PACKAGES.json",
  "licenses/Node.js-LICENSE.txt", "licenses/BallanceMMO-LICENSE.txt"
];
const fileManifest = [];
for (const relativePath of criticalFiles) {
  const data = await readFile(join(output, ...relativePath.split("/")));
  fileManifest.push({ relativePath, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
await writeFile(join(output, "PORTABLE_MANIFEST.json"), `${JSON.stringify({
  schemaVersion: 1,
  applicationVersion: rootPackage.version,
  nodeVersion: process.version,
  mockClientVersion: `${mockVersion.stdout}${mockVersion.stderr}`.trim(),
  generatedAt: new Date().toISOString(),
  files: fileManifest
}, null, 2)}\n`);
console.log(`Portable package created at ${output}`);
