import { test, expect, Page } from '@playwright/test';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

async function navigateToContextHealth(page: Page) {
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
  // Click the Context Management sub-tab
  const mgmtTab = page.locator('[data-tab="context-mgmt"]');
  if (await mgmtTab.count() > 0) {
    await mgmtTab.first().click();
    await page.waitForFunction(() => {
      const content = document.getElementById('content');
      return content && content.textContent.includes('Context Score') && !content.querySelector('.loading-spinner');
    }, { timeout: 15000 });
  }
}

test.describe('Context Management', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToContextHealth(page);
    // Click the Context Management sub-tab if present
    const mgmtTab = page.locator('[data-tab="context-mgmt"], button:has-text("Context Management")');
    if (await mgmtTab.count() > 0) {
      await mgmtTab.first().click();
      await page.waitForFunction(() => {
        const content = document.getElementById('content');
        return content && !content.querySelector('.loading-spinner');
      }, { timeout: 10000 });
    }
  });

  test('renders overall context score', async ({ page }) => {
    const content = await page.textContent('#content');
    // overallScore: 74
    expect(content).toContain('74');
  });

  test('shows workspace table with names', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('my-api');
    expect(content).toContain('frontend-app');
  });

  test('shows compaction stats', async ({ page }) => {
    const content = await page.textContent('#content');
    // totalCompactions: 12
    expect(content).toContain('12');
  });

  test('workspace rows are clickable for drill-down', async ({ page }) => {
    // Click on a workspace row to expand
    const row = page.locator('tr:has-text("my-api"), [data-workspace="ws-1"]').first();
    await row.click();
    await page.waitForTimeout(1000);
    const content = await page.textContent('#content');
    expect(content).toMatch(/Local Agent|session|28|35/i);
  });

  test('shows CLI sessions without per-request token data', async ({ page }) => {
    const row = page.locator('tr:has-text("my-api"), [data-workspace="ws-1"]').first();
    await row.click();
    await page.waitForTimeout(1000);
    const content = await page.textContent('#content');
    expect(content).toContain('GitHub Copilot CLI');
  });

  test('shows sessions with per-request token data', async ({ page }) => {
    const row = page.locator('tr:has-text("my-api"), [data-workspace="ws-1"]').first();
    await row.click();
    await page.waitForTimeout(1000);
    const content = await page.textContent('#content');
    expect(content).toContain('Local Agent');
  });
});

type CompositionWindow = Window & { mockCompositionMode?: 'empty' | false };

async function setCompositionMode(page: Page, mode: 'empty' | false) {
  await page.addInitScript(value => { (window as CompositionWindow).mockCompositionMode = value; }, mode);
}

async function openWorkspaceSessions(page: Page) {
  await page.locator('.ctx-ws-row[data-ws-id="ws-1"]').click();
  await expect(page.locator('.ctx-session-row')).toHaveCount(4);
}

