import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";

export interface StaticLogResult {
  size: number;
  mtimeMs: number;
  sha256: string;
  lines: readonly string[];
  invalidEncoding: boolean;
}

const decodeUtf8 = (buffer: Uint8Array): { text: string; invalid: boolean } => {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), invalid: false };
  } catch {
    return { text: new TextDecoder("utf-8").decode(buffer), invalid: true };
  }
};

export const readStaticLog = async (path: string): Promise<StaticLogResult> => {
  const before = await stat(path);
  const bytes = await readFile(path);
  const decoded = decodeUtf8(bytes);
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Static log changed while reading");
  return {
    size: bytes.length,
    mtimeMs: after.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lines: decoded.text.replace(/\r\n/g, "\n").split("\n"),
    invalidEncoding: decoded.invalid
  };
};

export interface GrowingLine {
  offset: number;
  sourceId: string;
  text: string;
}

export class GrowingLogReader {
  private offset = 0;
  private remainder = Buffer.alloc(0);
  private identity: string | undefined;
  private generation = 0;

  public constructor(private readonly path: string) {}

  public async readAvailable(): Promise<readonly GrowingLine[]> {
    const info = await stat(this.path);
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (this.identity !== undefined && (identity !== this.identity || info.size < this.offset)) {
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.generation += 1;
    }
    this.identity = identity;
    if (info.size === this.offset) return [];
    const length = info.size - this.offset;
    const handle = await open(this.path, "r");
    try {
      const chunk = Buffer.alloc(length);
      const result = await handle.read(chunk, 0, length, this.offset);
      const chunkStart = this.offset;
      this.offset += result.bytesRead;
      const combined = Buffer.concat([this.remainder, chunk.subarray(0, result.bytesRead)]);
      const lines: GrowingLine[] = [];
      let lineStart = 0;
      for (let cursor = 0; cursor < combined.length; cursor += 1) {
        if (combined[cursor] !== 0x0a) continue;
        const raw = combined.subarray(lineStart, cursor);
        const clean = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
        const lineOffset = chunkStart - this.remainder.length + lineStart;
        const sourceId = createHash("sha256").update(`${identity}:${this.generation}:${lineOffset}:`).update(clean).digest("hex");
        lines.push({ offset: lineOffset, sourceId, text: decodeUtf8(clean).text });
        lineStart = cursor + 1;
      }
      this.remainder = combined.subarray(lineStart);
      return lines;
    } finally {
      await handle.close();
    }
  }

  public getOffset(): number { return this.offset; }
}
