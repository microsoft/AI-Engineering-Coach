import { test, expect, Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

async function bootHarness(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

async function navigateToBurndown(page: Page) {
  await page.locator('[data-page="burndown"]').first().click();
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.querySelector('.loading-spinner') && content.innerHTML.length > 200;
  }, { timeout: 10000 });
}

// TODO(FF_TOKEN_REPORTING_ENABLED): These tests are SKIPPED while the burndown
// feature flag is off (see beforeEach). When the flag is switched back on, two
// things below are known to be stale and MUST be fixed before they will pass:
//   1. The value assertions in this file still expect the OLD getBurndown mock
//      (budget 1500 / consumed 248 / projected 2480). The page now reads
//      getAiCreditBurndown (budget 300 / consumed 42.5 / projected 425). Either
//      update these to the new numbers, or switch to structural checks
//      (presence of "Budget" / "Consumed:" / "Projected:" / "All Models").
//   2. The getAiCreditBurndown mock in tests/e2e/harness.html is incomplete
//      (missing byModel/missingPct/countedRequests/partialRequests/
//      pendingRequests/noDataRequests/finalizableRequests/coverageByDay, etc.),
//      so the status section never renders. Fill it out to match the real
//      AiCreditBurndownData shape in src/core/analyzer-consumption.ts.
test.describe('Burndown', () => {
  test.beforeEach(async ({ page }) => {
    await bootHarness(page);
    // When FF_TOKEN_REPORTING_ENABLED is off, app.ts removes the Burndown nav
    // link at runtime (and the page renders only a "disabled" notice). The link
    // removal runs synchronously on app.js load, so by the time the harness has
    // booted it is already gone. Skip gracefully instead of timing out on a
    // click target that no longer exists.
    const hasBurndown = (await page.locator('[data-page="burndown"]').count()) > 0;
    test.skip(!hasBurndown, 'Burndown is gated by FF_TOKEN_REPORTING_ENABLED');
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
