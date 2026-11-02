import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

async function waitForDashboard(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForDashboard(page);
  });

  test('all nav links work', async ({ page }) => {
    const pages = ['dashboard', 'timeline', 'output', 'burndown', 'patterns', 'anti-patterns', 'config-health'];
    for (const p of pages) {
      const link = page.locator(`[data-page="${p}"]`).first();
      if (p === 'burndown' && await link.count() === 0) continue;
      await link.click();
      await page.waitForTimeout(500);
      const content = await page.locator('#content');
      const text = await content.textContent();
      expect(text!.length).toBeGreaterThan(50);
    }
  });

  test('page content changes on navigation', async ({ page }) => {
    const dashboardContent = await page.textContent('#content');
    await page.locator('[data-page="output"]').first().click();
    await page.waitForFunction(() => {
      const content = document.getElementById('content');
      return content && !content.querySelector('.loading-spinner');
    }, { timeout: 10000 });
    const outputContent = await page.textContent('#content');
    expect(outputContent).not.toEqual(dashboardContent);
  });

  test('no JS errors on any page navigation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const pages = ['timeline', 'output', 'burndown', 'patterns', 'anti-patterns', 'config-health', 'dashboard'];
    for (const p of pages) {
      const link = page.locator(`[data-page="${p}"]`).first();
      if (p === 'burndown' && await link.count() === 0) continue;
      await link.click();
      await page.waitForTimeout(500);
    }

    expect(errors).toHaveLength(0);
  });

  test('badges populate after data loads', async ({ page }) => {
    await page.waitForTimeout(500);
    const sessionsBadge = page.locator('#badge-sessions');
    const text = await sessionsBadge.textContent();
    expect(text!.trim().length).toBeGreaterThan(0);
  });
});
