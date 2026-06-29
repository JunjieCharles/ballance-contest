import { expect, test } from "@playwright/test";

test("opens the two-mode console through a local authenticated session", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto("/#token=e2e-bootstrap-token");
  await expect(page.getByText("Ballance 比赛控制台")).toBeVisible();
  await expect(page.getByText(/服务 0\.1\.0-dev/)).toBeVisible();
  await expect(page.locator(".mode-badge")).toHaveText("未选择比赛");
  await expect(page.getByLabel("模式")).toHaveValue("test");
  await expect(page.getByLabel("模式").locator("option")).toHaveText(["测试模式", "工作模式"]);
  await expect(page.getByText(/已取得控制权|只读标签页/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});
