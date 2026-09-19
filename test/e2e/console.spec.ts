import type {
  ActionAvailability,
  CompetitionSnapshot,
  ConfirmationSummary,
  RefereeActionId,
  WorkConnectionStatus,
  WorkConnectionView
} from "@ballance/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { APPLICATION_VERSION } from "@ballance/core";

const parseQuotedCsv = (csv: string): string[][] => csv.replace(/^\ufeff/, "").split("\r\n").map((line) =>
  [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => (match[1] ?? "").replaceAll('""', '"')));

const decodeXml = (value: string): string => value
  .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'");

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

const selectedCompetitionSnapshot = async (page: Page, competitionName: string): Promise<{ competitionId: string; snapshot: CompetitionSnapshot }> =>
  page.evaluate(async (name) => {
    const stored = sessionStorage.getItem("ballance-console-session");
    if (!stored) throw new Error("missing local session");
    const session = JSON.parse(stored) as { token: string };
    const headers = { authorization: `Bearer ${session.token}` };
    const competitions = await (await fetch("/api/v1/competitions", { headers })).json() as { data: Array<{ id: string; name: string }> };
    const competitionId = competitions.data.find((competition) => competition.name === name)?.id;
    if (!competitionId) throw new Error("missing competition");
    const response = await fetch(`/api/v1/competitions/${competitionId}/snapshot`, { headers });
    if (!response.ok) throw new Error(`snapshot failed ${response.status}`);
    const payload = await response.json() as { data: CompetitionSnapshot };
    return { competitionId, snapshot: payload.data };
  }, competitionName);

const connectionReason = (status: WorkConnectionStatus): string =>
  `比赛连接当前为 ${status}；完成认证并达到 healthy 后才能发送现场命令`;

const withWorkActionMatrix = (
  actions: readonly ActionAvailability[],
  status: WorkConnectionStatus,
  options: { offline?: boolean; mapsRegistering?: boolean } = {}
): ActionAvailability[] => {
  const lifecycleEnabled = !options.offline && ["healthy", "suspect", "blocked"].includes(status);
  const liveWritesEnabled = !options.offline && status === "healthy" && !options.mapsRegistering;
  const liveWriteReason = options.mapsRegistering
    ? "当前 MockClient 正在注册比赛地图；完成前不能发送现场命令"
    : connectionReason(status);
  const liveActions = new Set<RefereeActionId>([
    "notification", "force-next-stage-ready", "ready", "cheat-off", "manual-go", "kick", "raw-command", "force-next-stage", "force-reset-stage", "restart-stage", "mark-stage-started"
  ]);
  const resolved = (action: ActionAvailability, enabled: boolean, disabledReason: string): ActionAvailability => {
    const result = { ...action, enabled };
    if (enabled) delete result.disabledReason;
    else result.disabledReason = disabledReason;
    return result;
  };
  return actions.map((action) => {
    if (action.action === "start-work") return resolved({
      ...action,
      label: options.offline ? "恢复比赛现场" : "连接比赛服务器"
    }, Boolean(options.offline), "比赛连接已经启动");
    if (action.action === "reconnect-work" || action.action === "restart-work") {
      return resolved(action, lifecycleEnabled, options.offline ? "请先建立比赛连接" : "连接建立或恢复流程正在进行");
    }
    if (liveActions.has(action.action)) return resolved(action, liveWritesEnabled, liveWriteReason);
    return action;
  });
};

const withForcedStageRecoveryAvailable = (actions: readonly ActionAvailability[]): ActionAvailability[] => [...actions];

const workConnectionFixture = (
  status: WorkConnectionStatus,
  processGeneration: number,
  connectionGeneration: number
): WorkConnectionView => ({
  status,
  processGeneration,
  connectionGeneration,
  ...(["healthy", "suspect"].includes(status) ? { refereeConnectionId: `judge-${connectionGeneration}` } : {}),
  ...(status === "recovering" ? {
    recoveryStep: "cooldown" as const,
    recoveryStartedAt: "2026-07-22T10:00:00.000Z",
    cooldownUntil: "2026-07-22T10:00:20.000Z"
  } : {}),
  recentServerEvidence: {
    kind: status === "blocked" ? "authentication-failed" : status === "healthy" ? "list-verified" : "connected",
    occurredAt: "2026-07-22T10:00:00.000Z",
    detail: `${status} fixture evidence`,
    processGeneration,
    connectionGeneration
  }
});

const confirmationFixture = (
  input: { kind: ConfirmationSummary["kind"]; intent?: string; target?: string },
  stateVersion: number
): ConfirmationSummary => {
  const reconnect = input.intent === "reconnect-work";
  const restart = input.intent === "restart-work";
  return {
    token: `fixture-${input.intent ?? input.kind}`,
    kind: input.kind,
    expiresAt: "2099-01-01T00:00:00.000Z",
    target: input.target ?? "fixture-target",
    stateVersion,
    impactHash: `fixture-hash-${input.intent ?? input.kind}`,
    summary: "browser fixture confirmation",
    effect: {
      title: reconnect
        ? "使用当前 MockClient 软重新连接比赛服务器？"
        : restart
          ? "关闭并重启当前受管 MockClient？"
          : input.kind === "automation-command-resolution"
            ? "确认流程命令已经执行？"
            : "确认不再执行这条失败命令？",
      target: input.target ?? "fixture-target",
      currentPhase: "paused",
      consequences: reconnect
        ? ["冻结当前命令代；若连接仍健康，先精确请求本机 *ContestConsole 自身断开并核对 1101 回显，再只发送一次 reconnect。", "完成显式 list 身份核验后恢复健康。"]
        : restart
          ? ["有界关闭并在必要时强制结束受管进程树。", "冷却后只启动一次新实例并重新认证。"]
          : ["只记录裁判的本地处置，不发送新命令。"],
      irreversible: restart
    }
  };
};

const accelerateActiveTestRun = async (page: Page, competitionName: string, milliseconds = 9_000_000): Promise<string> =>
  page.evaluate(async ({ name, duration }) => {
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
    const advanced = await response.json() as { data: { phase: string } };
    return advanced.data.phase;
  }, { name: competitionName, duration: milliseconds });

const advanceUntilStageScore = async (
  page: Page,
  competitionName: string,
  stageId: string
): Promise<CompetitionSnapshot> => {
  for (let index = 0; index < 40; index += 1) {
    await accelerateActiveTestRun(page, competitionName, 15_000);
    const { snapshot } = await selectedCompetitionSnapshot(page, competitionName);
    if (snapshot.currentScoreboard.some((entry) => entry.stages[stageId] !== undefined)) return snapshot;
  }
  throw new Error(`no score observed for ${stageId}`);
};

