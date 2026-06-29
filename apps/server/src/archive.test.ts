import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompetitionArchive } from "./archive.js";
import { createScoreboardExports } from "./scoreboard-export.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const exportsForTest = () => createScoreboardExports({
  competitionName: "Archive Test", mode: "test", version: 1, generatedAt: "2026-06-29T12:00:00.000Z",
  entries: [{ rank: 1, playerId: "p1", displayName: "测试选手", points: 20, placeCounts: [1], change: null, stages: { s1: { playerId: "p1", status: "finished", place: 1, points: 20, sourceId: "event-1" } } }]
});

describe("competition archive", () => {
  it("creates an immutable, hashed test archive without modifying source logs", () => {
    const root = mkdtempSync(join(tmpdir(), "ballance-archive-"));
    temporary.push(root);
    const sourceRoot = join(root, "source");
    mkdirSync(sourceRoot);
    const log = join(sourceRoot, "Mock Client.log");
    writeFileSync(log, "[06-29 12:00:00] test\r\n", "utf8");
    const before = { hash: sha(log), mtime: statSync(log).mtimeMs };
    const created = createCompetitionArchive({
      dataRoot: join(root, "data"), sourceRoot,
      competition: { id: "competition-1", name: "测试比赛", mode: "test", timezone: "Asia/Shanghai" },
      version: 1, generatedAt: "2026-06-29T12:00:00.000Z", applicationVersion: "0.1.0-dev",
      parserVersion: "1", mockClientVersion: "3.6.8-beta18",
      sourceFiles: [{ sourcePath: log, kind: "log" }],
      records: { "config/config.json": { stages: 1 }, "events/events.json": [{ type: "go" }] },
      exports: exportsForTest()
    });

    expect(created.directory.replaceAll("\\", "/")).toContain("/data/test/competition-1/archive/v1-");
    expect(created.packagePath.endsWith(".zip")).toBe(true);
    expect(created.manifest).toMatchObject({ mode: "test", testData: true, applicationVersion: "0.1.0-dev" });
    expect(created.manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "logs/Mock Client.log", "config/config.json", "events/events.json",
      expect.stringMatching(/^exports\/.+\.xlsx$/)
    ]));
    expect(readFileSync(join(created.directory, "manifest.sha256"), "utf8")).toContain(created.manifestHash);
    expect(readFileSync(created.packagePath).readUInt32LE(0)).toBe(0x04034b50);
    expect({ hash: sha(log), mtime: statSync(log).mtimeMs }).toEqual(before);
  });

  it("never overwrites an archive version and rejects source paths outside the authorized root", () => {
    const root = mkdtempSync(join(tmpdir(), "ballance-archive-safe-"));
    temporary.push(root);
    const sourceRoot = join(root, "source");
    mkdirSync(sourceRoot);
    const inside = join(sourceRoot, "inside.log");
    const outside = join(root, "outside.log");
    writeFileSync(inside, "inside");
    writeFileSync(outside, "outside");
    const request = {
      dataRoot: join(root, "data"), sourceRoot,
      competition: { id: "competition-1", name: "Test", mode: "test" as const, timezone: "Asia/Shanghai" },
      version: 1, generatedAt: "2026-06-29T12:00:00.000Z", applicationVersion: "dev", parserVersion: "1", mockClientVersion: "fake",
      sourceFiles: [{ sourcePath: inside, kind: "log" as const }], records: {}, exports: exportsForTest()
    };
    createCompetitionArchive(request);
    expect(() => createCompetitionArchive(request)).toThrow("ARCHIVE_VERSION_EXISTS");
    expect(() => createCompetitionArchive({ ...request, version: 2, sourceFiles: [{ sourcePath: outside, kind: "log" }] })).toThrow("ARCHIVE_SOURCE_OUTSIDE_ROOT");
  });
});
