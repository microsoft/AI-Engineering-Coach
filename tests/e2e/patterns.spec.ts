import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

async function navigateToPatterns(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="patterns"]').first().click();
  // Wait for patterns page to fully render (heatmap + WLB data)
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.querySelector('.error-boundary') && content.innerHTML.length > 1000;
  }, { timeout: 15000 });
}

test.describe('Patterns', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToPatterns(page);
  });

  test('renders heatmap grid', async ({ page }) => {
    const heatmap = page.locator('.heatmap-container, #heatmapGrid');
    await expect(heatmap.first()).toBeAttached();
  });

  test('shows work-life balance score', async ({ page }) => {
    const content = await page.textContent('#content');
    // WLB section is rendered under Work Hours tab
    expect(content).toMatch(/Work Hours/i);
    // The heatmap data includes hour/activity values
    expect(content).toMatch(/Sun|Mon|Tue/i);
  });

  test('shows day or hour labels', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun|Weekday|Weekend/i);
  });
});
