import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrowingLogReader, readStaticLog } from "./log-source.js";

const temporary: string[] = [];
const tempFile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "ballance-log-"));
  temporary.push(directory);
  return join(directory, "MockClient.log");
};
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("log sources", () => {
  it("reads a static log without changing it", async () => {
    const path = tempFile();
    writeFileSync(path, "first\r\n第二行\r\n", "utf8");
    const before = statSync(path);
    const result = await readStaticLog(path);
    const after = statSync(path);
    expect(result.lines.slice(0, 2)).toEqual(["first", "第二行"]);
    expect(result.invalidEncoding).toBe(false);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  it("emits only complete growing lines and keeps stable offsets", async () => {
    const path = tempFile();
    writeFileSync(path, "first\npart", "utf8");
    const reader = new GrowingLogReader(path);
    expect(await reader.readAvailable()).toMatchObject([{ offset: 0, text: "first" }]);
    expect(await reader.readAvailable()).toEqual([]);
    appendFileSync(path, "ial\nsecond\n", "utf8");
    const lines = await reader.readAvailable();
    expect(lines.map((line) => [line.offset, line.text])).toEqual([[6, "partial"], [14, "second"]]);
  });
});
