import { test, expect, Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

async function navigateToBurndown(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="burndown"]').first().click();
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.querySelector('.loading-spinner') && content.innerHTML.length > 200;
  }, { timeout: 10000 });
}

test.describe('Burndown', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToBurndown(page);
  });

  test('renders budget info', async ({ page }) => {
    const content = await page.textContent('#content');
    // budget: 1500
    expect(content).toMatch(/1[,.]?500/);
  });

  test('shows consumed number', async ({ page }) => {
    const content = await page.textContent('#content');
    // consumed: 248
    expect(content).toContain('248');
  });

  test('shows projected number', async ({ page }) => {
    const content = await page.textContent('#content');
    // projected: 2480
    expect(content).toMatch(/2[,.]?480/);
  });

  test('status indicator visible', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toMatch(/on.?track|within budget|budget/i);
  });

  test('shows current month', async ({ page }) => {
    const content = await page.textContent('#content');
    // page-burndown.ts formats the month with toLocaleString('default') in the BROWSER, so
    // compute the expected label in the same runtime via page.evaluate. Deriving it in Node
    // would use the OS default locale, which can differ from the browser's (e.g. a German
    // host renders "Juni" in Node but the page shows "June"). This still tracks the live
    // month without hard-coding it, so it never goes stale on a month rollover.
    const expectedMonth = await page.evaluate(() =>
      new Date().toLocaleString('default', { month: 'long', year: 'numeric' }),
    );
    expect(content).toContain(expectedMonth);
  });
});
