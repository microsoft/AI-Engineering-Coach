import { test, expect, Page } from '@playwright/test';
import { harnessUrl } from './harness-url';

/* The Timeline's date picker and Range view, on the synthetic Timeline range (activity on 2 and 3 May 2026). */

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
const day = (page: Page, date: string) => page.locator(`#tlxCal button[data-date="${date}"]`);

test.describe('Timeline date picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 4, 3, 12));
    await openTimeline(page);
  });

  test('opens a calendar from the date, marks active days and disables days outside the loaded range', async ({ page }) => {
    const label = page.locator('#tlxDateLabel');
    await expect(label).toHaveAttribute('aria-expanded', 'false');
    await label.click();
    await expect(page.locator('#tlxCal')).toBeVisible();
    await expect(label).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#tlxCalMonth')).toHaveText('May 2026');
    // 3 May has the most turns; 2 May fewer; days with none have no dot; days outside the loaded range can't be picked.
    await expect(day(page, '2026-05-03')).toHaveClass(/\ba3\b/);
    await expect(day(page, '2026-05-02')).toHaveClass(/\ba[12]\b/);
    await expect(day(page, '2026-05-02')).toHaveAttribute('aria-label', /Saturday, May 2, 2026, 3 turns \(2 typed\)/);
    await expect(day(page, '2026-05-01')).toBeDisabled();
    await expect(day(page, '2026-05-04')).toBeDisabled();
    await expect(page.locator('#tlxCalPrev')).toBeDisabled();
    await expect(page.locator('#tlxCalNext')).toBeDisabled();
    // The shown day is highlighted, and focus starts on it.
    await expect(day(page, '2026-05-03')).toHaveClass(/\bend\b/);
    await expect(day(page, '2026-05-03')).toBeFocused();
  });

  test('moves between days with the arrows, picks with Enter, and closes with Esc back on the button', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await page.keyboard.press('ArrowLeft');
    await expect(day(page, '2026-05-02')).toBeFocused();
    // Out of the loaded range, focus stays on its edge.
    await page.keyboard.press('ArrowLeft');
    await expect(day(page, '2026-05-02')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tlxCal')).toHaveCount(0);
    await expect(page.locator('#tlxDateLabel')).toContainText('May 2, 2026');
    await expect(page.locator('#tlxDateLabel')).toBeFocused();
    await expect(kpi(page, 'Turns you typed')).toHaveText('2 of 3');
    await page.locator('#tlxDateLabel').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#tlxCal')).toHaveCount(0);
    await expect(page.locator('#tlxDateLabel')).toBeFocused();
    await expect(page.locator('#tlxDateLabel')).toContainText('May 2, 2026');
  });

  test('keeps focus inside the calendar while it is open', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('#tlxCal'));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 3 === 0 ? 'Shift+Tab' : 'Tab');
      expect(await inside()).toBe(true);
    }
  });

  test('picks a custom range of two days that adds up its days', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await page.locator('#tlxCalMode button[data-value="range"]').click();
    await expect(page.locator('#tlxCalStatus')).toContainText('Pick the first day');
    await day(page, '2026-05-02').click();
    await expect(page.locator('#tlxCalStatus')).toContainText('now pick the last day');
    await day(page, '2026-05-03').click();
    await expect(page.locator('#tlxView button[data-value="range"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tlxDateLabel')).toContainText('2 days');
    // 2 of 3 typed on 2 May, 5 of 11 on 3 May.
    await expect(kpi(page, 'Turns you typed')).toHaveText('7 of 14');
    await expect(page.locator('#tlxCount')).toHaveText('9 of 9 sessions shown');
    await expect(page.locator('#tlxInsights')).toContainText('What happened from 2026-05-02 to 2026-05-03');
    await expect(page.locator('#tlxInsights')).toContainText('in this range');
    await expect(page.locator('#tlxImpact tbody tr')).toHaveCount(4);
    // Two days: an axis every 6 hours, midnights named by their day; both days highlighted on the strip.
    await expect(page.locator('.tlx-axis span').filter({ hasText: '6:00' })).toHaveCount(2);
    await expect(page.locator('.tlx-strip-bars .d.inwk')).toHaveCount(2);
    await expect(page.locator('.tlx-lg-end').first()).toContainText('Range 2026-05-02 → 2026-05-03: 7 typed · 7 automated');
    await expect(page).toHaveURL(/#view=range&from=2026-05-02&to=2026-05-03$/);
    // The detail panel and wait tips speak of the range.
    await expect(page.locator('#tlxDetail')).toContainText('agent time in this range');
  });

  test('steps a range by its length with the buttons and the arrows, and a strip day opens that day', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await page.locator('#tlxCalMode button[data-value="range"]').click();
    await day(page, '2026-05-02').click();
    await day(page, '2026-05-02').click();
    await expect(page.locator('#tlxDateLabel')).toContainText('1 day');
    await expect(page.locator('#tlxPrev')).toBeDisabled();
    await page.locator('#tlxNext').click();
    await expect(page).toHaveURL(/from=2026-05-03&to=2026-05-03$/);
    await expect(page.locator('#tlxNext')).toBeDisabled();
    await page.locator('#tlxLanes').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/from=2026-05-02&to=2026-05-02$/);
    await page.locator('.tlx-strip-bars .d[data-day="2026-05-03"]').click();
    await expect(page.locator('#tlxView button[data-value="day"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tlxDateLabel')).toContainText('May 3, 2026');
  });

  test('opens a parent active in the range on the range, whatever day the Day view was left on', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await page.locator('#tlxCalMode button[data-value="range"]').click();
    await day(page, '2026-05-02').click();
    await day(page, '2026-05-02').click();
    // The Day view moves to 3 May; back on the Range view, the range is still 2 May.
    await page.locator('.tlx-strip-bars .d[data-day="2026-05-03"]').click();
    await page.locator('#tlxView button[data-value="range"]').click();
    await expect(page).toHaveURL(/from=2026-05-02&to=2026-05-02$/);
    await page.locator('.tlx-lane[data-session="tl-log"]').click();
    await page.locator('#tlxOpenParent').click();
    await expect(page.locator('#tlxView button[data-value="range"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/from=2026-05-02&to=2026-05-02$/);
    await expect(page.locator('#tlxDetailName')).toHaveText('Release notes');
  });

  test('offers Today and the quick ranges, kept within the loaded days', async ({ page }) => {
    await page.locator('#tlxView button[data-value="week"]').click();
    await page.locator('#tlxDateLabel').click();
    await expect(page.locator('#tlxCalStatus')).toHaveText('Pick a day: its week opens.');
    await page.locator('#tlxCal [data-quick="last7"]').click();
    await expect(page.locator('#tlxView button[data-value="range"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/#view=range&from=2026-05-02&to=2026-05-03$/);
    await page.locator('#tlxDateLabel').click();
    await expect(page.locator('#tlxCal [data-quick="month"]')).toHaveAttribute('title', /May 2 – May 3/);
    await page.locator('#tlxCalMode button[data-value="date"]').click();
    await page.locator('#tlxCalToday').click();
    await expect(page.locator('#tlxView button[data-value="day"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tlxDateLabel')).toContainText('May 3, 2026');
  });

  test('closes when you click outside it', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await page.mouse.click(5, 5);
    await expect(page.locator('#tlxCal')).toHaveCount(0);
  });

  test('returns focus to the date after a click outside, unless the click focused something else', async ({ page }) => {
    await page.locator('#tlxDateLabel').click();
    await expect(day(page, '2026-05-03')).toBeFocused();
    // A click on plain text, which takes no focus.
    await page.locator('#tlxKpis .ctx-comp-kpi-sub').first().click();
    await expect(page.locator('#tlxCal')).toHaveCount(0);
    await expect(page.locator('#tlxDateLabel')).toBeFocused();
    await page.locator('#tlxDateLabel').click();
    const tree = page.locator('#tlxGroup button[data-value="tree"]');
    await tree.click();
    await expect(page.locator('#tlxCal')).toHaveCount(0);
    await expect(tree).toBeFocused();
  });

  test('keeps a picked date without activity when the Timeline loads again', async ({ page }) => {
    type MockWindow = { mockTimelineData: () => { sessions: { turns: { t: number }[] }[] }; mockTimelineDataOverride?: unknown };
    // Activity on 2, 3 and 17 May: 11 May lies between, with none.
    await page.evaluate(() => {
      const w = window as unknown as MockWindow;
      const data = w.mockTimelineData();
      const flaky = data.sessions[5];
      w.mockTimelineDataOverride = { ...data, sessions: [...data.sessions, { ...flaky, id: 'tl-late', turns: [{ ...flaky.turns[0], t: new Date(2026, 4, 17, 10).getTime() }] }] };
    });
    await page.locator('[data-page="dashboard"]').first().click();
    await page.locator('[data-page="timeline"]').first().click();
    await page.locator('#tlxView button[data-value="week"]').click();
    await page.locator('#tlxDateLabel').click();
    await day(page, '2026-05-11').click();
    await expect(page.locator('#tlxDateLabel')).toContainText('May 11 – May 17, 2026');
    await page.locator('[data-page="dashboard"]').first().click();
    await page.locator('[data-page="timeline"]').first().click();
    await expect(page.locator('#tlxDateLabel')).toContainText('May 11 – May 17, 2026');
  });

  test('keeps focus in the calendar when a month button it was on turns disabled', async ({ page }) => {
    type MockWindow = { mockTimelineData: () => { sessions: { turns: { t: number }[] }[] }; mockTimelineDataOverride?: unknown };
    // Activity from 20 April: ‹ from May opens April, the first loaded month, where ‹ can't go further.
    await page.evaluate(() => {
      const w = window as unknown as MockWindow;
      const data = w.mockTimelineData();
      const flaky = data.sessions[5];
      w.mockTimelineDataOverride = { ...data, sessions: [...data.sessions, { ...flaky, id: 'tl-april', turns: [{ ...flaky.turns[0], t: new Date(2026, 3, 20, 10).getTime() }] }] };
    });
    await page.locator('[data-page="dashboard"]').first().click();
    await page.locator('[data-page="timeline"]').first().click();
    await page.locator('#tlxDateLabel').click();
    await page.locator('#tlxCalPrev').click();
    await expect(page.locator('#tlxCalMonth')).toHaveText('April 2026');
    await expect(page.locator('#tlxCalPrev')).toBeDisabled();
    const focused = () => page.evaluate(() => (document.activeElement?.closest('#tlxCal') ? (document.activeElement as HTMLElement).dataset.date ?? document.activeElement.id : null));
    await expect.poll(focused).toBe('2026-04-20');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#tlxCal'))).toBe(true);
    await page.locator('#tlxCalNext').click();
    await expect(page.locator('#tlxCalMonth')).toHaveText('May 2026');
    await expect(page.locator('#tlxCalNext')).toBeDisabled();
    await expect.poll(focused).toBe('2026-05-03');
  });
});

