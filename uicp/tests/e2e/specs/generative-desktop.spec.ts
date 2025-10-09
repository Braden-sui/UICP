import { test, expect } from "@playwright/test";

// Full flow e2e exercising chat reveal, grant modal, apply, and stop behaviour.
test("mock planner notepad flow", async ({ page }) => {
  await page.goto("/");
  // Ensure workspace root is present before sending commands
  await expect(page.locator('#workspace-root')).toHaveCount(1);

  // Reveal chat so Dock header and controls are visible
  await page.keyboard.press("/");
  const input = page.locator('[data-testid="dockchat-input"]');
  await expect(input).toBeVisible();

  // Enable Full Control if needed
  const grant = page.getByText("Grant full control");
  if (await grant.isVisible()) {
    await grant.click();
    await page.getByRole("dialog").getByRole("button", { name: "Grant full control" }).click();
  }

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
