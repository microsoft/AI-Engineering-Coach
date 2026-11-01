import { test, expect, Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

/** Opens the dashboard and waits until its first page has rendered. */
async function openDashboard(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

async function openPromptCache(page: Page, mode?: string, readyText = 'Prompt Cache') {
  await page.goto(HARNESS_URL);
  if (mode) await page.evaluate(m => { (window as unknown as { mockPromptCacheMode: string }).mockPromptCacheMode = m; }, mode);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="config-health"]').first().click();
  await page.locator('[data-tab="prompt-cache"]').click();
  await page.waitForFunction(text => {
    const content = document.getElementById('content');
    return content && content.textContent?.includes(text) && !content.querySelector('.loading-spinner');
  }, readyText, { timeout: 15000 });
}

test.describe('Prompt Cache tab', () => {
  test.beforeEach(async ({ page }) => {
    await openPromptCache(page, undefined, 'Why the cache broke');
  });

  test('sits next to Context Management and keeps each tab working', async ({ page }) => {
    const tabs = page.locator('.ctx-sub-tab');
    await expect(tabs).toHaveText(['Context Quality', 'Context Management', 'Prompt Cache']);
    await page.locator('[data-tab="context-mgmt"]').click();
    await expect(page.locator('#content')).toContainText('Context Score');
    await page.locator('[data-tab="prompt-cache"]').click();
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
  });

  test('shows key figures, insights and one row per harness without pooling them', async ({ page }) => {
    const root = page.locator('#ctxPromptCache');
    await expect(root.locator('.ctx-cache-tips')).toContainText('5 minutes for claude-opus-5.5');
    await expect(root.locator('.ctx-comp-kpi', { hasText: 'Cache hit ratio' })).toHaveCount(3);
    await expect(root.locator('.ctx-comp-kpi', { hasText: 'Input cost saved' }).locator('.ctx-comp-kpi-value')).toHaveText('90%');
    await expect(root.locator('.ctx-comp-kpi', { hasText: 'Breaks per 100 calls' })).toContainText('2.2');
    const rows = root.locator('.ctx-comp-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: 'Local Agent' })).toContainText('Not reported by this harness');
    await expect(rows.filter({ hasText: 'Codex' })).toContainText('session totals');
    await expect(rows.filter({ hasText: 'Copilot App' }).locator('.ctx-comp-bar')).toHaveAttribute('aria-label', /Read from cache 97%, Written to cache 3\.3%/);
  });

  test('lists why the cache broke, who controls each cause, and opens details from the keyboard', async ({ page }) => {
    const table = page.locator('table[aria-label="Why the cache broke"]');
    await expect(table.locator('tbody tr.ctx-cache-cause')).toHaveCount(7);
    const first = table.locator('tr.ctx-cache-cause').first();
    await expect(first).toContainText('Came back after the cache expired');
    await expect(first).toContainText('You');
    await expect(table.locator('tr[data-cause="system-prompt"]')).toContainText('Harness');
    const toggle = first.locator('button.ctx-cache-expand');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const detail = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('/compact');
    await expect(detail).toContainText('session resumed (9)');
    await page.keyboard.press('Space');
    await expect(detail).toBeHidden();
    const unattributed = table.locator('tr[data-cause="unattributed"] button.ctx-cache-expand');
    await unattributed.click();
    const unattributedDetail = page.locator(`#${await unattributed.getAttribute('aria-controls')}`);
    await expect(unattributedDetail).toContainText('Confidence: Not logged');
    await expect(unattributedDetail).not.toContainText('Logged on the call itself');
    await expect(page.locator('#ctxCacheAttribution')).toContainText('54% of rebuilt tokens came from causes you can change');
  });

  test('explains where cache misses come from and how the time since the cache was refreshed compares with its lifetime', async ({ page }) => {
    const attribution = page.locator('#ctxCacheAttribution');
    await expect(attribution.locator('[data-origin="rebuilt"]')).toContainText('54%');
    await expect(attribution.locator('[data-origin="rebuilt"]')).toContainText('(25% of cost)');
    await expect(attribution).toContainText('You came back after the cache expired in 78 of 450 returns');
    await expect(attribution.locator('#ctxCacheReturns')).toContainText('3 more returns came after a call that didn\u2019t log when its cache expires, so they aren\u2019t counted.');
    await expect(attribution).toContainText('At an expiry break, the cache had last been refreshed 51 min earlier (median).');
    await expect(attribution.locator('.ctx-cache-list').last()).toContainText('claude-opus-5.5');
    await expect(attribution.locator('.ctx-cache-list').last()).toContainText('5 min');
  });

  test('opens a session timeline on demand with cache layers and a break table', async ({ page }) => {
    const toggle = page.locator('#ctxCacheTopSessions .ctx-cache-session-toggle').first();
    await expect(toggle).toContainText('254.0K rebuilt');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    await expect(panel.locator('canvas')).toHaveAttribute('aria-label', /3 cache breaks marked/);
    await expect(panel.locator('table[aria-label="Cache breaks in this session"] tbody tr')).toHaveCount(3);
    await expect(panel.locator('table[aria-label="Cache breaks in this session"] thead')).toContainText('Since refresh / lifetime');
    await expect(panel.locator('tr[data-cause="ttl-agent"]')).toContainText('also system prompt changed');
    await expect(panel.locator('tr[data-cause="ttl-agent"]')).toContainText('workspace_context');
    const layers = panel.locator('.ctx-cache-layer');
    await expect(layers).toHaveText(['Cache tokens', 'Cache breaks']);
    await layers.nth(1).click();
    await expect(layers.nth(1)).toHaveAttribute('aria-pressed', 'false');
    // The chart's values as a table, from the keyboard; it keeps every layer even when one is toggled off.
    const data = panel.locator('details.call-timeline-data');
    await expect(data.locator('summary')).toHaveText('Show the chart as a table');
    await data.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(data).toHaveAttribute('open', '');
    await expect(data.locator('thead th')).toHaveText(['Model calls', 'Time', 'Read from cache', 'Written to cache', 'Uncached', 'Markers']);
    await expect(data.locator('tbody tr')).toHaveCount(60);
    await expect(data.locator('tbody tr').first().locator('th')).toHaveText('#1\u20132');
    await expect(data.locator('tbody tr').first()).toContainText('30.0K');
    await expect(data.locator('tbody tr').nth(18)).toContainText('Came back after the cache expired: 98.0K tokens rebuilt');
    const requests = await page.evaluate(() => (window as unknown as { promptCacheRequests: { method: string; params: { sessionId?: string } }[] }).promptCacheRequests);
    expect(requests.filter(r => r.method === 'getSessionTimeline').map(r => r.params.sessionId)).toEqual(['pc-1']);
  });

  test('shows per-request timelines without break attribution for other harnesses', async ({ page }) => {
    const toggle = page.locator('#ctxCacheTopSessions .ctx-cache-session-toggle').filter({ hasText: 'data-pipeline' });
    await toggle.click();
    const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    await expect(panel.locator('canvas')).toHaveAttribute('aria-label', /per request/);
    await expect(panel).toContainText('Cache breaks are logged only by Copilot App and Copilot CLI');
    await panel.locator('details.call-timeline-data summary').click();
    await expect(panel.locator('details.call-timeline-data thead th')).toHaveText(['Requests', 'Time', 'Read from cache', 'Written to cache', 'Uncached']);
    await expect(panel.locator('details.call-timeline-data tbody tr')).toHaveCount(18);
  });

  test('loads a workspace\u2019s sessions for that harness', async ({ page }) => {
    const toggle = page.locator('.ctx-cache-ws-toggle').first();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    await expect(panel.locator('.ctx-cache-session-toggle')).toHaveCount(1);
    const requests = await page.evaluate(() => (window as unknown as { promptCacheRequests: { method: string; params: { workspaceId?: string; harness?: string } }[] }).promptCacheRequests);
    expect(requests.filter(r => r.method === 'getPromptCacheSessions').map(r => [r.params.workspaceId, r.params.harness])).toEqual([['my-api', 'GitHub Copilot App']]);
    await toggle.click();
    await expect(panel).toBeHidden();
  });

  test('links to GitHub guidance and says it is not for performance evaluation', async ({ page }) => {
    await expect(page.locator('#ctxPromptCache .ctx-comp-guide')).toHaveAttribute('href', /optimize-ai-usage#4-preserve-the-cache/);
    await expect(page.locator('#ctxPromptCache')).toContainText('not for evaluating anyone\u2019s performance');
  });

  test('keeps the latest range when an earlier range responds later', async ({ page }) => {
    const coverage = page.locator('.ctx-comp-kpi', { hasText: 'Coverage' });
    await expect(coverage).toContainText('of 1.8K requests');
    // Month requests answer slowly from now on; three-month requests answer at once.
    await page.evaluate(() => {
      (window as unknown as { mockResponseDelay: (method: string, params: { filter?: { fromDate?: string } }) => number }).mockResponseDelay = (method, params) => {
        if (method !== 'getPromptCache') return 5;
        const from = params.filter?.fromDate;
        return from != null && Date.now() - Date.parse(from) > 45 * 86_400_000 ? 5 : 800;
      };
    });
    await page.locator('#ctxRangeBar .cons-range-btn', { hasText: 'Last 3 months' }).click();
    await expect(coverage).toContainText('of 5.4K requests');
    await page.locator('#ctxRangeBar .cons-range-btn', { hasText: 'Last 1 month' }).click();
    await page.locator('#ctxRangeBar .cons-range-btn', { hasText: 'Last 3 months' }).click();
    await expect(coverage).toContainText('of 5.4K requests');
    await page.waitForTimeout(1_200);
    await expect(page.locator('#ctxRangeBar .cons-range-btn.active')).toHaveText('Last 3 months');
    await expect(coverage).toContainText('of 5.4K requests');
  });
});

test.describe('Prompt Cache tab states', () => {
  test('says so when the data fails to load instead of spinning', async ({ page }) => {
    await openPromptCache(page, 'error', 'Couldn\u2019t load prompt-cache data');
    await expect(page.locator('#ctxCacheError')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#content .loading-spinner')).toHaveCount(0);
  });

  test('explains when no request in range logged cache usage', async ({ page }) => {
    await openPromptCache(page, 'empty', 'No model call in this range');
    await expect(page.locator('#ctxCacheEmpty')).toContainText('VS Code doesn\u2019t');
    await expect(page.locator('.ctx-comp-row')).toContainText('Not reported by this harness');
  });

  test('says attribution is Copilot-only when no harness logs breaks', async ({ page }) => {
    await openPromptCache(page, 'no-attribution', 'Prompt Cache');
    await expect(page.locator('#ctxCacheNoAttribution')).toContainText('logged only by Copilot App and Copilot CLI');
    await expect(page.locator('.ctx-comp-row')).toHaveCount(4);
  });

  test('says breaks in range are unlisted instead of claiming the cache never broke', async ({ page }) => {
    await openPromptCache(page, 'unlisted', 'Why the cache broke');
    await expect(page.locator('#ctxCacheUnlisted')).toContainText('5 cache breaks in this range aren\u2019t listed, because each session lists only its first 100 breaks.');
    await expect(page.locator('#ctxCacheAttribution')).not.toContainText('every main-agent call reused');
  });

  test('shows Copilot returns without claiming zero breaks or misses when only other harnesses logged cache tokens', async ({ page }) => {
    await openPromptCache(page, 'returns-only', 'Cache lifetime and expiry');
    const root = page.locator('#ctxPromptCache');
    await expect(root.locator('.ctx-comp-row', { hasText: 'Copilot App' })).toContainText('No cache usage logged in this range');
    await expect(root.locator('#ctxCacheAttribution')).toHaveCount(0);
    await expect(root.locator('#ctxCacheNoBreaks')).toHaveCount(0);
    await expect(root).not.toContainText('tokens missed the cache');
    const returns = root.locator('#ctxCacheReturnsOnly');
    await expect(returns).toContainText('You came back after the cache expired in 1 of 1 returns (100%).');
    await expect(returns).toContainText('No Copilot App call in this range logged cache tokens, so Copilot App cache breaks and misses can\u2019t be measured');
  });

  test('keeps one Copilot harness\u2019s returns out of the other\u2019s measured attribution, on a card of their own', async ({ page }) => {
    await openPromptCache(page, 'returns-mixed', 'Why the cache broke');
    const root = page.locator('#ctxPromptCache');
    await expect(root.locator('.ctx-comp-row', { hasText: 'Copilot CLI' })).toContainText('No cache usage logged in this range');
    await expect(root.locator('#ctxCacheAttribution h4')).toContainText('Why the cache broke \u00b7 Copilot App \u00b7');
    // The measured harness's own returns, unchanged by the other harness's.
    await expect(root.locator('#ctxCacheReturns')).toContainText('You came back after the cache expired in 78 of 450 returns (17%).');
    const returns = root.locator('#ctxCacheReturnsOnly');
    await expect(returns).toContainText('Cache lifetime and expiry \u00b7 Copilot CLI');
    await expect(returns).toContainText('You came back after the cache expired in 1 of 1 returns (100%).');
    await expect(returns).toContainText('No Copilot CLI call in this range logged cache tokens, so Copilot CLI cache breaks and misses can\u2019t be measured');
  });
});

test.describe('Context Health sub-tabs with late responses', () => {
  /** Opens the dashboard with one RPC method answering after a second. */
  async function openWithSlow(page: Page, method: string) {
    await openDashboard(page);
    await page.evaluate(slow => {
      (window as unknown as { mockResponseDelay: (method: string) => number }).mockResponseDelay = m => (m === slow ? 1_000 : 5);
    }, method);
  }

  test('keeps Prompt Cache when Context Quality answers after the switch', async ({ page }) => {
    await openWithSlow(page, 'getConfigHealth');
    await page.locator('[data-page="config-health"]').first().click();
    await page.locator('[data-tab="prompt-cache"]').click();
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    // Context Quality's response arrives meanwhile and is dropped.
    await page.waitForTimeout(1_500);
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    await expect(page.locator('#content')).not.toContainText('Overall Score');
  });

  test('keeps Prompt Cache when a Context Management range check answers after the switch', async ({ page }) => {
    await openWithSlow(page, 'getContextRangeAvailability');
    await page.locator('[data-page="config-health"]').first().click();
    await expect(page.locator('#content')).toContainText('Overall Score');
    await page.locator('[data-tab="context-mgmt"]').click();
    await page.locator('[data-tab="prompt-cache"]').click();
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    const ranges = page.locator('#ctxRangeBar .cons-range-btn');
    await expect(ranges).toHaveCount(5);
    // The range check for Context Management arrives meanwhile; it must not redraw the bar or the tab.
    await page.waitForTimeout(1_500);
    await expect(ranges).toHaveCount(5);
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    const loads = await page.evaluate(() => (window as unknown as { promptCacheRequests: { method: string }[] }).promptCacheRequests.filter(r => r.method === 'getPromptCache').length);
    expect(loads).toBe(1);
  });

  test('drops a late Context Quality failure instead of replacing Prompt Cache with an error', async ({ page }) => {
    await openWithSlow(page, 'getConfigHealth');
    await page.evaluate(() => { (window as unknown as { mockErrorMethods: string[] }).mockErrorMethods = ['getConfigHealth']; });
    await page.locator('[data-page="config-health"]').first().click();
    await page.locator('[data-tab="prompt-cache"]').click();
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    // Context Quality's load fails meanwhile; the failure belongs to a render the user has left.
    await page.waitForTimeout(1_500);
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  });

  test('still shows the error when the selected tab fails to load', async ({ page }) => {
    await openWithSlow(page, 'getConfigHealth');
    await page.evaluate(() => { (window as unknown as { mockErrorMethods: string[] }).mockErrorMethods = ['getConfigHealth']; });
    await page.locator('[data-page="config-health"]').first().click();
    await expect(page.locator('#content .error-boundary')).toContainText('mock getConfigHealth failure');
  });
});

test.describe('Context Health date cutoff', () => {
  test('applies to Context Quality but not to Prompt Cache', async ({ page }) => {
    await openDashboard(page);
    await page.locator('[data-page="config-health"]').first().click();
    await expect(page.locator('#content')).toContainText('Overall Score');
    const allTime = page.locator('#ctxRangeBar .cons-range-btn[data-range="0"]');
    await expect(allTime).toBeDisabled();

    await page.locator('[data-tab="prompt-cache"]').click();
    await expect(page.locator('#ctxPromptCache')).toBeVisible();
    await expect(allTime).toBeEnabled();
    await allTime.click();
    await expect(allTime).toHaveClass(/\bactive\b/);
    // All time asks for every request, including those from before the Context Health cutoff.
    await expect.poll(() => page.evaluate(() => {
      const loads = (window as unknown as { promptCacheRequests: { method: string; params: { filter: { fromDate?: string } } }[] }).promptCacheRequests.filter(r => r.method === 'getPromptCache');
      return loads.length > 1 ? loads[loads.length - 1].params.filter.fromDate ?? 'none' : 'pending';
    })).toBe('none');

    await page.locator('[data-tab="config-quality"]').click();
    await expect(page.locator('#content')).toContainText('Overall Score');
    await expect(allTime).toBeDisabled();
  });
});
