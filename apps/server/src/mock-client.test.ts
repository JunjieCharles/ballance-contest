import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildMockClientArguments,
  consumeMockClientLogChunk,
  ManagedMockClient,
  MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES,
  resolveMockClientUuid,
  type ManagedMockClientDependencies,
  type MockClientLaunchOptions,
  type MockClientProcessInspection
} from "./mock-client.js";

let nextFakePid = 20_000;

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;

  public constructor(public readonly stdin: Writable = new PassThrough(), public readonly pid = nextFakePid += 1) { super(); }

  public emitExit(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  public kill(): boolean { return true; }
}

class BlockedWritable extends Writable {
  private writeCallback: ((error?: Error | null) => void) | undefined;

  public override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writeCallback = callback;
  }

  public release(error?: Error): void {
    const callback = this.writeCallback;
    this.writeCallback = undefined;
    callback?.(error);
  }
}

const managedOptions = {
  executable: "MockClient.exe",
  workingDirectory: "C:/mock",
  server: "1.bmmo.win",
  refereeName: "ContestConsole",
  uuid: "uuid",
  logPath: join(tmpdir(), "managed-mock-client-test.log")
};

const createManagedClient = (
  child: FakeChildProcess,
  writeTimeoutMs = 50,
  options = managedOptions,
  dependencies: ManagedMockClientDependencies = {}
): ManagedMockClient => new ManagedMockClient(
  options,
  {
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    writeTimeoutMs,
    ...dependencies
  }
);

const quoteWindowsArgument = (value: string): string => `"${value.replaceAll("\"", "\\\"")}"`;

const ownedInspection = (
  options: MockClientLaunchOptions,
  pid: number,
  overrides: Partial<MockClientProcessInspection> = {}
): MockClientProcessInspection => {
  const executablePath = win32.isAbsolute(options.executable)
    ? win32.normalize(options.executable)
    : win32.resolve(options.workingDirectory, options.executable);
  const commandLine = [executablePath, ...buildMockClientArguments(options)].map(quoteWindowsArgument).join(" ");
  return { pid, executablePath, commandLine, ...overrides };
};