test("opens the authenticated local console without external requests", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText("Ballance 比赛控制台")).toBeVisible();
  await expect(page.locator("header")).toContainText(`服务 ${APPLICATION_VERSION}`);
  await expect(page.locator(".create-panel").getByLabel("模式")).toHaveValue("work");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("uses grouped controls to adjust a paused plan and enter next Ready immediately", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 暂停控制 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "发布比赛", exact: true }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /普通玩家场景/ }).click();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  const operator = page.getByRole("heading", { name: "裁判操作", exact: true }).locator("..");
  const operatorBox = await operator.boundingBox();
  const activityBox = await page.getByRole("heading", { name: "流程动态与注意事项" }).locator("..").boundingBox();
  expect(activityBox!.x).toBeGreaterThan(operatorBox!.x);
  expect(Math.abs(activityBox!.y - operatorBox!.y)).toBeLessThan(2);
  await expect(operator.locator("h3")).toHaveText(["服务器连接", "自动化", "手动操作", "流程推进", "起跑保护", "本关重置", "时间操作", "改期（UTC+8）"]);
  await expect(operator.getByLabel("通知文本")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..").getByLabel("通知文本")).toBeVisible();
  await page.getByRole("button", { name: "启动自动化", exact: true }).click();
  await page.getByRole("button", { name: "暂停自动化", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复自动化", exact: true })).toBeEnabled();
  const clickConfirmed = async (label: string) => {
    const control = page.locator(".confirm-action").filter({ has: page.getByRole("button", { name: label, exact: true }) });
    await control.getByRole("button", { name: label, exact: true }).click();
    await control.getByRole("button", { name: "确认", exact: true }).click();
    await expect(control.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  };
  const initial = (await selectedCompetitionSnapshot(page, name)).snapshot.runtime.plannedReadyAtMs!;
  await clickConfirmed("T-60 延后 1 分钟");
  await expect.poll(async () => (await selectedCompetitionSnapshot(page, name)).snapshot.runtime.plannedReadyAtMs).toBe(initial + 60_000);
  await clickConfirmed("T-60 提前 1 分钟");
  await clickConfirmed("T-60 提前 1 分钟");
  await clickConfirmed("T-60 提前 1 分钟");
  await expect(page.getByRole("button", { name: "T-60 提前 1 分钟", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "T-60 改期", exact: true })).toBeDisabled();
  expect((await selectedCompetitionSnapshot(page, name)).snapshot.runtime.automationEnabled).toBe(false);
  await clickConfirmed("直接进入下一关 Ready+发令流程");
  await expect(page.getByText("关卡", { exact: true }).locator("..")).toContainText("SR2");
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("Ready");
  await accelerateActiveTestRun(page, name, 33_000);
  await page.getByRole("button", { name: "暂停自动化", exact: true }).click();
  const before = (await selectedCompetitionSnapshot(page, name)).snapshot.runtime.stageDeadlineAt!;
  await clickConfirmed("本关时限缩短 1 分钟");
  await expect.poll(async () => (await selectedCompetitionSnapshot(page, name)).snapshot.runtime.stageDeadlineAt).toBe(new Date(Date.parse(before) - 60_000).toISOString());
  await page.screenshot({ path: `.runtime/controls-${testInfo.project.name.replaceAll(" ", "-")}.png`, fullPage: true });
});

test("edits per-stage scoring and replaces the stage draft through inline confirmation", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 单关配置 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await expect(page.getByText("配置完整，可以发布。")).toBeVisible();
  for (const [label, type, points] of [
    ["中型赛事预设", "medium", [20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 1]],
    ["小型赛事预设", "small", [15, 12, 10, 8, 6, 5, 4, 3, 2, 1]]
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const confirmation = page.locator(".inline-confirm").filter({ hasText: `用${label}覆盖当前计分` });
    await confirmation.getByRole("button", { name: "确认", exact: true }).click();
    await expect.poll(async () => (await selectedCompetitionSnapshot(page, name)).snapshot.config.contestType).toBe(type);
    await page.reload();
    await expect(page.getByLabel("第 1 名计分")).toHaveValue(String(points[0]));
    const saved = (await selectedCompetitionSnapshot(page, name)).snapshot.config;
    expect(saved.scoring.points).toEqual(points);
    expect(saved.stages.every(stage => JSON.stringify(stage.scoring) === JSON.stringify(points) && stage.minimumScoringPlace === points.length)).toBe(true);
  }
  const protectionToggle = page.getByLabel("启用起跑保护");
  await expect(protectionToggle).toBeChecked();
  await protectionToggle.uncheck();
  await expect(page.getByText("未启用", { exact: true })).toBeVisible();
  await protectionToggle.check();
  const protectionStatus = page.getByText("已启用（默认）", { exact: true });
  await expect(protectionStatus).toBeVisible();
  const [protectionRowBox, protectionToggleBox, protectionStatusBox] = await Promise.all([
    protectionToggle.locator("..").boundingBox(),
    protectionToggle.boundingBox(),
    protectionStatus.boundingBox()
  ]);
  if (!protectionRowBox || !protectionToggleBox || !protectionStatusBox) throw new Error("起跑保护行未完成布局");
  expect(protectionStatusBox.x - (protectionToggleBox.x + protectionToggleBox.width)).toBeLessThanOrEqual(12);
  expect(protectionStatusBox.x + protectionStatusBox.width).toBeLessThanOrEqual(protectionRowBox.x + protectionRowBox.width + 1);
  await page.getByRole("button", { name: "大型赛事预设" }).click();
  const scoringPresetConfirmation = page.locator(".grid.two .panel .inline-confirm").filter({ hasText: "用大型赛事预设覆盖当前计分" });
  await expect(scoringPresetConfirmation).toBeVisible();
  await scoringPresetConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(scoringPresetConfirmation).toHaveCount(0);
  await expect(page.getByLabel("第 1 名计分")).toHaveValue(/30|20/);

  await page.getByLabel("第 1 名计分").fill("31");
  await page.getByRole("button", { name: "保存计分规则并覆盖单关配置" }).click();
  await expect(page.getByLabel("第 1 名计分")).toHaveValue("31");
  await expect(page.locator(".stage-editor").first().getByLabel("单关计分"))
    .toHaveValue("31,24,21,18,16,14,12,10,8,6,5,4,3,2,1");

  await page.getByRole("button", { name: "HS1–13 预设" }).click();
  const presetConfirmation = page.locator(".panel.wide .inline-confirm");
  await expect(presetConfirmation).toContainText("用 HS 1–13 整体替换当前关卡草稿。");
  await presetConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(presetConfirmation).toHaveCount(0);
  await expect(page.locator(".stage-editor")).toHaveCount(13);
  await expect(page.locator('.stage-editor[data-stage-id="hs-1"]')).toBeVisible();
  const secondHsStage = page.locator('.stage-editor[data-stage-id="hs-2"]');
  await expect(secondHsStage.getByLabel("第 2 关关卡模式")).toHaveValue("official-HS");
  await expect(secondHsStage.getByLabel("关卡号")).toHaveValue("2");

  const firstStage = page.locator(".stage-editor").first();
  await firstStage.getByLabel("第 1 关关卡模式").selectOption("custom-HS");
  await firstStage.getByLabel("自制图名称").fill("决赛关");
  await firstStage.getByLabel("关卡哈希").fill("e90b2f535c8bf881e9cb83129fba241d");
  await firstStage.getByLabel("时限（分钟）").fill("12");
  await firstStage.getByLabel("单关计分").fill("50,30,20");
  await firstStage.getByLabel("单关计分").blur();
  const customStage = page.locator('.stage-editor[data-stage-id="hs-1"]');
  const rowBox = await customStage.boundingBox();
  const handleBox = await customStage.getByRole("button", { name: "拖拽第 1 关" }).boundingBox();
  const targetBox = await page.locator(".stage-editor").nth(2).boundingBox();
  expect(rowBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!rowBox || !handleBox || !targetBox) return;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * .75, { steps: 6 });
  await expect(page.locator(".stage-drag-ghost")).toBeVisible();
  const ghostBox = await page.locator(".stage-drag-ghost").boundingBox();
  const placeholderBox = await page.locator(".stage-drop-placeholder").boundingBox();
  expect(ghostBox).not.toBeNull();
  expect(placeholderBox).not.toBeNull();
  expect(Math.abs((ghostBox?.height ?? 0) - rowBox.height)).toBeLessThan(2);
  expect(Math.abs((placeholderBox?.height ?? 0) - rowBox.height)).toBeLessThan(2);
  await page.mouse.up();
  await expect(page.locator(".stage-drag-ghost")).toHaveCount(0);
  await expect(page.locator(".stage-drop-placeholder")).toHaveCount(0);
  await expect(customStage.locator(".stage-order strong")).toHaveText("#3");
  await expect(customStage.getByLabel("自制图名称")).toHaveValue("决赛关");
  await expect(page.getByRole("button", { name: "发布比赛" })).toBeDisabled();
  await page.getByRole("button", { name: "保存关卡列表" }).click();
  await expect(page.getByRole("button", { name: "发布比赛" })).toBeEnabled();
  await page.reload();
  await expect(page.locator(".competition-list button.selected")).toContainText(name);
  await expect(page.locator('.stage-editor[data-stage-id="hs-1"] .stage-order strong')).toHaveText("#3");
  await expect(page.locator('.stage-editor[data-stage-id="hs-1"]').getByLabel("自制图名称")).toHaveValue("决赛关");

  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "玩家", exact: true }).click();
  await expect(page.getByText("尚未观察到普通玩家；无需在比赛开始前手工登记。")).toBeVisible();
});

