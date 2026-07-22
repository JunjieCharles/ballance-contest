import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEST_REFEREE_NAME, spectatorLoginName } from "@ballance/contracts";

export const MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES = 64 * 1024;
const DEFAULT_STDIN_WRITE_TIMEOUT_MS = 5_000;

export interface MockClientLaunchOptions {
  executable: string;
  workingDirectory: string;
  server: string;
  refereeName: string;
  uuid: string;
  logPath: string;
}

const PRESET_SERVERS = new Set(["0.bmmo.win", "1.bmmo.win", "2.bmmo.win"]);

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

export const consumeMockClientLogChunk = (chunk: string, pending: string): ConsumeMockClientLogChunkResult => {
  const combined = `${pending}${chunk}`;
  const segments = combined.split(/\r?\n/);
  const nextPending = segments.pop() ?? "";
  const lines = segments.map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "").trimEnd()).filter((line) => line.length > 0);
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

export type MockClientSpawner = (options: MockClientLaunchOptions) => ChildProcessWithoutNullStreams;

export interface ManagedMockClientDependencies {
  spawn?: MockClientSpawner;
  writeTimeoutMs?: number;
}

const spawnMockClient: MockClientSpawner = (options) => spawn(options.executable, buildMockClientArguments(options), {
  cwd: options.workingDirectory,
  shell: false,
  windowsHide: true,
  stdio: "pipe"
});

export class ManagedMockClient implements CommandTransport {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly listeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(info: MockClientExitInfo) => void>();
  private logTailTimer: NodeJS.Timeout | undefined;
  private logOffset = 0;
  private logPending = "";
  private stopping = false;
  private diagnosticTailBuffer = Buffer.alloc(0);
  private diagnosticBytesRead = 0;

  public constructor(
    private readonly options: MockClientLaunchOptions,
    private readonly dependencies: ManagedMockClientDependencies = {}
  ) {}

  public start(): void {
    if (this.process) throw new Error("MockClient is already running");
    this.logOffset = existsSync(this.options.logPath) ? readFileSync(this.options.logPath, "utf8").length : 0;
    this.logPending = "";
    this.stopping = false;
    this.diagnosticTailBuffer = Buffer.alloc(0);
    this.diagnosticBytesRead = 0;
    const child = (this.dependencies.spawn ?? spawnMockClient)(this.options);
    this.process = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.consumeDiagnosticOutput(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => this.consumeDiagnosticOutput(chunk));
    this.startLogTail();
    child.on("exit", (code, signal) => {
      const expected = this.stopping;
      this.stopLogTail();
      this.process = undefined;
      this.stopping = false;
      for (const listener of this.exitListeners) listener({ code, signal, expected });
    });
  }

  public get isRunning(): boolean { return Boolean(this.process); }
  public get diagnosticOutputTail(): string { return this.diagnosticTailBuffer.toString("utf8"); }
  public get diagnosticOutputBytes(): number { return this.diagnosticBytesRead; }

  public onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onExit(listener: (info: MockClientExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private startLogTail(): void {
    const readNewLogLines = () => {
      if (!existsSync(this.options.logPath)) return;
      const content = readFileSync(this.options.logPath, "utf8");
      if (content.length < this.logOffset) this.logOffset = 0;
      const chunk = content.slice(this.logOffset);
      this.logOffset = content.length;
      const parsed = consumeMockClientLogChunk(chunk, this.logPending);
      this.logPending = parsed.pending;
      for (const line of parsed.lines) {
        if (line.length > 0) for (const listener of this.listeners) listener(line);
      }
    };
    readNewLogLines();
    this.logTailTimer = setInterval(readNewLogLines, 250);
  }

  private stopLogTail(): void {
    if (this.logTailTimer) {
      clearInterval(this.logTailTimer);
      this.logTailTimer = undefined;
    }
    this.logOffset = 0;
    this.logPending = "";
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

  public async write(command: string, timeoutMs = this.dependencies.writeTimeoutMs ?? DEFAULT_STDIN_WRITE_TIMEOUT_MS): Promise<void> {
    const child = this.process;
    if (!child?.stdin.writable) throw new Error("MockClient is not running");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error("MockClient stdin write timed out")), Math.max(0, timeoutMs));
      try {
        child.stdin.write(`${command}\n`, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onExit = (): void => finish();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        if (error) {
          this.stopping = false;
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
      void this.write("stop", Math.max(0, timeoutMs)).catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}
