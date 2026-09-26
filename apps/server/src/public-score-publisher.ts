import { createHash } from "node:crypto";
import type { CompetitionSnapshot, PublicScoreSettings, PublicScoreStatus, PublicScoreUpdate } from "@ballance/contracts";
import type { OpenedDatabase } from "./storage/database.js";
import { ServiceError } from "./service-error.js";
import { publicScoreData, renderPublicScorePage } from "./public-score-page.js";

const INTERVAL = 6 * 60_000;
const defaults = (): PublicScoreSettings => ({ owner: "", repository: "", branch: "public-scores", enabled: false });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const blobHash = (value: string) => createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex");
interface Upload {
  sha: string;
  fingerprint: string;
  version: number;
  sequence: number;
  generatedAt: string;
}
interface Stored {
  settings: PublicScoreSettings;
  revision: number;
  sequence: number;
  uploaded?: Upload;
  attempt?: Upload;
  retryRequested?: boolean;
  error?: string;
}
const initial = (): Stored => ({ settings: defaults(), revision: 0, sequence: 0 });

export class PublicScorePublisher {
  private readonly tokens = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | undefined;
  private driverError: string | undefined;
  private stopped = false;

  public constructor(
    private readonly database: OpenedDatabase,
    private readonly snapshot: (id: string) => CompetitionSnapshot,
    private readonly changed: (id: string) => void,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  public start(): void {
    this.timer = setInterval(() => { void this.tick(); }, 5_000);
    this.timer.unref();
  }

  public async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.active;
    this.tokens.clear();
  }

