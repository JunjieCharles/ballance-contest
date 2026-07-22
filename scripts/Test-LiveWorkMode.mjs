import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandQueue } from "../apps/server/dist/command-queue.js";
import { ManagedMockClient, readMockClientVersion } from "../apps/server/dist/mock-client.js";

if (process.env.BALLANCE_ALLOW_LIVE_COMMANDS !== "1") {
  throw new Error("Set BALLANCE_ALLOW_LIVE_COMMANDS=1 only after both target servers are approved for full workflow commands");
}

const root = resolve(import.meta.dirname, "..");
const serverDirectory = join(root, "server-windows");
const artifactsDirectory = join(root, "test", "artifacts");
const requiredServers = ["1.bmmo.win", "2.bmmo.win"];
const configuredServers = process.env.BALLANCE_LIVE_SERVERS ?? process.env.BALLANCE_LIVE_SERVER;
const servers = [...new Set((configuredServers ? configuredServers.split(",") : requiredServers).map((server) => server.trim()).filter(Boolean))];
const requireDualGate = process.argv.includes("--require-dual");
const customMapHash = process.env.BALLANCE_LIVE_CUSTOM_MAP_HASH ?? "e90b2f535c8bf881e9cb83129fba241d";
const probeName = "ContestConsole";

if (servers.length === 0) throw new Error("At least one live server must be configured");
if (requireDualGate && (servers.length !== requiredServers.length || requiredServers.some((server) => !servers.includes(server)))) {
  throw new Error(`The dual-server gate must cover exactly: ${requiredServers.join(", ")}`);
}

const waitForCondition = (read, timeoutMs, failureMessage) => new Promise((resolveValue, reject) => {
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const value = read();
    if (value !== undefined) {
      clearInterval(timer);
      resolveValue(value);
    } else if (Date.now() >= deadline) {
      clearInterval(timer);
      reject(new Error(failureMessage()));
    }
  }, 50);
});

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const identityFromLine = (line) => {
  const modern = /(?:^|\] )(\d+):\s+\*ContestConsole\s+-?\d+ms/.exec(line)?.[1];
  const legacy = /(?:^|\] )\*ContestConsole \(#(\d+)\)$/.exec(line)?.[1];
  return modern ? { connectionId: modern, style: "modern-id-row", line }
    : legacy ? { connectionId: legacy, style: "legacy-name-row", line }
      : undefined;
};

const listSnapshot = (lines) => {
  const modernSummary = [...lines]
    .reverse()
    .map((line) => /(\d+) client\(s\) online:\s*(\d+) player\(s\),\s*(\d+) spectator\(s\)/.exec(line))
    .find(Boolean);
  if (modernSummary) {
    return {
      style: "modern-summary",
      clientCount: Number(modernSummary[1]),
      playerCount: Number(modernSummary[2]),
      spectatorCount: Number(modernSummary[3]),
      summary: modernSummary[0]
    };
  }
  const legacyHeaderIndex = lines.findLastIndex((line) => /(?:^|\] )(\d+) player\(s\) online:$/.test(line));
  if (legacyHeaderIndex < 0) return undefined;
  const expected = Number(/(?:^|\] )(\d+) player\(s\) online:$/.exec(lines[legacyHeaderIndex])?.[1]);
  const rows = lines.slice(legacyHeaderIndex + 1)
    .map((line) => /(?:^|\] )(.*?) \(#\d+\)(?: \[CHEAT\])?$/.exec(line)?.[1])
    .filter(Boolean)
    .slice(0, expected);
  if (!Number.isInteger(expected) || rows.length < expected) return undefined;
  const playerCount = rows.filter((name) => !name.trim().startsWith("*")).length;
  return {
    style: "legacy-header-rows",
    clientCount: rows.length,
    playerCount,
    spectatorCount: rows.length - playerCount,
    summary: `${rows.length} client(s): ${playerCount} player(s), ${rows.length - playerCount} spectator(s)`
  };
};

const echoShape = (line) => {
  if (!line) return "missing";
  if (/Level_\d+/i.test(line)) return "registered-official-name";
  if (/Level\s+\d+\*/i.test(line)) return "official-name-force-next-restart";
  if (/Level\s+\d+/i.test(line)) return "official-name";
  if (/"Contest Console Probe Map"/i.test(line)) return "registered-custom-name";
  if (/[0-9a-f]+\.\./i.test(line)) return "hash-prefix";
  return "other";
};

const commandEvidence = (records) => records.map((record) => ({
  actionType: record.action.type,
  command: record.command,
  status: record.status,
  ...(record.responseLine === undefined ? {} : { responseLine: record.responseLine })
}));

