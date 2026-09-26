import { expect, test } from "@playwright/test";
import { renderPublicScorePage, type PublicScoreData } from "../../apps/server/src/public-score-page.js";

test("public scoreboard updates automatically, preserves scroll and keeps the last result on network failure", async ({ page }) => {
  const data: PublicScoreData = {
    competitionId: "public-e2e", name: "公开成绩自动更新", mode: "work", status: "running", version: 1, sequence: 1,
    generatedAt: "2026-09-26T01:00:00Z", headers: ["变化", "名次", "总分", "选手", ...Array.from({ length: 13 }, (_, i) => `SR${i + 1}`)],
    rows: Array.from({ length: 35 }, (_, i) => ({ cells: [
      { text: "—", style: "plain" }, { text: String(i + 1), style: "plain" }, { text: "15", style: "plain" },
      { text: i ? `选手 ${i}` : "</script><script>window.pwned=true</script>", style: "plain" },
      ...Array.from({ length: 13 }, () => ({ text: "#1 / 15 分", style: "gold" as const }))
    ] }))
  };
  let html = renderPublicScorePage(data);
  let offline = false;
  await page.route("**/public-score-e2e/**", route => offline ? route.abort() : route.fulfill({ contentType: "text/html", body: html }));
  await page.clock.install();
  await page.goto("/public-score-e2e/");
  await expect(page.getByRole("heading", { name: data.name })).toBeVisible();
  await expect(page.locator("#meta")).toContainText("榜单 v1");
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  const scroll = await page.locator(".table-wrap").evaluate(element => { element.scrollTop = 200; element.scrollLeft = 250; return { top: element.scrollTop, left: element.scrollLeft }; });
  html = renderPublicScorePage({ ...data, sequence: 2, version: 2, generatedAt: "2026-09-26T01:06:00Z" });
  await page.clock.fastForward(15_001);
  await expect(page.locator("#meta")).toContainText("榜单 v2");
  expect(await page.locator(".table-wrap").evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(scroll);
  html = renderPublicScorePage(data); // A stale CDN response must not roll back the displayed revision.
  await page.clock.fastForward(15_001);
  await expect(page.locator("#meta")).toContainText("榜单 v2");
  offline = true;
  await page.clock.fastForward(15_001);
  await expect(page.locator("#connection")).toContainText("暂时无法检查更新");
  await expect(page.locator("#meta")).toContainText("榜单 v2");
  offline = false;
  html = renderPublicScorePage({ ...data, sequence: 3, version: 3, status: "finished" });
  await page.clock.fastForward(15_001);
  await expect(page.locator("#meta")).toContainText("榜单 v3");
  await expect(page.locator("#meta")).toContainText("比赛已结束");
  await page.screenshot({ path: `.runtime/public-score-${test.info().project.name.replaceAll(" ", "-")}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: data.name })).toBeVisible();
  expect(await page.locator("th").nth(3).evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(150);
  await page.screenshot({ path: `.runtime/public-score-mobile-${test.info().project.name.replaceAll(" ", "-")}.png` });
});

test("referee can configure public scores and preview test scores without uploading", async ({ page }) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByRole("button", { name: "新建比赛" })).toBeVisible();
  await page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem("ballance-console-session")!) as { token: string };
    const response = await fetch("/api/v1/sessions/control", { method: "POST", headers: { authorization: `Bearer ${session.token}` } });
    if (!response.ok) throw new Error("control failed");
    sessionStorage.setItem("ballance-console-session", JSON.stringify(await response.json()));
  });
  await page.reload();
  const panel = page.locator(".create-panel");
  const name = `公开成绩配置-${Date.now()}`;
  await panel.getByLabel("名称", { exact: true }).fill(name);
  await panel.getByLabel("模式").selectOption("work");
  await panel.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue(name);
  // Publish the config through the same authenticated API, without starting a real client.
  await page.evaluate(async competitionName => {
    const session = JSON.parse(sessionStorage.getItem("ballance-console-session")!) as { token: string };
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const list = await (await fetch("/api/v1/competitions", { headers })).json() as { data: { id: string; name: string; stateVersion: number }[] };
    const competition = list.data.find(c => c.name === competitionName)!;
    const response = await fetch(`/api/v1/competitions/${competition.id}/publish`, { method: "POST", headers, body: JSON.stringify({ expectedStateVersion: competition.stateVersion, idempotencyKey: crypto.randomUUID() }) });
    if (!response.ok) throw new Error("publish config failed");
  }, name);
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const publicPanel = page.locator(".public-score-panel");
  await publicPanel.getByLabel("GitHub 用户名 / 组织").fill("referee");
  await publicPanel.getByLabel("公开成绩仓库", { exact: true }).fill("ballance-scores");
  await publicPanel.getByLabel("发布分支").fill("public-scores");
  await publicPanel.getByLabel("开启自动发布到公开仓库").check();
  // No token is supplied: no outbound call is permitted.
  await publicPanel.getByRole("button", { name: "保存公开成绩设置" }).click();
  await expect(publicPanel.getByText("等待填写上传凭据", { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  await expect(publicPanel.getByLabel("公开成绩仓库", { exact: true })).toHaveValue("ballance-scores");
  await publicPanel.getByRole("button", { name: "预览公开成绩" }).click();
  await expect(page.frameLocator('iframe[title="公开成绩预览"]').getByRole("heading", { name })).toBeVisible();
  // A concurrent settings update must not silently advance an in-progress form's revision.
  await page.evaluate(async competitionName => {
    const session = JSON.parse(sessionStorage.getItem("ballance-console-session")!) as { token: string };
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const list = await (await fetch("/api/v1/competitions", { headers })).json() as { data: { id: string; name: string }[] };
    const id = list.data.find(c => c.name === competitionName)!.id;
    const path = `/api/v1/competitions/${id}/public-score`;
    const state = await (await fetch(path, { headers })).json() as { data: { revision: number; settings: object } };
    const response = await fetch(path, { method: "PUT", headers, body: JSON.stringify({ ...state.data.settings, enabled: false, expectedRevision: state.data.revision, idempotencyKey: crypto.randomUUID() }) });
    if (!response.ok) throw new Error("concurrent settings update failed");
  }, name);
  await expect(publicPanel.getByText("自动发布未开启", { exact: true })).toBeVisible({ timeout: 8_000 });
  await publicPanel.getByRole("button", { name: "保存公开成绩设置" }).click();
  await expect(publicPanel.getByRole("alert")).toContainText("公开成绩设置已变化");
  await panel.getByLabel("名称", { exact: true }).fill(`公开成绩测试-${Date.now()}`);
  await panel.getByLabel("模式").selectOption("test");
  await panel.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue(/公开成绩测试/);
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  await expect(publicPanel.getByText("测试模式仅支持本地预览，不上传 GitHub。")).toBeVisible();
  await expect(publicPanel.getByLabel("GitHub 上传凭据")).toHaveCount(0);
  await publicPanel.getByRole("button", { name: "预览公开成绩" }).click();
  await expect(page.frameLocator('iframe[title="公开成绩预览"]').getByRole("heading")).toContainText("【测试预览】");
});
