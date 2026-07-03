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
const probeName = "ContestConsole";
const lines = [];
const records = [];
let client;
let refereeConnectionId;

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
    const modernIdentity = /(?:^|\] )(\d+):\s+\*ContestConsole\s+-?\d+ms/.exec(line)?.[1];
    const legacyIdentity = /(?:^|\] )\*ContestConsole \(#(\d+)\)$/.exec(line)?.[1];
    const observedIdentity = modernIdentity ?? legacyIdentity;
    if (observedIdentity) {
      refereeConnectionId = observedIdentity;
      queue.setRefereeConnectionId(observedIdentity);
    }
    queue.observeLine(line);
  });
  client.start();
  await waitForLine((line) => /Connected to server OK/i.test(line), 15_000);

  const run = async (action, key) => {
    const record = await queue.enqueue(action, key);
    if (record.status !== "acknowledged") throw new Error(`${action.type} ended as ${record.status}: ${record.command}\nRecent live lines:\n${lines.slice(-30).join("\n")}`);
    return record;
  };

  const listStartIndex = lines.length;
  const list = await run({ type: "list" }, "live-list");
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  const listLines = lines.slice(listStartIndex);
  const modernSummary = listLines.map((line) => /client\(s\) online:\s*(\d+) player\(s\),\s*(\d+) spectator\(s\)/.exec(line)).find(Boolean);
  const legacyHeaderIndex = listLines.findIndex((line) => /(?:^|\] )(\d+) player\(s\) online:$/.test(line));
  const legacyExpected = legacyHeaderIndex >= 0
    ? Number(/(?:^|\] )(\d+) player\(s\) online:$/.exec(listLines[legacyHeaderIndex])?.[1])
    : undefined;
  const legacyRows = legacyHeaderIndex >= 0
    ? listLines.slice(legacyHeaderIndex + 1).map((line) => /(?:^|\] )(.*?) \(#\d+\)(?: \[CHEAT\])?$/.exec(line)?.[1]).filter(Boolean)
    : [];
  if (!modernSummary && (legacyExpected === undefined || legacyRows.length < legacyExpected)) {
    throw new Error(`Live list response could not be verified: ${listLines.join("\n") || list.responseLine || "missing"}`);
  }
  const playerCount = modernSummary ? Number(modernSummary[1]) : legacyRows.filter((name) => !name.trim().startsWith("*")).length;
  const spectatorCount = modernSummary ? Number(modernSummary[2]) : legacyRows.length - playerCount;
  if (playerCount > 0 && process.env.BALLANCE_ALLOW_OCCUPIED_LIVE_SERVER !== "1") {
    throw new Error(`Refusing workflow probe because ${server} has ${playerCount} player(s) online`);
  }
  if (!refereeConnectionId) throw new Error("The live list did not identify the local *ContestConsole connection ID");
  await run({ type: "notification", channel: "bulletin", text: `${probeName} workflow probe` }, "live-bulletin");
  await run({ type: "notification", channel: "notice", text: `${probeName} notice probe` }, "live-notice");
  await run({ type: "notification", channel: "announce", text: `${probeName} announce probe` }, "live-announce");
  for (let index = 0; index < 3; index += 1) {
    await run({ type: "ready", map: "level 1", mode: "sr" }, `live-ready-${index + 1}`);
  }
  await run({ type: "cheat-off" }, "live-cheat-off");
  await run({ type: "go", map: "level 1", mode: "sr" }, "live-go");
  await run({ type: "ready", map: "level 1", mode: "hs" }, "live-hs-ready");
  await run({ type: "go", map: "level 1", mode: "hs" }, "live-hs-go");
  await run({ type: "set-map", mapHash: customMapHash, displayName: "Contest Console Probe Map" }, "live-custom-set-map");
  await run({ type: "ready", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "sr" }, "live-custom-ready");
  await run({ type: "go", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "sr" }, "live-custom-go");
  await run({ type: "ready", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "hs" }, "live-custom-hs-ready");
  await run({ type: "go", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "hs" }, "live-custom-hs-go");
  await run({ type: "kick", playerName: `*${probeName}`, reason: "workflow-probe-finished" }, "live-kick");

  const artifact = {
    checkedAt: new Date().toISOString(),
    server,
    refereeName: `*${probeName}`,
    refereeConnectionId,
    mockClientVersion: readMockClientVersion(join(serverDirectory, "BallanceMMOMockClient.exe"), serverDirectory),
    commands: records.map((record) => ({
      actionType: record.action.type,
      command: record.command,
      status: record.status,
      responseLine: record.responseLine
    })),
    listSummary: modernSummary ? modernSummary[0] : `${legacyRows.length} client(s): ${playerCount} player(s), ${spectatorCount} spectator(s)`
  };
  await mkdir(join(root, "test", "artifacts"), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Live work workflow passed on ${server} with ${artifact.commands.length} acknowledged commands`);
} finally {
  if (client) await client.stop().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
