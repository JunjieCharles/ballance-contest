import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompetitionSnapshot } from "@ballance/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompetitionService } from "./competition-service.js";
import { openDatabase, type OpenedDatabase } from "./storage/database.js";
import { PublicScorePublisher } from "./public-score-publisher.js";
import { publicScoreData, renderPublicScorePage } from "./public-score-page.js";

describe("public score publishing", () => {
  let root: string;
  let database: OpenedDatabase;
  let service: CompetitionService;
  let publisher: PublicScorePublisher;
  let snapshot: CompetitionSnapshot;
  let now: number;
  let remote: { sha: string; content: string; type: string } | undefined;
  let fail: "none" | "lost-receipt" | "lost-write" | "read" | "403";
  let network: ReturnType<typeof vi.fn<typeof fetch>>;
  const credential = "github_pat_TEST_ONLY_NOT_REAL";
  const digest = (html: string) => createHash("sha1").update(`blob ${Buffer.byteLength(html)}\0`).update(html).digest("hex");
  const configure = (extra = {}) => publisher.configure(snapshot.competition.id, {
    owner: "referee", repository: "ballance-scores", branch: "main", enabled: true,
    expectedRevision: publisher.status(snapshot.competition.id).revision, idempotencyKey: crypto.randomUUID(), token: credential, ...extra
  });
  const writes = () => network.mock.calls.filter(([, options]) => options?.method === "PUT");
  const advance = () => { now += 360_001; };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ballance-public-score-"));
    database = openDatabase(join(root, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot: root });
    const competition = service.create({ name: "公开成绩测试", mode: "work", idempotencyKey: "new" });
    service.publish(competition.id, 0, "publish");
    snapshot = service.snapshot(competition.id);
    now = Date.parse("2026-09-26T00:00:00Z");
    remote = undefined; fail = "none";
    network = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url).startsWith("https://api.github.com/repos/referee/ballance-scores")).toBe(true);
      expect(options?.redirect).toBe("error");
      if (options?.method !== "PUT") {
        if (fail === "read") throw new Error(`sensitive ${credential}`);
        if (!String(url).includes("/contents/")) return Response.json({ private: false });
        return remote ? Response.json(remote) : new Response("", { status: 404 });
      }
      if (fail === "403") return new Response(credential, { status: 403 });
      const body = JSON.parse(String(options.body)) as { content: string; sha?: string };
      expect(body.sha).toBe(remote?.sha);
      if (fail === "lost-write") throw new Error("timeout before server commit");
      const html = Buffer.from(body.content, "base64").toString("utf8");
      remote = { sha: digest(html), content: body.content, type: "file" };
      if (fail === "lost-receipt") throw new Error("timeout after server commit");
      return Response.json({ content: { sha: remote.sha } });
    });
    publisher = new PublicScorePublisher(database, () => snapshot, () => {}, network, () => now);
  });
  afterEach(async () => {
    await publisher.close(); await service.close(); database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes one coherent page, coalesces revisions and persists throttle across service restart without credentials", async () => {
    configure();
    await publisher.tick();
    expect(writes()).toHaveLength(1);
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ pending: false, uploadedVersion: 0, uncertain: false });
    snapshot = { ...snapshot, competition: { ...snapshot.competition, name: "已修订" } };
    await publisher.tick(); expect(writes()).toHaveLength(1);
    expect(publisher.status(snapshot.competition.id).pending).toBe(true);
    await publisher.close(); await service.close(); database.close();
    database = openDatabase(join(root, "console.sqlite"));
    service = new CompetitionService(undefined, { database, dataRoot: root });
    publisher = new PublicScorePublisher(database, () => snapshot, () => {}, network, () => now);
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ hasCredential: false, pending: true, uploadedVersion: 0 });
    advance(); await publisher.tick(); expect(writes()).toHaveLength(1);
    configure(); await publisher.tick(); expect(writes()).toHaveLength(2);
    expect(Buffer.from(remote!.content, "base64").toString("utf8")).toContain("已修订");
    expect(JSON.stringify(database.sqlite.prepare("SELECT * FROM public_score_publications").all())).not.toContain(credential);
    expect(JSON.stringify(database.sqlite.prepare("SELECT * FROM public_score_receipts").all())).not.toContain(credential);
  });

  it("reconciles a lost success receipt through a read, without a second PUT", async () => {
    configure(); fail = "lost-receipt";
    await publisher.tick(); expect(publisher.status(snapshot.competition.id).uncertain).toBe(true);
    advance(); fail = "none"; await publisher.tick();
    expect(writes()).toHaveLength(1);
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ uncertain: false, pending: false });
  });

  it("never automatically resends an uncertain write; explicit retry reconciles before writing", async () => {
    configure(); fail = "lost-write";
    await publisher.tick(); advance(); fail = "none"; await publisher.tick();
    expect(writes()).toHaveLength(1);
    expect(publisher.status(snapshot.competition.id).uncertain).toBe(true);
    advance();
    publisher.retry(snapshot.competition.id, { expectedRevision: 1, idempotencyKey: "retry" });
    await publisher.tick();
    expect(writes()).toHaveLength(2);
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ uncertain: false, pending: false });
  });

  it("handles read and permission failures without leaking response bodies or blocking competition changes", async () => {
    configure(); fail = "read"; await publisher.tick();
    expect(writes()).toHaveLength(0);
    expect(publisher.status(snapshot.competition.id).error).not.toContain(credential);
    advance(); fail = "403"; await publisher.tick();
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ uncertain: false, pending: true });
    expect(publisher.status(snapshot.competition.id).error).toContain("403");
    expect(publisher.status(snapshot.competition.id).error).not.toContain(credential);
    snapshot = { ...snapshot, competition: { ...snapshot.competition, status: "finished" } };
    advance(); fail = "none"; await publisher.tick();
    expect(publisher.status(snapshot.competition.id).pending).toBe(false);
  });

  it("rejects stale settings, deduplicates requests, disables upload and does not overwrite unrelated files", async () => {
    configure({ idempotencyKey: "same" }); configure({ expectedRevision: 0, idempotencyKey: "same" });
    expect(publisher.status(snapshot.competition.id).revision).toBe(1);
    expect(() => configure({ expectedRevision: 0 })).toThrow("已变化");
    expect(() => configure({ owner: "referee/../../evil" })).toThrow("有效");
    remote = { sha: "foreign", content: Buffer.from("unrelated page").toString("base64"), type: "file" };
    await publisher.tick(); expect(writes()).toHaveLength(0);
    expect(publisher.status(snapshot.competition.id).error).toContain("停止覆盖");
    configure({ enabled: false }); advance(); await publisher.tick();
    expect(publisher.status(snapshot.competition.id)).toMatchObject({ hasCredential: false, pending: false });
  });

  it("blocks all network publishing in test mode and before competition publication", async () => {
    snapshot = { ...snapshot, competition: { ...snapshot.competition, mode: "test" } };
    expect(() => configure()).toThrow("测试模式");
    await publisher.tick(); expect(network).not.toHaveBeenCalled();
    snapshot = { ...snapshot, competition: { ...snapshot.competition, mode: "work" } };
    delete snapshot.publishedConfig;
    expect(() => configure()).toThrow("先发布比赛");
  });

  it("reuses score cells while removing private identity and escaping script markup", () => {
    const data = publicScoreData({ ...snapshot, currentScoreboard: [{ playerId: "secret-player-id", displayName: "</script><script>window.pwned=true</script>", rank: 1, points: 15, change: 1, stages: { [snapshot.config.stages[0]!.id]: { status: "finished", place: 1, points: 15, sourceId: "private-source" } } }] });
    expect(data.rows[0]?.cells[4]).toEqual({ text: "#1 / 15 分", style: "gold" });
    const html = renderPublicScorePage(data);
    expect(html).not.toContain("secret-player-id"); expect(html).not.toContain("private-source");
    expect(html).not.toContain("</script><script>window.pwned");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
