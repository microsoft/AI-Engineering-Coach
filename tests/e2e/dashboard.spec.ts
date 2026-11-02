import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

async function waitForDashboard(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-screen') && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await waitForDashboard(page);
  });

  test('renders practice score cards', async ({ page }) => {
    const cards = page.locator('.ap-score-card');
    await expect(cards).toHaveCount(4);
    const content = await page.textContent('#content');
    // Scores: 72, 85, 68, 91
    expect(content).toContain('72');
    expect(content).toContain('85');
    expect(content).toContain('68');
    expect(content).toContain('91');
  });

  test('shows total workspaces stat', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('12');
    expect(content).toContain('Workspaces');
  });

  test('shows session and request stats', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('Requests');
    expect(content).toContain('Sessions');
  });

  test('renders daily activity chart area', async ({ page }) => {
    const canvas = page.locator('canvas#dailyChart');
    await expect(canvas).toBeAttached();
  });

  test('shows harness breakdown', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('Local Agent');
    expect(content).toContain('Claude Code');
  });

  test('shows workspace breakdown chart', async ({ page }) => {
    const canvas = page.locator('canvas#wsChart');
    await expect(canvas).toBeAttached();
  });

  test('navigation works to all pages', async ({ page }) => {
    const pages = ['timeline', 'output', 'burndown', 'patterns', 'anti-patterns'];
    for (const p of pages) {
      const link = page.locator(`[data-page="${p}"]`).first();
      if (p === 'burndown' && await link.count() === 0) continue;
      await link.click();
      await page.waitForTimeout(800);
      // Check no uncaught error boundary
      const hasError = await page.locator('.error-boundary').count();
      expect(hasError, `Page ${p} has error`).toBe(0);
      await page.locator('[data-page="dashboard"]').first().click();
      await page.waitForTimeout(800);
    }
  });

  test('shows AI LoC stat', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('AI LoC');
  });
});
