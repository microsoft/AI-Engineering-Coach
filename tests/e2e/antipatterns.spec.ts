import { test, expect, Page } from '@playwright/test';
import { curiosityBalance } from '../../src/core/curiosity-balance';
import type { CuriosityData } from '../../src/core/types/curiosity-types';
import { curiosityAntiPatterns } from '../../src/core/curiosity-patterns';
import type { AntiPatternData } from '../../src/core/types';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';
type MockWindow = Window & {
  getMockData: (method: string, params: Record<string, unknown>) => unknown;
  recordedRequests?: string[];
};

async function navigateToAntiPatterns(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="anti-patterns"]').first().click();
  await expect(page.locator('#content h1')).toHaveText('Anti-Patterns', { timeout: 15000 });
  await expect(page.locator('#content .ap-score-card')).toHaveCount(4);
}

test.describe('Anti-Patterns', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-30T12:00:00Z'));
    await navigateToAntiPatterns(page);
  });

  test('renders practice score cards for all 4 groups', async ({ page }) => {
    const cards = page.locator('.ap-score-card');
    await expect(cards.first()).toBeVisible();
    const content = await page.textContent('#content');
    expect(content).toContain('72');
    expect(content).toContain('85');
    expect(content).toContain('68');
    expect(content).toContain('91');
  });

  test('shows pattern list with occurrences', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('Giant Prompt Detected');
    expect(content).toContain('Abandoned Session');
  });

  test('shows total occurrence count', async ({ page }) => {
    const content = await page.textContent('#content');
    // Individual pattern occurrences should be visible
    expect(content).toContain('8');  // Giant Prompt: 8 occurrences
    expect(content).toContain('5');  // Abandoned Session: 5 occurrences
  });

  test('score badges are color-coded', async ({ page }) => {
    const cards = page.locator('.ap-score-card');
    const count = await cards.count();
    expect(count).toBe(4);
  });

  test('keeps Curiosity under Prompt Quality, with no separate tab', async ({ page }) => {
    await expect(page.locator('.ap-tab')).toHaveText([/Anti-Patterns/, /Rules/]);
    await expect(page.locator('#tab-curiosity')).toHaveCount(0);
    await expect(page.locator('.ap-score-card[data-group="prompt-quality"]')).toContainText('Curiosity: More evidence needed');
  });

  for (const [counts, label] of [
    [{ direct: 10, web: 10, repository: 20, action: 60 }, 'Balanced'],
    [{ direct: 18, web: 1, repository: 1, action: 30 }, 'Needs review'],
    [{ direct: 20, web: 0, repository: 0, action: 30 }, 'Strongly skewed'],
  ] as const) {
    test(`renders ${label} in the existing Prompt Quality score and findings`, async ({ page }) => {
      const data = await page.evaluate(() => (window as MockWindow).getMockData('getCuriosity', {}) as CuriosityData);
      const total = counts.direct + counts.web + counts.repository + counts.action;
      data.counts = counts;
      data.balance = curiosityBalance(counts, total, 7);
      data.repeated = [];
      const patterns = curiosityAntiPatterns(data);
      await page.evaluate(({ patterns, tier }) => {
        const root = window as MockWindow;
        const original = root.getMockData;
        const calls: string[] = [];
        root.recordedRequests = calls;
        root.getMockData = (method, params) => {
          calls.push(method);
          const base = original(method, params) as AntiPatternData;
          return method === 'getAntiPatterns' ? {
            ...base, curiosityTier: tier, patterns: [...base.patterns, ...patterns],
            totalOccurrences: base.totalOccurrences + patterns.length,
          } : base;
        };
      }, { patterns, tier: data.balance.tier });
      await page.locator('#sidebar [data-page="anti-patterns"]').click();
      await expect(page.locator('.ap-score-card[data-group="prompt-quality"]')).toContainText(`Curiosity: ${label}`);
      const group = page.locator('.ap-group-details').first();
      await group.locator('summary').first().click();
      if (label === 'Balanced') await expect(group.locator('.ap-finding-name').filter({ hasText: 'Curiosity balance' })).toHaveCount(0);
      else {
        const finding = group.locator('.ap-finding').filter({ hasText: `Curiosity balance: ${label}` });
        await expect(finding).toBeVisible();
        await expect(finding).toContainText('not question quality or learning');
        await finding.locator('.ap-occurrences > summary').click();
        await expect(finding.getByRole('link', { name: 'View example', exact: true }).first()).toBeVisible();
        await expect(finding.locator('.occ-explain-btn')).toHaveCount(0);
      }
      await expect(page.locator('.ap-tab')).toHaveCount(2);
      expect(await page.evaluate(() => (window as MockWindow).recordedRequests)).not.toContain('getCuriosity');
    });
  }

  test('shows escaped repeated-wording examples as a low-severity Prompt Quality finding', async ({ page }) => {
    const data = await page.evaluate(() => (window as MockWindow).getMockData('getCuriosity', {}) as CuriosityData);
    const text = '<img src=x onerror=window.coachInjected=true>';
    data.repeated[0].text = text;
    const patterns = curiosityAntiPatterns(data);
    await page.evaluate(patterns => {
      const root = window as MockWindow;
      const original = root.getMockData;
      root.getMockData = (method, params) => {
        const base = original(method, params) as AntiPatternData;
        return method === 'getAntiPatterns' ? { ...base, patterns: [...base.patterns, ...patterns] } : base;
      };
    }, patterns);
    await page.locator('#sidebar [data-page="anti-patterns"]').click();
    const group = page.locator('.ap-group-details').first();
    await group.locator('summary').first().click();
    const finding = group.locator('.ap-finding').filter({ hasText: 'Repeated inquiry wording' });
    await expect(finding).toContainText('not semantic similarity or proof of forgetting');
    await finding.locator('.ap-occurrences > summary').click();
    await expect(finding).toContainText(text);
    await expect(finding.locator('img')).toHaveCount(0);
    await expect(finding.locator('.occ-explain-btn')).toHaveCount(0);
    await expect(finding.getByRole('link', { name: 'View example', exact: true })).toHaveCount(1);
    await expect(finding.locator('.occ-session-link')).toHaveCSS('color', 'rgb(55, 148, 255)');
  });
});
