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
    await expect(page.locator('#tlxKpis')).toContainText('3 waits started · 2 of 30 min or more');
    await expect(kpi(page, 'Peak parallel sessions')).toHaveText('3');
    await expect(page.locator('#tlxInsights')).toContainText('The longest unattended stretch on this day was 1 h 13 m, in the family of your coordinator “Checkout revamp” (5 of 5 sessions shown)');
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
    // A family with no credits beside one with credits has a known 0.0% share, not an unknown one.
    await expect(page.locator('#tlxImpact tr[data-family="tl-flaky"] td').last()).toHaveText('0.0%');
  });

  test('shows the selected session’s turns without prompt text, and links its family', async ({ page }) => {
    await expect(page.locator('#tlxDetailName')).toHaveText('Payment API tests');
    await page.locator('.tlx-lane[data-session="tl-lint"]').click();
    await expect(page.locator('#tlxDetail')).toContainText('Grandchild · parent “Payment API tests”');
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
    // The family the lane belongs to is the one selected: its root row and its detail, every member listed.
    await expect(page.locator('.frow.sel')).toHaveAttribute('data-family', 'tl-coord');
    await expect(page.locator('#tlxFamilyDetail h2')).toHaveText('Checkout revamp');
    await expect(page.locator('#tlxFamilyDetail tr[data-session]')).toHaveCount(5);
    await expect(page.locator('#tlxFamilyDetail tr[data-session="tl-lint"]')).toBeVisible();
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
    // ← → belong to the sidebar while it has focus.
    await page.locator('[data-page="timeline"]').first().focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.tlx-lane .nm').first()).toHaveText('Checkout revamp');
    await page.locator('#tlxLanes').focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.locator('.tlx-lane .nm').first()).toHaveText('Checkout revamp');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Release notes', 'Changelog', /^Untitled Copilot CLI session \d+ · /]);
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

  test('masks names, branches, repositories and search text', async ({ page }) => {
    await page.locator('#tlxQuery').fill('docs-site');
    await expect(page.locator('.tlx-lane .nm')).toHaveText(['Docs update']);
    await page.locator('#tlxMask').check();
    await expect(page.locator('#tlxQuery')).toHaveValue('');
    // Typing a name again can't show it: search is off while names are masked.
    await expect(page.locator('#tlxQuery')).toBeDisabled();
    await expect(page.locator('#tlxCount')).toHaveText('6 of 6 sessions shown');
    await expect(page.locator('.tlx-lane .nm').first()).toHaveText(/^Session \d+$/);
    await expect(page.locator('.tlx-lane[data-session="tl-pay"] .nm')).toHaveText(/^Child session \d+$/);
    const text = await page.locator('#tlx-root').innerText();
    for (const secret of ['Checkout revamp', 'Payment API', 'checkout-revamp', 'shop', 'my-api', 'docs-site']) expect(text).not.toContain(secret);
    await page.locator('#tlxMask').uncheck();
    await page.locator('#tlxView [data-value="families"]').click();
    await page.locator('#tlxFamilyQuery').fill('Checkout');
    await page.locator('#tlxMask').check();
    await expect(page.locator('#tlxFamilyQuery')).toHaveValue('');
    await expect(page.locator('#tlxFamilyQuery')).toBeDisabled();
  });

  test('judges each family in the Families view and opens one on its busiest day', async ({ page }) => {
    await page.locator('#tlxView [data-value="families"]').click();
    await expect(page.locator('#tlxFamilyKpis')).toContainText('2');
    await expect(page.locator('.frow')).toHaveCount(2);
    await expect(page.locator('.frow').first()).toContainText('Checkout revamp');
    await expect(page.locator('.frow').first()).toContainText('You stepped in');
    await expect(page.locator('#tlxFamilyDetail')).toContainText('1 of 4 child sessions (marked ✋) got input from you: you typed 1 prompt into it.');
    await expect(page.locator('#tlxFamilyDetail .hand')).toHaveText('✋ 1');
    await expect(page.locator('#tlxFamilyKpis')).toContainText('Credits in the top 2');
    await page.locator('[data-verdict="alone"]').click();
    await expect(page.locator('.frow')).toHaveCount(1);
    await expect(page.locator('.frow')).toContainText('Release notes');
    // The selection follows the filter: the family left in the list is the one shown.
    await expect(page.locator('#tlxFamilyDetail h2')).toHaveText('Release notes');
    await page.locator('#tlxOpenFamilyDay').click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Release notes');
    await expect(page.locator('#tlxView [data-value="day"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('opens family rows and headers from the keyboard', async ({ page }) => {
    await page.locator('.tlx-fam[data-family="tl-coord"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.tlx-fam[data-family="tl-coord"]')).toHaveAttribute('aria-expanded', 'false');
    // A collapsed family's lanes are hidden, so the selection moves to a lane you can see.
    await expect(page.locator('#tlxDetailName')).toHaveText('Investigate flaky test');
    await page.locator('#tlxImpact tr[data-family="tl-coord"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tlxDetailName')).toHaveText('Checkout revamp');
  });

  test('drills down to Context Health › Prompt Cache', async ({ page }) => {
    await page.locator('#tlxDetail a', { hasText: 'Prompt Cache' }).click();
    await expect(page.locator('#ctxSubTabCache')).toHaveCSS('font-weight', '600');
  });
});

