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

const accelerateActiveTestRun = async (page: Page, competitionName: string): Promise<void> => {
  await page.evaluate(async (name) => {
    const stored = sessionStorage.getItem("ballance-console-session");
    if (!stored) throw new Error("missing local session");
    const session = JSON.parse(stored) as { token: string };
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const competitionsResponse = await fetch("/api/v1/competitions", { headers });
    const competitions = await competitionsResponse.json() as { data: Array<{ id: string; name: string }> };
    const competitionId = competitions.data.find((competition) => competition.name === name)?.id;
    if (!competitionId) throw new Error("missing competition");
    const snapshotResponse = await fetch(`/api/v1/competitions/${competitionId}/snapshot`, { headers });
    const snapshot = await snapshotResponse.json() as { data: { testRun?: { runId: string } } };
    const runId = snapshot.data.testRun?.runId;
    if (!runId) throw new Error("missing test run");
    for (let stage = 1; stage <= 13; stage += 1) {
      for (const milliseconds of [15_000, stage === 13 ? 900_000 : 600_000]) {
        const response = await fetch(`/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, {
          method: "POST",
          headers,
          body: JSON.stringify({ milliseconds })
        });
        if (!response.ok) throw new Error(`advance failed ${response.status}`);
      }
    }
  }, competitionName);
};

test("opens the authenticated two-mode console without external requests", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText("Ballance 比赛控制台")).toBeVisible();
  await expect(page.getByText(/服务 0\.1\.0-dev/)).toBeVisible();
  await expect(page.locator(".mode-badge")).toHaveText(/未选择比赛|测试模式|工作模式/);
  await expect(page.getByLabel("模式")).toHaveValue("work");
  await expect(page.getByLabel("模式").locator("option")).toHaveText(["工作模式（默认）", "测试模式"]);
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("keeps the current competition selected and publishes without preregistration", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);

  const competitionName = `E2E 自动登记 ${testInfo.project.name}`;
  await page.getByLabel("名称", { exact: true }).fill(competitionName);
  await page.getByLabel("模式").selectOption("test");
  await page.getByRole("button", { name: "新建比赛" }).click();

  await expect(page.getByLabel("比赛名称")).toHaveValue(competitionName);
  await expect(page.locator(".tabs button.active")).toHaveText("比赛配置");
  await expect(page.getByText("配置完整，可以发布。")).toBeVisible();
  await expect(page.getByLabel("MockClient 登录名")).toHaveCount(0);
  await expect(page.getByText("MockClient 会自动强制使用旁观模式登录，无需单独配置登录名。")).toBeVisible();
  await expect(page.getByText("参赛者无需预登记，系统会根据玩家上下线和 MockClient 列表自动登记。")).toBeVisible();
  await expect(page.getByRole("button", { name: "小型赛事" })).toBeVisible();
  await expect(page.locator(".raw-log-body")).toBeVisible();
  await page.getByRole("button", { name: "最小化" }).click();
  await page.getByRole("button", { name: "大型赛事" }).click();
  await page.getByRole("button", { name: "保存积分方案并应用全部关卡" }).click();
  await expect(page.locator("header")).toContainText("草稿已保存");
  await expect(page.getByLabel("第 1 名积分")).toHaveValue("30");
  await expect(page.getByText("最后计分名次：第 15 名")).toBeVisible();

  const selectedCompetition = page.locator(".competition-list button").filter({ hasText: competitionName });
  await selectedCompetition.click();
  await expect(page.getByRole("heading", { name: "基本信息" })).toBeVisible();
  await expect(page.getByText("请选择或新建比赛")).toHaveCount(0);

  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator("header")).toContainText("发布检查通过，比赛已发布");

  await page.getByRole("button", { name: "玩家", exact: true }).click();
  await expect(page.getByText("尚未观察到普通玩家；无需在比赛开始前手工登记。")).toBeVisible();
  await page.getByLabel("玩家 ID（游戏内名称）").fill("Silent_Snow");
  await page.getByLabel("排行榜显示名").fill("渴望新地图");
  await page.getByRole("button", { name: "保存映射" }).click();
  await expect(page.getByRole("cell", { name: "Silent_Snow" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "渴望新地图" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "等待上线" })).toBeVisible();
});

test("creates a visual test run, plays the scenario, exports, and keeps work mode isolated", async ({ page }) => {
  const externalRequests: string[] = [];
  let snapshotRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
    if (url.pathname.endsWith("/snapshot")) snapshotRequests += 1;
  });

  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);

  await page.getByLabel("名称", { exact: true }).fill("E2E 测试模式");
  await page.getByLabel("模式").selectOption("test");
  await page.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue("E2E 测试模式");
  await expect(page.locator(".mode-badge")).toHaveText("测试模式");
  await expect(page.locator(".watermark")).toHaveText("测试数据");
  await expect(page.locator(".raw-log-body")).toBeVisible();
  await expect(page.locator(".raw-log-window")).toHaveCSS("resize", "both");
  await page.getByRole("button", { name: "最小化" }).click();

  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /独立测试玩家沙盒/ }).click();
  await expect(page.locator(".behavior-card").filter({ hasText: "游戏高手" }).first()).toBeVisible();
  await expect(page.getByText("场景只定义玩家的行为模型")).toBeVisible();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await page.getByRole("button", { name: "启用自动化" }).click();
  await expect(page.getByText("阶段").locator("..")).toContainText("Ready");
  await expect(page.getByText(/1× 实时运行中/)).toBeVisible();
  await accelerateActiveTestRun(page, "E2E 测试模式");
  await expect(page.getByText("阶段").locator("..")).toContainText("比赛复核");
  await expect(page.getByText("本轮计划起跑（UTC+8）").locator("..")).not.toContainText("未设置");

  await page.getByRole("button", { name: "展开" }).click();
  await expect(page.locator(".raw-log-body")).toContainText("游戏高手");
  await expect(page.locator(".raw-log-body")).toContainText("did not finish Level 13");
  await expect(page.locator(".raw-log-body")).toContainText("Level 13 - Go!");

  const logWindow = page.locator(".raw-log-window");
  const logTitle = page.locator(".raw-log-title");
  const beforeDrag = await logWindow.boundingBox();
  const titleBounds = await logTitle.boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(titleBounds).not.toBeNull();
  await page.mouse.move(titleBounds!.x + 20, titleBounds!.y + 20);
  await page.mouse.down();
  await page.mouse.move(titleBounds!.x - 60, titleBounds!.y - 30);
  await page.mouse.up();
  const afterDrag = await logWindow.boundingBox();
  expect(afterDrag!.x).toBeLessThan(beforeDrag!.x);
  expect(afterDrag!.y).toBeLessThan(beforeDrag!.y);
  await page.getByRole("button", { name: "最小化" }).click();

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  await expect(page.getByRole("cell", { name: "游戏高手", exact: true })).toBeVisible();
  await page.getByTitle("修改 游戏高手 的 SR 1 名次").click();
  await page.getByLabel("expert SR 1 新名次").fill("2");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("榜单修订版本已生成")).toBeVisible();
  await expect(page.getByText("expert:sr-1")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  await expect.poll(async () => (await download).suggestedFilename()).toContain(".csv");

  await page.getByLabel("名称", { exact: true }).fill("E2E 工作模式");
  await page.getByLabel("模式").selectOption("work");
  await page.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue("E2E 工作模式");
  await expect(page.locator(".mode-badge")).toHaveText("工作模式");
  await expect(page.locator(".watermark")).toHaveCount(0);
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await expect(page.getByText("工作模式不提供测试运行控制。")).toBeVisible();
  expect(snapshotRequests).toBeLessThan(20);
  expect(externalRequests).toEqual([]);
});
