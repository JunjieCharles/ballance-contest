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

const createCompetition = async (page: Page, name: string, mode: "work" | "test"): Promise<void> => {
  const createPanel = page.locator(".create-panel");
  await createPanel.getByLabel("名称", { exact: true }).fill(name);
  await createPanel.getByLabel("模式").selectOption(mode);
  await createPanel.getByRole("button", { name: "新建比赛" }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue(name);
};

const accelerateActiveTestRun = async (page: Page, competitionName: string, milliseconds = 9_000_000): Promise<void> => {
  await page.evaluate(async ({ name, duration }) => {
    const stored = sessionStorage.getItem("ballance-console-session");
    if (!stored) throw new Error("missing local session");
    const session = JSON.parse(stored) as { token: string };
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const competitions = await (await fetch("/api/v1/competitions", { headers })).json() as { data: Array<{ id: string; name: string }> };
    const competitionId = competitions.data.find((competition) => competition.name === name)?.id;
    if (!competitionId) throw new Error("missing competition");
    const snapshot = await (await fetch(`/api/v1/competitions/${competitionId}/snapshot`, { headers })).json() as { data: { testRun?: { runId: string } } };
    const runId = snapshot.data.testRun?.runId;
    if (!runId) throw new Error("missing run");
    const response = await fetch(`/api/v1/competitions/${competitionId}/test-runs/${runId}/automation/advance`, {
      method: "POST", headers, body: JSON.stringify({ milliseconds: duration })
    });
    if (!response.ok) throw new Error(`advance failed ${response.status}`);
  }, { name: competitionName, duration: milliseconds });
};

test("opens the authenticated local console without external requests", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText("Ballance 比赛控制台")).toBeVisible();
  await expect(page.getByText(/服务 0\.1\.0-dev/)).toBeVisible();
  await expect(page.locator(".create-panel").getByLabel("模式")).toHaveValue("work");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("edits per-stage scoring and replaces the stage draft through inline confirmation", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 单关配置 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await expect(page.getByText("配置完整，可以发布。")).toBeVisible();
  await page.getByRole("button", { name: "大型赛事" }).click();
  await page.getByRole("button", { name: "保存计分方案并应用到全部关卡" }).click();
  await expect(page.getByLabel("第 1 名计分")).toHaveValue("30");

  await page.getByRole("button", { name: "HS1–13 预设" }).click();
  const presetConfirmation = page.getByText("用 HS 1–13 整体替换当前关卡草稿。").locator("..");
  await expect(presetConfirmation).toBeVisible();
  await presetConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".stage-editor")).toHaveCount(13);
  await expect(page.locator(".stage-editor").nth(11).getByLabel("时限（分钟）")).toHaveValue("15");
  await expect(page.locator(".stage-editor").nth(12).getByLabel("时限（分钟）")).toHaveValue("15");

  const firstStage = page.locator(".stage-editor").first();
  await firstStage.getByLabel("名称").fill("决赛关");
  await firstStage.getByLabel("时限（分钟）").fill("12");
  await firstStage.getByLabel("单关计分").fill("50,30,20");
  await firstStage.getByLabel("单关计分").blur();
  await page.getByRole("button", { name: "保存关卡列表" }).click();
  await expect(page.locator("header")).toContainText("草稿已保存");

  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator("header")).toContainText("发布检查通过");
  await page.getByRole("button", { name: "玩家", exact: true }).click();
  await expect(page.getByText("尚未观察到普通玩家；无需在比赛开始前手工登记。")).toBeVisible();
});

test("runs the 20-player sandbox from the console and edits a score without losing the player", async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  let dialogOpened = false;
  page.on("request", (request) => { if (new URL(request.url()).hostname !== "127.0.0.1") externalRequests.push(request.url()); });
  page.on("dialog", async (dialog) => { dialogOpened = true; await dialog.dismiss(); });
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 综合沙盒 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /20 人小型综合沙盒/ }).click();
  await expect(page.locator(".behavior-card")).toHaveCount(20);
  await expect(page.getByText("自动化仅在“控制台”启停。")).toBeVisible();
  await expect(page.getByRole("button", { name: "启用自动化" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "故障注入" })).toHaveCount(0);
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText(/虚拟时钟：0:00/)).toBeVisible();

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "启用自动化" }).click();
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("Ready");
  await accelerateActiveTestRun(page, name);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核");
  await expect(page.locator(".attention-card").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("Crash");
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("标记 DNF");

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const rowsBefore = await page.locator(".scoreboard tbody tr").count();
  expect(rowsBefore).toBe(20);
  const editable = page.locator(".scoreboard .cell-button").filter({ hasText: /^#/ }).first();
  await editable.click();
  const editor = page.locator(".score-cell-editor").first();
  await editor.getByLabel(/新名次/).fill("2");
  await editor.getByRole("button", { name: "保存名次" }).click();
  const inlineConfirmation = editor.getByRole("group", { name: "保存名次确认" });
  await expect(inlineConfirmation).toContainText("生成新的榜单版本");
  await inlineConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.locator("header")).toContainText("成绩修订版本已生成");
  await expect(page.locator(".scoreboard tbody tr")).toHaveCount(rowsBefore);

  const dnfEditorButton = page.locator(".scoreboard .cell-button").filter({ hasText: /^#/ }).nth(1);
  await dnfEditorButton.click();
  const secondEditor = page.locator(".score-cell-editor").first();
  await secondEditor.getByRole("button", { name: "设为 DNF" }).click();
  await secondEditor.getByRole("group", { name: "设为 DNF确认" }).getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".scoreboard tbody tr")).toHaveCount(rowsBefore);
  expect(dialogOpened).toBe(false);
  expect(externalRequests).toEqual([]);
});

test("shows disabled reasons, shared scheduling controls and inline end confirmation", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 控制矩阵 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /30 人大型综合沙盒/ }).click();
  await expect(page.getByText("30 人 · 2 个场景故障")).toBeVisible();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText(/虚拟时钟：0:00/)).toBeVisible();
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByLabel("改期时间（UTC+8）")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready 改期" })).toBeDisabled();
  await expect(page.getByText("当前没有可改期的 Ready 计划")).toBeVisible();
  await expect(page.getByRole("button", { name: "关卡时限改期" })).toBeDisabled();
  await expect(page.getByText("当前没有开放的成绩接收窗口").first()).toBeVisible();

  await page.getByRole("button", { name: "启用自动化" }).click();
  await accelerateActiveTestRun(page, name);
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: "结束比赛" }).click();
  const confirmation = page.getByRole("group", { name: "结束比赛确认" });
  await expect(confirmation).toContainText("目标：");
  await expect(confirmation).toContainText("状态版本");
  await confirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.locator("header")).toContainText("比赛已结束");
});