test("hides test controls in work mode and keeps official-stage actions clear of scoring", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  await createCompetition(page, `E2E 工作布局 ${testInfo.project.name}`, "work");
  await expect(page.getByRole("button", { name: "测试", exact: true })).toHaveCount(0);
  await expect(page.getByText("工作模式不提供测试运行控制。")).toHaveCount(0);
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "连接比赛服务器" })).toBeVisible();
  await expect(page.getByRole("button", { name: "连接比赛服务器" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "启动自动化", exact: true })).toBeDisabled();
  await page.getByLabel("服务器地址", { exact: true }).fill("2.bmmo.win");
  await expect(page.getByRole("button", { name: "连接比赛服务器" })).toBeDisabled();
  await page.getByRole("button", { name: "保存地址", exact: true }).click();
  await expect(page.getByRole("button", { name: "连接比赛服务器" })).toBeEnabled();
  await expect(page.getByLabel("服务器地址", { exact: true })).toHaveValue("2.bmmo.win");
  await expect(page.getByRole("button", { name: /恢复工作运行|重启 MockClient/ })).toHaveCount(0);
  await page.getByRole("button", { name: "比赛配置", exact: true }).click();

  await expect(page.getByLabel("服务器", { exact: true })).toHaveCount(0);

  const official = page.locator(".stage-editor.official-stage").first();
  const scoringBox = await official.getByLabel("单关计分").boundingBox();
  const actionsBox = await official.locator(".stage-actions").boundingBox();
  expect(scoringBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  if (!scoringBox || !actionsBox) return;
  const overlaps = scoringBox.x < actionsBox.x + actionsBox.width
    && scoringBox.x + scoringBox.width > actionsBox.x
    && scoringBox.y < actionsBox.y + actionsBox.height
    && scoringBox.y + scoringBox.height > actionsBox.y;
  expect(overlaps).toBe(false);
  await page.getByRole("button", { name: "发布比赛", exact: true }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByLabel("服务器地址", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("服务器地址", { exact: true })).toHaveValue("2.bmmo.win");
  await page.getByLabel("服务器地址", { exact: true }).fill("1.bmmo.win");
  await page.getByRole("button", { name: "保存地址", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存地址", exact: true })).toBeDisabled();
  await page.locator(".competition-list button.selected").click();
  await expect(page.getByLabel("服务器地址", { exact: true })).toHaveValue("1.bmmo.win");
});

test("renders every work connection state and invalidates lifecycle confirmations on generation changes", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 工作连接六态 ${testInfo.project.name}`;
  await createCompetition(page, name, "work");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  const fixture = await selectedCompetitionSnapshot(page, name);
  let mockedSnapshot = structuredClone(fixture.snapshot);
  const originalActions = structuredClone(fixture.snapshot.runtime.availableActions);
  const confirmationIntents: string[] = [];

  await page.route(`**/api/v1/competitions/${fixture.competitionId}/snapshot`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: mockedSnapshot })
    });
  });
  await page.route(`**/api/v1/competitions/${fixture.competitionId}/confirmations`, async (route) => {
    const input = route.request().postDataJSON() as { kind: ConfirmationSummary["kind"]; intent?: string; target?: string };
    if (input.intent) confirmationIntents.push(input.intent);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: confirmationFixture(input, mockedSnapshot.competition.stateVersion) })
    });
  });

  const applyConnection = async (
    status: WorkConnectionStatus,
    processGeneration: number,
    connectionGeneration: number,
    offline = false
  ): Promise<void> => {
    mockedSnapshot = {
      ...mockedSnapshot,
      connectionSettings: { server: "1.bmmo.win", locked: true },
      runtime: {
        ...mockedSnapshot.runtime,
        workConnection: workConnectionFixture(status, processGeneration, connectionGeneration),
        availableActions: withWorkActionMatrix(originalActions, status, { offline })
      }
    };
    await page.locator(".competition-list button.selected").click();
    const connectionPanel = page.getByRole("region", { name: "工作模式连接状态" });
    await expect(connectionPanel).toHaveClass(new RegExp(`connection-${status}`));
    await expect(connectionPanel).toContainText(`进程代次${processGeneration}`);
    await expect(connectionPanel).toContainText(`连接代次${connectionGeneration}`);
    await expect(page.getByLabel("服务器地址", { exact: true })).toBeDisabled();
  };

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  const operatorPanel = page.locator(".grid.two > .panel").first();
  const playerActionPanel = page.getByRole("heading", { name: "玩家处置" }).locator("..");
  await playerActionPanel.getByText("高级操作：原始命令", { exact: true }).click();
  await playerActionPanel.getByRole("textbox", { name: "原始命令" }).fill("scores");
  const statusCases: ReadonlyArray<{ status: WorkConnectionStatus; label: string; lifecycleEnabled: boolean }> = [
    { status: "connecting", label: "正在连接", lifecycleEnabled: false },
    { status: "authenticating", label: "正在认证", lifecycleEnabled: false },
    { status: "healthy", label: "连接健康", lifecycleEnabled: true },
    { status: "suspect", label: "连接可疑", lifecycleEnabled: true },
    { status: "recovering", label: "正在恢复", lifecycleEnabled: false },
    { status: "blocked", label: "连接已阻断", lifecycleEnabled: true }
  ];
  for (const [index, item] of statusCases.entries()) {
    await applyConnection(item.status, 3, 20 + index);
    const connectionPanel = page.getByRole("region", { name: "工作模式连接状态" });
    await expect(connectionPanel.getByText(item.label, { exact: true })).toBeVisible();
    await expect(operatorPanel.getByRole("button", { name: "软重新连接", exact: true })).toBeEnabled({ enabled: item.lifecycleEnabled });
    await expect(operatorPanel.getByRole("button", { name: "重启 MockClient", exact: true })).toBeEnabled({ enabled: item.lifecycleEnabled });
    const liveWritesEnabled = item.status === "healthy";
    await expect(playerActionPanel.getByRole("button", { name: "发送", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    await expect(operatorPanel.getByRole("button", { name: "手动 Ready", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    await expect(operatorPanel.getByRole("button", { name: "手动关闭 cheat", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    await expect(playerActionPanel.getByRole("button", { name: "发送原始命令", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    if (!liveWritesEnabled) await expect(operatorPanel).toContainText(connectionReason(item.status));
    if (item.status === "recovering") {
      await expect(connectionPanel).toContainText("等待服务器冷却");
      await expect(connectionPanel).toContainText("冷却至：");
    }
  }

  await applyConnection("healthy", 4, 31);
  await operatorPanel.getByRole("button", { name: "软重新连接", exact: true }).click();
  const reconnectConfirmation = operatorPanel.getByRole("group", { name: "软重新连接确认" });
  await expect(reconnectConfirmation).toContainText("使用当前 MockClient 软重新连接比赛服务器？");
  await expect(reconnectConfirmation).toContainText("先精确请求本机 *ContestConsole 自身断开并核对 1101 回显");
  await reconnectConfirmation.getByRole("button", { name: "取消" }).click();
  await operatorPanel.getByRole("button", { name: "重启 MockClient", exact: true }).click();
  const restartConfirmation = operatorPanel.getByRole("group", { name: "重启 MockClient确认" });
  await expect(restartConfirmation).toContainText("关闭并重启当前受管 MockClient？");
  await expect(restartConfirmation).toContainText("强制结束受管进程树");
  expect(confirmationIntents).toEqual(["reconnect-work", "restart-work"]);

  // Keep competition/runtime versions unchanged: only the connection generations invalidate this confirmation.
  await applyConnection("healthy", 5, 32);
  await expect(restartConfirmation).toHaveCount(0);
  await expect(page.getByRole("region", { name: "工作模式连接状态" }).getByText("judge-32", { exact: true })).toBeVisible();
  await expect(page.locator(".workspace > .global-connection")).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  const sidebarBox = await page.locator(".sidebar").boundingBox();
  const connectionBox = await page.locator(".global-connection").boundingBox();
  expect(sidebarBox!.y).toBeLessThanOrEqual(connectionBox!.y);
  await page.getByRole("button", { name: "玩家", exact: true }).click();
  await expect(page.getByRole("region", { name: "工作模式连接状态" })).toBeVisible();
  await page.getByRole("button", { name: "控制台", exact: true }).click();

  await applyConnection("blocked", 5, 32, true);
  await expect(operatorPanel.getByRole("button", { name: "恢复比赛现场", exact: true })).toBeEnabled();
  await expect(operatorPanel.getByRole("button", { name: "软重新连接", exact: true })).toHaveCount(0);
  await expect(operatorPanel.getByRole("button", { name: "重启 MockClient", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "工作模式连接状态" })).toContainText("尚未由本次 list 确认");
});

test("binds stage confirmations and submitted actions to the backend SR3 target", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 后端关卡目标 ${testInfo.project.name}`;
  await createCompetition(page, name, "work");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  const fixture = await selectedCompetitionSnapshot(page, name);
  const targetedActions = withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "healthy")
    .map((action): ActionAvailability => ["force-next-stage-ready", "ready", "manual-go", "force-next-stage"].includes(action.action)
      ? { ...action, enabled: true, targetStageId: "sr-3" }
      : ["mark-stage-started", "force-reset-stage"].includes(action.action)
        ? { ...action, enabled: true, targetStageId: "sr-2" }
        : action);
  const mockedSnapshot: CompetitionSnapshot = {
    ...structuredClone(fixture.snapshot),
    runtime: {
      ...structuredClone(fixture.snapshot.runtime),
      phase: "tail-intake",
      stateVersion: 73,
      currentStageId: "sr-2",
      plannedReadyStageId: "sr-3",
      plannedReadyAtMs: 180_000,
      workConnection: workConnectionFixture("healthy", 8, 52),
      availableActions: targetedActions
    }
  };
  const confirmationRequests: Array<{ intent?: string; target?: string; stageId?: string }> = [];
  const submittedActions: Array<{ action: { type: string; confirmationToken?: string; impactHash?: string } }> = [];
  let delayForceResetConfirmation = false;
  let signalForceResetConfirmationStarted: (() => void) | undefined;
  let releaseForceResetConfirmation: (() => void) | undefined;
  const forceResetConfirmationStarted = new Promise<void>((resolve) => {
    signalForceResetConfirmationStarted = resolve;
  });
  const forceResetConfirmationRelease = new Promise<void>((resolve) => {
    releaseForceResetConfirmation = resolve;
  });

  await page.route(`**/api/v1/competitions/${fixture.competitionId}/snapshot`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: mockedSnapshot })
    });
  });
  await page.route(`**/api/v1/competitions/${fixture.competitionId}/confirmations`, async (route) => {
    const input = route.request().postDataJSON() as { kind: ConfirmationSummary["kind"]; intent?: string; target?: string; stageId?: string };
    confirmationRequests.push(input);
    const intent = input.intent ?? "unknown";
    const confirmationStateVersion = mockedSnapshot.competition.stateVersion;
    const confirmationRuntimeStateVersion = mockedSnapshot.runtime.stateVersion;
    const confirmationPhase = mockedSnapshot.runtime.phase;
    if (intent === "force-reset-stage" && delayForceResetConfirmation) {
      signalForceResetConfirmationStarted?.();
      await forceResetConfirmationRelease;
    }
    const title = intent === "force-next-stage-ready"
      ? "进入 SR3 的 Ready+发令流程？"
      : intent === "ready"
        ? "发送一次 SR3 Ready？"
        : intent === "mark-stage-started"
          ? "把 SR2 标记为已起跑？"
          : intent === "force-reset-stage"
            ? "将 SR2 重置到 T-60？"
            : "进入下一关 T-60（SR2 → SR3）？";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          ...confirmationFixture(input, confirmationStateVersion),
          token: `fixture-${intent}-${input.stageId}`,
          runtimeStateVersion: confirmationRuntimeStateVersion,
          impactHash: `fixture-hash-${intent}-${input.stageId}`,
          effect: {
            title,
            target: "SR3",
            currentPhase: confirmationPhase,
            consequences: ["动作只对后端锁定的 SR3 生效。"],
            irreversible: false
          }
        } satisfies ConfirmationSummary
      })
    });
  });
  await page.route(`**/api/v1/competitions/${fixture.competitionId}/actions`, async (route) => {
    const input = route.request().postDataJSON() as { action: { type: string; confirmationToken?: string; impactHash?: string } };
    submittedActions.push(input);
    if (input.action.type === "ready" || input.action.type === "force-next-stage") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "CONFIRMATION_STALE", message: "确认已失效：目标关已从 SR3 变更" } })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) });
  });

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.locator(".competition-list button.selected").click();
  await expect(page.getByText("关卡", { exact: true }).locator("..")).toContainText("SR2");

  const readyFlowAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "直接进入下一关 Ready+发令流程" })
  });
  await readyFlowAction.getByRole("button", { name: "直接进入下一关 Ready+发令流程" }).click();
  await expect(readyFlowAction).toContainText("进入 SR3 的 Ready+发令流程？");
  await expect(readyFlowAction).not.toContainText("进入 SR2 的 Ready+发令流程？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "force-next-stage-ready",
    target: "sr-3",
    stageId: "sr-3"
  });
  await readyFlowAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(1);
  expect(submittedActions[0]?.action).toMatchObject({
    type: "force-next-stage-ready",
    confirmationToken: "fixture-force-next-stage-ready-sr-3",
    impactHash: "fixture-hash-force-next-stage-ready-sr-3"
  });

  const manualReadyAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "手动 Ready" })
  });
  await manualReadyAction.getByRole("button", { name: "手动 Ready" }).click();
  await expect(manualReadyAction).toContainText("发送一次 SR3 Ready？");
  await expect(manualReadyAction).not.toContainText("发送一次 SR2 Ready？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "ready",
    target: "sr-3",
    stageId: "sr-3"
  });
  await manualReadyAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(2);
  expect(submittedActions[1]?.action).toMatchObject({
    type: "ready",
    confirmationToken: "fixture-ready-sr-3",
    impactHash: "fixture-hash-ready-sr-3"
  });
  await expect(page.locator("header")).toContainText("确认已失效：目标关已从 SR3 变更");

  const markStartedAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "重置本关到已起跑" })
  });
  await markStartedAction.getByRole("button", { name: "重置本关到已起跑" }).click();
  await expect(markStartedAction).toContainText("把 SR2 标记为已起跑？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "mark-stage-started",
    target: "sr-2",
    stageId: "sr-2"
  });
  await markStartedAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(3);
  expect(submittedActions[2]?.action).toMatchObject({
    type: "mark-stage-started",
    stageId: "sr-2",
    confirmationToken: "fixture-mark-stage-started-sr-2",
    impactHash: "fixture-hash-mark-stage-started-sr-2"
  });

  const forceResetAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "重置本关到 T-60" })
  });
  delayForceResetConfirmation = true;
  await forceResetAction.getByRole("button", { name: "重置本关到 T-60" }).click();
  await forceResetConfirmationStarted;
  mockedSnapshot.runtime = {
    ...mockedSnapshot.runtime,
    stateVersion: mockedSnapshot.runtime.stateVersion + 1
  };
  await page.locator(".competition-list button.selected").click();
  await expect(forceResetAction).toHaveAttribute(
    "data-version",
    `${mockedSnapshot.competition.stateVersion}:${mockedSnapshot.runtime.stateVersion}`
  );
  const staleConfirmationResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/competitions/${fixture.competitionId}/confirmations`)
      && response.request().method() === "POST");
  releaseForceResetConfirmation?.();
  await staleConfirmationResponse;
  await expect(forceResetAction).toContainText("现场状态已变化，请重新点击确认");
  await expect(forceResetAction.getByRole("group", { name: "重置本关到 T-60确认" })).toHaveCount(0);
  delayForceResetConfirmation = false;
  await forceResetAction.getByRole("button", { name: "重置本关到 T-60" }).click();
  await expect(forceResetAction).toContainText("将 SR2 重置到 T-60？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "force-reset-stage",
    target: "sr-2",
    stageId: "sr-2"
  });
  await forceResetAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(4);
  expect(submittedActions[3]?.action).toMatchObject({
    type: "force-reset-stage",
    stageId: "sr-2",
    confirmationToken: "fixture-force-reset-stage-sr-2",
    impactHash: "fixture-hash-force-reset-stage-sr-2"
  });

  const forceNextAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "进入下一关 T-60" })
  });
  await forceNextAction.getByRole("button", { name: "进入下一关 T-60" }).click();
  await expect(forceNextAction).toContainText("进入下一关 T-60（SR2 → SR3）？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "force-next-stage",
    target: "sr-3",
    stageId: "sr-3"
  });
  await forceNextAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(5);
  expect(submittedActions[4]?.action).toMatchObject({
    type: "force-next-stage",
    stageId: "sr-3",
    confirmationToken: "fixture-force-next-stage-sr-3",
    impactHash: "fixture-hash-force-next-stage-sr-3"
  });
  await expect(forceNextAction).toContainText("确认已失效：目标关已从 SR3 变更");
});

test("disables connection-bound resends while keeping local command disposition available", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 连接阻断命令处置 ${testInfo.project.name}`;
  await createCompetition(page, name, "work");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  const fixture = await selectedCompetitionSnapshot(page, name);
  let mockedSnapshot: CompetitionSnapshot = {
    ...structuredClone(fixture.snapshot),
    runtime: {
      ...structuredClone(fixture.snapshot.runtime),
      workConnection: workConnectionFixture("blocked", 7, 41),
      availableActions: withForcedStageRecoveryAvailable(withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "blocked")),
      unconfirmedAutomationActions: [{ id: "flow-uncertain", kind: "ready", stageId: "sr-1", status: "uncertain" }],
      unconfirmedCommands: [{
        id: "raw-failed",
        actionType: "raw",
        status: "failed",
        command: "scores",
        createdAt: "2026-07-22T10:00:00.000Z"
      }]
    }
  };
  await page.route(`**/api/v1/competitions/${fixture.competitionId}/snapshot`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: mockedSnapshot }) });
  });
  await page.route(`**/api/v1/competitions/${fixture.competitionId}/confirmations`, async (route) => {
    const input = route.request().postDataJSON() as { kind: ConfirmationSummary["kind"]; intent?: string; target?: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: confirmationFixture(input, mockedSnapshot.competition.stateVersion) })
    });
  });

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.locator(".competition-list button.selected").click();
  const flowPanel = page.locator(".unconfirmed-command-panel").filter({ hasText: "未确认流程命令" });
  const commandPanel = page.locator(".unconfirmed-command-panel").filter({ hasText: "未确认真实命令" });
  await expect(flowPanel.getByRole("button", { name: "确认已执行", exact: true })).toBeEnabled();
  await expect(commandPanel.getByRole("button", { name: "确认不再执行", exact: true })).toBeEnabled();
  await expect(flowPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(commandPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(flowPanel).toContainText("当前连接为连接已阻断；完成服务器身份核验后才能重发真实命令");
  await expect(commandPanel).toContainText("当前连接为连接已阻断；完成服务器身份核验后才能重发真实命令");

  await flowPanel.getByRole("button", { name: "确认已执行", exact: true }).click();
  const localConfirmation = flowPanel.getByRole("group", { name: "确认已执行确认" });
  await expect(localConfirmation).toContainText("只记录裁判的本地处置，不发送新命令。");
  await localConfirmation.getByRole("button", { name: "取消" }).click();

  const operatorPanel = page.locator(".grid.two > .panel").first();
  const playerActionPanel = page.getByRole("heading", { name: "玩家处置" }).locator("..");
  await playerActionPanel.getByText("高级操作：原始命令", { exact: true }).click();
  await playerActionPanel.getByRole("textbox", { name: "原始命令" }).fill("scores");
  await expect(playerActionPanel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "手动 Ready", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "手动关闭 cheat", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "重置本关到 T-60", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "进入下一关 T-60", exact: true })).toBeDisabled();
  await expect(playerActionPanel.getByRole("button", { name: "发送原始命令", exact: true })).toBeDisabled();
  await expect(operatorPanel).toContainText(connectionReason("blocked"));

  mockedSnapshot = {
    ...mockedSnapshot,
    runtime: {
      ...mockedSnapshot.runtime,
      workConnection: {
        ...workConnectionFixture("healthy", 7, 42),
        recoveryStep: "register-maps"
      },
      availableActions: withForcedStageRecoveryAvailable(withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "healthy", { mapsRegistering: true }))
    }
  };
  await page.locator(".competition-list button.selected").click();
  await expect(flowPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(commandPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(flowPanel).toContainText("当前 MockClient 正在完成地图注册；完成前不能重发真实命令");
  await expect(playerActionPanel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "重置本关到 T-60", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "进入下一关 T-60", exact: true })).toBeDisabled();
  await expect(operatorPanel).toContainText("当前 MockClient 正在注册比赛地图；完成前不能发送现场命令");

  mockedSnapshot = {
    ...mockedSnapshot,
    runtime: {
      ...mockedSnapshot.runtime,
      workConnection: workConnectionFixture("healthy", 7, 42),
      availableActions: withForcedStageRecoveryAvailable(withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "healthy"))
    }
  };
  await page.locator(".competition-list button.selected").click();
  await expect(flowPanel.getByRole("button", { name: "执行重发", exact: true })).toBeEnabled();
  await expect(commandPanel.getByRole("button", { name: "执行重发", exact: true })).toBeEnabled();
  await expect(playerActionPanel.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
});

