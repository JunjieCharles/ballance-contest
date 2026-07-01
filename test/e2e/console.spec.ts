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
  await expect(page.locator("header")).toContainText("实时已连接");
  await expect(page.getByRole("button", { name: "发布比赛" })).toBeEnabled();
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
  await page.getByRole("button", { name: "大型赛事预设" }).click();
  const scoringPresetConfirmation = page.locator(".grid.two .panel .inline-confirm").filter({ hasText: "用大型赛事预设覆盖当前计分" });
  await expect(scoringPresetConfirmation).toBeVisible();
  await scoringPresetConfirmation.getByRole("button", { name: "确认" }).click({ force: true });
  await expect(page.getByLabel("第 1 名计分")).toHaveValue(/30|20/);

  await page.getByLabel("第 1 名计分").fill("31");
  await page.getByRole("button", { name: "保存计分规则并覆盖单关配置" }).click();
  await expect(page.getByLabel("第 1 名计分")).toHaveValue("31");

  await page.getByRole("button", { name: "HS1–13 预设" }).click();
  const presetConfirmation = page.locator(".panel.wide .inline-confirm");
  await expect(presetConfirmation).toContainText("用 HS 1–13 整体替换当前关卡草稿。");
  await presetConfirmation.getByRole("button", { name: "确认" }).click({ force: true });
  await expect(page.locator(".stage-editor")).toHaveCount(13);

  const firstStage = page.locator(".stage-editor").first();
  await firstStage.getByLabel("名称").fill("决赛关");
  await firstStage.getByLabel("时限（分钟）").fill("12");
  await firstStage.getByLabel("单关计分").fill("50,30,20");
  await firstStage.getByLabel("单关计分").blur();
  await expect(page.getByRole("button", { name: "发布比赛" })).toBeDisabled();
  await page.getByRole("button", { name: "保存关卡列表" }).click();
  await expect(page.getByRole("button", { name: "发布比赛" })).toBeEnabled();

  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
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
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /20 人小型综合沙盒/ }).click();
  await expect(page.locator(".behavior-card")).toHaveCount(20);
  await expect(page.getByText("自动化仅在“控制台”启停。")).toBeVisible();
  await expect(page.getByRole("button", { name: "启动自动化" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "故障注入" })).toHaveCount(0);
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText(/虚拟时钟：0:00/)).toBeVisible();

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "启动自动化" }).click();
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("准备检查");
  await accelerateActiveTestRun(page, name);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核");
  await expect(page.locator(".attention-card").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("Crash");
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("标记 DNF");

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const rowsBefore = await page.locator(".scoreboard tbody tr").count();
  expect(rowsBefore).toBe(20);
  const firstStageResults = await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents();
  expect(firstStageResults.filter((value) => value.trim().startsWith("#")).length).toBeGreaterThan(12);
  const editable = page.locator(".scoreboard .cell-button").filter({ hasText: /^#/ }).first();
  await editable.click();
  const editor = page.locator(".score-cell-editor").first();
  await editor.getByLabel(/新名次/).fill("2");
  await expect(editor.getByLabel("其他玩家是否顺延")).toBeChecked();
  await editor.getByRole("button", { name: "保存名次" }).click();
  const inlineConfirmation = editor.getByRole("group", { name: "保存名次确认" });
  await expect(inlineConfirmation).toContainText("生成新的榜单版本");
  await expect(inlineConfirmation).toContainText("受影响玩家");
  await inlineConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.locator("header")).toContainText("成绩修订版本已生成");
  await expect(page.locator(".scoreboard tbody tr")).toHaveCount(rowsBefore);
  await expect(page.locator(".score-cell-editor")).toHaveCount(0);

  const secondRow = page.locator(".scoreboard tbody tr").nth(1);
  const dnfEditorButton = secondRow.locator(".cell-button").filter({ hasText: /^#/ }).first();
  await dnfEditorButton.click();
  const secondEditor = secondRow.locator(".score-cell-editor");
  await expect(secondEditor).toBeVisible();
  const dnfButton = secondEditor.getByRole("button", { name: "设为 DNF" });
  await expect(dnfButton).toBeVisible();
  await dnfButton.click();
  const dnfConfirmation = secondEditor.locator(".inline-confirm");
  await expect(dnfConfirmation).toContainText("生成新的榜单版本");
  await dnfConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".scoreboard tbody tr")).toHaveCount(rowsBefore);
  await page.reload();
  await expect(page.locator(".competition-list button.selected")).toContainText(name);
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  await expect(page.locator(".scoreboard tbody tr")).toHaveCount(rowsBefore);
  expect(dialogOpened).toBe(false);
  expect(externalRequests).toEqual([]);
});

test("resizes the raw client log window from the top-left handle", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 日志浮窗 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  const rawLog = page.getByRole("complementary", { name: "原始客户端日志" });
  const handle = page.getByRole("button", { name: "拖动左上角缩放原始客户端日志" });
  const before = await rawLog.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();
  if (!before || !handleBox) return;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 30, handleBox.y + 20);
  await page.mouse.up();
  const after = await rawLog.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.width).toBeLessThan(before.width);
  expect(after?.height).toBeLessThan(before.height);
});

test("restarts the current stage and unlocks its score review only after the next Ready", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 重赛与修订边界 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /普通玩家场景/ }).click();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "启动自动化" }).click();
  await accelerateActiveTestRun(page, name, 300_000);
  await expect(page.getByRole("button", { name: "重赛本关" })).toBeEnabled();

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const firstStageCell = page.locator(".scoreboard tbody tr").first().locator("td").nth(4).getByRole("button");
  await expect(firstStageCell).toBeDisabled();
  await expect(firstStageCell).toHaveAttribute("title", /进入下一关 Ready 后才能修订/);
  expect((await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(true);

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "重赛本关" }).click();
  const confirmation = page.getByRole("group", { name: "重赛本关确认" });
  await expect(confirmation).toContainText("当前尝试将作废并立即退出有效榜单");
  await expect(confirmation).toContainText("只有新 Go 才创建新尝试");
  await confirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("Ready");
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  expect((await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(false);

  await accelerateActiveTestRun(page, name, 240_000);
  await expect.poll(async () => (await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(true);
  await accelerateActiveTestRun(page, name, 180_000);
  const previousStageCell = page.locator(".scoreboard tbody tr").first().locator("td").nth(4).getByRole("button");
  await expect(previousStageCell).toBeEnabled();
});

test("shows disabled reasons, shared scheduling controls and automatic review completion", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 控制矩阵 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动自动化" })).toBeDisabled();
  await page.getByRole("button", { name: "比赛配置", exact: true }).click();
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
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

  await page.getByRole("button", { name: "启动自动化" }).click();
  await accelerateActiveTestRun(page, name);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核");
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("finished");
  await expect(page.getByRole("button", { name: "结束比赛" })).toBeDisabled();
});
