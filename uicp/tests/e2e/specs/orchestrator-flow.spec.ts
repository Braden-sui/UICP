import { test, expect } from '@playwright/test';

// This spec exercises the orchestrator path with a real backend.
// It requires a valid Ollama Cloud API key configured in the app.
// Enable via: E2E_ORCHESTRATOR=1
const enabled = !!process.env.E2E_ORCHESTRATOR;

(enabled ? test : test.skip)('orchestrator notepad flow (Full Control ON)', async ({ page }) => {
  await page.goto('/');

  // Grant full control
  const grant = page.getByText('Grant full control');
  if (await grant.isVisible()) {
    await grant.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Grant full control' }).click();
  }

  // Reveal chat, send intent
  await page.keyboard.press('/');
  const input = page.locator('[data-testid="dockchat-input"]');
  await expect(input).toBeVisible();

  await input.fill('make a notepad');
  await page.locator('button[aria-label="Send"]').click();

  // Expect at least one window within 30s (cloud latency)
  const workspaceWindows = page.locator('.workspace-window');
  await expect(workspaceWindows).toHaveCount(1, { timeout: 30000 });
});