test("runs the 20-player sandbox from the console and edits a score without losing the player", async ({ page }, testInfo) => {
  const externalRequests: string[] = [];
  let dialogOpened = false;
  await page.addInitScript(() => {
    class CapturedClipboardItem {
      public readonly types: string[];
      public constructor(private readonly values: Record<string, Blob>) { this.types = Object.keys(values); }
      public getType(type: string): Promise<Blob> { return Promise.resolve(this.values[type] as Blob); }
    }
    Object.defineProperty(window, "ClipboardItem", { configurable: true, value: CapturedClipboardItem });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async (items: CapturedClipboardItem[]) => {
        const copied: Record<string, string> = {};
        const item = items[0];
        if (!item) return;
        for (const type of item.types) copied[type] = await (await item.getType(type)).text();
        (window as unknown as { __copiedScoreboard: Record<string, string> }).__copiedScoreboard = copied;
      }
    } });
  });
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
  await expect(page.getByLabel("通知类型").locator('option[value="s"]')).toHaveText("s · 公共聊天发言");
  await page.getByRole("button", { name: "启动自动化" }).click();
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("准备检查");
  expect(await accelerateActiveTestRun(page, name)).toBe("review");
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核", { timeout: 15_000 });
  await expect(page.locator(".attention-card").first()).toBeVisible();
  await expect(page.locator(".attention-card small")).toHaveCount(0);
  expect(await page.locator(".attention-card p").filter({ hasText: "玩家" }).count()).toBeGreaterThan(0);
  expect(await page.locator(".attention-card p").first().evaluate((element) => getComputedStyle(element).fontSize)).toBe("13px");
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("Crash");
  await expect(page.getByRole("heading", { name: "玩家处置" }).locator("..")).not.toContainText("标记 DNF");

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const rowsBefore = await page.locator(".scoreboard tbody tr").count();
  expect(rowsBefore).toBe(20);
  const firstStageResults = await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents();
  expect(firstStageResults.filter((value) => value.trim().startsWith("#")).length).toBeGreaterThan(12);
  const liveScoring = page.locator(".live-scoring-editor");
  for (const [preset, count, first] of [["大型", 15, 30], ["中型", 12, 20], ["小型", 10, 15]] as const) {
    await liveScoring.getByRole("button", { name: `${preset}赛事预设` }).click();
    await expect(liveScoring.getByRole("spinbutton")).toHaveCount(count);
    await expect(liveScoring.getByLabel("第 1 名分数")).toHaveValue(String(first));
    await expect(liveScoring).toContainText(`最低计分名次：第 ${count} 名`);
  }
  await liveScoring.getByLabel("第 1 名分数").fill("25");
  await liveScoring.getByRole("button", { name: "保存并实时重算" }).click();
  const scoringConfirmation = liveScoring.getByRole("group", { name: "保存并实时重算确认" });
  await expect(scoringConfirmation).toContainText("已产生的单关成绩、总分和排名将立即重算");
  await scoringConfirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("运行期修订 r1")).toBeVisible();
  await expect(liveScoring.getByLabel("第 1 名分数")).toHaveValue("25");
  const liveSnapshot = await selectedCompetitionSnapshot(page, name);
  expect(liveSnapshot.snapshot.activeScoring.points[0]).toBe(25);
  expect(liveSnapshot.snapshot.publishedConfig?.scoring.points[0]).toBe(15);
  expect(liveSnapshot.snapshot.scoreboardVersions.at(-1)?.entries).toHaveLength(rowsBefore);
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
  const secondPlayerName = (await secondRow.locator("td").nth(3).innerText()).trim();
  const targetRow = page.locator(".scoreboard tbody tr").filter({ has: page.getByRole("cell", { name: secondPlayerName, exact: true }) });
  const dnfEditorButton = targetRow.locator(".cell-button").filter({ hasText: /^#/ }).first();
  await dnfEditorButton.click();
  const secondEditor = targetRow.locator(".score-cell-editor");
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
  const tableMatrix = await page.locator("table.scoreboard tr").evaluateAll((rows) => rows.map((row) =>
    [...row.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").trim())));
  await page.getByRole("button", { name: "复制表格" }).click();
  await expect(page.getByRole("status")).toContainText("表格已复制");
  const copied = await page.evaluate(() => (window as unknown as { __copiedScoreboard: Record<string, string> }).__copiedScoreboard);
  expect(copied["text/plain"]?.split("\r\n").map((row) => row.split("\t"))).toEqual(tableMatrix);
  const copiedHtmlMatrix = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    return [...document.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").trim()));
  }, copied["text/html"] ?? "");
  expect(copiedHtmlMatrix).toEqual(tableMatrix);
  expect(copied["text/html"]).toContain('data-style="gold"');
  expect(copied["text/html"]).toContain('data-style="excluded"');
  expect(copied["text/html"]).toContain("text-decoration:line-through");

  const exported = await page.evaluate(async (competitionName) => {
    const stored = sessionStorage.getItem("ballance-console-session");
    if (!stored) throw new Error("missing local session");
    const session = JSON.parse(stored) as { token: string };
    const headers = { authorization: `Bearer ${session.token}` };
    const competitions = await (await fetch("/api/v1/competitions", { headers })).json() as { data: Array<{ id: string; name: string }> };
    const competitionId = competitions.data.find((competition) => competition.name === competitionName)?.id;
    if (!competitionId) throw new Error("missing competition");
    const csvResponse = await fetch(`/api/v1/competitions/${competitionId}/exports/csv`, { headers });
    const xlsxResponse = await fetch(`/api/v1/competitions/${competitionId}/exports/xlsx`, { headers });
    return { csv: await csvResponse.text(), xlsx: [...new Uint8Array(await xlsxResponse.arrayBuffer())] };
  }, name);
  expect(parseQuotedCsv(exported.csv)).toEqual(tableMatrix);
  const xlsxText = Buffer.from(exported.xlsx).toString("utf8");
  const xlsxCells = [...xlsxText.matchAll(/<t xml:space="preserve">(.*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? ""));
  const xlsxMatrix = Array.from({ length: tableMatrix.length }, (_value, index) =>
    xlsxCells.slice(index * tableMatrix[0]!.length, (index + 1) * tableMatrix[0]!.length));
  expect(xlsxMatrix).toEqual(tableMatrix);

  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new Error("permission denied"); }; });
  await page.getByRole("button", { name: "复制表格" }).click();
  await expect(page.getByLabel("手工复制表格")).toBeVisible();
  await expect(page.getByLabel("手工复制表格")).toHaveValue((copied["text/plain"] ?? "").replaceAll("\r\n", "\n"));
  expect(dialogOpened).toBe(false);
  expect(externalRequests).toEqual([]);
});

