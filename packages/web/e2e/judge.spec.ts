import { expect, test } from "@playwright/test";

// The judge's path through the built site (served by `vite preview` from the evidence snapshot):
// the first-load picker, the league feed, a round's Report, and the in-browser Re-check against
// the live contract.

test("first load asks visitor or judge; #/judge starts the tour", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByText("How do you want to see it?")).toBeVisible();
  await page.goto("./#/judge");
  await page.reload();
  await expect(page.locator(".tour-card")).toContainText("01 / 16");
});

test("league feed, a round's Report tables and Copy proof", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("bm-mode", "visitor"));
  await page.goto("./#/league");
  await expect(page.locator(".feed-row").first()).toBeVisible({ timeout: 30_000 });
  await page.goto("./#/round/14");
  await page.locator('[data-tour="report"]').click();
  const report = page.locator(".report");
  await expect(report).toContainText("Entrants");
  await expect(report.locator("tbody tr").first()).toBeVisible();
  await expect(report).toContainText("overturned");
  await expect(page.locator('[data-tour="copy-proof"]')).toBeVisible();
});

test("Re-check of round 2 passes every check in the browser", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem("bm-mode", "visitor"));
  await page.goto("./#/round/2");
  await page.locator('[data-tour="recheck"]').click();
  const count = page.locator('[data-tour="verify-count"]');
  await expect(count).toHaveAttribute("data-state", "done", { timeout: 120_000 });
  await expect(count).toHaveAttribute("data-failed", "false");
  await expect(count).toContainText("passed");
});