test.describe('Timeline day strip', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 4, 3, 12));
    await openTimeline(page);
  });

  /** The strip's footer, as the KPI tiles give it: `typed · automated · agent-hours`. */
  async function kpiFooter(page: Page): Promise<string> {
    const [typed, turns] = (await kpi(page, 'Turns you typed').innerText()).split(' of ').map(Number);
    const hours = (await kpi(page, 'Agent time').innerText()).replace(' h', '');
    return `${typed} typed · ${turns - typed} automated · ${hours} agent-hours`;
  }

  test('sits above the day’s callouts and KPIs, and counts what the filters show', async ({ page }) => {
    const above = await page.evaluate(() => {
      const strip = document.getElementById('tlxStrip')!;
      return [document.getElementById('tlxInsights'), document.getElementById('tlxKpis')]
        .every(el => !!el && !!(strip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(above).toBe(true);
    await expect(page.locator('#tlxStrip .tlx-strip-head')).not.toContainText('before filters');
    await expect(page.locator('.tlx-lg-end').first()).toContainText(`Selected day 2026-05-03: ${await kpiFooter(page)}`);

    await page.locator('#tlxHarness').selectOption('Claude Code');
    await expect(kpi(page, 'Turns you typed')).toHaveText('2 of 2');
    await expect(page.locator('#tlxStrip .tlx-strip-head')).toContainText('only sessions your filters show');
    await expect(page.locator('.tlx-lg-end').first()).toContainText(`Selected day 2026-05-03: ${await kpiFooter(page)}`);
    // No Claude Code session on 2 May: an empty bar, and no dot in the calendar.
    await expect(page.locator('.tlx-strip-bars .d[data-day="2026-05-02"]')).toHaveAttribute('title', /2026-05-02: no session your filters show/);
    await page.locator('#tlxDateLabel').click();
    await expect(day(page, '2026-05-02')).toHaveClass(/\ba0\b/);
    await expect(day(page, '2026-05-03')).toHaveClass(/\ba3\b/);
  });

  test('gives a filtered range the totals of its KPIs', async ({ page }) => {
    await page.locator('#tlxYouTyped').check();
    await page.locator('#tlxDateLabel').click();
    await page.locator('#tlxCalMode button[data-value="range"]').click();
    await day(page, '2026-05-02').click();
    await day(page, '2026-05-03').click();
    await expect(page.locator('#tlxDateLabel')).toContainText('2 days');
    await expect(page.locator('.tlx-lg-end').first()).toContainText(`Range 2026-05-02 → 2026-05-03: ${await kpiFooter(page)}`);
  });
});

/** Opens the dashboard at a Timeline link, as a copied link would: no click on the sidebar. */
async function openLink(page: Page, hash: string): Promise<void> {
  await page.goto(HARNESS_URL + hash);
  await expect(page.locator('#tlxKpis')).toBeVisible({ timeout: 10000 });
}

test.describe('Timeline range links', () => {
  test('opens the Timeline at a range from its link, and keeps the view in the address', async ({ page }) => {
    await openLink(page, '#view=range&from=2026-05-02&to=2026-05-03');
    await expect(page.locator('.nav-links a.active[data-page="timeline"]')).toHaveCount(1);
    await expect(page.locator('#tlxView button[data-value="range"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(kpi(page, 'Turns you typed')).toHaveText('7 of 14');
    await page.locator('#tlxView button[data-value="week"]').click();
    await expect(page).toHaveURL(/#view=week&date=2026-05-03$/);
    // On another page the address no longer names a Timeline view.
    await page.locator('[data-page="dashboard"]').first().click();
    await expect(page).not.toHaveURL(/#view=/);
  });

  test('cuts a linked range to the loaded days', async ({ page }) => {
    await openLink(page, '#view=range&from=2026-04-20&to=2026-05-02');
    await expect(page).toHaveURL(/#view=range&from=2026-05-02&to=2026-05-02$/);
  });

  test('opens the Day view for a linked range with no loaded day', async ({ page }) => {
    await openLink(page, '#view=range&from=2026-01-01&to=2026-01-31');
    await expect(page.locator('#tlxView button[data-value="day"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/#view=day&date=2026-05-03$/);
  });

  test('keeps the view in the webview state by dates, and opens it again from there', async ({ page }) => {
    type StateWindow = { mockWebviewState?: Record<string, unknown> };
    await openTimeline(page);
    await page.locator('#tlxView button[data-value="range"]').click();
    expect(await page.evaluate(() => (window as unknown as StateWindow).mockWebviewState?.timelineView)).toBe('view=range&from=2026-05-02&to=2026-05-03');
    // A reloaded webview gets its state back (the harness keeps it in memory, so it is given here).
    await page.addInitScript(() => { (window as unknown as StateWindow).mockWebviewState = { timelineView: 'view=week&date=2026-05-02' }; });
    await openTimeline(page);
    await expect(page.locator('#tlxView button[data-value="week"]')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Timeline date picker layout', () => {
  test('fits a 560 px panel and reads in a light theme', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 900 });
    await openTimeline(page);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
      document.documentElement.style.setProperty('--vscode-foreground', '#202020');
    });
    await page.locator('#tlxDateLabel').click();
    const box = await page.locator('#tlxCal').boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 560).toBe(true);
    await expect(page.locator('#tlxCal')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(day(page, '2026-05-02')).toHaveCSS('color', 'rgb(32, 32, 32)');
  });
});
