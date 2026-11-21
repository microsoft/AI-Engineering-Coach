import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();

async function openTimeline(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="timeline"]').first().click();
  await expect(page.locator('#tlxKpis')).toBeVisible();
}

const kpi = (page: Page, label: string) => page.locator('#tlxKpis .ctx-comp-kpi')
  .filter({ has: page.locator('.ctx-comp-kpi-label', { hasText: new RegExp(`^${label}$`, 'i') }) }).locator('.ctx-comp-kpi-value');

test.describe('Timeline', () => {
  test.beforeEach(async ({ page }) => {
    await openTimeline(page);
  });

  test('shows the latest day with autonomy KPIs, coaching callouts and the session tree', async ({ page }) => {
    await expect(page.locator('#tlxDateLabel')).toContainText('2026');
    await expect(page.locator('#tlxDateLabel')).toContainText('3');
    await expect(kpi(page, 'Agent time')).toHaveText('3.9 h');
    await expect(kpi(page, 'Turns you typed')).toHaveText('5 of 11');
    await expect(kpi(page, 'Agent time per prompt')).toHaveText('47 min');
    await expect(kpi(page, 'Longest unattended')).toHaveText('1 h 13 m');
    await expect(kpi(page, 'Waiting on you')).toHaveText('1 h 30 m');
    await expect(page.locator('#tlxKpis')).toContainText('3 waits · 2 over 30 min');
    await expect(kpi(page, 'Peak parallel agents')).toHaveText('3');
    await expect(page.locator('#tlxInsights')).toContainText('Your coordinator “Checkout revamp” and 4 sessions of its family kept working 1 h 13 m');
    await expect(page.locator('#tlxCount')).toHaveText('6 of 6 sessions shown');
    // Tree order: coordinator, child, its grandchild, then the other children; one connector per shown child.
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Checkout revamp', 'Payment API tests', 'Lint fixes', 'Docs update', 'Perf probe', 'Investigate flaky test']);
    await expect(page.locator('.tlx-lanes .conn')).toHaveCount(4);
    await expect(page.locator('.tlx-lane[data-session="tl-perf"]')).toContainText('started by relay');
    await expect(page.locator('.tlx-lane[data-session="tl-flaky"] .wait')).toHaveCount(1);
    await expect(page.locator('.tlx-lane[data-session="tl-pay"] .sub')).toHaveText('2');
    await expect(page.locator('.tlx-lane[data-session="tl-docs"] .mk.autopilot')).toHaveCount(1);
    await expect(page.locator('.tlx-lane[data-session="tl-coord"] .mk.agent')).toHaveCount(1);
    await expect(page.locator('#tlxImpact tbody tr')).toHaveCount(2);
  });

  test('shows the selected session’s turns without prompt text, and links its family', async ({ page }) => {
    await expect(page.locator('#tlxDetailName')).toHaveText('Payment API tests');
    await page.locator('.tlx-lane[data-session="tl-lint"]').click();
    await expect(page.locator('#tlxDetail')).toContainText('Grandchild of “Payment API tests”');
    await expect(page.locator('#tlxDetail')).toContainText('compaction');
    await page.locator('#tlxOpenParent').click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Payment API tests');
    // ↑ ↓ change lane only when the timeline has focus.
    await page.locator('[data-page="timeline"]').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#tlxDetailName')).toHaveText('Payment API tests');
    await page.locator('#tlxLanes').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#tlxDetailName')).toHaveText('Lint fixes');
    await page.locator('#tlxShowFamily').click();
    await expect(page.locator('#tlxFamilyDetail h2')).toHaveText('Checkout revamp');
  });

  test('filters recompute the KPIs, and Clear restores every session', async ({ page }) => {
    await page.locator('#tlxYouTyped').check();
    await expect(page.locator('#tlxCount')).toContainText('3 of 6 sessions shown · KPIs, callouts and the impact table use the shown sessions');
    await expect(kpi(page, 'Turns you typed')).toHaveText('5 of 7');
    await page.locator('#tlxHarness').selectOption('Claude Code');
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Investigate flaky test']);
    await page.locator('#tlxClear').click();
    await expect(page.locator('#tlxCount')).toHaveText('6 of 6 sessions shown');
    await page.locator('#tlxQuery').fill('docs-site');
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Docs update']);
  });

  test('changes day with the arrows and the strip, and switches to the week', async ({ page }) => {
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Release notes', 'Changelog', /^Untitled Copilot CLI session/]);
    // A question the agent waited on inside a turn: drawn as a wait, left out of agent time.
    await expect(page.locator('.tlx-lane[data-session="tl-notes"] .wait.ask')).toHaveCount(1);
    await expect(page.locator('#tlxKpis')).toContainText('(1 on a question or permission)');
    await expect(kpi(page, 'Agent time')).toHaveText('0.4 h');
    await page.locator('.tlx-strip-bars [data-day="2026-05-03"]').click();
    await expect(kpi(page, 'Turns you typed')).toHaveText('5 of 11');
    await page.locator('#tlxView [data-value="week"]').click();
    await expect(page.locator('#tlxCount')).toHaveText('9 of 9 sessions shown');
    await expect(page.locator('.tlx-lanes.wk')).toBeVisible();
    await page.locator('#tlxGroup [data-value="flat"]').click();
    await expect(page.locator('.tlx-fam')).toHaveCount(0);
    await expect(page.locator('.tlx-lanes .conn')).toHaveCount(0);
  });

  test('masks names, branches and repositories', async ({ page }) => {
    await page.locator('#tlxMask').check();
    await expect(page.locator('.tlx-lane .nm').first()).toHaveText(/^Session \d+$/);
    await expect(page.locator('.tlx-lane[data-session="tl-pay"] .nm')).toHaveText(/^Child session \d+$/);
    const text = await page.locator('#tlx-root').innerText();
    for (const secret of ['Checkout revamp', 'Payment API', 'checkout-revamp', 'shop', 'my-api', 'docs-site']) expect(text).not.toContain(secret);
  });

  test('judges each family in the Families view and opens one on its busiest day', async ({ page }) => {
    await page.locator('#tlxView [data-value="families"]').click();
    await expect(page.locator('#tlxFamilyKpis')).toContainText('2');
    await expect(page.locator('.frow')).toHaveCount(2);
    await expect(page.locator('.frow').first()).toContainText('Checkout revamp');
    await expect(page.locator('.frow').first()).toContainText('Needed you');
    await expect(page.locator('#tlxFamilyDetail')).toContainText('You typed 1 prompt into 1 of 4 child sessions (marked ✋)');
    await expect(page.locator('#tlxFamilyDetail .hand')).toHaveText('✋ 1');
    await page.locator('[data-verdict="alone"]').click();
    await expect(page.locator('.frow')).toHaveCount(1);
    await expect(page.locator('.frow')).toContainText('Release notes');
    await page.locator('.frow').click();
    await page.locator('#tlxOpenFamilyDay').click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Release notes');
    await expect(page.locator('#tlxView [data-value="day"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('drills down to Context Health › Prompt Cache', async ({ page }) => {
    await page.locator('#tlxDetail a', { hasText: 'Prompt Cache' }).click();
    await expect(page.locator('#ctxSubTabCache')).toHaveCSS('font-weight', '600');
  });
});
