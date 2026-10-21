import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`loading starts before progress and survives early navigation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto('http://localhost:3999/tests/e2e/harness?mode=loading');
    await expect(page.locator('#load-progress-bar')).toBeAttached();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'progress', phase: 2, pct: 20,
        workspacePlan: [JSON.stringify({ order: 0, workspaceKey: 'my-api' })],
      } }));
      document.querySelector<HTMLAnchorElement>('[data-page="curiosity"]')?.click();
    });
    await expect(page.locator('#load-progress-bar')).toBeAttached();
    await expect(page.locator('.cal-workspace-cell')).toHaveCount(1);
    await expect(page.locator('.loading-spinner')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
    });
    await page.clock.runFor(300);
    await expect(page.locator('#content')).toContainText('Sessions with inquiry');
    await expect(page.locator('#load-progress-bar')).toHaveCount(0);
  });

  test(`one progress screen covers parsing and analysis at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto('http://localhost:3999/tests/e2e/harness?mode=manual-loading');
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'progress', phase: 4, pct: 91, detail: 'Computing analytics',
      } }));
    });
    await page.clock.runFor(60_000);
    await expect(page.locator('.loading-screen')).toBeVisible();
    await expect(page.locator('#loading-phase-detail')).toHaveText('Computing analytics');
    await expect(page.locator('#load-progress-bar')).toHaveAttribute('style', /91%/);
    await expect(page.locator('#dailyChart')).toHaveCount(0);
    await expect(page.locator('.ap-score-card')).toHaveCount(0);
    await expect(page.locator('.loading-spinner')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
    });
    await page.clock.runFor(300);
    await expect(page.locator('.loading-screen')).toHaveCount(0);
    await expect(page.locator('.dash-stat-lbl')).toContainText(['Requests', 'Sessions', 'AI LoC', 'Workspaces']);
    await expect(page.locator('.ap-score-card')).toHaveCount(4);
    await expect(page.locator('.dash-identity .score-ring text')).toHaveText('79');
    await expect(page.locator('#dailyChart')).toBeVisible();
    await expect(page.locator('#content')).not.toContainText('Analyzing anti-patterns');
    await page.locator('[data-page="anti-patterns"]').first().click();
    await page.clock.runFor(300);
    await expect(page.getByRole('heading', { name: 'Anti-Patterns', exact: true })).toBeVisible();
    await expect(page.locator('.ap-score-grid .score-ring')).toHaveCount(4);
    await expect(page.locator('.loading-spinner:visible')).toHaveCount(0);
  });

  test(`loading preserves completions and ignores stale progress at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto('http://localhost:3999/tests/e2e/harness?mode=loading');
    await page.clock.runFor(120);
    await expect(page.locator('.loading-screen')).toBeVisible();

    const linesBefore = await page.locator('#loading-log .log-line').count();
    await page.evaluate(() => {
      const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
      const workspacePlan = Array.from({ length: 23_275 }, (_, order) => JSON.stringify({
        order, workspaceKey: `workspace-${order}`,
      }));
      send({ type: 'progress', phase: 2, pct: 10, workspacePlan });
      for (let order = 0; order < 1000; order++) {
        send({
          type: 'progress', phase: 2, pct: 30, workspaceDone: `workspace-${order}`,
          detail: `Workspace ${order + 1}`, sessions: 13,
        });
      }
    });
    await page.clock.runFor(20);
    await expect(page.locator('.cal-workspace-cell')).toHaveCount(23_275);
    await expect(page.locator('.cal-workspace-done')).toHaveCount(1000);
    await expect(page.locator('#loading-phase-detail')).toHaveText('Workspace 1000');
    await expect(page.locator('#loading-log .log-line')).toHaveCount(linesBefore + 1);

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'progress', phase: 4, pct: 90, detail: 'Pending progress' },
      }));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
    });
    await page.clock.runFor(300);
    await expect(page.locator('.loading-screen')).toHaveCount(0);
    await expect(page.locator('#content')).toContainText('Sessions');
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'progress', phase: 2, pct: 50, detail: 'Stale progress' },
      }));
    });
    await page.clock.runFor(300);
    await expect(page.locator('.loading-screen')).toHaveCount(0);
    await expect(page.locator('#content')).toContainText('Sessions');
  });
}