test.describe('Context Composition', () => {
  test.beforeEach(async ({ page }) => {
    await navigateToContextHealth(page);
    await expect(page.locator('#ctxComposition')).toBeVisible();
  });

  test('renders a 100% stacked bar per reporting harness with a category legend', async ({ page }) => {
    const section = page.locator('#ctxComposition');
    await expect(section.locator('#ctxCompositionTitle')).toContainText('Context Composition');
    for (const harness of ['GitHub Copilot CLI', 'Local Agent', 'Local Agent (Insiders)']) {
      await expect(section.locator(`.ctx-comp-row[data-harness="${harness}"] .ctx-comp-bar`)).toBeVisible();
    }
    const legend = section.locator('.ctx-comp-legend');
    for (const label of ['System instructions', 'Tool definitions', 'Messages', 'Tool results', 'Files', 'Conversation']) {
      await expect(legend).toContainText(label);
    }
    await expect(section).toContainText('weighted by prompt size');
  });

  test('shows percentages, estimated tokens and KPI chips', async ({ page }) => {
    const vscode = page.locator('.ctx-comp-row[data-harness="Local Agent"]');
    const tools = vscode.locator('.ctx-comp-seg[data-category="toolDefinitions"]');
    await expect(tools).toHaveText('36%');
    await expect(tools).toHaveAttribute('data-tip', 'Tool definitions: 36% \u00b7 \u224818.8K tokens per request');
    await expect(vscode).toContainText('\u224852.0K tokens per request');
    await expect(page.locator('.ctx-comp-row[data-harness="GitHub Copilot CLI"] .ctx-comp-seg[data-category="conversation"]'))
      .toHaveAttribute('data-tip', /Conversation: 85% \u00b7 \u2248265\.2K tokens per call/);
    const kpis = page.locator('.ctx-comp-kpis');
    await expect(kpis).toContainText('16%');
    await expect(kpis).toContainText('14%');
    await expect(kpis).toContainText('29.5K');
    await expect(kpis).toContainText('up to 271 tools');
    await expect(kpis).toContainText('68%');
  });

  test('gives every bar a text equivalent and explains each harness data source', async ({ page }) => {
    const bar = page.locator('.ctx-comp-row[data-harness="Local Agent"] .ctx-comp-bar');
    await expect(bar).toHaveAttribute('role', 'img');
    await expect(bar).toHaveAttribute('aria-label', /Tool definitions 36%.*Tool results 30%/);
    const cliInfo = page.locator('.ctx-comp-row[data-harness="GitHub Copilot CLI"] .info-icon');
    await cliInfo.hover();
    await expect(cliInfo.locator('.info-popup')).toBeVisible();
    await expect(cliInfo.locator('.info-popup')).toContainText('every main-agent model call');
  });

  test('flags partial coverage and harnesses that do not report composition', async ({ page }) => {
    const claude = page.locator('.ctx-comp-row[data-harness="Claude Code"]');
    await expect(claude).toContainText('Not reported by this harness');
    await expect(claude.locator('.ctx-comp-bar')).toHaveCount(0);
    const partial = page.locator('.ctx-comp-row[data-harness="Local Agent (Insiders)"] .ctx-comp-partial');
    await expect(partial).toContainText('180 of 240 requests (75%)');
    await expect(partial).toHaveAttribute('data-tip', /60 requests in range have no composition data/);
  });

  test('adds composition coaching to the insights box and links to GitHub guidance', async ({ page }) => {
    await expect(page.locator('#content')).toContainText('Tool definitions take 36% of your VS Code prompts');
    await expect(page.locator('.ctx-comp-guide')).toHaveAttribute('href', 'https://docs.github.com/en/copilot/tutorials/optimize-ai-usage');
  });

  test('draws the weekly tool-definition trend, workspace bars and CLI system prompt segments', async ({ page }) => {
    await expect(page.locator('#ctxCompTrendChart')).toBeVisible();
    await expect(page.locator('.ctx-comp-ws[data-workspace="frontend-app"]')).toContainText('44% tools');
    const segments = page.locator('.ctx-comp-segment-list');
    await expect(segments).toContainText('tool_instructions');
    await expect(segments).toContainText('\u22489.6K');
    await expect(segments.locator('li').first()).toHaveAttribute('aria-label', /tool_instructions: about 9\.6K tokens, in 32 of 32 sessions/);
  });

  test('session drill-down shows a composition bar per session and the not-reported state', async ({ page }) => {
    await openWorkspaceSessions(page);
    const rows = page.locator('.ctx-session-row');
    await expect(rows.nth(0).locator('.ctx-comp-mini .ctx-comp-bar')).toBeVisible();
    await expect(rows.nth(1).locator('.ctx-comp-mini .ctx-comp-bar')).toBeVisible();
    await expect(rows.nth(3).locator('.ctx-comp-dash')).toHaveAttribute('data-tip', /No composition recorded for this session/);
  });

  test('expanding a VS Code session aligns per-request composition with the token curve', async ({ page }) => {
    await openWorkspaceSessions(page);
    await page.locator('.ctx-session-row').nth(0).click();
    await expect(page.locator('#ctxSessionTokenChart')).toBeVisible();
    await expect(page.locator('#ctxSessionCompositionChart')).toBeVisible();
    const panel = page.locator('.ctx-comp-session');
    await expect(panel).toContainText('Tool definitions');
    await expect(panel).toContainText('\u224813.3K per request');
  });

  test('expanding a Copilot CLI session shows system prompt segments and context at compaction', async ({ page }) => {
    await openWorkspaceSessions(page);
    await page.locator('.ctx-session-row').nth(1).click();
    const panel = page.locator('.ctx-comp-session');
    await expect(panel).toContainText(/System prompt \(latest checkpoint\)/i);
    await expect(panel).toContainText('64 tools sent');
    await expect(panel).toContainText('custom_instructions');
    await expect(panel).toContainText('774.8K of 968.0K tokens (80%)');
    await expect(panel.locator('.ctx-comp-snapshot .ctx-comp-seg[data-category="other"]')).toHaveAttribute('data-tip', /Other \/ unattributed: 6\.3% \u00b7 \u224849\.1K tokens/);
    await expect(page.locator('#ctxSessionCompositionChart')).toBeVisible();
    await expect(page.locator('#ctxSessionTokenChart')).toHaveCount(0);
  });

  test('drills into a workspace from the composition card, including Copilot CLI-only workspaces', async ({ page }) => {
    const workspace = page.locator('.ctx-comp-ws[data-workspace="infra-tools"]');
    const toggle = workspace.locator('.ctx-comp-ws-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sessions = workspace.locator('.ctx-comp-ws-session');
    await expect(sessions).toHaveCount(2);
    await sessions.nth(1).click();
    await expect(sessions.nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(workspace.locator('.ctx-comp-session')).toContainText('774.8K of 968.0K tokens (80%)');
    await expect(page.locator('#ctxCompWsSessionChart')).toBeVisible();
    await toggle.click();
    await expect(workspace.locator('.ctx-comp-ws-sessions')).toBeHidden();
    await expect(page.locator('#ctxCompWsSessionChart')).toHaveCount(0);
  });
});

test.describe('Context Composition empty states', () => {
  test('explains when no request in range carries composition data', async ({ page }) => {
    await setCompositionMode(page, 'empty');
    await navigateToContextHealth(page);
    const section = page.locator('#ctxComposition');
    await expect(section).toContainText('No request in this range carries composition data');
    await expect(section.locator('.ctx-comp-row[data-harness="Local Agent"]')).toContainText('No composition recorded in this range');
    await expect(section.locator('.ctx-comp-row[data-harness="Claude Code"]')).toContainText('Not reported by this harness');
    await expect(section.locator('.ctx-comp-kpis')).toHaveCount(0);
    await expect(section.locator('#ctxCompTrendChart')).toHaveCount(0);
  });

  test('omits the section when the analyzer sends no composition data', async ({ page }) => {
    await setCompositionMode(page, false);
    await navigateToContextHealth(page);
    await expect(page.locator('#content')).toContainText('Context Score');
    await expect(page.locator('#ctxComposition')).toHaveCount(0);
  });
});
