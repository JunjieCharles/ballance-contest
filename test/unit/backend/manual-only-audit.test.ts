import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";

it("completes all stages and archives without enabling automation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ballance-manual-audit-"));
  const cleanAuditRoot = () => {
    if (!root.startsWith(join(tmpdir(), "ballance-manual-audit-"))) throw new Error("Unexpected audit root");
    rmSync(root, { recursive: true, force: true });
  };
  const app = await buildApp({ bootstrapToken: "audit", serveStatic: false, dataRoot: root });
  try {
    const session = await app.inject({ method: "POST", url: "/api/v1/sessions/bootstrap", payload: { bootstrapToken: "audit", tabId: "audit" } });
    const headers = { authorization: `Bearer ${session.json().token}` };
    const post = async (url: string, payload: object) => {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().data;
    };
    const created = await post("/api/v1/competitions", { name: "manual audit", mode: "test", idempotencyKey: "create" });
    const base = `/api/v1/competitions/${created.id}`;
    await post(`${base}/publish`, { expectedStateVersion: 0, idempotencyKey: "publish" });
    const run = await post(`${base}/test-runs/from-scenario`, { scenarioId: "normal-player-roster" });
    const snapshot = async () => (await app.inject({ method: "GET", url: `${base}/snapshot`, headers })).json().data;
    let serial = 0;
    const execute = async (type: string) => {
      const before = await snapshot();
      const availability = before.runtime.availableActions.find((item: { action: string }) => item.action === type);
      expect(before.runtime.automationEnabled).toBe(false);
      expect(availability?.enabled, JSON.stringify(availability)).toBe(true);
      const confirmation = type === "cheat-off" ? {} : await post(`${base}/confirmations`, {
        kind: type === "manual-go" ? "manual-go" : "manual-action", intent: type, target: availability.targetStageId ?? created.id
      });
      await post(`${base}/actions`, { expectedStateVersion: before.competition.stateVersion, idempotencyKey: `action-${serial++}`, action: {
        type, ...(type === "force-next-stage" ? { stageId: availability.targetStageId } : {}), ...(type === "cheat-off" ? {} : { confirmationToken: confirmation.token, impactHash: confirmation.impactHash })
      } });
    };
    const initial = await snapshot();
    for (const stage of initial.config.stages) {
    await execute("ready");
    await execute("cheat-off");
    await execute("manual-go");
    await post(`${base}/test-runs/${run.runId}/automation/advance`, { milliseconds: 3_000 });
    const running = await snapshot();
    expect(running.runtime.automationEnabled).toBe(false);
    expect(running.runtime.currentStageId).toBe(stage.id);
    await post(`${base}/test-runs/${run.runId}/automation/advance`, { milliseconds: 90_000 });
    await execute("end-stage");
    }
    const final = await snapshot();
    expect(final.runtime.phase).toBe("review");
    expect(final.runtime.automationEnabled).toBe(false);
    expect(final.runtime.attempts).toHaveLength(initial.config.stages.length);
    expect(final.competition.status).toBe("finished");
    expect(final.scoreboardVersions.length).toBeGreaterThan(0);
    await post(`${base}/archive`, { version: final.scoreboardVersions.at(-1).version });
    expect((await snapshot()).competition.status).toBe("archived");
  } finally {
    await app.close();
    cleanAuditRoot();
  }
});
