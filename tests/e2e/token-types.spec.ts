import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

type TokenTypesWindow = Window & { mockTokenTypesMode?: 'empty' | 'error'; tokenTypesRequests?: { filter?: { fromDate?: string } }[] };

async function openTokenTypes(page: Page, mode?: 'empty' | 'error') {
  if (mode) await page.addInitScript(m => { (window as TokenTypesWindow).mockTokenTypesMode = m; }, mode);
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="config-health"]').first().click();
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.querySelector('.loading-spinner') && content.innerHTML.length > 500 && !content.querySelector('.error-boundary');
  }, { timeout: 15000 });
  await page.locator('[data-tab="token-types"]').click();
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && !content.querySelector('.loading-spinner') && content.querySelector('#ctxTokenTypes, #ctxTokenTypesError');
  }, { timeout: 15000 });
}

test.describe('Token Types tab', () => {
  test('is the fourth Context Health tab, with its own range bar and Insights box', async ({ page }) => {
    await openTokenTypes(page);
    await expect(page.locator('.ctx-sub-tab')).toHaveText(['Context Quality', 'Context Management', 'Prompt Cache', 'Token Types']);
    await expect(page.locator('#ctxRangeBar .cons-range-btn').first()).toBeVisible();
    await expect(page.locator('.ctx-tt-tips')).toContainText('Reasoning is 61% of Copilot App output tokens');
    const requests = await page.evaluate(() => (window as TokenTypesWindow).tokenTypesRequests ?? []);
    expect(requests.at(-1)?.filter?.fromDate).toBeTruthy();
  });

  test('shows the five token types for Copilot App with figures and sections', async ({ page }) => {
    await openTokenTypes(page);
    const kpis = page.locator('.ctx-tt-kpi');
    await expect(kpis).toHaveCount(5);
    await expect(kpis.locator('.ctx-tt-kpi-value')).toHaveText(['61%', '1.3%', '12%', '4', '3.2 s']);
    await expect(page.locator('[aria-label="Reasoning share by effort"] .ctx-tt-bar')).toHaveCount(4);
    await expect(page.locator('[aria-label="Sub-agent tokens by type"] .ctx-tt-bar-label')).toHaveText(['research', 'code-review', 'custom', 'explore']);
    await expect(page.locator('#ctxTokenTypes')).toContainText('14 compactions: 14 automatic \u00b7 1 failed.');
    await expect(page.locator('#ctxTokenTypes')).toContainText('not for evaluating anyone');
  });

  test('expands latency by model from the keyboard', async ({ page }) => {
    await openTokenTypes(page);
    const toggle = page.locator('#ctxTtLatency .ctx-tt-expand');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#ctxTtLatencyTable')).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#ctxTtLatencyTable tbody tr')).toHaveCount(2);
    await expect(page.locator('#ctxTtLatencyTable')).toContainText('16.0 s / 1.2 min');
  });

  test('switches harness and marks what a harness does not log as not reported', async ({ page }) => {
    await openTokenTypes(page);
    const picks = page.locator('.ctx-tt-pick');
    await expect(picks).toHaveText(['Copilot App', 'Claude Code']);
    await picks.nth(1).click();
    await expect(picks.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ctx-tt-source')).toHaveAttribute('data-source', 'claude');
    await expect(page.locator('.ctx-tt-kpi.muted')).toHaveCount(4);
    await expect(page.locator('.ctx-tt-kpi[data-type="truncation"] .ctx-tt-kpi-value')).toHaveText('2');
    const local = page.locator('.ctx-tt-matrix tbody tr', { hasText: 'Local Agent' });
    await expect(local.locator('.not-reported')).toHaveCount(5);
  });

  test('explains an empty range', async ({ page }) => {
    await openTokenTypes(page, 'empty');
    await expect(page.locator('#ctxTokenTypesEmpty')).toContainText('No request in this range logged token types beyond input and output');
    await expect(page.locator('.ctx-tt-matrix')).toBeVisible();
  });

  test('reports a failed load', async ({ page }) => {
    await openTokenTypes(page, 'error');
    await expect(page.locator('#ctxTokenTypesError')).toContainText('Could not load token types');
  });
});

test.describe('Token Types date range', () => {
  test('offers All time without Context Health\u2019s token-data cutoff, which Context Quality keeps', async ({ page }) => {
    await openTokenTypes(page);
    const allTime = page.locator('#ctxRangeBar .cons-range-btn[data-range="0"]');
    await expect(allTime).toBeEnabled();
    await allTime.click();
    await expect(allTime).toHaveClass(/\bactive\b/);
    // All time asks for every request, including those from before the cutoff, such as older Claude Code logs.
    await expect.poll(() => page.evaluate(() => {
      const loads = (window as TokenTypesWindow).tokenTypesRequests ?? [];
      return loads.length > 1 ? loads[loads.length - 1].filter?.fromDate ?? 'none' : 'pending';
    })).toBe('none');
    await expect(page.locator('#ctxTokenTypes')).toBeVisible();

    await page.locator('[data-tab="config-quality"]').click();
    await expect(page.locator('#content')).toContainText('Overall Score');
    await expect(allTime).toBeDisabled();
  });
});

test.describe('Token Types with a late response', () => {
  test('keeps Context Management when Token Types answers after the switch', async ({ page }) => {
    await page.goto(HARNESS_URL);
    await page.waitForFunction(() => {
      const content = document.getElementById('content');
      return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
    }, { timeout: 10000 });
    await page.evaluate(() => {
      (window as unknown as { mockResponseDelay: (method: string) => number }).mockResponseDelay = m => (m === 'getTokenTypes' ? 1_000 : 5);
    });
    await page.locator('[data-page="config-health"]').first().click();
    await expect(page.locator('#content')).toContainText('Overall Score');
    await page.locator('[data-tab="token-types"]').click();
    await page.locator('[data-tab="context-mgmt"]').click();
    await expect(page.locator('#content')).toContainText('Context Score');
    // Token Types answers meanwhile: its response is dropped instead of replacing Context Management.
    await page.waitForTimeout(1_500);
    await expect(page.locator('#content')).toContainText('Context Score');
    await expect(page.locator('#ctxTokenTypes, #ctxTokenTypesError')).toHaveCount(0);
    expect(await page.evaluate(() => ((window as TokenTypesWindow).tokenTypesRequests ?? []).length)).toBe(1);
  });
});
