import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

// Use the clean (extensionless) path: `npx serve` 301-redirects `harness.html` → `harness` and
// drops the query string, which would lose ?mode=loading. Requesting the clean path keeps it.
const LOADING_URL = harnessUrl('tests/e2e/harness?mode=loading');

async function waitForTelemetryStrip(page: Page) {
  await page.goto(LOADING_URL);
  // The loading screen must stay up (no dataReady in ?mode=loading) and the telemetry strip
  // should be built from the streamed progress message.
  await page.waitForFunction(() => {
    const strip = document.getElementById('loading-telemetry');
    return !!strip && strip.dataset.init === '1' && !!document.getElementById('tg-mem-used');
  }, { timeout: 10000 });
}

test.describe('Loading telemetry strip (issue #106)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForTelemetryStrip(page);
  });

  test('renders the resource telemetry strip on the loading screen', async ({ page }) => {
    await expect(page.locator('#loading-telemetry')).toBeVisible();
    // The dashboard must NOT have taken over — the loading screen is still up.
    await expect(page.locator('.loading-screen')).toBeVisible();
  });

  test('populates memory gauge from worker telemetry', async ({ page }) => {
    // heapUsedMB 2200 (→ 2.1 GB) / heapLimitMB 4096 (→ 4.0 GB).
    const used = await page.textContent('#tg-mem-used');
    const limit = await page.textContent('#tg-mem-limit');
    expect(used).toContain('2.1 GB');
    expect(limit).toContain('4.0 GB');
  });

  test('populates CPU gauge and load label', async ({ page }) => {
    const cpu = await page.textContent('#tg-cpu-load');
    // cpuPct 78 → "busy" (>=70).
    expect(cpu?.toLowerCase()).toContain('busy');
  });

  test('populates RSS and buffer tiles', async ({ page }) => {
    expect(await page.textContent('#tg-rss')).toContain('1.5 GB'); // rssMB 1536
    expect(await page.textContent('#tg-buf')).toContain('320 MB'); // fileBufMB 320
  });

  test('keeps the status card stable for long workspace paths', async ({ page }) => {
    const metrics = await page.locator('#loading-phase-detail').evaluate((element) => {
      const detail = element as HTMLElement;
      const longText = detail.textContent ?? '';
      const longHeight = detail.getBoundingClientRect().height;
      const isTruncated = detail.scrollWidth > detail.clientWidth;

      detail.textContent = 'Short workspace path';
      const shortHeight = detail.getBoundingClientRect().height;
      detail.textContent = longText;

      return {
        longHeight,
        shortHeight,
        isTruncated,
        title: detail.title,
        text: longText,
      };
    });

    expect(metrics.isTruncated).toBe(true);
    expect(metrics.longHeight).toBe(metrics.shortHeight);
    expect(metrics.title).toBe(metrics.text);
  });
});