  private read(id: string): Stored {
    const row = this.database.sqlite.prepare("SELECT payload FROM public_score_publications WHERE competition_id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Stored : initial();
  }

  private write(id: string, state: Stored): void {
    this.database.sqlite.prepare("INSERT INTO public_score_publications(competition_id,payload) VALUES (?,?) ON CONFLICT(competition_id) DO UPDATE SET payload=excluded.payload")
      .run(id, JSON.stringify(state));
  }

  private fingerprint(snapshot: CompetitionSnapshot): string {
    return hash(JSON.stringify(publicScoreData(snapshot, 0, "")));
  }

  private repositoryKey(settings: PublicScoreSettings): string {
    return `${settings.owner}/${settings.repository}`.toLowerCase();
  }

  private nextUpload(settings: PublicScoreSettings): number {
    const row = this.database.sqlite.prepare("SELECT attempted_at FROM public_score_upload_slots WHERE repository=?").get(this.repositoryKey(settings)) as { attempted_at: number } | undefined;
    return row ? row.attempted_at + INTERVAL : 0;
  }

  public status(id: string): PublicScoreStatus {
    const snapshot = this.snapshot(id);
    const state = this.read(id);
    const { settings } = state;
    const owner = settings.owner.toLowerCase();
    const root = settings.repository.toLowerCase() === `${owner}.github.io` ? "" : `${encodeURIComponent(settings.repository)}/`;
    const next = this.nextUpload(settings);
    return {
      settings, revision: state.revision,
      hasCredential: this.tokens.has(id), uploading: this.busy.has(id),
      pending: Boolean(settings.enabled && this.fingerprint(snapshot) !== state.uploaded?.fingerprint),
      uncertain: Boolean(state.attempt),
      ...(settings.owner && settings.repository ? { pageUrl: `https://${owner}.github.io/${root}scores/${encodeURIComponent(id)}/` } : {}),
      ...(state.uploaded ? { uploadedVersion: state.uploaded.version, uploadedAt: state.uploaded.generatedAt } : {}),
      ...(next > this.now() ? { nextUploadAt: new Date(next).toISOString() } : {}),
      ...(this.driverError || state.error ? { error: this.driverError ?? state.error! } : {})
    };
  }

  private assertWork(id: string): void {
    const snapshot = this.snapshot(id);
    if (snapshot.competition.mode !== "work") throw new ServiceError("CAPABILITY_UNSUPPORTED", "测试模式只允许本地预览，不会连接 GitHub", 409);
    if (!snapshot.publishedConfig) throw new ServiceError("CAPABILITY_UNSUPPORTED", "请先发布比赛配置，再开启公开成绩", 409);
  }

  private mutate(id: string, expectedRevision: number, key: string, identity: string, update: (state: Stored) => void): boolean {
    if (typeof key !== "string" || !key || key.length > 200) throw new TypeError("缺少有效幂等键");
    if (this.busy.has(id)) throw new ServiceError("PUBLIC_SCORE_BUSY", "正在上传，请稍后再修改公开成绩设置", 409);
    const applied = this.database.sqlite.transaction(() => {
      const old = this.database.sqlite.prepare("SELECT identity FROM public_score_receipts WHERE competition_id=? AND idempotency_key=?").get(id, key) as { identity: string } | undefined;
      if (old) {
        if (old.identity !== identity) throw new ServiceError("IDEMPOTENCY_CONFLICT", "该请求标识已用于其他操作", 409);
        return false;
      }
      const state = this.read(id);
      if (expectedRevision !== state.revision) throw new ServiceError("STATE_CONFLICT", "公开成绩设置已变化，请刷新后重试", 409);
      update(state);
      state.revision++;
      this.write(id, state);
      this.database.sqlite.prepare("INSERT INTO public_score_receipts VALUES (?,?,?)").run(id, key, identity);
      return true;
    })();
    this.changed(id);
    return applied;
  }

  public configure(id: string, input: PublicScoreUpdate): PublicScoreStatus {
    this.assertWork(id);
    if (!input || typeof input.owner !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(input.owner) ||
      typeof input.repository !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.repository) || [".", ".."].includes(input.repository) ||
      typeof input.branch !== "string" || !/^[a-zA-Z0-9_/-]{1,100}$/.test(input.branch) || input.branch.startsWith("/") || input.branch.endsWith("/") || input.branch.includes("//") ||
      typeof input.enabled !== "boolean") throw new TypeError("请填写有效的 GitHub 用户名、仓库名和分支");
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length > 500 || /\s/.test(input.token))) throw new TypeError("GitHub 凭据格式无效");
    const settings: PublicScoreSettings = { owner: input.owner, repository: input.repository, branch: input.branch, enabled: input.enabled };
    // Persist no credential or credential hash in SQLite/audits.
    let targetChanged = false;
    const applied = this.mutate(id, input.expectedRevision, input.idempotencyKey, JSON.stringify(settings), state => {
      targetChanged = state.settings.owner !== settings.owner || state.settings.repository !== settings.repository || state.settings.branch !== settings.branch;
      if (state.attempt && targetChanged) throw new ServiceError("PUBLIC_SCORE_UNCERTAIN", "请先核对上次上传结果，再更换目标仓库", 409);
      if (targetChanged) delete state.uploaded;
      state.settings = settings;
      delete state.error;
    });
    if (applied && targetChanged) this.tokens.delete(id);
    if (applied && input.token) this.tokens.set(id, input.token);
    if (applied && !settings.enabled) this.tokens.delete(id);
    return this.status(id);
  }

  public retry(id: string, input: { expectedRevision: number; idempotencyKey: string }): PublicScoreStatus {
    this.assertWork(id);
    this.mutate(id, input.expectedRevision, input.idempotencyKey, "retry", state => {
      if (!state.settings.enabled) throw new ServiceError("CAPABILITY_UNSUPPORTED", "请先开启公开成绩", 409);
      // The next upload reads the remote file first; a retry is explicit, never an automatic resend of an uncertain PUT.
      if (state.attempt) state.retryRequested = true;
      delete state.error;
    });
    void this.tick();
    return this.status(id);
  }

  public tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    const running = this.scan().then(() => { this.driverError = undefined; }).catch(() => {
      this.driverError = "公开成绩状态保存失败，请检查本地数据目录；比赛流程未停止";
    });
    this.active = running;
    void running.finally(() => { if (this.active === running) this.active = undefined; });
    return running;
  }

  private async scan(): Promise<void> {
    const rows = this.database.sqlite.prepare("SELECT competition_id FROM public_score_publications").all() as { competition_id: string }[];
    rows.sort((a, b) => (this.read(a.competition_id).uploaded?.generatedAt ?? "").localeCompare(this.read(b.competition_id).uploaded?.generatedAt ?? ""));
    for (const row of rows) {
      if (this.stopped) return;
      const id = row.competition_id;
      const state = this.read(id);
      if (!state.settings.enabled || !this.tokens.has(id) || this.nextUpload(state.settings) > this.now()) continue;
      try {
        this.assertWork(id);
        const snapshot = this.snapshot(id);
        if (!state.attempt && this.fingerprint(snapshot) === state.uploaded?.fingerprint) continue;
        await this.upload(id, state, snapshot);
      } catch {
        // All external errors are converted to fixed messages, never echoing tokens/response bodies.
        state.error = "公开成绩同步失败，请检查配置后重试；比赛可继续";
        this.write(id, state);
        this.changed(id);
      }
    }
  }

  private async upload(id: string, state: Stored, snapshot: CompetitionSnapshot): Promise<void> {
    this.busy.add(id);
    const { owner, repository, branch } = state.settings;
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const path = `${base}/contents/scores/${encodeURIComponent(id)}/index.html`;
    const token = this.tokens.get(id)!;
    const request = (url: string, init: RequestInit = {}) => this.transport(url, {
      ...init, redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)])
    });
    this.database.sqlite.prepare("INSERT INTO public_score_upload_slots VALUES (?,?) ON CONFLICT(repository) DO UPDATE SET attempted_at=excluded.attempted_at")
      .run(this.repositoryKey(state.settings), this.now());
    this.changed(id);
    try {
      const repoResponse = await request(base);
      if (!repoResponse.ok) throw new Error("repository");
      const repo = await repoResponse.json() as { private?: boolean };
      if (repo.private !== false) { state.error = "请选择独立的公开成绩仓库，并启用该分支根目录的 GitHub Pages"; return; }
      const remoteResponse = await request(`${path}?ref=${encodeURIComponent(branch)}`);
      if (!remoteResponse.ok && remoteResponse.status !== 404) throw new Error("read");
      const remote = remoteResponse.ok ? await remoteResponse.json() as { sha?: string; content?: string; type?: string } : undefined;
      if (state.attempt) {
        if (remote?.sha === state.attempt.sha) {
          state.uploaded = state.attempt; delete state.attempt; delete state.retryRequested; delete state.error;
          return;
        }
        if (!state.retryRequested) {
          state.error = "上次上传结果未确认，已停止自动重发。请核对 GitHub 文件后点击“核对并重试”";
          return;
        }
        delete state.attempt;
        delete state.retryRequested;
      }
      if (remote && (remote.type !== "file" || !remote.sha || !remote.content ||
        !Buffer.from(remote.content, "base64").toString("utf8").includes(`"competitionId":"${id}"`))) {
        state.error = "目标文件不是本比赛生成的成绩页，已停止覆盖，请更换仓库"; return;
      }
      if (remote && remote.sha !== state.uploaded?.sha) {
        state.error = "GitHub 上的成绩文件与本机记录不同，已停止覆盖；请核对是否有其他控制台发布到同一路径"; return;
      }
      const data = publicScoreData(snapshot, state.sequence + 1, new Date(this.now()).toISOString());
      const html = renderPublicScorePage(data);
      if (Buffer.byteLength(html) > 900_000) { state.error = "成绩页超过单次发布大小限制，请联系维护者"; return; }
      const attempt: Upload = { sha: blobHash(html), fingerprint: this.fingerprint(snapshot), version: data.version, sequence: data.sequence, generatedAt: data.generatedAt };
      state.sequence = data.sequence;
      state.attempt = attempt;
      delete state.error;
      this.write(id, state); // Durable before any potentially ambiguous write.
      const result = await request(path, { method: "PUT", body: JSON.stringify({ message: `Publish scoreboard v${data.version}`, content: Buffer.from(html).toString("base64"), branch, ...(remote?.sha ? { sha: remote.sha } : {}) }) });
      if (!result.ok) {
        if ([400, 401, 403, 404, 409, 422, 429].includes(result.status)) delete state.attempt;
        state.error = `GitHub 上传失败（HTTP ${result.status}），请检查仓库、分支及 Contents 写入权限后重试`;
        return;
      }
      const receipt = await result.json() as { content?: { sha?: string } };
      if (receipt.content?.sha !== attempt.sha) throw new Error("unconfirmed receipt");
      state.uploaded = attempt;
      delete state.attempt;
      delete state.error;
    } catch {
      state.error = state.attempt
        ? "上传结果不确定，将先读取 GitHub 文件核对；不会自动重发"
        : "无法读取 GitHub，请检查网络、仓库、分支及凭据；稍后自动重试";
    } finally {
      this.busy.delete(id);
      // Deletion is allowed while an upload is running; don't resurrect a deleted competition.
      if (this.database.sqlite.prepare("SELECT id FROM competitions WHERE id=?").get(id)) {
        this.write(id, state);
        this.changed(id);
      }
    }
  }
}
