import { test, expect } from '@playwright/test';

// This spec exercises the orchestrator path with a real backend.
// It requires a valid Ollama Cloud API key configured in the app.
// Enable via: E2E_ORCHESTRATOR=1
const enabled = !!process.env.E2E_ORCHESTRATOR;

(enabled ? test : test.skip)('orchestrator notepad flow (Full Control ON)', async ({ page }) => {
  await page.goto('/');
  // Dismiss First Run permissions sheet if present
  const acceptButton = page.getByRole('button', { name: 'Accept' });
  if (await acceptButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await acceptButton.click({ force: true });
  }

  // Grant full control before interacting with chat (overlay intercepts pointer)
  const grant = page.getByRole('button', { name: 'Grant full control' });
  if (await grant.isVisible().catch(() => false)) {
    await grant.click({ force: true });
    // Some builds open a confirm dialog; others toggle inline. Handle both.
    const dialog = page.getByRole('dialog');
    const hasDialog = await dialog.isVisible({ timeout: 1000 }).catch(() => false);
    if (hasDialog) {
      await dialog.getByRole('button', { name: 'Grant full control' }).click();
    }
  }

  // Reveal chat, send intent
  await page.keyboard.press('/');
  const input = page.locator('[data-testid="dockchat-input"]');
  await expect(input).toBeVisible();

  await input.fill('make a notepad');
  const sendButton = page.locator('button[aria-label="Send"]');
  await sendButton.scrollIntoViewIfNeeded();
  // Ensure visibility within the viewport and force click to bypass overlay jitter
  await page.evaluate(() => {
    const el = document.querySelector('button[aria-label="Send"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  });
  await sendButton.click({ force: true });

  // Expect at least one window within 30s (cloud latency)
  const workspaceWindows = page.locator('.workspace-window');
  await expect(workspaceWindows).toHaveCount(1, { timeout: 30000 });
});