describe("MockClient launch", () => {
  const options = { executable: "MockClient.exe", workingDirectory: "C:/mock", server: "1.bmmo.win", refereeName: "ContestConsole", uuid: "uuid", logPath: "C:/data/logs/mock.log" };
  it("uses an argument array with isolated log and fixed identity", () => {
    expect(buildMockClientArguments(options)).toEqual(["-s", "1.bmmo.win", "-n", "*ContestConsole", "-u", "uuid", "-l", "C:/data/logs/mock.log", "--auto-flush", "--no-sound-files"]);
  });
  it("rejects ports on preset servers", () => {
    expect(() => buildMockClientArguments({ ...options, server: "1.bmmo.win:26676" })).toThrow("must not include a port");
  });
  it("ignores configurable names and always uses the fixed server identity", () => {
    expect(buildMockClientArguments({ ...options, refereeName: "**Referee" })[3]).toBe("*ContestConsole");
  });

  it("observes the asynchronous ChildProcess error after a failed spawn", async () => {
    const child = new FakeChildProcess(new PassThrough(), 0);
    const client = createManagedClient(child);

    expect(() => client.start()).toThrow("valid managed process PID");
    expect(() => child.emit("error", new Error("spawn EACCES"))).not.toThrow();
    expect(client.diagnosticOutputTail).toContain("spawn EACCES");
    expect(client.isRunning).toBe(false);
  });

  it("turns a pre-spawn ChildProcess error with an assigned PID into one controlled unexpected exit", () => {
    const child = new FakeChildProcess();
    const client = createManagedClient(child);
    const exits: Array<{ code: number | null; expected: boolean }> = [];
    client.onExit((info) => exits.push({ code: info.code, expected: info.expected }));
    client.start();

    expect(() => child.emit("error", new Error("spawn EIO"))).not.toThrow();
    expect(client.isRunning).toBe(false);
    expect(exits).toEqual([{ code: null, expected: false }]);

    child.emitExit(1);
    expect(exits).toEqual([{ code: null, expected: false }]);
  });

  it("retains the owned process handle for a non-terminal error after spawn was confirmed", () => {
    const child = new FakeChildProcess();
    const client = createManagedClient(child);
    const exits: Array<{ code: number | null; expected: boolean }> = [];
    client.onExit((info) => exits.push({ code: info.code, expected: info.expected }));
    client.start();
    child.emit("spawn");

    expect(() => child.emit("error", new Error("kill EPERM"))).not.toThrow();
    expect(client.isRunning).toBe(true);
    expect(client.captureProcess()).toMatchObject({ pid: child.pid });
    expect(exits).toEqual([]);

    child.emitExit(1);
    expect(client.isRunning).toBe(false);
    expect(exits).toEqual([{ code: 1, expected: false }]);
  });

  it("reads a persisted UUID from a local file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-client-uuid-"));
    try {
      writeFileSync(join(dir, ".mock-client-uuid"), "3b9d4b57-5d8e-4f09-8f2d-1ce8d3c5f7a1\n");
      expect(resolveMockClientUuid(dir, "fallback-uuid")).toBe("3b9d4b57-5d8e-4f09-8f2d-1ce8d3c5f7a1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the generated UUID when no persisted file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-client-uuid-"));
    try {
      expect(resolveMockClientUuid(dir, "fallback-uuid")).toBe("fallback-uuid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips ANSI control codes from log chunks while preserving full lines", () => {
    const result = consumeMockClientLogChunk("\u001b[31mhello\u001b[0m\nworld\n", "");
    expect(result.lines).toEqual(["hello", "world"]);
    expect(result.pending).toBe("");
  });

  it("retains the line-start byte position when an incomplete line crosses a flushed boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-flush-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const lines: string[] = [];
    const positions: Array<{ streamGeneration: number; startByteOffset: number; endByteOffset: number }> = [];
    try {
      client.start();
      client.onLine((line, position) => {
        lines.push(line);
        positions.push(position);
      });
      appendFileSync(logPath, "old-complete\npartial", "utf8");
      const boundary = client.flushLog();
      expect(lines).toEqual(["old-complete"]);
      appendFileSync(logPath, "-complete\n", "utf8");
      client.flushLog();
      expect(lines).toEqual(["old-complete", "partial-complete"]);
      expect(positions[1]?.startByteOffset).toBeLessThan(boundary.byteOffset);
      expect(positions[1]?.endByteOffset).toBeGreaterThan(boundary.byteOffset);

      appendFileSync(logPath, "fresh-same-second\n", "utf8");
      client.flushLog();
      expect(lines).toEqual(["old-complete", "partial-complete", "fresh-same-second"]);
      expect(positions[2]?.startByteOffset).toBeGreaterThanOrEqual(boundary.byteOffset);
      expect(positions[2]?.streamGeneration).toBe(boundary.streamGeneration);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects truncate-and-regrow beyond the old offset from the continuity tail", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-regrow-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{
      line: string;
      streamGeneration: number;
      startByteOffset: number;
      trustedEvidence: boolean;
    }> = [];
    try {
      client.start();
      client.onLine((line, position) => observed.push({
        line,
        streamGeneration: position.streamGeneration,
        startByteOffset: position.startByteOffset,
        trustedEvidence: position.trustedEvidence
      }));
      appendFileSync(logPath, "old-complete\nold-incomplete-tail", "utf8");
      const oldBoundary = client.flushLog();
      const replacement = `replacement-first\nreplacement-${"x".repeat(oldBoundary.byteOffset + 16)}\n`;
      expect(Buffer.byteLength(replacement, "utf8")).toBeGreaterThan(oldBoundary.byteOffset);

      writeFileSync(logPath, replacement, "utf8");
      const replacementBoundary = client.flushLog();

      expect(replacementBoundary.streamGeneration).toBeGreaterThan(oldBoundary.streamGeneration);
      expect(observed.map((entry) => entry.line)).toEqual([
        "old-complete",
        "replacement-first",
        `replacement-${"x".repeat(oldBoundary.byteOffset + 16)}`
      ]);
      expect(observed[1]).toMatchObject({
        streamGeneration: replacementBoundary.streamGeneration,
        startByteOffset: 0,
        trustedEvidence: false
      });
      expect(observed[2]?.trustedEvidence).toBe(false);

      appendFileSync(logPath, "genuinely-appended\n", "utf8");
      client.flushLog();
      expect(observed.at(-1)).toMatchObject({
        line: "genuinely-appended",
        streamGeneration: replacementBoundary.streamGeneration,
        trustedEvidence: true
      });
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("advances the log stream generation when a missing file is recreated", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-recreate-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{ line: string; streamGeneration: number; trustedEvidence: boolean }> = [];
    try {
      client.start();
      client.onLine((line, position) => observed.push({
        line,
        streamGeneration: position.streamGeneration,
        trustedEvidence: position.trustedEvidence
      }));
      appendFileSync(logPath, "before-delete\n", "utf8");
      const oldBoundary = client.flushLog();

      rmSync(logPath);
      client.flushLog();
      writeFileSync(logPath, "after-recreate\n", "utf8");
      const recreatedBoundary = client.flushLog();

      expect(recreatedBoundary.streamGeneration).toBeGreaterThan(oldBoundary.streamGeneration);
      expect(observed).toEqual([
        { line: "before-delete", streamGeneration: oldBoundary.streamGeneration, trustedEvidence: true },
        { line: "after-recreate", streamGeneration: recreatedBoundary.streamGeneration, trustedEvidence: false }
      ]);

      appendFileSync(logPath, "after-recreate-append\n", "utf8");
      client.flushLog();
      expect(observed.at(-1)).toEqual({
        line: "after-recreate-append",
        streamGeneration: recreatedBoundary.streamGeneration,
        trustedEvidence: true
      });
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("audits an atomically replaced prefix as untrusted and trusts only later appends", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-replace-"));
    const logPath = join(directory, "mock-client.log");
    const replacementPath = join(directory, "replacement.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{ line: string; trustedEvidence: boolean; discontinuityPrefix?: boolean }> = [];
    try {
      client.start();
      client.onLine((line, position) => observed.push({
        line,
        trustedEvidence: position.trustedEvidence,
        ...(position.discontinuityPrefix === undefined
          ? {}
          : { discontinuityPrefix: position.discontinuityPrefix })
      }));
      appendFileSync(logPath, "before-replace\n", "utf8");
      client.flushLog();

      writeFileSync(replacementPath, "old-ready\nold-go\n", "utf8");
      rmSync(logPath);
      renameSync(replacementPath, logPath);
      client.flushLog();
      appendFileSync(logPath, "fresh-after-replace\n", "utf8");
      client.flushLog();

      expect(observed).toEqual([
        { line: "before-replace", trustedEvidence: true },
        { line: "old-ready", trustedEvidence: false, discontinuityPrefix: true },
        { line: "old-go", trustedEvidence: false, discontinuityPrefix: true },
        { line: "fresh-after-replace", trustedEvidence: true }
      ]);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows initial log creation but fails a strict stage-recovery flush when the log is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-late-log-"));
    const logPath = join(directory, "mock-client.log");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{ line: string; trustedEvidence: boolean }> = [];
    try {
      expect(() => client.start()).not.toThrow();
      client.onLine((line, position) => observed.push({ line, trustedEvidence: position.trustedEvidence }));

      writeFileSync(logPath, "Connected to server OK\n", "utf8");
      expect(() => client.flushLog({ requirePresentStable: true })).not.toThrow();
      expect(observed).toEqual([{ line: "Connected to server OK", trustedEvidence: true }]);

      rmSync(logPath);
      expect(() => client.flushLog({ requirePresentStable: true }))
        .toThrow(/STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE.*missing/);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats the first stable prefix after an unstable initial read as audit-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-unstable-initial-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "old-go-from-unstable-prefix\n", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{ line: string; trustedEvidence: boolean }> = [];
    const readStable = vi.spyOn(
      client as unknown as { readStableLogFileSnapshot(): unknown },
      "readStableLogFileSnapshot"
    );
    readStable.mockReturnValueOnce({
      status: "unstable",
      detail: "simulated file mutation during initial read"
    });
    try {
      client.onLine((line, position) => observed.push({
        line,
        trustedEvidence: position.trustedEvidence
      }));
      client.start();
      expect(observed).toEqual([{
        line: "old-go-from-unstable-prefix",
        trustedEvidence: false
      }]);

      appendFileSync(logPath, "fresh-after-stable-boundary\n", "utf8");
      client.flushLog();
      expect(observed.at(-1)).toEqual({
        line: "fresh-after-stable-boundary",
        trustedEvidence: true
      });
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails a strict stage-recovery flush when the present log cannot be read stably", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-unstable-flush-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    try {
      client.start();
      vi.spyOn(
        client as unknown as { readStableLogFileSnapshot(): unknown },
        "readStableLogFileSnapshot"
      ).mockReturnValueOnce({
        status: "unstable",
        detail: "simulated mutation during all stable-read attempts"
      });

      expect(() => client.flushLog({ requirePresentStable: true }))
        .toThrow(/STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE.*not stable after 3 reads/);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves UTF-8 characters and a CRLF terminator split across flushes", () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-utf8-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const child = new FakeChildProcess(new PassThrough());
    const client = createManagedClient(child, 50, { ...managedOptions, workingDirectory: directory, logPath });
    const observed: Array<{ line: string; startByteOffset: number; endByteOffset: number }> = [];
    const encoded = Buffer.from("玩家完成\r\n", "utf8");
    try {
      client.start();
      client.onLine((line, position) => observed.push({
        line,
        startByteOffset: position.startByteOffset,
        endByteOffset: position.endByteOffset
      }));

      appendFileSync(logPath, encoded.subarray(0, 1));
      client.flushLog();
      appendFileSync(logPath, encoded.subarray(1, encoded.length - 1));
      client.flushLog();
      expect(observed).toEqual([]);
      appendFileSync(logPath, encoded.subarray(encoded.length - 1));
      client.flushLog();

      expect(observed).toEqual([{
        line: "玩家完成",
        startByteOffset: 0,
        endByteOffset: encoded.length
      }]);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps list writes, log tailing and stop responsive while draining over 1 MiB from each diagnostic pipe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-pressure-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const stdin = new PassThrough();
    const child = new FakeChildProcess(stdin);
    const diagnosticChunk = Buffer.alloc(32 * 1024, "x");
    const listCommandCount = 40;
    let stdinPending = "";
    let observedListCommands = 0;
    stdin.on("data", (chunk: Buffer) => {
      const commands = `${stdinPending}${chunk.toString("utf8")}`.split("\n");
      stdinPending = commands.pop() ?? "";
      for (const command of commands) {
        if (command === "list") {
          observedListCommands += 1;
          child.stdout.write(diagnosticChunk);
          child.stderr.write(diagnosticChunk);
          appendFileSync(logPath, `list-response-${observedListCommands}\n`, "utf8");
        } else if (command === "stop") {
          setImmediate(() => child.emitExit());
        }
      }
    });
    const client = createManagedClient(child, 250, { ...managedOptions, logPath });
    const lines: string[] = [];
    client.onLine((line) => lines.push(line));

    try {
      client.start();
      for (let index = 0; index < listCommandCount; index += 1) await client.write("list");
      const sentinel = Buffer.from("stderr-tail-sentinel", "utf8");
      await new Promise<void>((resolve, reject) => child.stderr.write(sentinel, (error) => error ? reject(error) : resolve()));
      await expect.poll(() => lines.at(-1), { timeout: 1_000 }).toBe(`list-response-${listCommandCount}`);

      expect(observedListCommands).toBe(listCommandCount);
      expect(listCommandCount * diagnosticChunk.length).toBeGreaterThan(1024 * 1024);
      expect(client.diagnosticOutputBytes).toBe(listCommandCount * diagnosticChunk.length * 2 + sentinel.length);
      expect(Buffer.byteLength(client.diagnosticOutputTail, "utf8")).toBeLessThanOrEqual(MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES);
      expect(client.diagnosticOutputTail.endsWith("stderr-tail-sentinel")).toBe(true);
      await expect(Promise.race([
        client.stop(250),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop exceeded its total budget")), 500))
      ])).resolves.toBeUndefined();
    } finally {
      if (client.isRunning) child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a stdin write even when the stream never invokes its callback", async () => {
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    const client = createManagedClient(child, 25);
    client.start();

    await expect(client.write("list")).rejects.toThrow("stdin write timed out");

    stdin.release();
    child.emitExit();
  });

  it("sends lifecycle reconnect directly and bounds its complete write", async () => {
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    const client = createManagedClient(child, 1_000);
    client.start();

    await expect(client.reconnect(25)).rejects.toThrow("MockClient reconnect timed out");

    stdin.release();
    child.emitExit();
  });

  it("opens exact self-kick observation before writing a healthy soft-reconnect disconnect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-soft-disconnect-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const stdin = new PassThrough();
    const child = new FakeChildProcess(stdin);
    const commands: string[] = [];
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      const lines = `${pending}${chunk.toString("utf8")}`.split("\n");
      pending = lines.pop() ?? "";
      for (const command of lines) {
        commands.push(command);
        if (command === "kick *ContestConsole contest-console-soft-reconnect") {
          appendFileSync(
            logPath,
            "[07-22 12:00:01] The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (contest-console-soft-reconnect).)\n",
            "utf8"
          );
        }
      }
    });
    const client = createManagedClient(child, 1_000, { ...managedOptions, logPath });

    try {
      client.start();
      await expect(client.disconnectForReconnect(1_000)).resolves.toMatch(/1101: Kicked by \*ContestConsole/);
      expect(commands).toEqual(["kick *ContestConsole contest-console-soft-reconnect"]);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts exact self-kick evidence without waiting for a late stdin callback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-soft-disconnect-late-write-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "", "utf8");
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    const client = createManagedClient(child, 1_000, { ...managedOptions, logPath });

    try {
      client.start();
      const disconnecting = client.disconnectForReconnect(1_000);
      appendFileSync(
        logPath,
        "[07-22 12:00:01] The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (contest-console-soft-reconnect).)\n",
        "utf8"
      );
      await expect(disconnecting).resolves.toMatch(/contest-console-soft-reconnect/);
      stdin.release();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      if (client.isRunning) child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds the complete graceful stop while the stop write is blocked", async () => {
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    const client = createManagedClient(child, 1_000);
    client.start();

    await expect(client.stop(25)).rejects.toThrow("graceful stop timed out");

    stdin.release();
    child.emitExit();
  });

  it("uses the byte end of a non-ASCII history file and never replays historical log bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mock-client-unicode-offset-"));
    const logPath = join(directory, "mock-client.log");
    writeFileSync(logPath, "历史记录：第六关\n", "utf8");
    const child = new FakeChildProcess();
    const client = createManagedClient(child, 50, { ...managedOptions, logPath });
    const lines: string[] = [];
    client.onLine((line) => lines.push(line));

    try {
      client.start();
      appendFileSync(logPath, "新连接：第七关\n", "utf8");
      await expect.poll(() => lines, { timeout: 1_000 }).toEqual(["新连接：第七关"]);
    } finally {
      child.emitExit();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("force-stops only the captured owned child after graceful stop times out", async () => {
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    let terminated = false;
    let killCalls = 0;
    const client = createManagedClient(child, 1_000, managedOptions, {
      inspectProcess: async () => terminated ? undefined : ownedInspection(managedOptions, child.pid),
      killProcessTree: async (pid) => {
        expect(pid).toBe(child.pid);
        killCalls += 1;
        terminated = true;
        setImmediate(() => child.emitExit(0));
      },
      processPollIntervalMs: 1
    });
    const exits: boolean[] = [];
    client.onExit((info) => exits.push(info.expected));
    client.start();
    const processRef = client.captureProcess();
    expect(processRef).toMatchObject({ pid: child.pid });

    await expect(client.stop(10)).rejects.toThrow("graceful stop timed out");
    await expect(client.forceStopOwnedProcessTree(processRef!, 100)).resolves.toBeUndefined();

    expect(killCalls).toBe(1);
    expect(client.isRunning).toBe(false);
    expect(exits).toEqual([true]);
    stdin.release();
  });

  it("treats the same captured child exiting during the first ownership inspection as stopped", async () => {
    const child = new FakeChildProcess();
    let killCalls = 0;
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => {
        child.emitExit(0);
        return undefined;
      },
      killProcessTree: async () => { killCalls += 1; }
    });
    client.start();
    const processRef = client.captureProcess()!;

    await expect(client.forceStopOwnedProcessTree(processRef, 100)).resolves.toBeUndefined();
    expect(killCalls).toBe(0);
    expect(client.isRunning).toBe(false);
  });

  it("treats the same captured child exiting during the ownership recheck as stopped", async () => {
    const child = new FakeChildProcess();
    let inspections = 0;
    let killCalls = 0;
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => {
        inspections += 1;
        if (inspections === 1) return ownedInspection(managedOptions, child.pid);
        child.emitExit(0);
        return undefined;
      },
      killProcessTree: async () => { killCalls += 1; }
    });
    client.start();
    const processRef = client.captureProcess()!;

    await expect(client.forceStopOwnedProcessTree(processRef, 100)).resolves.toBeUndefined();
    expect(killCalls).toBe(0);
    expect(client.isRunning).toBe(false);
  });

  it("refuses ownership mismatches without invoking the process-tree killer", async () => {
    const child = new FakeChildProcess();
    let killCalls = 0;
    const exits: boolean[] = [];
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => ownedInspection(managedOptions, child.pid, { executablePath: "C:\\Other\\MockClient.exe" }),
      killProcessTree: async () => { killCalls += 1; }
    });
    client.onExit((info) => exits.push(info.expected));
    client.start();

    try {
      await expect(client.forceStopOwnedProcessTree(client.captureProcess()!, 100)).rejects.toThrow("different executable");
      expect(killCalls).toBe(0);
      expect(client.isRunning).toBe(true);
    } finally {
      child.emitExit();
    }
    expect(exits).toEqual([false]);
  });

  it("refuses a changed server argument without invoking the process-tree killer", async () => {
    const child = new FakeChildProcess();
    let killCalls = 0;
    const otherServer = { ...managedOptions, server: "2.bmmo.win" };
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => ownedInspection(otherServer, child.pid),
      killProcessTree: async () => { killCalls += 1; }
    });
    client.start();

    try {
      await expect(client.forceStopOwnedProcessTree(client.captureProcess()!, 100)).rejects.toThrow("different -s argument");
      expect(killCalls).toBe(0);
    } finally {
      child.emitExit();
    }
  });

  it("refuses a PID mismatch without invoking the process-tree killer", async () => {
    const child = new FakeChildProcess();
    let killCalls = 0;
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => ownedInspection(managedOptions, child.pid + 1),
      killProcessTree: async () => { killCalls += 1; }
    });
    client.start();

    try {
      await expect(client.forceStopOwnedProcessTree(client.captureProcess()!, 100)).rejects.toThrow("different PID");
      expect(killCalls).toBe(0);
    } finally {
      child.emitExit();
    }
  });

  it("refuses a stale process reference even if Windows has reused the PID for a new child", async () => {
    const reusedPid = nextFakePid += 1;
    const first = new FakeChildProcess(new PassThrough(), reusedPid);
    const second = new FakeChildProcess(new PassThrough(), reusedPid);
    const children = [first, second];
    let killCalls = 0;
    const client = new ManagedMockClient(managedOptions, {
      spawn: () => children.shift() as unknown as ChildProcessWithoutNullStreams,
      inspectProcess: async () => ownedInspection(managedOptions, reusedPid),
      killProcessTree: async () => { killCalls += 1; }
    });
    client.start();
    const staleRef = client.captureProcess()!;
    first.emitExit();
    client.start();

    try {
      expect(client.processGeneration).not.toBe(staleRef.generation);
      await expect(client.forceStopOwnedProcessTree(staleRef, 100)).rejects.toThrow("no longer current");
      expect(killCalls).toBe(0);
    } finally {
      second.emitExit();
    }
  });

  it("bounds termination verification and ignores a late child exit", async () => {
    const child = new FakeChildProcess();
    const client = createManagedClient(child, 50, managedOptions, {
      inspectProcess: async () => ownedInspection(managedOptions, child.pid),
      killProcessTree: async () => undefined,
      processPollIntervalMs: 1
    });
    const exits: boolean[] = [];
    client.onExit((info) => exits.push(info.expected));
    client.start();
    const processRef = client.captureProcess()!;
    const startedAt = Date.now();

    await expect(client.forceStopOwnedProcessTree(processRef, 25)).rejects.toThrow(/timeout|did not exit/);
    expect(Date.now() - startedAt).toBeLessThan(500);
    child.emitExit(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual([true]);
  });
});
