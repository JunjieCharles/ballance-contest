import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { CommandQueue } from "../apps/server/dist/command-queue.js";
import { ManagedMockClient, readMockClientVersion } from "../apps/server/dist/mock-client.js";
import { DEFAULT_RECOVERY_COOLDOWN_MS } from "../apps/server/dist/work-runtime-manager.js";

const runSelfTest = process.argv.includes("--self-test");

if (!runSelfTest && process.env.BALLANCE_ALLOW_LIVE_COMMANDS !== "1") {
  throw new Error("Set BALLANCE_ALLOW_LIVE_COMMANDS=1 only after both target servers are approved for full workflow commands");
}

const root = resolve(import.meta.dirname, "..");
const serverDirectory = join(root, "server-windows");
const artifactsDirectory = join(root, "test", "artifacts");
const requiredServers = ["1.bmmo.win", "2.bmmo.win"];
const configuredServers = process.env.BALLANCE_LIVE_SERVERS ?? process.env.BALLANCE_LIVE_SERVER;
const selectedServers = [...new Set((configuredServers ? configuredServers.split(",") : requiredServers).map((server) => server.trim()).filter(Boolean))];
const requireDualGate = process.argv.includes("--require-dual");
const servers = requireDualGate ? requiredServers : selectedServers;
const runRecoveryGate = requireDualGate && process.env.BALLANCE_ALLOW_LIVE_RECOVERY === "1";
// The documentation's e90b... example is official Level 02, whose existing
// server name can take precedence. Use a dedicated synthetic protocol map.
const customMapHash = process.env.BALLANCE_LIVE_CUSTOM_MAP_HASH
  ?? createHash("md5").update("ContestConsole independent protocol probe map v1").digest("hex");
const probeName = "ContestConsole";
const loginRejectionObservationMs = 1_000;
const recoveryReleaseLimitMs = 60_000;
const recoveryRetryIntervalMs = 5_000;
const gracefulStopTimeoutMs = 5_000;
const forcedStopTimeoutMs = 10_000;

const recoveryCooldownIsSufficient = (maxReleaseMs) => maxReleaseMs <= DEFAULT_RECOVERY_COOLDOWN_MS;
const monotonicNow = () => performance.now();

if (selectedServers.length === 0) throw new Error("At least one live server must be configured");
if (requireDualGate && (selectedServers.length !== requiredServers.length || requiredServers.some((server) => !selectedServers.includes(server)))) {
  throw new Error(`The dual-server gate must cover exactly: ${requiredServers.join(", ")}`);
}
if (!runSelfTest && requireDualGate && !runRecoveryGate) {
  throw new Error("Set BALLANCE_ALLOW_LIVE_RECOVERY=1 only after both target servers are approved for recovery probes");
}

const waitForCondition = (read, timeoutMs, failureMessage) => new Promise((resolveValue, reject) => {
  const deadline = monotonicNow() + timeoutMs;
  const timer = setInterval(() => {
    const value = read();
    if (value !== undefined) {
      clearInterval(timer);
      resolveValue(value);
    } else if (monotonicNow() >= deadline) {
      clearInterval(timer);
      reject(new Error(failureMessage()));
    }
  }, 50);
});

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

const waitWithinDeadline = async (deadline, milliseconds, failureMessage) => {
  const remaining = deadline - monotonicNow();
  if (remaining <= 0) throw new Error(failureMessage);
  await wait(Math.min(milliseconds, remaining));
  if (monotonicNow() > deadline) throw new Error(failureMessage);
};

const boundedTimeout = (deadline, preferredMs, failureMessage) => {
  const remaining = deadline === undefined ? preferredMs : Math.min(preferredMs, deadline - monotonicNow());
  if (remaining <= 0) throw new Error(failureMessage);
  return remaining;
};

const settleWithin = async (operation, timeoutMs, failureMessage) => await new Promise((resolveValue, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    if (error) reject(error);
    else resolveValue(value);
  };
  const timer = setTimeout(() => finish(new Error(failureMessage)), Math.max(0, timeoutMs));
  void operation.then((value) => finish(undefined, value), (error) => finish(error));
});

const authRejectionFromLine = (line) => /Login denied\.|(?:1002|2000):/i.test(line);

class AuthenticationRejectedError extends Error {
  constructor(server, line, evidence) {
    super(`Authentication was rejected on ${server}: ${line}`);
    this.name = "AuthenticationRejectedError";
    this.rejectionLine = line;
    this.evidence = evidence;
  }
}

