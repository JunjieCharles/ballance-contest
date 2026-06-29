import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const acquireControl = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const stored = sessionStorage.getItem("ballance-console-session");
    if (!stored) throw new Error("missing local session");
    const session = JSON.parse(stored) as { token: string };
    const response = await fetch("/api/v1/sessions/control", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: "{}"
    });
    if (!response.ok) throw new Error(`control failed ${response.status}`);
    sessionStorage.setItem("ballance-console-session", JSON.stringify(await response.json()));
  });
  await page.reload();
  await expect(page.getByText("已取得控制权")).toBeVisible();
};

test("opens the two-mode console through a local authenticated session", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText("Ballance 比赛控制台")).toBeVisible();
  await expect(page.getByText(/服务 0\.1\.0-dev/)).toBeVisible();
  await expect(page.locator(".mode-badge")).toHaveText(/未选择比赛|测试模式|工作模式/);
  await expect(page.getByLabel("模式")).toHaveValue("test");
  await expect(page.getByLabel("模式").locator("option")).toHaveText(["测试模式", "工作模式"]);
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("E2E-TEST-001/002 creates a test run, plays the main scenario and keeps work mode isolated", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  await page.getByLabel("名称").fill("E2E 测试模式");
  await page.getByLabel("模式").selectOption("test");
  await page.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.locator(".mode-badge")).toHaveText("测试模式");
  await expect(page.locator(".watermark")).toHaveText("测试数据");
  await expect(page.getByText("真实进程").locator("..")).toContainText("禁用");
  await expect(page.getByText("真实命令").locator("..")).toContainText("禁用");

  const scenario = readFileSync(resolve("test/fixtures/scenarios/three-stage-main/scenario.json"), "utf8");
  await page.locator("textarea").fill(scenario);
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText("0 次尝试 · 0 个榜单版本 · 0 条异常")).toBeVisible();
  await page.getByRole("button", { name: "播放到底" }).click();
  await expect(page.getByText("3 次尝试 · 15 个榜单版本 · 1 条异常")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Alpha" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "55" })).toBeVisible();

  await page.getByLabel("名称").fill("E2E 工作模式");
  await page.getByLabel("模式").selectOption("work");
  await page.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.locator(".mode-badge")).toHaveText("工作模式");
  await expect(page.locator(".watermark")).toHaveCount(0);
  await expect(page.getByText("工作模式由本服务托管真实 MockClient")).toBeVisible();
  await expect(page.getByRole("button", { name: "创建测试运行" })).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
