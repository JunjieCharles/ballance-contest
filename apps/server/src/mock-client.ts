import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spectatorLoginName } from "@ballance/contracts";

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
  return ["-s", options.server, "-n", spectatorLoginName(options.refereeName), "-u", options.uuid, "-l", options.logPath, "--auto-flush", "--no-sound-files"];
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

export class ManagedMockClient implements CommandTransport {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly listeners = new Set<(line: string) => void>();
  private logTailTimer: NodeJS.Timeout | undefined;
  private logOffset = 0;
  private logPending = "";

  public constructor(private readonly options: MockClientLaunchOptions) {}

  public start(): void {
    if (this.process) throw new Error("MockClient is already running");
    const child = spawn(this.options.executable, buildMockClientArguments(this.options), {
      cwd: this.options.workingDirectory,
      shell: false,
      windowsHide: true,
      stdio: "pipe"
    });
    this.process = child;
    this.startLogTail();
    child.on("exit", () => {
      this.stopLogTail();
      this.process = undefined;
    });
  }

  public onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  public async write(command: string): Promise<void> {
    if (!this.process?.stdin.writable) throw new Error("MockClient is not running");
    await new Promise<void>((resolve, reject) => this.process?.stdin.write(`${command}\n`, (error) => error ? reject(error) : resolve()));
  }

  public async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.process;
    if (!child) return;
    await this.write("stop");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MockClient graceful stop timed out")), timeoutMs);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
}