test("keeps a scrolled raw log in place, follows at the bottom, and resizes the window", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 日志浮窗 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /20 人小型综合沙盒/ }).click();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  const logBody = page.locator(".raw-log-body");
  await expect.poll(() => page.locator(".raw-log-line").count()).toBeGreaterThan(15);
  await logBody.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  const notification = page.locator(".notification-form");
  const firstCount = await page.locator(".raw-log-line").count();
  await notification.getByLabel("通知文本").fill("日志停留检查");
  await notification.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => page.locator(".raw-log-line").count()).toBeGreaterThan(firstCount);
  expect(await logBody.evaluate((element) => element.scrollTop)).toBe(0);

  await logBody.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  const secondCount = await page.locator(".raw-log-line").count();
  await notification.getByLabel("通知文本").fill("日志底部跟随检查");
  await notification.getByRole("button", { name: "发送" }).click();
  await expect.poll(() => page.locator(".raw-log-line").count()).toBeGreaterThan(secondCount);
  expect(await logBody.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(4);

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

test("restarts the current stage and unlocks its score review after the next T-60 preparation boundary", async ({ page }, testInfo) => {
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
  await expect(page.getByRole("button", { name: "重置本关到 Ready" })).toBeEnabled();

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const firstStageCell = page.locator(".scoreboard tbody tr").first().locator("td").nth(4).getByRole("button");
  await expect(firstStageCell).toBeDisabled();
  await expect(firstStageCell).toHaveAttribute("title", /进入下一关 Ready 前 1 分钟的准备阶段后才能修订/);
  expect((await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(true);

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "重置本关到 Ready" }).click();
  const confirmation = page.getByRole("group", { name: "重置本关到 Ready确认" });
  await expect(confirmation).toContainText("立即把当前关重置到 Ready");
  await expect(confirmation).toContainText("当前流程命令、事故、权限提示、未决真实命令和观察缺口将不再阻断新周期");
  await expect(confirmation).toContainText("真实连接或权限仍不可用时，新命令可能再次失败。");
  await confirmation.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("Ready");
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  expect((await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(false);

  await accelerateActiveTestRun(page, name, 240_000);
  await expect.poll(async () => (await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(true);
  await accelerateActiveTestRun(page, name, 240_000);
  const previousStageCell = page.locator(".scoreboard tbody tr").first().locator("td").nth(4).getByRole("button");
  await expect(previousStageCell).toBeEnabled();
});

test("recovers a live stage by marking start, clearing a reset, and preserving a forced next stage", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 显式关卡恢复 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /普通玩家场景/ }).click();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await page.getByRole("button", { name: "控制台", exact: true }).click();

  const recovery = page.getByRole("group", { name: "本关重置", exact: true });
  await expect(recovery.getByRole("button")).toHaveText(["重置本关到 T-60", "重置本关到 Ready", "重置本关到已起跑"]);
  await expect(recovery).toContainText("清除本关有效成绩，从确认时刻重新计时并继续自动流程，不重新发令。");
  await expect(recovery).toContainText("清除本关有效成绩，立即开始 Ready 和自动发令流程。");
  await expect(recovery).toContainText("清除本关有效成绩，准备 60 秒后开始 Ready 和自动发令流程。");
  await expect(page.getByRole("group", { name: "流程推进", exact: true })).toContainText("保留本关成绩并关闭接收，切换到下一关，准备 60 秒后开始 Ready。");
  await expect(page.getByRole("group", { name: "手动操作", exact: true }).getByRole("button")).toHaveText(["手动 Ready", "手动关闭 cheat", "手动发令"]);
  await expect(page.getByRole("group", { name: "时间操作", exact: true }).getByRole("button")).toHaveText(["T-60 延后 1 分钟", "本关时限延长 1 分钟", "T-60 提前 1 分钟", "本关时限缩短 1 分钟"]);
  await expect(page.getByRole("button", { name: "重置本关到已起跑" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "重置本关到 T-60" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "进入下一关 T-60" })).toBeEnabled();

  const readyFlow = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "重置本关到 T-60" })
  });
  await readyFlow.getByRole("button", { name: "重置本关到 T-60" }).click();
  await readyFlow.getByRole("button", { name: "确认" }).click();
  await accelerateActiveTestRun(page, name, 60_000);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("Ready");
  await expect(page.getByRole("button", { name: "重置本关到已起跑" })).toBeEnabled();

  const beforeMark = (await selectedCompetitionSnapshot(page, name)).snapshot;
  const markAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "重置本关到已起跑" })
  });
  await markAction.getByRole("button", { name: "重置本关到已起跑" }).click();
  await expect(markAction).toContainText("从确认成功时刻重新计算本关时限。");
  await expect(markAction).toContainText("不会向比赛服务器发送命令");
  await expect(markAction).toContainText("进入比赛中并启用自动化");
  await markAction.getByRole("button", { name: "确认" }).click();

  const marked = (await selectedCompetitionSnapshot(page, name)).snapshot;
  const markedAttempt = [...marked.runtime.attempts].reverse().find((candidate): candidate is {
    stageId: string;
    goAtMs: number;
    deadlineAtMs: number;
    origin: string;
    voided: boolean;
  } => typeof candidate === "object" && candidate !== null
    && (candidate as { stageId?: unknown }).stageId === "sr-1"
    && (candidate as { voided?: unknown }).voided !== true);
  expect(markedAttempt).toBeDefined();
  expect(marked.runtime.virtualNowMs).toBe(beforeMark.runtime.virtualNowMs);
  expect(markedAttempt?.goAtMs).toBe(marked.runtime.virtualNowMs);
  expect(markedAttempt?.deadlineAtMs).toBe((marked.runtime.virtualNowMs ?? 0) + (marked.config.stages[0]?.timeLimitMs ?? 0));
  expect(markedAttempt?.origin).toBe("referee-marked-started");
  const commandsAddedByMark = marked.runtime.commands.filter(
    (command) => !beforeMark.runtime.commands.some((existing) => existing.id === command.id)
  );
  expect(commandsAddedByMark).toEqual([
    expect.objectContaining({
      actionType: "mark-stage-started",
      command: "mark-stage-started",
      simulated: true,
      status: "simulated"
    })
  ]);
  expect(marked.runtime).toMatchObject({ phase: "running", automationEnabled: true });
  await expect(page.getByText("本关起跑（UTC+8）").locator("..")).not.toContainText("未设置");
  await expect(page.getByText("本关最晚结束（UTC+8）").locator("..")).not.toContainText("未设置");
  await expect(page.getByText("自动化 / 倒数").locator("..")).toContainText("启用");

  let scoredBeforeReset = await advanceUntilStageScore(page, name, "sr-1");
  expect(scoredBeforeReset.currentScoreboard.some((entry) => entry.stages["sr-1"] !== undefined)).toBe(true);
  await expect(markAction).toHaveAttribute("data-version", `${scoredBeforeReset.competition.stateVersion}:${scoredBeforeReset.runtime.stateVersion}`);
  await markAction.getByRole("button", { name: "重置本关到已起跑" }).click();
  await expect(markAction).toContainText("作废本关已有有效尝试和成绩");
  await markAction.getByRole("button", { name: "确认" }).click();
  const remarked = (await selectedCompetitionSnapshot(page, name)).snapshot;
  expect(remarked.runtime).toMatchObject({ phase: "running", automationEnabled: true });
  expect(remarked.currentScoreboard.every(entry => entry.stages["sr-1"] === undefined)).toBe(true);
  expect(remarked.runtime.attempts).toContainEqual(expect.objectContaining({ origin: "referee-marked-started", voided: true }));
  expect(remarked.runtime.commands.filter(command => !scoredBeforeReset.runtime.commands.some(old => old.id === command.id)))
    .toEqual([expect.objectContaining({ actionType: "mark-stage-started" })]);
  scoredBeforeReset = await advanceUntilStageScore(page, name, "sr-1");
  const resetAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "重置本关到 T-60" })
  });
  await expect(resetAction).toHaveAttribute(
    "data-version",
    `${scoredBeforeReset.competition.stateVersion}:${scoredBeforeReset.runtime.stateVersion}`
  );
  await resetAction.getByRole("button", { name: "重置本关到 T-60" }).click();
  await expect(resetAction).toContainText("本关当前有效尝试和成绩将作废");
  await expect(resetAction).toContainText("60 秒后发送第一条 Ready");
  await resetAction.getByRole("button", { name: "确认" }).click();

  const reset = (await selectedCompetitionSnapshot(page, name)).snapshot;
  expect(reset.runtime.currentStageId).toBe("sr-1");
  expect(reset.runtime.automationEnabled).toBe(true);
  expect(reset.runtime.plannedReadyStageId).toBe("sr-1");
  expect((reset.runtime.plannedReadyAtMs ?? 0) - (reset.runtime.virtualNowMs ?? 0)).toBe(60_000);
  expect(reset.currentScoreboard.every((entry) => entry.stages["sr-1"] === undefined)).toBe(true);
  expect(reset.runtime.attempts).toContainEqual(expect.objectContaining({
    stageId: "sr-1",
    origin: "referee-marked-started",
    voided: true
  }));
  await expect(page.getByText("本关 Ready（UTC+8）").locator("..")).not.toContainText("未设置");

  const scoredBeforeNext = await advanceUntilStageScore(page, name, "sr-1");
  const preservedStageResults = scoredBeforeNext.currentScoreboard
    .filter((entry) => entry.stages["sr-1"] !== undefined)
    .map((entry) => ({ playerId: entry.playerId, result: entry.stages["sr-1"] }));
  expect(preservedStageResults.length).toBeGreaterThan(0);
  const beforeNextVirtualNow = scoredBeforeNext.runtime.virtualNowMs ?? 0;
  const forceNextAction = page.locator(".confirm-action").filter({
    has: page.getByRole("button", { name: "进入下一关 T-60" })
  });
  await expect(forceNextAction).toHaveAttribute(
    "data-version",
    `${scoredBeforeNext.competition.stateVersion}:${scoredBeforeNext.runtime.stateVersion}`
  );
  await forceNextAction.getByRole("button", { name: "进入下一关 T-60" }).click();
  await expect(forceNextAction).toContainText("立即关闭上一关成绩窗口但保留已有尝试和成绩");
  await expect(forceNextAction).toContainText("当前关卡立即切换为 SR2");
  await forceNextAction.getByRole("button", { name: "确认" }).click();

  const forcedNext = (await selectedCompetitionSnapshot(page, name)).snapshot;
  expect(forcedNext.runtime.virtualNowMs).toBe(beforeNextVirtualNow);
  expect(forcedNext.runtime.currentStageId).toBe("sr-2");
  expect(forcedNext.runtime.plannedReadyStageId).toBe("sr-2");
  expect((forcedNext.runtime.plannedReadyAtMs ?? 0) - (forcedNext.runtime.virtualNowMs ?? 0)).toBe(60_000);
  expect(forcedNext.runtime.nextStageReadyAt).toBeUndefined();
  expect(forcedNext.runtime.scoreEditPermissions).toContainEqual(expect.objectContaining({ stageId: "sr-1", editable: true }));
  expect(forcedNext.currentScoreboard
    .filter((entry) => entry.stages["sr-1"] !== undefined)
    .map((entry) => ({ playerId: entry.playerId, result: entry.stages["sr-1"] }))).toEqual(preservedStageResults);
  await expect(page.getByText("关卡", { exact: true }).locator("..")).toContainText("SR2");
  await expect(page.getByText("本关 Ready（UTC+8）").locator("..")).not.toContainText("未设置");

  await page.reload();
  await page.locator(".competition-list button").filter({ hasText: name }).click();
  await expect(page.getByLabel("比赛名称")).toHaveValue(name);
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByText("关卡", { exact: true }).locator("..")).toContainText("SR2");
  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const previousStageResult = page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").filter({ hasText: /^#/ }).first();
  await expect(previousStageResult).toBeEnabled();
});

