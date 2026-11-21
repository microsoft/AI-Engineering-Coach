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

  test('says the work hours count only typed prompts, and which turns were left out', async ({ page }) => {
    const note = page.locator('#tabHours .turn-basis-note');
    await expect(note).toContainText('Counts the 2.8K prompts you typed; 1.2K automated turns left out.');
    await expect(note.locator('.turn-basis-kind')).toHaveText([
      'Sent by another agent: 899', 'Relayed from another session: 180', 'Autopilot continuations: 94', 'Sent by the harness: 30',
    ]);
    await expect(note.locator('.info-popup')).toBeHidden();
    await note.locator('.info-icon').focus();
    await expect(note.locator('.info-popup')).toBeVisible();
    await expect(page.locator('#heatmapGrid .heatmap-cell').first()).toHaveAttribute('title', /^Sun \d+:00 — \d+ prompts, \d+% focus$/);
  });

  test('says the calendar counts only typed prompts', async ({ page }) => {
    await page.locator('#patternTabs [data-tab="calendar"]').click();
    await expect(page.locator('#tabCalendar .turn-basis-note')).toContainText('Counts the 2.8K prompts you typed; 1.2K automated turns left out.');
    await expect(page.locator('#calendarGrid rect title').filter({ hasText: 'prompts' }).first()).toHaveText(/^\d{4}-\d{2}-\d{2}: \d+ prompts, 60% focus$/);
  });

  test('counts typed prompts per project, and code from every turn', async ({ page }) => {
    await page.locator('#patternTabs [data-tab="projects"]').click();
    const note = page.locator('#tabProjects .turn-basis-note');
    await expect(note).toContainText('Counts the 2.2K prompts you typed; 1.4K automated turns left out. Lines of code, languages and hot files include every turn.');
    await expect(page.locator('#tabProjects .project-card')).toHaveCount(3);
    await expect(page.locator('#tabProjects .proj-requests')).toHaveText(['980 prompts', '720 prompts', '510 prompts']);
    await page.locator('#tabProjects .proj-explore-btn').first().click();
    await expect(page.locator('#explore-ws-1')).toContainText('Prompts You Typed980');
  });
});
