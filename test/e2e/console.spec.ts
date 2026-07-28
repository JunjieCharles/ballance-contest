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
    "notification", "start-ready-flow", "ready", "cheat-off", "manual-go", "kick", "raw-command"
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
  const protectionToggle = page.getByLabel("启用起跑保护");
  await expect(protectionToggle).toBeChecked();
  await protectionToggle.uncheck();
  await expect(page.getByText("未启用", { exact: true })).toBeVisible();
  await protectionToggle.check();
  await expect(page.getByText("已启用（默认）", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "连接比赛服务器" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /恢复工作运行|重启 MockClient/ })).toHaveCount(0);
  await page.getByRole("button", { name: "比赛配置", exact: true }).click();

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
  };

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  const operatorPanel = page.locator(".grid.two > .panel").first();
  const playerActionPanel = page.getByRole("heading", { name: "玩家处置" }).locator("..");
  await playerActionPanel.getByLabel("原始命令").fill("scores");
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
    await expect(operatorPanel.getByRole("button", { name: "发送", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    await expect(operatorPanel.getByRole("button", { name: "手动 Ready", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
    await expect(operatorPanel.getByRole("button", { name: "关闭 cheat", exact: true })).toBeEnabled({ enabled: liveWritesEnabled });
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
  await expect(operatorPanel.getByText("judge-32", { exact: true })).toBeVisible();

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
    .map((action): ActionAvailability => ["start-ready-flow", "ready", "manual-go"].includes(action.action)
      ? { ...action, enabled: true, targetStageId: "sr-3" }
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
    const title = intent === "start-ready-flow"
      ? "进入 SR3 的 Ready+发令流程？"
      : "发送一次 SR3 Ready？";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          ...confirmationFixture(input, mockedSnapshot.competition.stateVersion),
          token: `fixture-${intent}-${input.stageId}`,
          runtimeStateVersion: mockedSnapshot.runtime.stateVersion,
          impactHash: `fixture-hash-${intent}-${input.stageId}`,
          effect: {
            title,
            target: "SR3",
            currentPhase: mockedSnapshot.runtime.phase,
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
    if (input.action.type === "ready") {
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
    has: page.getByRole("button", { name: "进入 Ready+发令流程" })
  });
  await readyFlowAction.getByRole("button", { name: "进入 Ready+发令流程" }).click();
  await expect(readyFlowAction).toContainText("进入 SR3 的 Ready+发令流程？");
  await expect(readyFlowAction).not.toContainText("进入 SR2 的 Ready+发令流程？");
  expect(confirmationRequests.at(-1)).toMatchObject({
    intent: "start-ready-flow",
    target: "sr-3",
    stageId: "sr-3"
  });
  await readyFlowAction.getByRole("button", { name: "确认" }).click();
  await expect.poll(() => submittedActions.length).toBe(1);
  expect(submittedActions[0]?.action).toMatchObject({
    type: "start-ready-flow",
    confirmationToken: "fixture-start-ready-flow-sr-3",
    impactHash: "fixture-hash-start-ready-flow-sr-3"
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
      availableActions: withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "blocked"),
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
  await playerActionPanel.getByLabel("原始命令").fill("scores");
  await expect(operatorPanel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "手动 Ready", exact: true })).toBeDisabled();
  await expect(operatorPanel.getByRole("button", { name: "关闭 cheat", exact: true })).toBeDisabled();
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
      availableActions: withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "healthy", { mapsRegistering: true })
    }
  };
  await page.locator(".competition-list button.selected").click();
  await expect(flowPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(commandPanel.getByRole("button", { name: "执行重发", exact: true })).toBeDisabled();
  await expect(flowPanel).toContainText("当前 MockClient 正在完成地图注册；完成前不能重发真实命令");
  await expect(operatorPanel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(operatorPanel).toContainText("当前 MockClient 正在注册比赛地图；完成前不能发送现场命令");

  mockedSnapshot = {
    ...mockedSnapshot,
    runtime: {
      ...mockedSnapshot.runtime,
      workConnection: workConnectionFixture("healthy", 7, 42),
      availableActions: withWorkActionMatrix(fixture.snapshot.runtime.availableActions, "healthy")
    }
  };
  await page.locator(".competition-list button.selected").click();
  await expect(flowPanel.getByRole("button", { name: "执行重发", exact: true })).toBeEnabled();
  await expect(commandPanel.getByRole("button", { name: "执行重发", exact: true })).toBeEnabled();
  await expect(operatorPanel.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
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
  await expect(page.getByRole("button", { name: "重赛本关" })).toBeEnabled();

  await page.getByRole("button", { name: "成绩", exact: true }).click();
  const firstStageCell = page.locator(".scoreboard tbody tr").first().locator("td").nth(4).getByRole("button");
  await expect(firstStageCell).toBeDisabled();
  await expect(firstStageCell).toHaveAttribute("title", /进入下一关 Ready 前 1 分钟的准备阶段后才能修订/);
  expect((await page.locator(".scoreboard tbody tr td:nth-child(5) .cell-button").allTextContents()).some((value) => value.trim().startsWith("#"))).toBe(true);

  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await page.getByRole("button", { name: "重赛本关" }).click();
  const confirmation = page.getByRole("group", { name: "重赛本关确认" });
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

test("shows disabled reasons, shared scheduling controls and automatic review completion", async ({ page }, testInfo) => {
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  await acquireControl(page);
  const name = `E2E 控制矩阵 ${testInfo.project.name}`;
  await createCompetition(page, name, "test");
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动自动化" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "重赛本关" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重赛本关" })).toBeDisabled();
  await page.getByRole("button", { name: "比赛配置", exact: true }).click();
  await page.getByRole("button", { name: "发布比赛" }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("published");
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByRole("button", { name: /30 人大型综合沙盒/ }).click();
  await expect(page.getByText("30 人 · 1 个场景故障")).toBeVisible();
  await page.getByRole("button", { name: "创建测试运行" }).click();
  await expect(page.getByText(/虚拟时钟：0:00/)).toBeVisible();
  await page.getByRole("button", { name: "控制台", exact: true }).click();
  await expect(page.getByRole("button", { name: "重赛本关" })).toBeEnabled();
  await expect(page.getByLabel("改期时间（UTC+8）")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready 改期" })).toBeDisabled();
  await expect(page.getByText("当前没有可改期的 Ready 计划")).toBeVisible();
  await expect(page.getByRole("button", { name: "关卡时限改期" })).toBeDisabled();
  await expect(page.getByText("当前没有开放的成绩接收窗口").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "进入 Ready+发令流程" })).toBeEnabled();
  const readyFlowAction = page.locator(".confirm-action").filter({ has: page.getByRole("button", { name: "进入 Ready+发令流程" }) });
  await readyFlowAction.getByRole("button", { name: "进入 Ready+发令流程" }).click();
  await expect(readyFlowAction.getByText("进入 SR1 的 Ready+发令流程？", { exact: true })).toBeVisible();
  await expect(readyFlowAction.getByText("立即发布本关发令预告，并把第一条 Ready 安排在 1 分钟后。", { exact: true })).toBeVisible();
  await expect(readyFlowAction).not.toContainText("目标：");
  await expect(readyFlowAction).not.toContainText("状态版本");
  await expect(readyFlowAction).not.toContainText("令牌有效");
  await readyFlowAction.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: "手动 Ready" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "关闭 cheat" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "手动发令" })).toBeDisabled();
  await expect(page.getByText("目标关尚无关闭 cheat 成功回显")).toBeVisible();
  const protectionAction = page.locator(".confirm-action").filter({ hasText: "将起跑保护标记为已使用" });
  await expect(protectionAction.getByRole("button", { name: "将起跑保护标记为已使用" })).toBeEnabled();
  await protectionAction.getByRole("button", { name: "将起跑保护标记为已使用" }).click();
  await expect(protectionAction.getByText("把 SR1 的起跑保护标记为已使用？", { exact: true })).toBeVisible();
  await expect(protectionAction.getByText("本关后续掉线不再触发自动延时或作废尝试。", { exact: true })).toBeVisible();
  await protectionAction.getByRole("button", { name: "确认" }).click();
  await expect(page.getByRole("button", { name: "将起跑保护重置为未使用" })).toBeVisible();
  await expect(page.getByText("下一关 Ready（UTC+8）").locator("..")).toContainText("未设置");

  await page.getByRole("button", { name: "启动自动化" }).click();
  await expect(page.getByText("本关 Ready（UTC+8）").locator("..")).not.toContainText("未设置");
  await expect(page.getByText("下一关 Ready（UTC+8）").locator("..")).toContainText("未设置");
  await accelerateActiveTestRun(page, name);
  await expect(page.getByText("阶段", { exact: true }).locator("..")).toContainText("比赛复核");
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.locator(".competition-list button.selected")).toContainText("finished");
  await expect(page.getByRole("button", { name: "结束比赛" })).toBeDisabled();
});
