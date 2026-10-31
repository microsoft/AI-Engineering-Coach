import { test, expect, Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

const available = { state: 'available', current: '0.2.0', latest: '0.4.0', publishedAt: '2026-10-01T12:00:00.000Z', canInstall: true };

async function openDashboard(page: Page, initialStatus?: unknown) {
  if (initialStatus) {
    await page.addInitScript(status => { (window as unknown as { mockUpdateStatus: unknown }).mockUpdateStatus = status; }, initialStatus);
  }
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
}

/** Simulate the VS Code host pushing a new update state. */
function pushUpdateStatus(page: Page, status: unknown) {
  return page.evaluate(value => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updateStatus', status: value } }));
  }, status);
}

function updateRequests(page: Page) {
  return page.evaluate(() => (window as unknown as { updateRequests?: string[] }).updateRequests ?? []);
}

test.describe('Update status in the build stamp footer', () => {
  test('stays hidden while there is no update', async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator('#build-info-status')).toBeHidden();
  });

  test('offers an available update and asks the host to confirm it', async ({ page }) => {
    await openDashboard(page, available);
    const status = page.locator('#build-info-status');
    await expect(status).toBeVisible();
    await expect(status.locator('.build-info-status-text')).toHaveText('v0.4.0 available');
    await expect(status).toHaveAttribute('title', /^You have v0\.2\.0\. v0\.4\.0 was published on /);
    await status.getByRole('button', { name: 'Update…' }).click();
    await expect.poll(() => updateRequests(page)).toEqual(['promptUpdate']);
  });

  test('offers a download when the host can only open the release page', async ({ page }) => {
    await openDashboard(page, { ...available, canInstall: false });
    const status = page.locator('#build-info-status');
    await expect(status.locator('.build-info-status-text')).toHaveText('v0.4.0 available');
    await status.getByRole('button', { name: 'Download…' }).click();
    await expect.poll(() => updateRequests(page)).toEqual(['promptUpdate']);
  });

  test('follows the host from updating to installed, then reloads on request', async ({ page }) => {
    await openDashboard(page);
    const status = page.locator('#build-info-status');
    await pushUpdateStatus(page, available);
    await expect(status.locator('.build-info-status-text')).toHaveText('v0.4.0 available');
    await pushUpdateStatus(page, { state: 'updating', latest: '0.4.0' });
    await expect(status).toHaveText('Updating to v0.4.0…');
    await expect(status.getByRole('button')).toHaveCount(0);
    await pushUpdateStatus(page, { state: 'installed', latest: '0.4.0' });
    await expect(status.locator('.build-info-status-text')).toHaveText('v0.4.0 installed');
    await status.getByRole('button', { name: 'Reload' }).click();
    await expect.poll(() => updateRequests(page)).toEqual(['reloadAfterUpdate']);
    await pushUpdateStatus(page, { state: 'none' });
    await expect(status).toBeHidden();
  });

  test('ignores malformed updates from the host', async ({ page }) => {
    await openDashboard(page, available);
    const status = page.locator('#build-info-status');
    await expect(status).toBeVisible();
    await pushUpdateStatus(page, { ...available, latest: '<img src=x onerror=alert(1)>' });
    await expect(status).toBeHidden();
    await expect(page.locator('#build-info-status img')).toHaveCount(0);
  });
});
