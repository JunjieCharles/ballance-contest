import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildMockClientArguments,
  consumeMockClientLogChunk,
  ManagedMockClient,
  MOCK_CLIENT_DIAGNOSTIC_TAIL_BYTES,
  resolveMockClientUuid
} from "./mock-client.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;

  public constructor(public readonly stdin: Writable = new PassThrough()) { super(); }

  public emitExit(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
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
  options = managedOptions
): ManagedMockClient => new ManagedMockClient(
  options,
  {
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    writeTimeoutMs
  }
);

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

  it("bounds the complete graceful stop while the stop write is blocked", async () => {
    const stdin = new BlockedWritable();
    const child = new FakeChildProcess(stdin);
    const client = createManagedClient(child, 1_000);
    client.start();

    await expect(client.stop(25)).rejects.toThrow("graceful stop timed out");

    stdin.release();
    child.emitExit();
  });
});
