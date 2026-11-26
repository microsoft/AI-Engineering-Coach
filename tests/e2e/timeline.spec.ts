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

/** Turns on Show prompts and questions in the open lane's details: it starts off. */
const showText = (page: Page) => page.locator('#tlxShowText').check();

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

  test('explains its numbers in a collapsed box, and what its text controls show in their tooltips', async ({ page }) => {
    const how = page.locator('#tlxHow');
    const summary = how.locator('summary');
    await expect(summary).toHaveText('How these numbers are measured');
    await expect(how).toHaveJSProperty('open', false);
    await expect(how.locator('li').first()).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(how).toHaveJSProperty('open', true);
    await expect(how.locator('li')).toHaveCount(6);
    await expect(how.locator('li').first()).toBeVisible();
    await expect(how).toContainText('Full definitions: the Timeline page of the AI Engineer Coach docs');
    await page.keyboard.press('Space');
    await expect(how).toHaveJSProperty('open', false);
    await page.keyboard.press('Space');
    await expect(how).toHaveJSProperty('open', true);
    // Its state survives the page drawing again.
    await page.locator('#tlxGroup button[data-value="flat"]').click();
    await expect(how).toHaveJSProperty('open', true);

    await expect(page.locator('label.tlx-mask')).toHaveAttribute('title', /model names.*on this page only, not the sidebar/);
    await expect(page.locator('#tlxMask')).toHaveAccessibleDescription(/on this page only, not the sidebar/);
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await expect(page.locator('label.tlx-text-toggle')).toHaveAttribute('title', /log on this machine.*nothing of it leaves this page/);
    await expect(page.locator('#tlxShowText')).toHaveAccessibleDescription(/secret-like tokens, your home folder and your names are replaced/);
  });

  test('shows the selected session’s turns and links its family', async ({ page }) => {
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

  test('shows the prompts and questions behind a lane, hides them when masked, and jumps to a wait', async ({ page }) => {
    const text = page.locator('#tlxText');
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    // Off until you turn it on: nothing is read before that.
    await expect(page.locator('#tlxShowText')).not.toBeChecked();
    await expect(text.locator('.tx-list')).toHaveCount(0);
    await showText(page);
    await expect(text).toContainText('2 prompts this day, read again from the session’s log on this machine');
    await expect(text.locator('[data-text-at^="t:"] > .tx-body')).toHaveText(['Why is the checkout test flaky?', 'Fix it with a fake clock.']);
    await expect(text.locator('[data-text-at^="i:"]')).toContainText('Waited 35 min for your next prompt');
    await expect(text.locator('[data-text-at^="i:"] .tx-body')).toHaveText('It races on the clock.');
    // A hatched wait opens its lane and highlights the wait.
    await page.locator('.tlx-lane[data-session="tl-coord"] .tlx-lbl').click();
    await page.locator('.tlx-lane[data-session="tl-flaky"] .wait').click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Investigate flaky test');
    await expect(text.locator('.tx-item.focus')).toContainText('Waited 35 min');
    // From the keyboard too: a wait is a button, and Enter on it does the same.
    await page.locator('.tlx-lane[data-session="tl-coord"] .tlx-lbl').click();
    const wait = page.locator('.tlx-lane[data-session="tl-flaky"] .wait');
    await expect(wait).toHaveAttribute('role', 'button');
    await expect(wait).toHaveAttribute('aria-label', /^Waiting on you .*: 35 min/);
    await wait.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tlxDetailName')).toHaveText('Investigate flaky test');
    await expect(text.locator('.tx-item.focus')).toContainText('Waited 35 min');
    // The highlight belongs to that click: opening the lane again some other way shows none.
    await page.locator('.tlx-lane[data-session="tl-coord"] .tlx-lbl').click();
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await expect(text.locator('[data-text-at^="i:"]')).toBeVisible();
    await expect(text.locator('.tx-item.focus')).toHaveCount(0);
    // A question: what the agent said before it, the question, its choices and your answer.
    await page.locator('.tlx-strip-bars [data-day="2026-05-02"]').click();
    await page.locator('.tlx-lane[data-session="tl-notes"] .tlx-lbl').click();
    const ask = text.locator('[data-text-at^="w:question:"]');
    await expect(text).toContainText('1 prompt and 1 question or permission prompt this day');
    await expect(ask.locator('.tx-head')).toContainText('The agent asked you · you answered after 4 min');
    await expect(ask.locator('.tx-choices li')).toHaveText(['Yes', 'No']);
    await expect(ask.locator('.tx-answer')).toHaveText('Your answer No');
    await expect(ask.locator('details summary')).toHaveText('What the agent said before it asked');
    // A lane whose log can't be read again says so.
    await page.locator('.tlx-lane[data-session="tl-log"] .tlx-lbl').click();
    await expect(text).toContainText('couldn’t be read again');
    // Masked: hidden, and the setting can't be turned on.
    await page.locator('.tlx-lane[data-session="tl-notes"] .tlx-lbl').click();
    await page.locator('#tlxMask').check();
    await expect(page.locator('#tlxShowText')).toBeDisabled();
    await expect(text).toContainText('Hidden while names are masked');
    await expect(page.locator('#tlx-root')).not.toContainText('Include the beta features');
    await page.locator('#tlxMask').uncheck();
    await expect(text).toContainText('Include the beta features?');
    // Turned off, it stays off for other lanes and after the page is drawn again.
    await page.locator('#tlxShowText').uncheck();
    await expect(text.locator('.tx-list')).toHaveCount(0);
    await page.locator('[data-page="timeline"]').first().click();
    await page.locator('.tlx-lane').first().locator('.tlx-lbl').click();
    await expect(page.locator('#tlxShowText')).not.toBeChecked();
  });

  test('a hatched question opens its question with what the agent said before it, and no highlight outlives its click', async ({ page }) => {
    const text = page.locator('#tlxText');
    const question = page.locator('.tlx-lane[data-session="tl-notes"] .wait');
    await page.locator('.tlx-strip-bars [data-day="2026-05-02"]').click();
    await page.locator('.tlx-lane[data-session="tl-log"] .tlx-lbl').click();
    await showText(page);
    await question.click();
    await expect(page.locator('#tlxDetailName')).toHaveText('Release notes');
    const focus = text.locator('.tx-item.focus');
    await expect(focus).toHaveCount(1);
    await expect(focus).toHaveAttribute('data-text-at', /^w:question:/);
    await expect(focus).toContainText('Include the beta features?');
    // The agent's last message before it asked is shown, not folded away.
    await expect(focus.locator('details')).toHaveAttribute('open', '');
    await expect(focus).toContainText('I found three beta features.');
    // A reload of the Timeline keeps the lane open, but not the highlight.
    await page.locator('[data-page="dashboard"]').first().click();
    await page.locator('[data-page="timeline"]').first().click();
    await expect(text.locator('[data-text-at^="w:question:"]')).toBeVisible();
    await expect(text.locator('.tx-item.focus')).toHaveCount(0);
    // A click while the text is masked, or turned off, leaves no highlight to find when it shows again.
    await page.locator('#tlxMask').check();
    await question.click();
    await page.locator('#tlxMask').uncheck();
    await expect(text.locator('[data-text-at^="w:question:"]')).toBeVisible();
    await expect(text.locator('.tx-item.focus')).toHaveCount(0);
    await page.locator('#tlxShowText').uncheck();
    await question.press(' ');
    await page.locator('#tlxShowText').check();
    await expect(text.locator('[data-text-at^="w:question:"]')).toBeVisible();
    await expect(text.locator('.tx-item.focus')).toHaveCount(0);
    // Space, like Enter, opens it.
    await question.press(' ');
    await expect(text.locator('.tx-item.focus')).toHaveAttribute('data-text-at', /^w:question:/);
  });

  test('of two questions that began together, a hatched wait highlights the one it stands for', async ({ page }) => {
    await page.evaluate(() => {
      const at = (m: number) => new Date(2026, 4, 2, 15, m).getTime();
      (window as unknown as { mockTimelineTextHook?: (id: string) => unknown }).mockTimelineTextHook = id => ({
        sessionId: id, turns: [{ t: at(0), k: 'you', prompt: 'Draft the release notes for 2.4' }], waits: [
          { s: at(2), e: at(9), k: 'question', a: true, ask: 'Ship today?' },
          { s: at(2), e: at(6), k: 'question', a: true, ask: 'Include the beta features?' },
        ],
      });
    });
    await page.locator('.tlx-strip-bars [data-day="2026-05-02"]').click();
    await page.locator('.tlx-lane[data-session="tl-notes"] .tlx-lbl').click();
    await showText(page);
    await page.locator('.tlx-lane[data-session="tl-notes"] .wait').click();
    const focus = page.locator('#tlxText .tx-item.focus');
    await expect(focus).toHaveCount(1);
    await expect(focus).toContainText('Include the beta features?');
  });

  test('reads a lane again when its read was dropped for a newer one', async ({ page }) => {
    await page.evaluate(() => {
      let calls = 0;
      (window as unknown as { mockTimelineTextHook?: () => unknown }).mockTimelineTextHook = () => (calls++ === 0 ? { superseded: true } : undefined);
    });
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await showText(page);
    await expect(page.locator('#tlxText [data-text-at^="t:"] > .tx-body').first()).toHaveText('Why is the checkout test flaky?');
  });

  test('a harness turn hides the message that started it, not the agent’s reply', async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { mockTimelineTextHook?: (id: string) => unknown }).mockTimelineTextHook = id => ({
        sessionId: id, waits: [], turns: [{ t: new Date(2026, 4, 3, 14).getTime(), k: 'other', reply: 'The background build finished green.' }],
      });
    });
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await showText(page);
    const turn = page.locator('#tlxText [data-text-at^="t:"]').first();
    await expect(turn).toContainText('The message that started it isn’t shown: it is a summary or a harness message, not an instruction.');
    await expect(turn).toContainText('The background build finished green.');
  });

  test('says a wait for your next prompt followed a compaction, not that no reply was logged', async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { mockTimelineTextHook?: (id: string) => unknown }).mockTimelineTextHook = id => ({
        sessionId: id, waits: [], turns: [{ t: new Date(2026, 4, 3, 14).getTime(), k: 'compaction' }, { t: new Date(2026, 4, 3, 14, 40).getTime(), k: 'you', prompt: 'Go on.' }],
      });
    });
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await showText(page);
    await expect(page.locator('#tlxText [data-text-at^="i:"]')).toContainText('It followed a compaction, whose summary isn’t shown.');
  });

  test('ignores a read of a lane’s text that the Timeline reloaded under', async ({ page }) => {
    type HookWindow = { mockTimelineTextHook?: (id: string) => unknown; releaseText?: () => void };
    const prompts = page.locator('#tlxText [data-text-at^="t:"] > .tx-body');
    await page.evaluate(() => {
      const w = window as unknown as HookWindow;
      const gate = new Promise<void>(resolve => { w.releaseText = resolve; });
      w.mockTimelineTextHook = id => gate.then(() => ({ sessionId: id, waits: [], turns: [{ t: new Date(2026, 4, 3, 14).getTime(), k: 'you', prompt: 'Stale prompt' }] }));
    });
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await showText(page);
    await expect(page.locator('#tlxText')).toContainText('Reading this session’s log');
    // The Timeline reloads while that read is pending, and reads the lane again.
    await page.evaluate(() => { (window as unknown as HookWindow).mockTimelineTextHook = undefined; });
    await page.locator('[data-page="dashboard"]').first().click();
    await page.locator('[data-page="timeline"]').first().click();
    await expect(prompts.first()).toHaveText('Why is the checkout test flaky?');
    await page.evaluate(() => (window as unknown as HookWindow).releaseText?.());
    await page.locator('#tlxMask').check();
    await page.locator('#tlxMask').uncheck();
    await expect(prompts.first()).toHaveText('Why is the checkout test flaky?');
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

test.describe('Timeline prompts and questions, off until you turn them on', () => {
  type ReadWindow = { textReads: number; mockTimelineTextHook?: () => unknown };

  test('reads nothing from the log on first load, and says how to show it', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as ReadWindow;
      w.textReads = 0;
      w.mockTimelineTextHook = () => { w.textReads++; return undefined; };
    });
    await openTimeline(page);
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await page.locator('.tlx-lane[data-session="tl-flaky"] .wait').click();
    await expect(page.locator('#tlxShowText')).not.toBeChecked();
    await expect(page.locator('#tlxTextOff')).toHaveText('Off: turn it on to read this lane’s prompts, questions and answers from its log.');
    await expect(page.locator('#tlxText .tx-list')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as ReadWindow).textReads)).toBe(0);
    await showText(page);
    await expect(page.locator('#tlxTextOff')).toHaveCount(0);
    await expect(page.locator('#tlxText [data-text-at^="t:"]').first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as ReadWindow).textReads)).toBeGreaterThan(0);
  });

  test('keeps it on when you turned it on before', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('harness-webview-state', JSON.stringify({ timelineShowText: true })));
    await openTimeline(page);
    await page.locator('.tlx-lane[data-session="tl-flaky"] .tlx-lbl').click();
    await expect(page.locator('#tlxShowText')).toBeChecked();
    await expect(page.locator('#tlxText [data-text-at^="t:"]').first()).toBeVisible();
  });
});

test.describe('Timeline navigation from Families', () => {
  test('says 1 session, not 1 sessions, when one session and no family are in range', async ({ page }) => {
    await page.addInitScript(() => {
      const t = new Date(2026, 4, 3, 9).getTime();
      (window as unknown as { mockTimelineDataOverride: unknown }).mockTimelineDataOverride = { forkedSessions: 0, sessions: [
        { id: 'solo', name: 'Solo', branch: '', repo: 'shop', harness: 'Copilot App', model: 'gpt-5.4', parent: -1, via: null,
          turns: [{ t, d: 600000, k: 'you', sub: 0, comp: false, cr: 1, tok: 0 }] },
      ] };
    });
    await openTimeline(page);
    await page.locator('#tlxView [data-value="families"]').click();
    await expect(page.locator('.tlx')).toContainText('among the 1 session in this range');
  });
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
    // One answer, in the singular (E9).
    await expect(page.locator('.tlx')).toContainText('plus 1 answer in children');
    await expect(page.locator('.tlx')).toContainText('(1 family, 1 credit on average)');
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