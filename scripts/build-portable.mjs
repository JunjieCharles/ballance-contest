import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist", "portable", "BallanceContestConsole");
const runtime = process.env.NODE_RUNTIME_DIR ?? join(root, ".tools", "node-v24.18.0-win-x64");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(runtime, join(output, "runtime"), { recursive: true });
await cp(join(root, "apps", "server", "dist"), join(output, "app", "server"), { recursive: true });
await cp(join(root, "apps", "web", "dist"), join(output, "app", "web"), { recursive: true });
await cp(join(root, "server-windows"), join(output, "server-windows"), {
  recursive: true,
  filter: (source) => !source.endsWith("server_docs_zh.md")
});

const serverPackage = JSON.parse(await readFile(join(root, "apps", "server", "package.json"), "utf8"));
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
delete serverPackage.devDependencies;
serverPackage.main = "app/server/main.js";
serverPackage.scripts = { start: "node app/server/main.js" };
for (const name of ["@ballance/contracts", "@ballance/core"]) delete serverPackage.dependencies[name];
serverPackage.allowScripts = rootPackage.allowScripts;
await writeFile(join(output, "package.json"), JSON.stringify(serverPackage, null, 2));

const node = join(runtime, "node.exe");
const npmCli = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
const install = spawnSync(node, [npmCli, "install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: output,
  env: { ...process.env, PATH: `${runtime};${process.env.PATH ?? ""}` },
  encoding: "utf8",
  stdio: "inherit"
});
if (install.status !== 0) process.exit(install.status ?? 1);

for (const packageName of ["contracts", "core"]) {
  const target = join(output, "node_modules", "@ballance", packageName);
  await mkdir(target, { recursive: true });
  await cp(join(root, "packages", packageName, "dist"), join(target, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, "packages", packageName, "package.json"), "utf8"));
  manifest.dependencies = {};
  await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2));
}

await writeFile(join(output, "Start-ContestConsole.cmd"), "@echo off\r\ncd /d %~dp0\r\nruntime\\node.exe app\\server\\main.js\r\n");
console.log(`Portable package created at ${output}`);