class OccupiedServerError extends Error {
  constructor(server, playerCount) {
    super(`Refusing workflow probe because ${server} has ${playerCount} player(s) online`);
    this.name = "OccupiedServerError";
  }
}

const identityFromLine = (line) => {
  const modern = /(?:^|\] )(\d+):\s+\*ContestConsole\s+-?\d+ms/.exec(line)?.[1];
  const legacy = /(?:^|\] )\*ContestConsole \(#(\d+)\)$/.exec(line)?.[1];
  return modern ? { connectionId: modern, style: "modern-id-row", line }
    : legacy ? { connectionId: legacy, style: "legacy-name-row", line }
      : undefined;
};

const modernClientFromLine = (line) => {
  const match = /(?:^|\] )(\d+):\s+(.*?)\s+-?\d+ms\s*$/.exec(line);
  return match ? { connectionId: match[1], name: match[2].trim(), line } : undefined;
};

const legacyClientFromLine = (line) => {
  const match = /(?:^|\] )(.*?) \(#(\d+)\)(?: \[CHEAT\])?$/.exec(line);
  return match ? { connectionId: match[2], name: match[1].trim(), line } : undefined;
};

const modernSummaryFromLine = (line) => {
  const match = /(?:^|\] )(\d+) client\(s\) online:\s*(\d+) player\(s\),\s*(\d+) spectator\(s\)\.?\s*$/.exec(line);
  return match ? {
    clientCount: Number(match[1]),
    playerCount: Number(match[2]),
    spectatorCount: Number(match[3]),
    summary: match[0]
  } : undefined;
};

const legacyHeaderFromLine = (line) => {
  const match = /(?:^|\] )(\d+) player\(s\) online:\s*$/.exec(line);
  return match ? { clientCount: Number(match[1]), summary: match[0] } : undefined;
};

const hasUniqueConnectionIds = (clients) => new Set(clients.map((client) => client.connectionId)).size === clients.length;