const probeServer = async (server, serverIndex) => {
  const temporary = await mkdtemp(join(tmpdir(), `ballance-live-work-${server.replaceAll(".", "-")}-`));
  const checkedAt = new Date().toISOString();
  const lines = [];
  const records = [];
  let client;
  let refereeConnectionId;
  let identityEvidence;
  let observedList;
  let failure;
  try {
    client = new ManagedMockClient({
      executable: join(serverDirectory, "BallanceMMOMockClient.exe"),
      workingDirectory: serverDirectory,
      server,
      refereeName: probeName,
      uuid: `10000000-2000-3000-4000-${String(500000000001 + serverIndex).padStart(12, "0")}`,
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
      const observedIdentity = identityFromLine(line);
      if (observedIdentity) {
        refereeConnectionId = observedIdentity.connectionId;
        queue.setRefereeConnectionId(observedIdentity.connectionId);
      }
      queue.observeLine(line);
    });
    client.start();
    await waitForCondition(
      () => lines.find((line) => /Connected to server OK/i.test(line)),
      15_000,
      () => `Connected to server OK was not observed on ${server}:\n${lines.join("\n")}`
    );
    await wait(750);
    const loginRejection = lines.find((line) => /Login denied\.|1002: A player with the same username/i.test(line));
    if (loginRejection) throw new Error(`The probe login was rejected on ${server}: ${loginRejection}`);

    const run = async (action, key) => {
      const record = await queue.enqueue(action, `${server}:${key}`);
      if (record.status !== "acknowledged") {
        throw new Error(`${action.type} ended as ${record.status}: ${record.command}\nRecent live lines:\n${lines.slice(-30).join("\n")}`);
      }
      return record;
    };

    refereeConnectionId = undefined;
    queue.setRefereeConnectionId(undefined);
    const listStartIndex = lines.length;
    await run({ type: "list" }, "live-list");
    observedList = await waitForCondition(
      () => listSnapshot(lines.slice(listStartIndex)),
      5_000,
      () => `Live list response could not be verified on ${server}:\n${lines.slice(listStartIndex).join("\n")}`
    );
    identityEvidence = lines.slice(listStartIndex).map(identityFromLine).find(Boolean);
    if (observedList.playerCount > 0 && process.env.BALLANCE_ALLOW_OCCUPIED_LIVE_SERVER !== "1") {
      throw new Error(`Refusing workflow probe because ${server} has ${observedList.playerCount} player(s) online`);
    }
    if (!identityEvidence) throw new Error(`The explicit live list on ${server} did not identify the local *ContestConsole connection ID`);
    refereeConnectionId = identityEvidence.connectionId;
    queue.setRefereeConnectionId(refereeConnectionId);

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
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (client) await client.stop().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }

  const commands = commandEvidence(records);
  const firstResponse = (type, predicate = () => true) => commands.find((record) => record.actionType === type && predicate(record))?.responseLine;
  const artifact = {
    checkedAt,
    finishedAt: new Date().toISOString(),
    status: failure ? "failed" : "passed",
    server,
    refereeName: `*${probeName}`,
    ...(refereeConnectionId === undefined ? {} : { refereeConnectionId }),
    ...(identityEvidence === undefined ? {} : { identityEvidence }),
    mockClientVersion: readMockClientVersion(join(serverDirectory, "BallanceMMOMockClient.exe"), serverDirectory),
    ...(observedList === undefined ? {} : { list: observedList }),
    echoShapes: {
      list: observedList?.style ?? "missing",
      identity: identityEvidence?.style ?? "missing",
      srReady: echoShape(firstResponse("ready", (record) => !/\shs(?:\s|$)/.test(record.command) && record.command.includes("level 1"))),
      srGo: echoShape(firstResponse("go", (record) => !/\shs(?:\s|$)/.test(record.command) && record.command.includes("level 1"))),
      hsReady: echoShape(firstResponse("ready", (record) => /\shs(?:\s|$)/.test(record.command) && record.command.includes("level 1"))),
      hsGo: echoShape(firstResponse("go", (record) => /\shs(?:\s|$)/.test(record.command) && record.command.includes("level 1"))),
      customReady: echoShape(firstResponse("ready", (record) => record.command.includes(customMapHash))),
      customGo: echoShape(firstResponse("go", (record) => record.command.includes(customMapHash)))
    },
    commands,
    ...(failure === undefined ? {} : { failure, recentLines: lines.slice(-50) })
  };
  const artifactPath = join(artifactsDirectory, `live-work-mode-${server.replace(/[^a-z0-9.-]/gi, "-")}.json`);
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
};

await mkdir(artifactsDirectory, { recursive: true });
const results = [];
for (const [index, server] of servers.entries()) {
  console.log(`Running live work probe ${index + 1}/${servers.length} on ${server}`);
  const result = await probeServer(server, index);
  results.push(result);
  if (result.status !== "passed") break;
  console.log(`Live work workflow passed on ${server} with ${result.commands.length} acknowledged commands`);
}

const shapeKeys = ["list", "identity", "srReady", "srGo", "hsReady", "hsGo", "customReady", "customGo"];
const protocolDifferences = Object.fromEntries(shapeKeys.flatMap((key) => {
  const values = Object.fromEntries(results.map((result) => [result.server, result.echoShapes[key]]));
  return new Set(Object.values(values)).size > 1 ? [[key, values]] : [];
}));
const summary = {
  checkedAt: new Date().toISOString(),
  gate: requireDualGate ? "dual-server-required" : "targeted",
  requiredServers: requireDualGate ? requiredServers : [],
  requestedServers: servers,
  status: results.length === servers.length && results.every((result) => result.status === "passed") ? "passed" : "failed",
  results: results.map((result) => ({
    server: result.server,
    status: result.status,
    commandCount: result.commands.length,
    list: result.list,
    echoShapes: result.echoShapes,
    ...(result.failure === undefined ? {} : { failure: result.failure })
  })),
  protocolDifferences
};
await writeFile(join(artifactsDirectory, "live-work-mode-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (summary.status !== "passed") {
  const failed = results.find((result) => result.status !== "passed");
  throw new Error(`Live work gate failed on ${failed?.server ?? "an untested server"}: ${failed?.failure ?? "not all requested servers ran"}`);
}
console.log(`Live work ${summary.gate} gate passed on ${servers.join(", ")}`);
if (Object.keys(protocolDifferences).length > 0) console.log(`Observed protocol differences: ${JSON.stringify(protocolDifferences)}`);