test("shows disabled reasons, shared scheduling controls and automatic review completion", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 控制矩阵 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动自动化" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重置本关到 Ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重置本关到 Ready" })).toBeDisabled();
  await page.getByRole("button", { name: "比赛配置", exact: true }).click();
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /30 人大型综合沙盒/ }).click();
  await expect(page.getByText("30 人 · 1 个场景故障")).toBeVisible();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText(/虚拟时钟：0:00/)).toBeVisible();
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "重置本关到 Ready" })).toBeEnabled();
  await expect(page.getByLabel("准备开始时间（UTC+8）")).toBeVisible();
  await expect(page.getByRole("button", { name: "T-60 改期" })).toBeDisabled();
  await expect(page.getByText("当前没有尚未开始的 T-60 计划").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "关卡时限改期" })).toBeDisabled();
  await expect(page.getByText("当前没有开放的成绩接收窗口").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "直接进入下一关 Ready+发令流程" })).toBeEnabled();
  const readyFlowAction = page.locator(".confirm-action").filter({ has: page.getByRole("button", { name: "直接进入下一关 Ready+发令流程" }) });
  await readyFlowAction.getByRole("button", { name: "直接进入下一关 Ready+发令流程" }).click();
  await expect(readyFlowAction.getByText("进入下一关 Ready+发令流程（SR1 → SR2）？", { exact: true })).toBeVisible();
  await expect(readyFlowAction.getByText("当前关卡立即切换为 SR2，立即发送第一条 Ready，并启用自动化继续发令。", { exact: true })).toBeVisible();
  await expect(readyFlowAction).not.toContainText("目标：");
  await expect(readyFlowAction).not.toContainText("状态版本");
  await expect(readyFlowAction).not.toContainText("令牌有效");
  await readyFlowAction.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: "手动 Ready" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "手动关闭 cheat" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "手动发令" })).toBeDisabled();
  await expect(page.getByText("目标关尚无关闭 cheat 成功回显")).toBeVisible();
  await expect(page.getByRole("button", { name: "将起跑保护重置为未使用" })).toBeDisabled();
  const protectionAction = page.locator(".confirm-action").filter({ hasText: "将起跑保护标记为已使用" });
  await expect(protectionAction.getByRole("button", { name: "将起跑保护标记为已使用" })).toBeEnabled();
  await protectionAction.getByRole("button", { name: "将起跑保护标记为已使用" }).click();
  await expect(protectionAction.getByText("把 SR1 的起跑保护标记为已使用？", { exact: true })).toBeVisible();
  await expect(protectionAction.getByText("本关后续掉线不再触发自动延时或作废尝试。", { exact: true })).toBeVisible();
  await protectionAction.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("起跑保护剩余 0 次", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "将起跑保护标记为已使用" })).toBeDisabled();
  const restoreProtection = page.locator(".confirm-action").filter({ has: page.getByRole("button", { name: "将起跑保护重置为未使用" }) });
  await restoreProtection.getByRole("button", { name: "将起跑保护重置为未使用" }).click();
  await expect(restoreProtection).toContainText("恢复本关两次保护：第一次保护任何形式的掉线，第二次仅保护 fatal error。");
  await restoreProtection.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("起跑保护剩余 2 次（第一次保护任何掉线，第二次仅保护 fatal error）", { exact: true })).toBeVisible();
  await expect(page.getByText("下一关 Ready（UTC+8）").locator("..")).toContainText("未设置");

  await page.getByRole("button", { name: "启动自动化" }).click();
  await expect(page.getByText("本关 Ready（UTC+8）").locator("..")).not.toContainText("未设置");
  await expect(page.getByText("下一关 Ready（UTC+8）").locator("..")).toContainText("未设置");
  await expect(page.getByText("下一关 T-60（UTC+8）").locator("..")).toContainText("未设置");
  const beforeReschedule = (await selectedCompetitionSnapshot(page, name)).snapshot;
  const preparationMs = Math.ceil((Date.parse(beforeReschedule.runtime.plannedReadyAt!) + 60_000) / 60_000) * 60_000;
  const utc8Value = new Date(preparationMs + 8 * 3_600_000).toISOString().slice(0, 16);
  await page.getByLabel("准备开始时间（UTC+8）").fill(utc8Value);
  const reschedule = page.locator(".confirm-action").filter({ has: page.getByRole("button", { name: "T-60 改期", exact: true }) });
  await reschedule.getByRole("button", { name: "T-60 改期", exact: true }).click();
  await expect(reschedule).toContainText("从指定时间进入准备阶段，60 秒后发送第一条 Ready");
  await reschedule.getByRole("button", { name: "确认", exact: true }).click();
  await expect.poll(async () => (await selectedCompetitionSnapshot(page, name)).snapshot.runtime.plannedReadyAt).toBe(new Date(preparationMs + 60_000).toISOString());
  let planned = (await selectedCompetitionSnapshot(page, name)).snapshot;
  await accelerateActiveTestRun(page, name, planned.runtime.plannedReadyAtMs! - planned.runtime.virtualNowMs! + 35_000);
  for (let step = 0; step < 40; step++) {
    planned = (await selectedCompetitionSnapshot(page, name)).snapshot;
    if (planned.runtime.nextStagePreparationAt) break;
    await accelerateActiveTestRun(page, name, 15_000);
  }
  expect(planned.runtime.nextStagePreparationAt).toBeDefined();
  expect(Date.parse(planned.runtime.nextStageReadyAt!) - Date.parse(planned.runtime.nextStagePreparationAt!)).toBe(60_000);
  const expectedPreparation = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(planned.runtime.nextStagePreparationAt!));
  await expect(page.getByText("下一关 T-60（UTC+8）").locator("..")).toContainText(expectedPreparation);
  await accelerateActiveTestRun(page, name);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核");
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("finished");
  await expect(page.getByRole("button", { name: "结束比赛" })).toBeDisabled();
});
