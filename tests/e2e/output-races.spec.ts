import { test, expect, type Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

interface PendingProduction {
  data: unknown;
  resolve: (data: unknown) => void;
}

declare global {
  interface Window {
    getMockData: (method: string, params?: Record<string, unknown>) => unknown;
    outputRace: {
      requests: number;
      pending: Map<number, PendingProduction>;
      delivered: number[];
    };
  }
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(HARNESS_URL);
  await waitForDashboard(page);
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function waitForDashboard(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content?.textContent && content.textContent.length > 200
      && !content.querySelector('.loading-spinner')
      && !content.querySelector('.error-boundary')
      && document.getElementById('badge-output')?.textContent;
  });
}

async function holdProduction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.getMockData;
    const state: Window['outputRace'] = {
      requests: 0,
      pending: new Map<number, PendingProduction>(),
      delivered: [],
    };
    window.outputRace = state;
    window.getMockData = (method, params) => {
      const data = original(method, params);
      if (method !== 'getCodeProduction') return data;
      const id = ++state.requests;
      return new Promise<unknown>(resolve => state.pending.set(id, { data, resolve }));
    };
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (typeof message !== 'object' || message === null || !('data' in message)) return;
      const data = message.data;
      if (typeof data === 'object' && data !== null && 'outputTestRequest' in data
        && typeof data.outputTestRequest === 'number') {
        state.delivered.push(data.outputTestRequest);
      }
    });
  });
}

async function pendingRequests(page: Page, count: number): Promise<number[]> {
  await page.waitForFunction(expected => window.outputRace.pending.size === expected, count);
  return page.evaluate(() => Array.from(window.outputRace.pending.keys()));
}

async function finishRequest(
  page: Page, id: number, result: { totalAiLoc: number } | { error: string },
): Promise<void> {
  await page.evaluate(({ id, result }) => {
    const request = window.outputRace.pending.get(id);
    if (!request) throw new Error(`Missing held request ${id}`);
    window.outputRace.pending.delete(id);
    if ('error' in result) {
      request.resolve({ error: result.error, outputTestRequest: id });
      return;
    }
    const data = request.data;
    if (typeof data !== 'object' || data === null || !('summary' in data)
      || typeof data.summary !== 'object' || data.summary === null) {
      throw new Error('Production fixture is missing its summary');
    }
    request.resolve({
      ...data,
      summary: { ...data.summary, totalAiLoc: result.totalAiLoc, totalNetAiLoc: result.totalAiLoc },
      outputTestRequest: id,
    });
  }, { id, result });
  await page.waitForFunction(id => window.outputRace.delivered.includes(id), id);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

async function navigate(page: Page, destination: string): Promise<void> {
  await page.locator(`[data-page="${destination}"]`).first().click();
}

async function expectOneRangeRequest(page: Page): Promise<void> {
  const before = await page.evaluate(() => window.outputRace.requests);
  await page.locator('#outputRange [data-range="7"]').click();
  const after = await page.evaluate(() => window.outputRace.requests);
  expect(after - before, 'One click must invoke exactly one current-mount handler').toBe(1);
}

test('a late range response cannot overwrite newer output', async ({ page }) => {
  await navigate(page, 'output');
  await page.waitForSelector('#prodModelChart');
  await holdProduction(page);
  await page.locator('#outputRange [data-range="7"]').click();
  await pendingRequests(page, 1);
  await page.locator('#outputRange [data-range="28"]').click();
  const [older, newer] = await pendingRequests(page, 2);

  await finishRequest(page, newer, { totalAiLoc: 222 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await finishRequest(page, older, { totalAiLoc: 111 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
});

test('leaving Output while loading preserves the destination page', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  const [older] = await pendingRequests(page, 1);
  await navigate(page, 'timeline');
  await expect(page.locator('#content h1')).toHaveText('Timeline');

  await finishRequest(page, older, { totalAiLoc: 111 });
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  await expect(page.locator('#content h1')).toHaveText('Timeline');
});

test('returning to Output does not duplicate range handlers', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  await pendingRequests(page, 1);
  await navigate(page, 'timeline');
  await expect(page.locator('#content h1')).toHaveText('Timeline');
  await navigate(page, 'output');
  const [older, newer] = await pendingRequests(page, 2);

  await finishRequest(page, newer, { totalAiLoc: 222 });
  await finishRequest(page, older, { totalAiLoc: 111 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expectOneRangeRequest(page);
});

test('changing the harness during Output loading does not duplicate range handlers', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  const [older] = await pendingRequests(page, 1);
  await page.locator('#harness-filter').selectOption('GitHub Copilot CLI');
  await page.waitForFunction(id => Array.from(window.outputRace.pending.keys()).some(key => key !== id), older);
  const newer = await page.evaluate(id => Array.from(window.outputRace.pending.keys()).filter(key => key !== id), older);
  for (const id of newer) await finishRequest(page, id, { totalAiLoc: 222 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');

  await finishRequest(page, older, { totalAiLoc: 111 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expectOneRangeRequest(page);
});

test('a duplicate data-ready message does not restart a pending Output load', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  const [current] = await pendingRequests(page, 1);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dataReady' },
  })));

  await finishRequest(page, current, { totalAiLoc: 222 });
  expect(await page.evaluate(() => window.outputRace.requests)).toBe(1);
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  await expectOneRangeRequest(page);
});

test('reloading the webview discards a pending Output load', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  await pendingRequests(page, 1);

  await page.reload();
  await waitForDashboard(page);
  await holdProduction(page);
  await navigate(page, 'output');
  const [current] = await pendingRequests(page, 1);
  await finishRequest(page, current, { totalAiLoc: 222 });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  await expectOneRangeRequest(page);
});

test('a stale RPC error cannot overwrite a different page', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  const [older] = await pendingRequests(page, 1);
  await navigate(page, 'timeline');
  await expect(page.locator('#content h1')).toHaveText('Timeline');

  await finishRequest(page, older, { error: 'Old Output request failed' });
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  await expect(page.locator('#content h1')).toHaveText('Timeline');
});

test('a stale RPC error cannot overwrite a newer Output mount', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  await pendingRequests(page, 1);
  await navigate(page, 'timeline');
  await expect(page.locator('#content h1')).toHaveText('Timeline');
  await navigate(page, 'output');
  const [older, newer] = await pendingRequests(page, 2);

  await finishRequest(page, newer, { totalAiLoc: 222 });
  await finishRequest(page, older, { error: 'Old Output request failed' });
  await expect(page.locator('#content .stat-value').first()).toHaveText('222');
  await expect(page.locator('#content .error-boundary')).toHaveCount(0);
  await expectOneRangeRequest(page);
});

test('a current RPC error remains visible', async ({ page }) => {
  await holdProduction(page);
  await navigate(page, 'output');
  const [current] = await pendingRequests(page, 1);

  await finishRequest(page, current, { error: 'Current Output request failed' });
  await expect(page.locator('#content .error-boundary')).toContainText('Current Output request failed');
});
