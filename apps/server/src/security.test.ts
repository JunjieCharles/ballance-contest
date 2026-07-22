import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { assertRawCommandAllowed } from "./referee-action-service.js";

describe("local security and process ownership", () => {
  let dataRoot = "";

  beforeEach(() => { dataRoot = mkdtempSync(join(tmpdir(), "ballance-security-")); });
  afterEach(() => {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
    dataRoot = "";
  });

  it("rejects forcenextrestart even through the high-risk raw command path", () => {
    expect(() => assertRawCommandAllowed(" forcenextrestart ")).toThrow(/服务器所有地图/);
    expect(() => assertRawCommandAllowed("list")).not.toThrow();
  });
  it("rejects cross-site writes even when a bearer token is present", async () => {
    const app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    try {
      const session = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "bootstrap", tabId: "tab" } });
      const token = session.json<{ token: string }>().token;
      const response = await app.inject({
        method: "POST", url: "/api/v1/competitions", headers: { authorization: `Bearer ${token}`, origin: "https://hostile.example" },
        payload: { name: "Injected", mode: "work", idempotencyKey: "evil" }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
    } finally {
      await app.close();
    }
  });

  it("only exposes development shutdown when configured and requires the random token", async () => {
    let shutdowns = 0;
    const app = await buildApp({
      bootstrapToken: "bootstrap", serveStatic: false,
      dataRoot,
      devShutdown: { token: "a-secure-development-token", onShutdown: () => { shutdowns += 1; } }
    });
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/dev/shutdown", payload: { token: "wrong" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/v1/dev/shutdown", payload: { token: "a-secure-development-token" } })).statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdowns).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("fails on fixed port occupation and never falls back to a random port", async () => {
    const blocker = createServer();
    const ownsBlocker = await new Promise<boolean>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(38623, "127.0.0.1", () => resolve(true));
    }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") return false;
      throw error;
    });
    const app = await buildApp({ bootstrapToken: "bootstrap", serveStatic: false, dataRoot });
    try {
      await expect(app.listen({ host: "127.0.0.1", port: 38623 })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(app.server.address()).toBeNull();
    } finally {
      await app.close();
      if (ownsBlocker) await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not expose files outside the built web root through encoded separators", async () => {
    const app = await buildApp({ bootstrapToken: "bootstrap", dataRoot });
    try {
      for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e%5cpackage.json", "/..%252f..%252fpackage.json"]) {
        const response = await app.inject({ method: "GET", url: path });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain('"workspaces"');
      }
    } finally {
      await app.close();
    }
  });
});
