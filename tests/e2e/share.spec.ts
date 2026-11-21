import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

interface ShareWindow {
  getMockData: (method: string, params: unknown) => unknown;
  openedUrls: string[];
}

/** Daily activity (every turn) on the five days up to 2026-05-03, and typed prompts on only the last two. */
function mockActivity(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as ShareWindow;
    const original = w.getMockData;
    const days = ['2026-04-29', '2026-04-30', '2026-05-01', '2026-05-02', '2026-05-03'];
    w.openedUrls = [];
    w.getMockData = (method, params) => {
      if (method === 'getDailyActivity') {
        return { labels: days, values: [9, 9, 9, 9, 9], loc: [0, 0, 0, 0, 0], sessions: [1, 1, 1, 1, 1], workspaces: [1, 1, 1, 1, 1], byHarness: [] };
      }
      if (method === 'getCalendarActivity') {
        return {
          days: days.slice(3).map(date => ({ date, requests: 3, focusScore: 50, dow: new Date(`${date}T00:00:00Z`).getUTCDay() })),
          maxRequests: 3,
          turnBasis: { humanTurns: 6, automatedTurns: 39, automatedByKind: { autopilot: 39 } },
        };
      }
      if (method === 'getFlowState') {
        return {
          overallFlowScore: 61, avgFollowUpSec: 20, avgBlockMin: 30, deepFlowDays: 1, totalDays: 2, suggestions: [], days: [],
          weeklyTrend: { labels: [], scores: [] }, hourlyFlow: Array.from({ length: 24 }, () => 0),
        };
      }
      if (method === 'openExternal') {
        w.openedUrls.push((params as { url: string }).url);
        return {};
      }
      return original(method, params);
    };
  });
}

test.describe('Share', () => {
  test('takes the current streak from the days you typed a prompt', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-05-03T12:00:00Z'));
    await page.goto(HARNESS_URL);
    await page.waitForFunction(() => {
      const content = document.getElementById('content');
      return content && content.innerHTML.length > 200 && !content.querySelector('.error-boundary');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'capabilities', host: 'vscode', llm: true } }));
    });
    await mockActivity(page);
    await page.locator('#sidebar [data-page="level-up"]').click();
    await page.locator('.lab-tab[data-lab-tab="share"]').click();
    await page.locator('#share-x').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as ShareWindow).openedUrls)).toHaveLength(1);
    const [url] = await page.evaluate(() => (window as unknown as ShareWindow).openedUrls);
    expect(decodeURIComponent(url)).toContain('2-day streak, Flow Score 61.');
  });
});
