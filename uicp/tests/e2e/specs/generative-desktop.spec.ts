import { test, expect } from "@playwright/test";

// Full flow e2e exercising chat reveal, grant modal, apply, and stop behaviour.
test("mock planner notepad flow", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("/");
  const input = page.locator('textarea[placeholder="Describe what you want to build..."]');
  await expect(input).toBeVisible();

  await input.fill("make a notepad");
  await page.locator('button[aria-label="Send"]').click();
  const planPreview = page.getByText("Plan preview");
  await expect(planPreview).toBeVisible();

  await page.getByText("Grant full control").click();
  await page.getByRole("dialog").getByRole("button", { name: "Grant full control" }).click();

  await page.keyboard.press("/");
  await input.fill("make a notepad");
  await page.locator('button[aria-label="Send"]').click();
  const workspaceWindows = page.locator('.workspace-window');
  await expect(workspaceWindows).toHaveCount(1, { timeout: 20000 });

  const stopButton = page.getByRole("button", { name: "Stop" });
  if (await stopButton.isVisible()) {
    await stopButton.click();
    await expect(page.getByText("Streaming cancelled")).toBeVisible();
  }
});
