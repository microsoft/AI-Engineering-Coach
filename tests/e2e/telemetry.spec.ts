import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

// Use the clean (extensionless) path: `npx serve` 301-redirects `harness.html` → `harness` and
// drops the query string, which would lose ?mode=loading. Requesting the clean path keeps it.
const LOADING_URL = harnessUrl('tests/e2e/harness?mode=loading');

async function openDetails(page: Page) {
  await page.goto(LOADING_URL);
  // The loading screen stays up (no dataReady in ?mode=loading); the worker box is built from
  // the streamed progress message once the details drawer is open.
  await page.locator('#loading-details-toggle').click();
  await page.waitForFunction(() => {
    const strip = document.getElementById('loading-telemetry');
    return !!strip && strip.dataset.init === '1' && document.getElementById('tg-mem-used')?.textContent !== '—';
  }, { timeout: 10000 });
}

test.describe('Loading worker telemetry (issue #106)', () => {
  test.beforeEach(async ({ page }) => {
    await openDetails(page);
  });

  test('renders the worker box in the details drawer on the loading screen', async ({ page }) => {
    await expect(page.locator('#loading-telemetry')).toBeVisible();
    await expect(page.locator('.loading-screen')).toBeVisible();
  });

  test('populates heap use against its cap from worker telemetry', async ({ page }) => {
    // heapUsedMB 2200 (→ 2.1 GB) / heapLimitMB 4096 (→ 4.0 GB).
    await expect(page.locator('#tg-mem-used')).toHaveText('2.1 GB');
    await expect(page.locator('#tg-mem-limit')).toHaveText('4.0 GB');
  });

  test('populates worker CPU', async ({ page }) => {
    await expect(page.locator('#tg-cpu-load')).toHaveText('78%');
  });

  test('populates RSS and buffer tiles', async ({ page }) => {
    await expect(page.locator('#tg-rss')).toHaveText('1.5 GB'); // rssMB 1536
    await expect(page.locator('#tg-buf')).toHaveText('320 MB'); // fileBufMB 320
  });

  test('summarises heap use in the health chip on the card', async ({ page }) => {
    // 2200 / 4096 ≈ 54%: below the 65% amber threshold.
    await expect(page.locator('#loading-health')).toHaveAttribute('data-level', 'ok');
    await expect(page.locator('#loading-health-text')).toHaveText('Healthy · 2.1 GB of 4.0 GB heap · 0 files skipped');
  });

  test('keeps the status card stable for long details', async ({ page }) => {
    // With the drawer closed the card is at its narrowest, so a long detail must clip.
    await page.locator('#loading-details-toggle').click();
    await expect(page.locator('#loading-details')).toBeHidden();
    const metrics = await page.locator('#loading-phase-detail').evaluate((element) => {
      const detail = element as HTMLElement;
      const longText = detail.textContent ?? '';
      const longHeight = detail.getBoundingClientRect().height;
      const isTruncated = detail.scrollWidth > detail.clientWidth;

      detail.textContent = 'Short detail';
      const shortHeight = detail.getBoundingClientRect().height;
      detail.textContent = longText;

      return { longHeight, shortHeight, isTruncated, title: detail.title, text: longText };
    });

    expect(metrics.isTruncated).toBe(true);
    expect(metrics.longHeight).toBe(metrics.shortHeight);
    expect(metrics.title).toBe(metrics.text);
  });
});
