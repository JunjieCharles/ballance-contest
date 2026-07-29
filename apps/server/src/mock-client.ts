import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONTEST_REFEREE_NAME, spectatorLoginName } from "@ballance/contracts";

export const MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
export const MOCK_CLIENT_SOFT_RECONNECT_REASON = "contest-console-soft-reconnect";
const DEFAULT_STDIN_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_POLL_INTERVAL_MS = 50;
const MOCK_CLIENT_LOG_CONTINUITY_TAIL_BYTES = 512;

export interface MockClientLaunchOptions {
  executable: string;
  workingDirectory: string;
  server: string;
  refereeName: string;
  uuid: string;
  logPath: string;
}

const PRESET_SERVERS = new Set(["0.bmmo.win", "1.bmmo.win", "2.bmmo.win"]);

const logFileIdentity = (stats: Stats): string =>
  `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const buildMockClientArguments = (options: MockClientLaunchOptions): readonly string[] => {
  if (PRESET_SERVERS.has(options.server.split(":")[0] ?? "") && options.server.includes(":")) throw new Error("bmmo.win presets must not include a port");
  return ["-s", options.server, "-n", spectatorLoginName(CONTEST_REFEREE_NAME), "-u", options.uuid, "-l", options.logPath, "--auto-flush", "--no-sound-files"];
};

export const resolveMockClientUuid = (workingDirectory: string, fallbackUuid: string): string => {
  const uuidPath = join(workingDirectory, ".mock-client-uuid");
  if (existsSync(uuidPath)) {
    const persisted = readFileSync(uuidPath, "utf8").trim();
    if (persisted) return persisted;
  }
  writeFileSync(uuidPath, `${fallbackUuid}\n`, "utf8");
  return fallbackUuid;
};

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = new RegExp("\\u001b\\[[0-9;?]*[ -/]*[@-~]", "g");

export interface ConsumeMockClientLogChunkResult {
  lines: readonly string[];
  pending: string;
}

const normalizeMockClientLogLine = (line: string): string =>
  line.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "").trimEnd();

export const consumeMockClientLogChunk = (chunk: string, pending: string): ConsumeMockClientLogChunkResult => {
  const combined = `${pending}${chunk}`;
  const segments = combined.split(/\r?\n/);
  const nextPending = segments.pop() ?? "";
  const lines = segments.map(normalizeMockClientLogLine).filter((line) => line.length > 0);
  return { lines, pending: nextPending };
};

export const readMockClientVersion = (executable: string, workingDirectory: string): string => {
  const result = spawnSync(executable, ["-v"], { cwd: workingDirectory, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`MockClient version probe failed: ${result.stderr}`);
  const match = /Version:\s*([^\r\n]+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error("MockClient version output was not recognized");
  return match[1].trim();
};

export interface CommandTransport {
  write(command: string): Promise<void>;
}

export interface MockClientExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface MockClientLogBoundary {
  readonly streamGeneration: number;
  readonly byteOffset: number;
}

export interface MockClientLogLinePosition extends MockClientLogBoundary {
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly trustedEvidence: boolean;
  readonly discontinuityPrefix?: boolean;
}

interface MockClientLogFileSnapshot {
  readonly content: Buffer;
  readonly identity: string;
}

type MockClientLogFileReadResult =
  | { readonly status: "present-stable"; readonly snapshot: MockClientLogFileSnapshot }
  | { readonly status: "missing" }
  | { readonly status: "unstable"; readonly detail?: string };

export interface MockClientLogFlushOptions {
  readonly requirePresentStable?: boolean;
}

export type MockClientSpawner = (options: MockClientLaunchOptions) => ChildProcessWithoutNullStreams;

export interface ManagedMockClientProcessRef {
  readonly generation: number;
  readonly pid: number;
}

export interface MockClientProcessInspection {
  readonly pid: number;
  readonly executablePath: string;
  readonly commandLine: string;
}

export type MockClientProcessInspector = (pid: number, timeoutMs: number) => Promise<MockClientProcessInspection | undefined>;
export type MockClientProcessTreeKiller = (pid: number, timeoutMs: number) => Promise<void>;

export interface ManagedMockClientDependencies {
  spawn?: MockClientSpawner;
  writeTimeoutMs?: number;
  inspectProcess?: MockClientProcessInspector;
  killProcessTree?: MockClientProcessTreeKiller;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  processPollIntervalMs?: number;
}

const spawnMockClient: MockClientSpawner = (options) => spawn(options.executable, buildMockClientArguments(options), {
  cwd: options.workingDirectory,
  shell: false,
  windowsHide: true,
  stdio: "pipe"
});

const runExecFile = async (executable: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> => await new Promise((resolve, reject) => {
  execFile(executable, args, {
    windowsHide: true,
    timeout: Math.max(1, timeoutMs),
    maxBuffer: 256 * 1024,
    encoding: "utf8"
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${executable} failed: ${stderr.trim() || error.message}`));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const inspectWindowsProcess: MockClientProcessInspector = async (pid, timeoutMs) => {
  if (process.platform !== "win32") throw new Error("MockClient process ownership inspection is only available on Windows");
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($null -ne $process) { [Console]::Out.Write(($process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress)) }`;
  const { stdout } = await runExecFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], timeoutMs);
  const serialized = stdout.trim();
  if (!serialized) return undefined;
  const parsed = JSON.parse(serialized) as { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown };
  if (typeof parsed.ProcessId !== "number" || typeof parsed.ExecutablePath !== "string" || typeof parsed.CommandLine !== "string") {
    throw new Error("Windows returned incomplete MockClient process ownership evidence");
  }
  return { pid: parsed.ProcessId, executablePath: parsed.ExecutablePath, commandLine: parsed.CommandLine };
};

const killWindowsProcessTree: MockClientProcessTreeKiller = async (pid, timeoutMs) => {
  if (process.platform !== "win32") throw new Error("MockClient process tree termination is only available on Windows");
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const taskkill = join(windowsRoot, "System32", "taskkill.exe");
  await runExecFile(taskkill, ["/PID", String(pid), "/T", "/F"], timeoutMs);
};

const sleep = async (delayMs: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));

const normalizeWindowsPath = (value: string): string => win32.normalize(value.replaceAll("/", "\\")).toLocaleLowerCase("en-US");

const resolveOwnedExecutable = (options: MockClientLaunchOptions): string => {
  if (win32.isAbsolute(options.executable)) return normalizeWindowsPath(options.executable);
  return normalizeWindowsPath(win32.resolve(options.workingDirectory, options.executable));
};

const splitWindowsCommandLine = (commandLine: string): readonly string[] => {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let current = "";
    let quoted = false;
    while (index < commandLine.length) {
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === "\"") {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += "\"";
          index += 1;
        } else {
          quoted = !quoted;
          index += 1;
        }
        continue;
      }
      current += "\\".repeat(backslashes);
      if (index >= commandLine.length || (!quoted && /\s/.test(commandLine[index] ?? ""))) break;
      current += commandLine[index] ?? "";
      index += 1;
    }
    args.push(current);
    while (index < commandLine.length && /\s/.test(commandLine[index] ?? "")) index += 1;
  }
  return args;
};

const assertOwnedProcess = (inspection: MockClientProcessInspection, processRef: ManagedMockClientProcessRef, options: MockClientLaunchOptions): void => {
  if (inspection.pid !== processRef.pid) throw new Error("MockClient process ownership check returned a different PID");
  const expectedExecutable = resolveOwnedExecutable(options);
  if (normalizeWindowsPath(inspection.executablePath) !== expectedExecutable) throw new Error("MockClient process ownership check found a different executable");
  const commandLine = splitWindowsCommandLine(inspection.commandLine);
  const commandExecutable = commandLine[0];
  if (!commandExecutable || normalizeWindowsPath(commandExecutable) !== expectedExecutable) {
    throw new Error("MockClient process ownership check found a different command executable");
  }
  const actualArguments = commandLine.slice(1);
  const expectedArguments = buildMockClientArguments(options);
  if (actualArguments.length !== expectedArguments.length) throw new Error("MockClient process ownership check found different launch arguments");
  for (let index = 0; index < expectedArguments.length; index += 1) {
    const actual = actualArguments[index] ?? "";
    const expected = expectedArguments[index] ?? "";
    const isLogPath = expectedArguments[index - 1] === "-l";
    if ((isLogPath ? normalizeWindowsPath(actual) : actual) !== (isLogPath ? normalizeWindowsPath(expected) : expected)) {
      throw new Error(`MockClient process ownership check found a different ${expectedArguments[index - 1] ?? "launch"} argument`);
    }
  }
};

let nextManagedProcessGeneration = 0;

export class ManagedMockClient implements CommandTransport {
  private process: ChildProcessWithoutNullStreams | undefined;
  private processRef: ManagedMockClientProcessRef | undefined;
  private readonly listeners = new Set<(line: string, position: MockClientLogLinePosition) => void>();
  private readonly exitListeners = new Set<(info: MockClientExitInfo) => void>();
  private readonly expectedExitProcesses = new WeakSet<ChildProcessWithoutNullStreams>();
  private logTailTimer: NodeJS.Timeout | undefined;
  private logStreamGeneration = 0;
  private logFileIdentity: string | undefined;
  private logFileMissing = true;
  private logStreamObserved = false;
  private logOffset = 0;
  private logLineStartByteOffset = 0;
  private logTrustedEvidenceFromByteOffset = 0;
  private logContinuityTailStartByteOffset = 0;
  private logContinuityTail = Buffer.alloc(0);
  private logPending = "";
  private logDecoder = new StringDecoder("utf8");
  private diagnosticTailBuffer = Buffer.alloc(0);
  private diagnosticBytesRead = 0;

  public constructor(
    private readonly options: MockClientLaunchOptions,
    private readonly dependencies: ManagedMockClientDependencies = {}
  ) {}

  public start(): void {
    if (this.process) throw new Error("MockClient is already running");
    this.logStreamGeneration += 1;
    this.initializeLogTailCursor();
    this.diagnosticTailBuffer = Buffer.alloc(0);
    this.diagnosticBytesRead = 0;
    const child = (this.dependencies.spawn ?? spawnMockClient)(this.options);
    let spawnConfirmed = false;
    child.once("spawn", () => { spawnConfirmed = true; });
    // A failed Windows spawn reports both an invalid PID synchronously and an
    // asynchronous ChildProcess `error`. Keep the latter observed so the
    // caller can handle the start() failure without a later uncaught event
    // terminating the console process.
    child.on("error", (error: Error) => {
      this.consumeDiagnosticOutput(`[MockClient process error] ${error.message}\n`);
    });
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      try { child.kill(); } catch { /* the failed spawn may not have a killable process */ }
      throw new Error("MockClient did not expose a valid managed process PID");
    }
    const processRef = Object.freeze({ generation: ++nextManagedProcessGeneration, pid: child.pid as number });
    let finalized = false;
    const finalizeProcess = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finalized) return;
      finalized = true;
      const expected = this.expectedExitProcesses.has(child);
      this.expectedExitProcesses.delete(child);
      if (this.process !== child || this.processRef !== processRef) return;
      this.stopLogTail();
      this.process = undefined;
      this.processRef = undefined;
      for (const listener of this.exitListeners) listener({ code, signal, expected });
    };
    child.on("error", () => {
      // Before `spawn`, an error is terminal even if Windows briefly assigned
      // a PID. After `spawn`, ChildProcess can also emit non-terminal kill/send
      // errors; retain the owned handle unless Node already exposes exit proof.
      if (!spawnConfirmed || child.exitCode !== null || child.signalCode !== null) {
        finalizeProcess(child.exitCode, child.signalCode);
      }
    });
    this.process = child;
    this.processRef = processRef;
    child.stdout.on("data", (chunk: Buffer | string) => this.consumeDiagnosticOutput(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.consumeDiagnosticOutput(chunk));
    this.startLogTail();
    child.on("exit", (code, signal) => {
      finalizeProcess(code, signal);
    });
  }

  public get isRunning(): boolean { return Boolean(this.process); }
  public get processGeneration(): number | undefined { return this.processRef?.generation; }
  public get processId(): number | undefined { return this.processRef?.pid; }
  public get diagnosticOutputTail(): string { return this.diagnosticTailBuffer.toString("utf8"); }
  public get diagnosticOutputBytes(): number { return this.diagnosticBytesRead; }

  public captureProcess(): ManagedMockClientProcessRef | undefined { return this.processRef; }

  public isCurrentProcess(processRef: ManagedMockClientProcessRef): boolean {
    return this.processRef === processRef && this.process?.pid === processRef.pid;
  }

  public onLine(listener: (line: string, position: MockClientLogLinePosition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onExit(listener: (info: MockClientExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private readStableLogFileSnapshot(): MockClientLogFileReadResult {
    let observedPresentFile = false;
    let lastDetail: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const before = statSync(this.options.logPath);
        observedPresentFile = true;
        const content = readFileSync(this.options.logPath);
        const after = statSync(this.options.logPath);
        if (logFileIdentity(before) !== logFileIdentity(after)
          || before.size !== after.size
          || content.length !== after.size
          || before.mtimeMs !== after.mtimeMs) {
          lastDetail = "the file changed while it was being read";
          continue;
        }
        return {
          status: "present-stable",
          snapshot: { content, identity: logFileIdentity(after) }
        };
      } catch (error) {
        if (isMissingFileError(error)) {
          if (!observedPresentFile) return { status: "missing" };
          lastDetail = "the file disappeared while it was being read";
          continue;
        }
        lastDetail = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      status: "unstable",
      ...(lastDetail === undefined ? {} : { detail: lastDetail })
    };
  }

  private resetLogDecodeCursor(): void {
    this.logOffset = 0;
    this.logLineStartByteOffset = 0;
    this.logTrustedEvidenceFromByteOffset = 0;
    this.logContinuityTailStartByteOffset = 0;
    this.logContinuityTail = Buffer.alloc(0);
    this.logPending = "";
    this.logDecoder = new StringDecoder("utf8");
  }

  private initializeLogTailCursor(): void {
    const result = this.readStableLogFileSnapshot();
    this.resetLogDecodeCursor();
    this.logStreamObserved = false;
    if (result.status !== "present-stable") {
      this.logFileIdentity = undefined;
      this.logFileMissing = result.status === "missing";
      // A present-but-unstable file may already contain arbitrary history.
      // Unlike an initially missing file, its first later stable prefix must
      // therefore cross a discontinuity boundary and remain audit-only.
      this.logStreamObserved = result.status === "unstable";
      return;
    }
    const { snapshot } = result;
    this.logFileIdentity = snapshot.identity;
    this.logFileMissing = false;
    this.logStreamObserved = true;
    this.logOffset = snapshot.content.length;
    this.logLineStartByteOffset = this.logOffset;
    this.logTrustedEvidenceFromByteOffset = this.logOffset;
    this.updateLogContinuityTail(snapshot.content);
  }

  private hasContinuousLogPrefix(content: Buffer): boolean {
    if (content.length < this.logOffset) return false;
    if (this.logContinuityTail.length === 0) return true;
    const endByteOffset = this.logContinuityTailStartByteOffset + this.logContinuityTail.length;
    return endByteOffset <= content.length
      && content.subarray(this.logContinuityTailStartByteOffset, endByteOffset).equals(this.logContinuityTail);
  }

  private updateLogContinuityTail(content: Buffer): void {
    const endByteOffset = this.logOffset;
    const startByteOffset = Math.max(0, endByteOffset - MOCK_CLIENT_LOG_CONTINUITY_TAIL_BYTES);
    this.logContinuityTailStartByteOffset = startByteOffset;
    this.logContinuityTail = Buffer.from(content.subarray(startByteOffset, endByteOffset));
  }

  /**
   * Synchronously drain every complete line currently present in the managed
   * MockClient log. High-risk local stage recovery calls this before it creates a
   * new attempt/cycle so buffered evidence cannot be mistaken for evidence from
   * the new referee boundary.
   */
  public flushLog(options: MockClientLogFlushOptions = {}): MockClientLogBoundary {
    const result = this.readStableLogFileSnapshot();
    if (result.status === "missing") {
      if (this.logStreamObserved && !this.logFileMissing) {
        this.logFileIdentity = undefined;
        this.logFileMissing = true;
        this.resetLogDecodeCursor();
      }
      if (options.requirePresentStable) {
        throw new Error("STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE: managed MockClient log file is missing");
      }
      return { streamGeneration: this.logStreamGeneration, byteOffset: this.logOffset };
    }
    if (result.status === "unstable") {
      if (options.requirePresentStable) {
        throw new Error(
          `STAGE_RECOVERY_LOG_BOUNDARY_UNAVAILABLE: managed MockClient log file was not stable after 3 reads${
            result.detail === undefined ? "" : ` (${result.detail})`
          }`
        );
      }
      return { streamGeneration: this.logStreamGeneration, byteOffset: this.logOffset };
    }
    const { snapshot } = result;
    const content = snapshot.content;
    const streamReplaced = this.logStreamObserved
      && (this.logFileMissing
        || this.logFileIdentity !== snapshot.identity
        || !this.hasContinuousLogPrefix(content));
    if (streamReplaced) {
      this.logStreamGeneration += 1;
      this.resetLogDecodeCursor();
      // The replacement prefix may contain arbitrarily old Ready/Go/results.
      // Deliver it for raw audit, but do not let it become command or domain
      // evidence. Lines genuinely appended after this stable prefix are trusted.
      this.logTrustedEvidenceFromByteOffset = content.length;
    }
    this.logFileIdentity = snapshot.identity;
    this.logFileMissing = false;
    this.logStreamObserved = true;
    const unread = content.subarray(this.logOffset);
    const linePositions: Array<{ startByteOffset: number; endByteOffset: number }> = [];
    let nextLineStartByteOffset = this.logLineStartByteOffset;
    for (let index = 0; index < unread.length; index += 1) {
      if (unread[index] !== 0x0a) continue;
      const endByteOffset = this.logOffset + index + 1;
      linePositions.push({ startByteOffset: nextLineStartByteOffset, endByteOffset });
      nextLineStartByteOffset = endByteOffset;
    }
    const chunk = this.logDecoder.write(unread);
    this.logOffset = content.length;
    this.logLineStartByteOffset = nextLineStartByteOffset;
    this.updateLogContinuityTail(content);
    const combined = `${this.logPending}${chunk}`;
    const segments = combined.split(/\r?\n/);
    this.logPending = segments.pop() ?? "";
    for (let index = 0; index < segments.length; index += 1) {
      const line = normalizeMockClientLogLine(segments[index] ?? "");
      const position = linePositions[index];
      if (line.length === 0 || !position) continue;
      const trustedEvidence = position.startByteOffset >= this.logTrustedEvidenceFromByteOffset;
      for (const listener of this.listeners) {
        listener(line, {
          streamGeneration: this.logStreamGeneration,
          byteOffset: position.endByteOffset,
          startByteOffset: position.startByteOffset,
          endByteOffset: position.endByteOffset,
          trustedEvidence,
          ...(trustedEvidence ? {} : { discontinuityPrefix: true })
        });
      }
    }
    return { streamGeneration: this.logStreamGeneration, byteOffset: this.logOffset };
  }

  private startLogTail(): void {
    this.flushLog();
    this.logTailTimer = setInterval(() => this.flushLog(), 250);
  }

  private stopLogTail(): void {
    if (this.logTailTimer) {
      clearInterval(this.logTailTimer);
      this.logTailTimer = undefined;
    }
    this.logFileIdentity = undefined;
    this.logFileMissing = true;
    this.logStreamObserved = false;
    this.logOffset = 0;
    this.logLineStartByteOffset = 0;
    this.logTrustedEvidenceFromByteOffset = 0;
    this.logContinuityTailStartByteOffset = 0;
    this.logContinuityTail = Buffer.alloc(0);
    this.logPending = "";
    this.logDecoder = new StringDecoder("utf8");
  }

  private consumeDiagnosticOutput(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.diagnosticBytesRead += buffer.length;
    if (buffer.length >= MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES) {
      this.diagnosticTailBuffer = Buffer.from(buffer.subarray(buffer.length - MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES));
      return;
    }
    const retainedBytes = Math.min(this.diagnosticTailBuffer.length, MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES - buffer.length);
    this.diagnosticTailBuffer = Buffer.concat([
      this.diagnosticTailBuffer.subarray(this.diagnosticTailBuffer.length - retainedBytes),
      buffer
    ], retainedBytes + buffer.length);
  }

  private async writeToChild(child: ChildProcessWithoutNullStreams, command: string, timeoutMs: number, timeoutMessage: string): Promise<void> {
    if (this.process !== child || !child.stdin.writable) throw new Error("MockClient is not running");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error(timeoutMessage)), Math.max(0, timeoutMs));
      try {
        child.stdin.write(`${command}\n`, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async write(command: string, timeoutMs = this.dependencies.writeTimeoutMs ?? DEFAULT_STDIN_WRITE_TIMEOUT_MS): Promise<void> {
    const child = this.process;
    if (!child) throw new Error("MockClient is not running");
    await this.writeToChild(child, command, timeoutMs, "MockClient stdin write timed out");
  }

  public async reconnect(timeoutMs = this.dependencies.writeTimeoutMs ?? DEFAULT_STDIN_WRITE_TIMEOUT_MS): Promise<void> {
    const child = this.process;
    if (!child) throw new Error("MockClient is not running");
    await this.writeToChild(child, "reconnect", timeoutMs, "MockClient reconnect timed out");
  }

  public async disconnectForReconnect(
    timeoutMs = this.dependencies.writeTimeoutMs ?? DEFAULT_STDIN_WRITE_TIMEOUT_MS
  ): Promise<string> {
    const child = this.process;
    if (!child) throw new Error("MockClient is not running");
    const totalTimeoutMs = Math.max(0, timeoutMs);
    const expected = `The host hath bidden us farewell.  (1101: Kicked by *ContestConsole (${MOCK_CLIENT_SOFT_RECONNECT_REASON}).)`;
    const permissionDenied = "Action failed: you don't have the permission to run this action.";
    let removeListener = (): void => undefined;
    let writeFailure: Error | undefined;
    const evidence = new Promise<string>((resolveEvidence, rejectEvidence) => {
      let settled = false;
      const finish = (error?: Error, line?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeListener();
        if (error) rejectEvidence(error);
        else resolveEvidence(line as string);
      };
      const timeout = setTimeout(() => {
        finish(new Error(writeFailure
          ? `MockClient controlled disconnect was not confirmed: ${writeFailure.message}`
          : "MockClient controlled disconnect timed out"));
      }, totalTimeoutMs);
      removeListener = this.onLine((line) => {
        if (line.endsWith(expected)) {
          finish(undefined, line);
        } else if (line.endsWith(permissionDenied)) {
          finish(new Error("ContestConsole lacks permission to disconnect its managed MockClient for a soft reconnect"));
        }
      });
    });
    void this.writeToChild(
      child,
      `kick *ContestConsole ${MOCK_CLIENT_SOFT_RECONNECT_REASON}`,
      totalTimeoutMs,
      "MockClient controlled disconnect write timed out"
    ).catch((error: unknown) => {
      writeFailure = error instanceof Error ? error : new Error(String(error));
    });
    return evidence;
  }

  public async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.expectedExitProcesses.add(child);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onExit = (): void => finish();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => finish(new Error("MockClient graceful stop timed out")), Math.max(0, timeoutMs));
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      void this.writeToChild(child, "stop", Math.max(0, timeoutMs), "MockClient graceful stop timed out").catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  public async forceStopOwnedProcessTree(processRef: ManagedMockClientProcessRef, timeoutMs = DEFAULT_FORCE_STOP_TIMEOUT_MS): Promise<void> {
    const child = this.process;
    if (!child || !this.isCurrentProcess(processRef)) throw new Error("Refusing to stop a MockClient process that is no longer current");
    const now = this.dependencies.now ?? Date.now;
    const deadline = now() + Math.max(0, timeoutMs);
    const inspectProcess = this.dependencies.inspectProcess ?? inspectWindowsProcess;
    const killProcessTree = this.dependencies.killProcessTree ?? killWindowsProcessTree;
    const wait = this.dependencies.sleep ?? sleep;
    const remaining = (): number => Math.max(0, deadline - now());
    const capturedChildExited = (): boolean => {
      if (this.process !== undefined && this.process !== child) return false;
      return this.process === undefined || child.exitCode !== null || child.signalCode !== null;
    };
    const withinDeadline = async <T>(operation: Promise<T>, message: string): Promise<T> => {
      const budget = remaining();
      if (budget <= 0) throw new Error(message);
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, value?: T): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value as T);
        };
        const timer = setTimeout(() => finish(new Error(message)), budget);
        void operation.then((value) => finish(undefined, value), (error: unknown) => finish(error));
      });
    };

    const inspection = await withinDeadline(inspectProcess(processRef.pid, remaining()), "MockClient ownership inspection timed out");
    if (!inspection) {
      if (capturedChildExited()) return;
      throw new Error("Refusing to stop MockClient because its managed PID no longer exists");
    }
    assertOwnedProcess(inspection, processRef, this.options);
    if (this.process !== child || !this.isCurrentProcess(processRef)) throw new Error("Refusing to stop MockClient because the managed child changed during ownership inspection");
    const secondInspection = await withinDeadline(inspectProcess(processRef.pid, remaining()), "MockClient ownership recheck timed out");
    if (!secondInspection) {
      if (capturedChildExited()) return;
      throw new Error("Refusing to stop MockClient because its managed PID exited before termination");
    }
    assertOwnedProcess(secondInspection, processRef, this.options);
    if (this.process !== child || !this.isCurrentProcess(processRef) || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Refusing to stop MockClient because the managed child changed before termination");
    }
    this.expectedExitProcesses.add(child);
    try {
      await withinDeadline(killProcessTree(processRef.pid, remaining()), "MockClient process tree termination timed out");
    } catch (error) {
      const gone = await withinDeadline(inspectProcess(processRef.pid, remaining()), "MockClient termination verification timed out");
      if (gone || (child.exitCode === null && child.signalCode === null)) throw error;
    }

    const pollInterval = Math.max(1, this.dependencies.processPollIntervalMs ?? DEFAULT_PROCESS_POLL_INTERVAL_MS);
    while (remaining() > 0) {
      if (this.process !== undefined && this.process !== child) throw new Error("MockClient child changed while waiting for process tree termination");
      const current = await withinDeadline(inspectProcess(processRef.pid, remaining()), "MockClient termination verification timed out");
      const childExited = child.exitCode !== null || child.signalCode !== null || this.process === undefined;
      if (!current && childExited) return;
      await withinDeadline(wait(Math.min(pollInterval, remaining())), "MockClient process tree did not exit before the timeout");
    }
    throw new Error("MockClient process tree did not exit before the timeout");
  }
}
