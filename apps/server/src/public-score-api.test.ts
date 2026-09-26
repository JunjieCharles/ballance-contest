import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

it("requires local control for publishing, rejects test uploads, and exposes only a safe authenticated preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "ballance-public-api-"));
  const network = vi.fn<typeof fetch>();
  const app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot: root, publicScoreTransport: network });
  try {
    const login = async (tabId: string) => (await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId } })).json<{ token: string }>().token;
    const token = await login("controller");
    const observer = await login("observer");
    const headers = { authorization: `Bearer ${token}` };
    const record = (await app.inject({ method: "POST", url: "/api/v1/competitions", headers, payload: { name: "测试公开榜单", mode: "test", idempotencyKey: "new" } })).json<{ data: { id: string } }>().data;
    const url = `/api/v1/competitions/${record.id}/public-score`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url: `${url}/preview` })).statusCode).toBe(401);
    const payload = { owner: "referee", repository: "scores", branch: "main", enabled: true, expectedRevision: 0, idempotencyKey: "setup" };
    expect((await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${observer}` }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url, headers: { ...headers, origin: "https://attacker.example" }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url, headers, payload })).statusCode).toBe(409);
    const preview = await app.inject({ url: `${url}/preview`, headers });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('"mode":"test"');
    expect(preview.body).not.toContain("bootstrap");
    expect(network).not.toHaveBeenCalled();
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