const listSnapshot = (lines) => {
  const modernSummaries = lines.flatMap((line, index) => {
    const summary = modernSummaryFromLine(line);
    return summary ? [{ index, summary }] : [];
  });
  const legacyHeaders = lines.flatMap((line, index) => {
    const header = legacyHeaderFromLine(line);
    return header ? [{ index, header }] : [];
  });
  if (modernSummaries.length > 0) {
    if (modernSummaries.length !== 1 || legacyHeaders.length > 0) return undefined;
    const [{ index: modernSummaryIndex, summary: modernSummary }] = modernSummaries;
    const clients = lines.slice(0, modernSummaryIndex).map(modernClientFromLine).filter(Boolean);
    const trailingRows = lines.slice(modernSummaryIndex + 1).map(modernClientFromLine).filter(Boolean);
    const rowPlayerCount = clients.filter((client) => !client.name.startsWith("*")).length;
    const rowSpectatorCount = clients.length - rowPlayerCount;
    if (
      !Number.isInteger(modernSummary.clientCount)
      || !Number.isInteger(modernSummary.playerCount)
      || !Number.isInteger(modernSummary.spectatorCount)
      || modernSummary.clientCount !== modernSummary.playerCount + modernSummary.spectatorCount
      || clients.length !== modernSummary.clientCount
      || trailingRows.length > 0
      || rowPlayerCount !== modernSummary.playerCount
      || rowSpectatorCount !== modernSummary.spectatorCount
      || !hasUniqueConnectionIds(clients)
    ) return undefined;
    return {
      style: "modern-summary",
      clientCount: modernSummary.clientCount,
      playerCount: modernSummary.playerCount,
      spectatorCount: modernSummary.spectatorCount,
      summary: modernSummary.summary,
      clients
    };
  }
  if (legacyHeaders.length !== 1) return undefined;
  const [{ index: legacyHeaderIndex, header: legacyHeader }] = legacyHeaders;
  const expected = legacyHeader.clientCount;
  const rows = lines.slice(legacyHeaderIndex + 1)
    .map(legacyClientFromLine)
    .filter(Boolean);
  if (!Number.isInteger(expected) || rows.length !== expected || !hasUniqueConnectionIds(rows)) return undefined;
  const playerCount = rows.filter((client) => !client.name.startsWith("*")).length;
  return {
    style: "legacy-header-rows",
    clientCount: rows.length,
    playerCount,
    spectatorCount: rows.length - playerCount,
    summary: `${rows.length} client(s): ${playerCount} player(s), ${rows.length - playerCount} spectator(s)`,
    clients: rows
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

const verifyLocalHelpers = () => {
  const modernIdentity = identityFromLine("[12:00:00] 321: *ContestConsole    42ms");
  const modernList = listSnapshot([
    "[12:00:00] 321: *ContestConsole    42ms",
    "[12:00:00] 1 client(s) online: 0 player(s), 1 spectator(s)."
  ]);
  const legacyIdentity = identityFromLine("[12:00:00] *ContestConsole (#654)");
  const legacyList = listSnapshot([
    "1 player(s) online:",
    "*ContestConsole (#654)"
  ]);
  const duplicateIdentityList = listSnapshot([
    "[12:00:00] 321: *ContestConsole    42ms",
    "[12:00:00] 654: *ContestConsole    45ms",
    "[12:00:00] 2 client(s) online: 0 player(s), 2 spectator(s)"
  ]);
  const missingExactIdentityList = listSnapshot([
    "[12:00:00] 321: ContestConsole    42ms",
    "[12:00:00] 1 client(s) online: 1 player(s), 0 spectator(s)"
  ]);
  const occupiedModernList = listSnapshot([
    "[12:00:00] 321: *ContestConsole    42ms",
    "[12:00:00] 987: RacingPlayer    58ms",
    "[12:00:00] 2 client(s) online: 1 player(s), 1 spectator(s)"
  ]);
  const checks = [
    [modernIdentity?.connectionId === "321", "modern explicit-list identity"],
    [modernList?.playerCount === 0 && modernList?.spectatorCount === 1, "modern explicit-list closure"],
    [legacyIdentity?.connectionId === "654", "legacy explicit-list identity"],
    [legacyList?.playerCount === 0 && legacyList?.spectatorCount === 1, "legacy explicit-list closure"],
    [duplicateIdentityList?.clients.filter((client) => client.name === "*ContestConsole").length === 2, "duplicate exact identities remain detectable"],
    [missingExactIdentityList?.clients.filter((client) => client.name === "*ContestConsole").length === 0, "non-exact identity is rejected"],
    [listSnapshot([
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 2 client(s) online: 1 player(s), 1 spectator(s)"
    ]) === undefined, "modern list waits for every announced row"],
    [listSnapshot([
      "[12:00:00] 987: RacingPlayer    58ms",
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 1 client(s) online: 0 player(s), 1 spectator(s)"
    ]) === undefined, "modern list rejects extra rows instead of truncating them"],
    [listSnapshot([
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 1 client(s) online: 1 player(s), 0 spectator(s)"
    ]) === undefined, "modern list rejects row and player/spectator summary contradictions"],
    [listSnapshot([
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 1 client(s) online: 1 player(s), 1 spectator(s)"
    ]) === undefined, "modern list rejects inconsistent client summary totals"],
    [listSnapshot([
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 1 client(s) online: 0 player(s), 1 spectator(s)",
      "[12:00:01] 654: *ContestConsole    45ms",
      "[12:00:01] 1 client(s) online: 0 player(s), 1 spectator(s)"
    ]) === undefined, "modern list rejects overlapping complete batches"],
    [listSnapshot([
      "[12:00:00] 321: *ContestConsole    42ms",
      "[12:00:00] 321: RacingPlayer    58ms",
      "[12:00:00] 2 client(s) online: 1 player(s), 1 spectator(s)"
    ]) === undefined, "modern list rejects duplicate connection IDs"],
    [occupiedModernList?.playerCount === 1
      && occupiedModernList?.spectatorCount === 1
      && occupiedModernList.clients.some((client) => client.name === "RacingPlayer"), "modern list exposes ordinary players to occupied-server protection"],
    [listSnapshot([
      "1 player(s) online:",
      "*ContestConsole (#654)",
      "RacingPlayer (#987)"
    ]) === undefined, "legacy list rejects extra rows instead of truncating them"],
    [authRejectionFromLine("Connected to server OK") === false, "Connected is not an authentication-rejection line"],
    [authRejectionFromLine("Login denied.  (1002: A player with the same username exists.)") === true, "1002 authentication rejection"],
    [authRejectionFromLine("Login denied.  (2000: Another authentication failure.)") === true, "2000 authentication rejection"],
    [DEFAULT_RECOVERY_COOLDOWN_MS === 20_000, "configured recovery cooldown"],
    [recoveryCooldownIsSufficient(19_999), "release inside configured recovery cooldown"],
    [recoveryCooldownIsSufficient(20_001) === false, "release beyond configured recovery cooldown"]
  ];
  const failed = checks.find(([passed]) => !passed);
  if (failed) throw new Error(`Live recovery helper self-test failed: ${failed[1]}`);
  console.log(`Live recovery helper self-test passed (${checks.length} checks)`);
};

const probeServer = async (server, serverIndex) => {
  const temporary = await mkdtemp(join(tmpdir(), `ballance-live-work-${server.replaceAll(".", "-")}-`));
  const checkedAt = new Date().toISOString();
  const records = [];
  const recoveryRecords = [];
  const sessions = new Set();
  const allObservedLines = [];
  let primarySession;
  let activeSession;
  let refereeConnectionId;
  let identityEvidence;
  let observedList;
  let recovery;
  let failure;

  const upsertRecord = (target, record) => {
    const existing = target.findIndex((candidate) => candidate.id === record.id);
    const copy = { ...record };
    if (existing >= 0) target[existing] = copy;
    else target.push(copy);
  };

  const createSession = (label, uuid, logName, recordTargets = [records]) => {
    const lines = [];
    const client = new ManagedMockClient({
      executable: join(serverDirectory, "BallanceMMOMockClient.exe"),
      workingDirectory: serverDirectory,
      server,
      refereeName: probeName,
      uuid,
      logPath: join(temporary, logName)
    });
    const queue = new CommandQueue(client, (action) => action.type === "go" ? 15_000 : 10_000, (record) => {
      for (const target of recordTargets) upsertRecord(target, record);
    });
    const session = { label, client, queue, lines };
    client.onLine((line) => {
      lines.push(line);
      allObservedLines.push(`[${label}] ${line}`);
      queue.observeLine(line);
    });
    sessions.add(session);
    return session;
  };

  const run = async (session, action, key, deadline) => {
    const recordPromise = session.queue.enqueue(action, `${server}:${key}`);
    const record = deadline === undefined
      ? await recordPromise
      : await settleWithin(
        recordPromise,
        boundedTimeout(deadline, action.type === "go" ? 15_000 : 10_000, `${action.type} exceeded the recovery deadline on ${server}`),
        `${action.type} exceeded the recovery deadline on ${server}`
      );
    if (record.status !== "acknowledged") {
      throw new Error(`${action.type} ended as ${record.status}: ${record.command}\nRecent live lines:\n${session.lines.slice(-30).join("\n")}`);
    }
    return record;
  };

  const authenticate = async (session, {
    key,
    connectionWindowStart = 0,
    deadline,
    requireEmpty = false
  }) => {
    const connectionFailure = `Connected to server OK was not observed on ${server}`;
    const connectedLine = await waitForCondition(
      () => session.lines.slice(connectionWindowStart).find((line) => /Connected to server OK/i.test(line)),
      boundedTimeout(deadline, 15_000, connectionFailure),
      () => `${connectionFailure}:\n${session.lines.slice(connectionWindowStart).join("\n")}`
    );
    const connectedIndex = session.lines.indexOf(connectedLine, connectionWindowStart);
    if (deadline === undefined) {
      await wait(loginRejectionObservationMs);
    } else {
      await waitWithinDeadline(
        deadline,
        loginRejectionObservationMs,
        `Login rejection observation exceeded the recovery deadline on ${server}`
      );
    }
    const rejectionLine = session.lines.slice(connectionWindowStart).find(authRejectionFromLine);
    const connectionEvidence = session.lines.slice(connectionWindowStart).filter((line) =>
      /Connected to server OK|Login denied\.|(?:1002|2000):/i.test(line)
    );
    if (rejectionLine) throw new AuthenticationRejectedError(server, rejectionLine, connectionEvidence);

    session.queue.setRefereeConnectionId(undefined);
    const listStartIndex = session.lines.length;
    await run(session, { type: "list" }, key, deadline);
    const listFailure = `Live list response could not be verified on ${server}`;
    const list = await waitForCondition(
      () => listSnapshot(session.lines.slice(listStartIndex)),
      boundedTimeout(deadline, 5_000, listFailure),
      () => `${listFailure}:\n${session.lines.slice(listStartIndex).join("\n")}`
    );
    const refereeClients = list.clients.filter((client) => client.name === "*ContestConsole");
    if (refereeClients.length !== 1) {
      throw new Error(`The explicit live list on ${server} identified ${refereeClients.length} local *ContestConsole connection IDs; exactly one is required`);
    }
    const refereeClient = refereeClients[0];
    const identity = {
      connectionId: refereeClient.connectionId,
      style: list.style === "modern-summary" ? "modern-id-row" : "legacy-name-row",
      line: refereeClient.line
    };
    if (list.playerCount > 0 && (requireEmpty || process.env.BALLANCE_ALLOW_OCCUPIED_LIVE_SERVER !== "1")) {
      throw new OccupiedServerError(server, list.playerCount);
    }
    session.queue.setRefereeConnectionId(identity.connectionId);
    return {
      connectedLine,
      connectedIndex,
      connectionEvidence,
      rejectionObservationMs: loginRejectionObservationMs,
      list,
      identity,
      listEvidence: session.lines.slice(listStartIndex).filter((line) => identityFromLine(line) || /player\(s\) online:|client\(s\) online:/i.test(line))
    };
  };

  const stopSessionSafely = async (session, label) => {
    if (!session.client.isRunning) return { method: "already-exited" };
    const processRef = session.client.captureProcess();
    try {
      await session.client.stop(gracefulStopTimeoutMs);
      return { method: "graceful-stop" };
    } catch (error) {
      const gracefulFailure = error instanceof Error ? error.message : String(error);
      if (!session.client.isRunning) return { method: "exited-after-graceful-timeout", gracefulFailure };
      if (!processRef || !session.client.isCurrentProcess(processRef)) {
        throw new Error(`${label} could not be force-stopped because its managed process identity changed`);
      }
      await session.client.forceStopOwnedProcessTree(processRef, forcedStopTimeoutMs);
      return { method: "verified-force-stop", gracefulFailure, processRef };
    }
  };

  const runRecovery = async (session, beforeIdentity) => {
    const recoveryStartedAt = new Date().toISOString();
    const softReconnectStarted = monotonicNow();
    session.queue.advanceGeneration(session.client);
    const controlledDisconnectEvidence = await session.client.disconnectForReconnect(5_000);
    const softWindowStart = session.lines.length;
    await session.client.reconnect(5_000);
    const softAuth = await authenticate(session, {
      key: "recovery-soft-list",
      connectionWindowStart: softWindowStart,
      requireEmpty: true
    });
    const softReconnectDurationMs = Math.ceil(monotonicNow() - softReconnectStarted);
    if (softAuth.identity.connectionId === beforeIdentity.connectionId) {
      throw new Error(`Soft reconnect on ${server} reused stale connection ID ${beforeIdentity.connectionId}`);
    }

    const duplicateSession = createSession(
      "duplicate-name-check",
      `20000000-2000-3000-4000-${String(600000000001 + serverIndex).padStart(12, "0")}`,
      "duplicate-name.log",
      [recoveryRecords]
    );
    const duplicateWindowStart = duplicateSession.lines.length;
    let duplicateConnectedLine;
    let duplicateRejectionLine;
    let duplicateCleanup;
    try {
      duplicateSession.client.start();
      duplicateConnectedLine = await waitForCondition(
        () => duplicateSession.lines.slice(duplicateWindowStart).find((line) => /Connected to server OK/i.test(line)),
        15_000,
        () => `The duplicate-name probe never reached the transport-connected state on ${server}:\n${duplicateSession.lines.join("\n")}`
      );
      duplicateRejectionLine = await waitForCondition(
        () => duplicateSession.lines.slice(duplicateWindowStart).find((line) => /Login denied\.|1002:\s*A player with the same username/i.test(line)),
        5_000,
        () => `The duplicate-name probe saw Connected but no Login denied/1002 on ${server}; Connected is not accepted as authentication:\n${duplicateSession.lines.join("\n")}`
      );
      if (duplicateSession.lines.indexOf(duplicateRejectionLine, duplicateWindowStart) <= duplicateSession.lines.indexOf(duplicateConnectedLine, duplicateWindowStart)) {
        throw new Error(`Duplicate-name rejection evidence did not follow Connected on ${server}`);
      }
    } finally {
      duplicateCleanup = await stopSessionSafely(duplicateSession, "Duplicate-name MockClient");
    }

    const managedProcess = session.client.captureProcess();
    if (!managedProcess || !session.client.isCurrentProcess(managedProcess)) {
      throw new Error(`The primary MockClient on ${server} has no current managed process to verify before forced termination`);
    }
    const forceStopStarted = monotonicNow();
    await session.client.forceStopOwnedProcessTree(managedProcess, forcedStopTimeoutMs);
    const forceStopCompleted = monotonicNow();
    const releaseMeasuredFrom = new Date().toISOString();
    const releaseDeadline = forceStopCompleted + recoveryReleaseLimitMs;
    const releaseAttempts = [];
    let replacementSession;
    let replacementAuth;

    while (monotonicNow() < releaseDeadline && !replacementSession) {
      const attemptNumber = releaseAttempts.length + 1;
      const attempt = createSession(
        `release-attempt-${attemptNumber}`,
        `10000000-2000-3000-4000-${String(500000000001 + serverIndex).padStart(12, "0")}`,
        `release-attempt-${attemptNumber}.log`,
        [records, recoveryRecords]
      );
      const attemptStartedAt = monotonicNow();
      const attemptEvidence = { attempt: attemptNumber, startedAfterForceMs: Math.max(0, Math.round(attemptStartedAt - forceStopCompleted)) };
      try {
        attempt.client.start();
        const auth = await authenticate(attempt, {
          key: `recovery-release-list-${attemptNumber}`,
          connectionWindowStart: 0,
          deadline: releaseDeadline,
          requireEmpty: true
        });
        if (auth.identity.connectionId === softAuth.identity.connectionId) {
          throw new Error(`The replacement MockClient on ${server} reused stale connection ID ${softAuth.identity.connectionId}`);
        }
        attemptEvidence.status = "authenticated";
        attemptEvidence.connectionId = auth.identity.connectionId;
        attemptEvidence.evidence = [...auth.connectionEvidence, ...auth.listEvidence];
        releaseAttempts.push(attemptEvidence);
        replacementSession = attempt;
        replacementAuth = auth;
      } catch (error) {
        if (error instanceof OccupiedServerError) throw error;
        attemptEvidence.status = error instanceof AuthenticationRejectedError ? "authentication-rejected" : "failed";
        attemptEvidence.failure = error instanceof Error ? error.message : String(error);
        attemptEvidence.evidence = error instanceof AuthenticationRejectedError ? error.evidence : attempt.lines.slice(-12);
        releaseAttempts.push(attemptEvidence);
        attemptEvidence.cleanup = await stopSessionSafely(attempt, `Release attempt ${attemptNumber}`);
        if (monotonicNow() >= releaseDeadline) break;
        await waitWithinDeadline(releaseDeadline, recoveryRetryIntervalMs, `MockClient server identity was not released within ${recoveryReleaseLimitMs}ms on ${server}`);
      }
    }

    if (!replacementSession || !replacementAuth) {
      throw new Error(`MockClient server identity was not released and fully authenticated within ${recoveryReleaseLimitMs}ms on ${server}`);
    }
    const releaseMs = Math.ceil(monotonicNow() - forceStopCompleted);
    const releaseAuthenticatedAt = new Date().toISOString();
    if (releaseMs > recoveryReleaseLimitMs) {
      throw new Error(`MockClient server identity release took ${releaseMs}ms on ${server}, exceeding ${recoveryReleaseLimitMs}ms`);
    }
    return {
      replacementSession,
      evidence: {
        status: "measured",
        startedAt: recoveryStartedAt,
        finishedAt: new Date().toISOString(),
        mockClientVersion: readMockClientVersion(join(serverDirectory, "BallanceMMOMockClient.exe"), serverDirectory),
        softReconnect: {
          durationMs: softReconnectDurationMs,
          beforeConnectionId: beforeIdentity.connectionId,
          afterConnectionId: softAuth.identity.connectionId,
          controlledDisconnectEvidence,
          rejectionObservationMs: softAuth.rejectionObservationMs,
          evidence: [...softAuth.connectionEvidence, ...softAuth.listEvidence]
        },
        duplicateNameRejection: {
          connectedAcceptedAsHealthy: false,
          connectedLine: duplicateConnectedLine,
          rejectionLine: duplicateRejectionLine,
          cleanup: duplicateCleanup
        },
        forcedStop: {
          managedGeneration: managedProcess.generation,
          managedPid: managedProcess.pid,
          durationMs: Math.ceil(forceStopCompleted - forceStopStarted),
          ownershipVerifiedByProductionAdapter: true
        },
        release: {
          measuredFrom: releaseMeasuredFrom,
          authenticatedAt: releaseAuthenticatedAt,
          limitMs: recoveryReleaseLimitMs,
          retryIntervalMs: recoveryRetryIntervalMs,
          releaseMs,
          beforeConnectionId: softAuth.identity.connectionId,
          afterConnectionId: replacementAuth.identity.connectionId,
          evidence: [...replacementAuth.connectionEvidence, ...replacementAuth.listEvidence],
          attempts: releaseAttempts
        },
        commands: commandEvidence(recoveryRecords)
      }
    };
  };

  try {
    primarySession = createSession(
      "primary",
      `10000000-2000-3000-4000-${String(500000000001 + serverIndex).padStart(12, "0")}`,
      "mock-client.log"
    );
    activeSession = primarySession;
    primarySession.client.start();
    const initialAuth = await authenticate(primarySession, { key: "live-list", requireEmpty: runRecoveryGate });
    observedList = initialAuth.list;
    identityEvidence = initialAuth.identity;
    refereeConnectionId = identityEvidence.connectionId;

    await run(activeSession, { type: "notification", channel: "bulletin", text: `${probeName} workflow probe` }, "live-bulletin");
    await run(activeSession, { type: "notification", channel: "notice", text: `${probeName} notice probe` }, "live-notice");
    await run(activeSession, { type: "notification", channel: "announce", text: `${probeName} announce probe` }, "live-announce");
    for (let index = 0; index < 3; index += 1) {
      await run(activeSession, { type: "ready", map: "level 1", mode: "sr" }, `live-ready-${index + 1}`);
    }
    await run(activeSession, { type: "cheat-off" }, "live-cheat-off");
    await run(activeSession, { type: "go", map: "level 1", mode: "sr" }, "live-go");
    await run(activeSession, { type: "ready", map: "level 1", mode: "hs" }, "live-hs-ready");
    await run(activeSession, { type: "go", map: "level 1", mode: "hs" }, "live-hs-go");
    await run(activeSession, { type: "set-map", mapHash: customMapHash, displayName: "Contest Console Probe Map" }, "live-custom-set-map");
    await run(activeSession, { type: "ready", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "sr" }, "live-custom-ready");
    await run(activeSession, { type: "go", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "sr" }, "live-custom-go");
    await run(activeSession, { type: "ready", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "hs" }, "live-custom-hs-ready");
    await run(activeSession, { type: "go", map: `${customMapHash} 0`, mapName: "Contest Console Probe Map", mode: "hs" }, "live-custom-hs-go");

    if (runRecoveryGate) {
      const recoveryResult = await runRecovery(activeSession, identityEvidence);
      recovery = recoveryResult.evidence;
      activeSession = recoveryResult.replacementSession;
      const mapRegistration = await run(
        activeSession,
        { type: "set-map", mapHash: customMapHash, displayName: "Contest Console Probe Map" },
        "recovery-post-auth-set-map"
      );
      recovery.mapRegistration = {
        sentOnlyAfterReplacementAuthentication: true,
        connectionId: recovery.release.afterConnectionId,
        command: commandEvidence([mapRegistration])[0]
      };
      recovery.status = "passed";
    }
    await run(activeSession, { type: "kick", playerName: `*${probeName}`, reason: "workflow-probe-finished" }, "live-kick");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (recovery && recovery.status !== "passed") recovery = { ...recovery, status: "failed", failure };
  } finally {
    for (const session of [...sessions].reverse()) {
      await stopSessionSafely(session, `Live probe session ${session.label}`).catch((error) => {
        if (!failure) failure = error instanceof Error ? error.message : String(error);
      });
    }
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
    recovery: runRecoveryGate ? recovery ?? { status: "failed", failure: failure ?? "Recovery probe did not complete" } : { status: "not-requested" },
    ...(failure === undefined ? {} : { failure, recentLines: allObservedLines.slice(-50) })
  };
  const artifactPath = join(artifactsDirectory, `live-work-mode-${server.replace(/[^a-z0-9.-]/gi, "-")}.json`);
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
};

if (runSelfTest) {
  verifyLocalHelpers();
} else {
await mkdir(artifactsDirectory, { recursive: true });
const results = [];
for (const [index, server] of servers.entries()) {
  console.log(`Running live work probe ${index + 1}/${servers.length} on ${server}`);
  const result = await probeServer(server, index);
  results.push(result);
  if (result.status !== "passed") break;
  console.log(`Live work workflow passed on ${server} with ${result.commands.length} acknowledged commands`);
  if (result.recovery.status === "passed") {
    console.log(`Live recovery passed on ${server}: ${result.recovery.release.releaseMs}ms release, ${result.recovery.release.beforeConnectionId} -> ${result.recovery.release.afterConnectionId}`);
  }
}

const shapeKeys = ["list", "identity", "srReady", "srGo", "hsReady", "hsGo", "customReady", "customGo"];
const protocolDifferences = Object.fromEntries(shapeKeys.flatMap((key) => {
  const values = Object.fromEntries(results.map((result) => [result.server, result.echoShapes[key]]));
  return new Set(Object.values(values)).size > 1 ? [[key, values]] : [];
}));
const completeRecoveryResults = runRecoveryGate
  ? results.filter((result) => result.recovery.status === "passed")
  : [];
const maxReleaseMs = completeRecoveryResults.length === servers.length
  ? Math.max(...completeRecoveryResults.map((result) => result.recovery.release.releaseMs))
  : undefined;
const cooldownMs = maxReleaseMs === undefined ? undefined : DEFAULT_RECOVERY_COOLDOWN_MS;
const cooldownSufficient = maxReleaseMs === undefined ? !runRecoveryGate : recoveryCooldownIsSufficient(maxReleaseMs);
const summary = {
  checkedAt: new Date().toISOString(),
  gate: requireDualGate ? "dual-server-required" : "targeted",
  recoveryGate: runRecoveryGate ? "explicitly-authorized" : "not-requested",
  requiredServers: requireDualGate ? requiredServers : [],
  requestedServers: servers,
  status: results.length === servers.length
    && results.every((result) => result.status === "passed")
    && cooldownSufficient ? "passed" : "failed",
  results: results.map((result) => ({
    server: result.server,
    status: result.status,
    commandCount: result.commands.length,
    list: result.list,
    echoShapes: result.echoShapes,
    recovery: result.recovery.status === "passed" ? {
      status: "passed",
      mockClientVersion: result.recovery.mockClientVersion,
      softReconnectMs: result.recovery.softReconnect.durationMs,
      softReconnectConnectionIds: {
        before: result.recovery.softReconnect.beforeConnectionId,
        after: result.recovery.softReconnect.afterConnectionId
      },
      releaseMs: result.recovery.release.releaseMs,
      forcedRestartConnectionIds: {
        before: result.recovery.release.beforeConnectionId,
        after: result.recovery.release.afterConnectionId
      },
      mapRegistration: result.recovery.mapRegistration
    } : result.recovery,
    ...(result.failure === undefined ? {} : { failure: result.failure })
  })),
  ...(maxReleaseMs === undefined ? {} : {
    recoveryCooldown: {
      policy: "fixed",
      releaseMustNotExceedCooldown: true,
      maxReleaseMs,
      cooldownMs,
      marginMs: cooldownMs - maxReleaseMs
    }
  }),
  protocolDifferences
};
await writeFile(join(artifactsDirectory, "live-work-mode-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

if (summary.status !== "passed") {
  if (!cooldownSufficient && maxReleaseMs !== undefined && cooldownMs !== undefined) {
    throw new Error(`Live work recovery gate failed: maximum identity release ${maxReleaseMs}ms exceeds the configured ${cooldownMs}ms cooldown`);
  }
  const failed = results.find((result) => result.status !== "passed");
  throw new Error(`Live work gate failed on ${failed?.server ?? "an untested server"}: ${failed?.failure ?? "not all requested servers ran"}`);
}
console.log(`Live work ${summary.gate} gate passed on ${servers.join(", ")}`);
if (cooldownMs !== undefined) console.log(`Configured recovery cooldown: ${cooldownMs}ms (max measured release ${maxReleaseMs}ms, margin ${cooldownMs - maxReleaseMs}ms)`);
if (Object.keys(protocolDifferences).length > 0) console.log(`Observed protocol differences: ${JSON.stringify(protocolDifferences)}`);
}
