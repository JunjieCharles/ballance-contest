import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedMockClient, readMockClientVersion } from "../apps/server/dist/mock-client.js";

const root = resolve(import.meta.dirname, "..");
const serverDirectory = join(root, "server-windows");
const temporary = await mkdtemp(join(tmpdir(), "ballance-real-pipe-"));
const artifactPath = join(root, "test", "artifacts", "mock-client-pipe.json");

const reservePort = async () => {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
};

const waitForServerStart = async (output, port, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output.join("").includes(`started at port ${port}`)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Local BallanceMMO server did not report a successful start");
};

const waitForLine = (lines, predicate, timeoutMs, startIndex = 0) => new Promise((resolveLine, reject) => {
  const existing = lines.slice(startIndex).find(predicate);
  if (existing) { resolveLine(existing); return; }
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const found = lines.slice(startIndex).find(predicate);
    if (found) { clearInterval(timer); resolveLine(found); }
    else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`Expected MockClient output was not observed:\n${lines.join("\n")}`)); }
  }, 50);
});

const port = await reservePort();
const serverOutput = [];
const server = spawn(join(serverDirectory, "BallanceMMOServer.exe"), ["-p", String(port), "-l", join(temporary, "server.log")], {
  cwd: temporary, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
});
for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => serverOutput.push(chunk.toString("utf8")));
let client;
try {
  await waitForServerStart(serverOutput, port, 10_000);
  const lines = [];
  client = new ManagedMockClient({
    executable: join(serverDirectory, "BallanceMMOMockClient.exe"), workingDirectory: serverDirectory,
    server: `127.0.0.1:${port}`, refereeName: "ConsolePipeProbe",
    uuid: "00010002-0003-0004-0005-000600070008", logPath: join(temporary, "mock-client.log")
  });
  client.onLine((line) => lines.push(line));
  client.start();
  await waitForLine(lines, (line) => /Connected to server OK/i.test(line), 10_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const commandBoundary = lines.length;
  await client.write("list");
  const listLine = await waitForLine(lines, (line) => /1 client\(s\) online:/i.test(line), 5_000, commandBoundary);
  await client.stop();
  client = undefined;
  const artifact = {
    checkedAt: new Date().toISOString(), server: `127.0.0.1:${port}`,
    mockClientVersion: readMockClientVersion(join(serverDirectory, "BallanceMMOMockClient.exe"), serverDirectory),
    connected: true, stdinCommand: "list", acknowledgedBy: listLine
  };
  await mkdir(join(root, "test", "artifacts"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Real MockClient pipe test passed: ${artifact.acknowledgedBy}`);
} catch (error) {
  const detail = serverOutput.join("");
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nServer output:\n${detail}`);
} finally {
  if (client) await client.stop().catch(() => undefined);
  if (!server.killed) server.kill();
  await new Promise((resolveExit) => server.exitCode === null ? server.once("exit", resolveExit) : resolveExit());
  await rm(temporary, { recursive: true, force: true });
}