test.describe('Timeline navigation from Families', () => {
  test('opens a child whose only activity is an answer on the day of that answer, selected (B12)', async ({ page }) => {
    await page.addInitScript(() => {
      const at = (d: number, h: number, m = 0) => new Date(2026, 4, d, h, m).getTime();
      const turn = (t: number, min: number, cr: number) => ({ t, d: min * 60000, k: 'you', sub: 0, comp: false, cr, tok: 0 });
      const s = (id: string, name: string, turns: unknown[], extra = {}) => ({ id, name, branch: '', repo: 'shop', harness: 'Copilot App', model: 'gpt-5.4', parent: -1, via: null, turns, ...extra });
      (window as unknown as { mockTimelineDataOverride: unknown }).mockTimelineDataOverride = { forkedSessions: 0, sessions: [
        s('p', 'Parent', [turn(at(2, 22), 10, 1)]),
        s('c', 'Answer child', [], { parent: 0, via: 'create', stops: [{ s: at(3, 0), e: at(3, 0), k: 'question', a: true }] }),
        s('u', 'Unrelated', [turn(at(2, 9), 30, 50)]),
      ] };
    });
    await openTimeline(page);
    // Coming from the parent's day, where an unrelated session has more credits.
    await page.locator('.tlx-strip-bars [data-day="2026-05-02"]').click();
    await page.locator('#tlxView [data-value="families"]').click();
    await page.locator('.frow[data-family="p"]').click();
    await expect(page.locator('.frow.sel')).toHaveAttribute('data-family', 'p');
    await page.locator('#tlxFamilyDetail tr[data-session="c"]').click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Answer child');
    await expect(page.locator('.tlx-lane.sel')).toHaveAttribute('data-session', 'c');
    await expect(page.locator('#tlxDateLabel')).toContainText('3');
  });

  test('describes a lane with no turn by what it holds, and a family with no agent time as 0% (B13, B14)', async ({ page }) => {
    await page.addInitScript(() => {
      const at = (d: number, h: number, m = 0) => new Date(2026, 4, d, h, m).getTime();
      const s = (id: string, name: string, turns: unknown[], extra = {}) => ({ id, name, branch: '', repo: 'shop', harness: 'Copilot App', model: 'gpt-5.4', parent: -1, via: null, turns, ...extra });
      (window as unknown as { mockTimelineDataOverride: unknown }).mockTimelineDataOverride = { forkedSessions: 0, sessions: [
        s('p', 'Parent', [{ t: at(3, 9), d: 0, k: 'you', sub: 0, comp: false, cr: 0, tok: 0 }]),
        s('c', 'Permission only', [], { parent: 0, via: 'create', stops: [{ s: at(3, 10), e: at(3, 10, 2), k: 'permission', a: true }] }),
        s('u', 'Lone session', [{ t: at(3, 11), d: 30 * 60000, k: 'you', sub: 0, comp: false, cr: 0, tok: 0 }]),
      ] };
    });
    await openTimeline(page);
    await page.locator('.tlx-lane[data-session="c"] .tlx-lbl').click();
    await expect(page.locator('#tlxDetail')).toContainText('This session logged no turn, only stops for you: the lane shows 2 min of waiting on you and 1 question or permission prompt you answered.');
    await expect(page.locator('#tlxDetail')).not.toContainText('carried over');
    await page.locator('#tlxView [data-value="families"]').click();
    await expect(page.locator('#tlx-root')).toContainText('0% of all agent time');
  });
});