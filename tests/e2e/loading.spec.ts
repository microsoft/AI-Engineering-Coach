import { test, expect } from '@playwright/test';
import { harnessUrl } from './harness-url';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`loading starts before progress and survives early navigation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto(harnessUrl('tests/e2e/harness?mode=loading'));
    await expect(page.locator('#loading-card')).toBeAttached();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'progress', phase: 2, pct: 20,
        workspacePlan: [JSON.stringify({ order: 0, workspaceKey: 'my-api' })],
      } }));
      document.querySelector<HTMLAnchorElement>('[data-page="curiosity"]')?.click();
    });
    await expect(page.locator('#loading-card')).toBeAttached();
    await expect(page.locator('.cal-workspace-cell')).toHaveCount(1);
    await expect(page.locator('.loading-spinner')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
    });
    await page.clock.runFor(300);
    await expect(page.locator('#content')).toContainText('Sessions with inquiry');
    await expect(page.locator('#loading-card')).toHaveCount(0);
  });

  test(`one progress screen covers parsing and analysis at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'progress', phase: 4, pct: 91, detail: 'Computing analytics',
      } }));
    });
    await page.clock.runFor(60_000);
    await expect(page.locator('.loading-screen')).toBeVisible();
    await expect(page.locator('#loading-phase-detail')).toHaveText('Computing analytics');
    await expect(page.locator('#loading-pct-value')).toHaveText('91');
    await expect(page.locator('#dailyChart')).toHaveCount(0);
    await expect(page.locator('.ap-score-card')).toHaveCount(0);
    await expect(page.locator('.loading-spinner')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dataReady' } }));
    });
    // A slow load holds a short ready summary before the dashboard replaces it.
    await page.clock.runFor(100);
    await expect(page.locator('#load-index')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#loading-kicker-text')).toHaveText('Activity index ready');
    await page.clock.runFor(1000);
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
    await page.goto(harnessUrl('tests/e2e/harness?mode=loading'));
    await page.clock.runFor(120);
    await expect(page.locator('.loading-screen')).toBeVisible();

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

test.describe('loading screen redesign', () => {
  const send = (page: import('@playwright/test').Page, data: Record<string, unknown>) =>
    page.evaluate((d) => window.dispatchEvent(new MessageEvent('message', { data: d })), data);
  const plan = (n: number) => Array.from({ length: n }, (_, order) => JSON.stringify({ order, workspaceKey: `ws-${order}` }));

  test('keeps the percentage moving forward and names the CLI re-read on a cached load', async ({ page }) => {
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await send(page, { type: 'progress', phase: 1, pct: 10, detail: 'Loaded 520 cached sessions from disk', sessions: 520 });
    await send(page, { type: 'progress', phase: 2, pct: 10, detail: 'Re-reading 790 Copilot CLI and App sessions', workspacePlan: plan(790) });
    await send(page, {
      type: 'progress', phase: 2, pct: 60, sessions: 900, workspaceDone: 'ws-0',
      item: { kind: 'cli-session', index: 600, total: 790, folder: 'my-api', path: '~/work/my-api', status: 'parsed', ms: 12, sessions: 1 },
    });
    await expect(page.locator('#loading-phase-title')).toHaveText('Re-reading Copilot CLI and App sessions');
    await expect(page.locator('#loading-phase-detail')).toHaveText('Session 600 of 790 · my-api');
    await expect(page.locator('#loading-note')).toBeVisible();
    await expect(page.locator('#loading-pct-value')).toHaveText('60');
    await send(page, { type: 'progress', phase: 1, pct: 10, detail: 'late report' });
    await page.waitForTimeout(50);
    await expect(page.locator('#loading-pct-value')).toHaveText('60');
    await expect(page.locator('#loading-step-2')).toHaveAttribute('data-state', 'active');
    await expect(page.locator('.cal-workspace-now')).toHaveCount(1);
    await expect(page.locator('.cal-workspace-now')).toHaveAttribute('data-slot', '1');
  });

  test('remembers the details drawer across a reload and filters its activity', async ({ page }) => {
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    const toggle = page.getByRole('button', { name: 'Show details' });
    await expect(page.locator('#loading-details')).toBeHidden();
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#loading-details')).toBeVisible();
    await expect(page.locator('#loading-details-toggle')).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await expect(page.locator('#loading-details')).toBeVisible();
    for (const [index, status, ms] of [[1, 'parsed', 40], [2, 'slow', 2600], [3, 'skipped', 10]] as const) {
      await send(page, {
        type: 'progress', phase: 2, pct: 10 + index * 5,
        item: { kind: 'workspace', index, total: 3, folder: `repo-${index}`, path: `~/src/repo-${index}`, status, ms, sessions: 1 },
      });
    }
    await expect(page.locator('#loading-activity tr')).toHaveCount(3);
    await page.getByRole('button', { name: /^Skipped/ }).click();
    await expect(page.locator('#loading-activity tr')).toHaveCount(1);
    await expect(page.locator('#loading-activity tr .load-path b')).toHaveText('repo-3');
    await expect(page.locator('#loading-activity')).not.toContainText(/Users|home/);
  });

  test('keeps the ready summary when a page is chosen during it, then opens that page once', async ({ page }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await page.evaluate(() => {
      const w = window as unknown as { getMockData: (m: string, p: unknown) => unknown; curiosityCalls: number };
      const original = w.getMockData;
      w.curiosityCalls = 0;
      w.getMockData = (method, params) => { if (method === 'getCuriosity') w.curiosityCalls++; return original(method, params); };
    });
    await send(page, { type: 'progress', phase: 4, pct: 95, detail: 'Computing analytics', sessions: 12 });
    await page.clock.runFor(2000);
    await send(page, { type: 'dataReady' });
    await page.clock.runFor(100);
    await expect(page.locator('#load-index')).toHaveAttribute('data-state', 'ready');

    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('[data-page="curiosity"]')?.click());
    await page.clock.runFor(100);
    await expect(page.locator('#load-index')).toHaveAttribute('data-state', 'ready');

    await page.clock.runFor(1000);
    await expect(page.locator('#content')).toContainText('Sessions with inquiry');
    await expect(page.locator('#load-index')).toHaveCount(0);
    // One render: the same number of requests a normal visit to the page makes.
    const calls = () => page.evaluate(() => (window as unknown as { curiosityCalls: number }).curiosityCalls);
    const duringHold = await calls();
    await page.locator('[data-page="dashboard"]').first().click();
    await page.clock.runFor(300);
    await page.locator('[data-page="curiosity"]').first().click();
    await page.clock.runFor(300);
    await expect(page.locator('#content')).toContainText('Sessions with inquiry');
    expect(duringHold).toBeGreaterThan(0);
    expect(await calls()).toBe(duringHold * 2);
  });

  test('keeps the hidden sidebar out of the tab order while loading', async ({ page }) => {
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#sidebar [data-page="curiosity"]').first()).not.toBeVisible();
  });

  test('turns off transitions and glow when the user prefers reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await send(page, { type: 'progress', phase: 2, pct: 20, workspacePlan: plan(4), workspaceDone: 'ws-0' });
    const styles = await page.evaluate(() => {
      const tile = document.querySelector('.cal-workspace-done')!;
      const now = document.querySelector('.cal-workspace-now')!;
      const fill = document.querySelector('.load-seg-fill')!;
      return {
        tile: getComputedStyle(tile).transitionDuration,
        fill: getComputedStyle(fill).transitionDuration,
        glow: getComputedStyle(now).boxShadow,
        screen: getComputedStyle(document.querySelector('.load-index')!).animationName,
      };
    });
    expect(styles).toEqual({ tile: '0s', fill: '0s', glow: 'none', screen: 'none' });
  });

  test('fits a 560 px panel without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await page.goto(harnessUrl('tests/e2e/harness?mode=manual-loading'));
    await page.locator('#loading-details-toggle').click();
    const fit = await page.evaluate(() => {
      const stage = document.querySelector('.load-stage') as HTMLElement;
      const card = document.getElementById('loading-card')!.getBoundingClientRect();
      return { overflow: stage.scrollWidth - stage.clientWidth, right: card.right, left: card.left };
    });
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(560);
  });
});
