import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

async function openDashboard(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

/** Simulate the VS Code host reporting a GitHub Copilot sign-in or sign-out. */
function pushCapabilities(page: Page, llm: boolean) {
  return page.evaluate(value => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'capabilities', host: 'vscode', llm: value } }));
  }, llm);
}

test.describe('GitHub Copilot availability', () => {
  test('shows and hides the Dashboard Skill Finder card in place', async ({ page }) => {
    await openDashboard(page);
    const card = page.locator('.dash-section').filter({ has: page.getByRole('heading', { name: 'Skill Finder' }) });
    await expect(card).toBeVisible();

    await pushCapabilities(page, false);
    await expect(card).toBeHidden();

    await pushCapabilities(page, true);
    await expect(card).toBeVisible();
    await expect(card.locator('#dashScanBtn')).toBeEnabled();
  });

  test('swaps Review Context Files for a disabled sign-in hint while Copilot is unavailable', async ({ page }) => {
    await openDashboard(page);
    await page.locator('#sidebar [data-page="config-health"]').click();
    const review = page.locator('#ctxReviewBtn');
    const count = page.locator('#ctxReviewCount');
    const unavailable = page.locator('button.llm-fallback', { hasText: 'Review Context Files' });
    await expect(review).toBeEnabled();
    await expect(count).toBeVisible();
    await expect(unavailable).toBeHidden();

    await pushCapabilities(page, false);
    await expect(review).toBeHidden();
    await expect(count).toBeHidden();
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAttribute('title', 'Sign in to GitHub Copilot in VS Code to use this.');

    await pushCapabilities(page, true);
    await expect(review).toBeEnabled();
    await expect(count).toBeVisible();
    await expect(unavailable).toBeHidden();
  });
});
