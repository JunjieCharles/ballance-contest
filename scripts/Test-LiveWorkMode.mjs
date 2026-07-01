import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandQueue } from "../apps/server/dist/command-queue.js";
import { ManagedMockClient, readMockClientVersion } from "../apps/server/dist/mock-client.js";

if (process.env.BALLANCE_ALLOW_LIVE_COMMANDS !== "1") {
  throw new Error("Set BALLANCE_ALLOW_LIVE_COMMANDS=1 only after the target server is approved for full workflow commands");
}

const root = resolve(import.meta.dirname, "..");
const serverDirectory = join(root, "server-windows");
const server = process.env.BALLANCE_LIVE_SERVER ?? "2.bmmo.win";
const customMapHash = process.env.BALLANCE_LIVE_CUSTOM_MAP_HASH ?? "e90b2f535c8bf881e9cb83129fba241d";
const temporary = await mkdtemp(join(tmpdir(), "ballance-live-work-"));
const artifactPath = join(root, "test", "artifacts", "live-work-mode.json");
const probeName = `Stage1Probe${Date.now().toString().slice(-6)}`;
const lines = [];
const records = [];
let client;

const waitForLine = (predicate, timeoutMs) => new Promise((resolveLine, reject) => {
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const found = lines.find(predicate);
    if (found) { clearInterval(timer); resolveLine(found); }
    else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`Expected live output was not observed:\n${lines.join("\n")}`)); }
  }, 50);
});

try {
  client = new ManagedMockClient({
    executable: join(serverDirectory, "BallanceMMOMockClient.exe"),
    workingDirectory: serverDirectory,
    server,
    refereeName: probeName,
    uuid: "10000000-2000-3000-4000-500000000001",
    logPath: join(temporary, "mock-client.log")
  });
  const queue = new CommandQueue(client, (action) => action.type === "go" ? 15_000 : 10_000, (record) => {
    const existing = records.findIndex((candidate) => candidate.id === record.id);
    const copy = { ...record };
    if (existing >= 0) records[existing] = copy;
    else records.push(copy);
  });
  client.onLine((line) => {
    lines.push(line);
    queue.observeLine(line);
  });
  client.start();
  await waitForLine((line) => /Connected to server OK/i.test(line), 15_000);

  const run = async (action, key) => {
    const record = await queue.enqueue(action, key);
    if (record.status !== "acknowledged") throw new Error(`${action.type} ended as ${record.status}: ${record.command}`);
    return record;
  };

  await run({ type: "list" }, "live-list");
  await run({ type: "notification", channel: "bulletin", text: `${probeName} workflow probe` }, "live-bulletin");
  await run({ type: "notification", channel: "notice", text: `${probeName} notice probe` }, "live-notice");
  await run({ type: "notification", channel: "announce", text: `${probeName} announce probe` }, "live-announce");
  for (let index = 0; index < 3; index += 1) {
    await run({ type: "ready", map: "level 1", mode: "sr" }, `live-ready-${index + 1}`);
  }
  await run({ type: "cheat-off" }, "live-cheat-off");
  await run({ type: "go", map: "level 1", mode: "sr" }, "live-go");
  await run({ type: "ready", map: `${customMapHash} 0`, mode: "sr" }, "live-custom-ready");
  await run({ type: "go", map: `${customMapHash} 0`, mode: "sr" }, "live-custom-go");
  await run({ type: "kick", playerName: `*${probeName}`, reason: "workflow-probe-finished" }, "live-kick");

  const artifact = {
    checkedAt: new Date().toISOString(),
    server,
    refereeName: `*${probeName}`,
    mockClientVersion: readMockClientVersion(join(serverDirectory, "BallanceMMOMockClient.exe"), serverDirectory),
    commands: records.map((record) => ({
      actionType: record.action.type,
      command: record.command,
      status: record.status,
      responseLine: record.responseLine
    })),
    listSummary: lines.find((line) => /client\(s\) online:/.test(line))
  };
  await mkdir(join(root, "test", "artifacts"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Live work workflow passed on ${server} with ${artifact.commands.length} acknowledged commands`);
} finally {
  if (client) await client.stop().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
