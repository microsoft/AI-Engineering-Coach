import { test, expect, Page } from '@playwright/test';
import { curiosityBalance } from '../../src/core/curiosity-balance';
import type { CuriosityData } from '../../src/core/types/curiosity-types';
import { curiosityAntiPatterns } from '../../src/core/curiosity-patterns';
import type { AntiPatternData } from '../../src/core/types';
import { harnessUrl } from './harness-url';

const HARNESS_URL = harnessUrl();
type MockWindow = Window & {
  getMockData: (method: string, params: Record<string, unknown>) => unknown;
  recordedRequests?: string[];
};

async function navigateToAntiPatterns(page: Page) {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    return content && content.innerHTML.length > 200 && !content.querySelector('.error-boundary');
  }, { timeout: 10000 });
  await page.locator('[data-page="anti-patterns"]').first().click();
  await expect(page.locator('#content h1')).toHaveText('Anti-Patterns', { timeout: 15000 });
  await expect(page.locator('#content .ap-score-card')).toHaveCount(4);
}

test.describe('Anti-Patterns', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-30T12:00:00Z'));
    await navigateToAntiPatterns(page);
  });

  test('renders practice score cards for all 4 groups', async ({ page }) => {
    const cards = page.locator('.ap-score-card');
    await expect(cards.first()).toBeVisible();
    const content = await page.textContent('#content');
    expect(content).toContain('72');
    expect(content).toContain('85');
    expect(content).toContain('68');
    expect(content).toContain('91');
  });

  test('shows pattern list with occurrences', async ({ page }) => {
    const content = await page.textContent('#content');
    expect(content).toContain('Giant Prompt Detected');
    expect(content).toContain('Abandoned Session');
  });

  test('shows total occurrence count', async ({ page }) => {
    const content = await page.textContent('#content');
    // Individual pattern occurrences should be visible
    expect(content).toContain('8');  // Giant Prompt: 8 occurrences
    expect(content).toContain('5');  // Abandoned Session: 5 occurrences
  });

  test('score badges are color-coded', async ({ page }) => {
    const cards = page.locator('.ap-score-card');
    const count = await cards.count();
    expect(count).toBe(4);
  });

  test('keeps Curiosity under Prompt Quality, with no separate tab', async ({ page }) => {
    await expect(page.locator('.ap-tab')).toHaveText([/Anti-Patterns/, /Rules/]);
    await expect(page.locator('#tab-curiosity')).toHaveCount(0);
    await expect(page.locator('.ap-score-card[data-group="prompt-quality"]')).toContainText('Curiosity: More evidence needed');
  });

  for (const [counts, label] of [
    [{ direct: 10, web: 10, repository: 20, action: 60 }, 'Balanced'],
    [{ direct: 18, web: 1, repository: 1, action: 30 }, 'Needs review'],
    [{ direct: 20, web: 0, repository: 0, action: 30 }, 'Strongly skewed'],
  ] as const) {
    test(`renders ${label} in the existing Prompt Quality score and findings`, async ({ page }) => {
      const data = await page.evaluate(() => (window as MockWindow).getMockData('getCuriosity', {}) as CuriosityData);
      const total = counts.direct + counts.web + counts.repository + counts.action;
      data.counts = counts;
      data.balance = curiosityBalance(counts, total, 7);
      data.repeated = [];
      const patterns = curiosityAntiPatterns(data);
      await page.evaluate(({ patterns, tier }) => {
        const root = window as MockWindow;
        const original = root.getMockData;
        const calls: string[] = [];
        root.recordedRequests = calls;
        root.getMockData = (method, params) => {
          calls.push(method);
          const base = original(method, params) as AntiPatternData;
          return method === 'getAntiPatterns' ? {
            ...base, curiosityTier: tier, patterns: [...base.patterns, ...patterns],
            totalOccurrences: base.totalOccurrences + patterns.length,
          } : base;
        };
      }, { patterns, tier: data.balance.tier });
      await page.locator('#sidebar [data-page="anti-patterns"]').click();
      await expect(page.locator('.ap-score-card[data-group="prompt-quality"]')).toContainText(`Curiosity: ${label}`);
      const group = page.locator('.ap-group-details').first();
      await group.locator('summary').first().click();
      if (label === 'Balanced') await expect(group.locator('.ap-finding-name').filter({ hasText: 'Curiosity balance' })).toHaveCount(0);
      else {
        const finding = group.locator('.ap-finding').filter({ hasText: `Curiosity balance: ${label}` });
        await expect(finding).toBeVisible();
        await expect(finding).toContainText('not question quality or learning');
        await finding.locator('.ap-occurrences > summary').click();
        await expect(finding.getByRole('link', { name: 'View example', exact: true }).first()).toBeVisible();
        await expect(finding.locator('.occ-explain-btn')).toHaveCount(0);
      }
      await expect(page.locator('.ap-tab')).toHaveCount(2);
      expect(await page.evaluate(() => (window as MockWindow).recordedRequests)).not.toContain('getCuriosity');
    });
  }

  test('shows escaped repeated-wording examples as a low-severity Prompt Quality finding', async ({ page }) => {
    const data = await page.evaluate(() => (window as MockWindow).getMockData('getCuriosity', {}) as CuriosityData);
    const text = '<img src=x onerror=window.coachInjected=true>';
    data.repeated[0].text = text;
    const patterns = curiosityAntiPatterns(data);
    await page.evaluate(patterns => {
      const root = window as MockWindow;
      const original = root.getMockData;
      root.getMockData = (method, params) => {
        const base = original(method, params) as AntiPatternData;
        return method === 'getAntiPatterns' ? { ...base, patterns: [...base.patterns, ...patterns] } : base;
      };
    }, patterns);
    await page.locator('#sidebar [data-page="anti-patterns"]').click();
    const group = page.locator('.ap-group-details').first();
    await group.locator('summary').first().click();
    const finding = group.locator('.ap-finding').filter({ hasText: 'Repeated inquiry wording' });
    await expect(finding).toContainText('not semantic similarity or proof of forgetting');
    await finding.locator('.ap-occurrences > summary').click();
    await expect(finding).toContainText(text);
    await expect(finding.locator('img')).toHaveCount(0);
    await expect(finding.locator('.occ-explain-btn')).toHaveCount(0);
    await expect(finding.getByRole('link', { name: 'View example', exact: true })).toHaveCount(1);
    await expect(finding.locator('.occ-session-link')).toHaveCSS('color', 'rgb(55, 148, 255)');
  });
});

type HarnessWindow = MockWindow & { mockResponseDelay?: (method: string) => number };

/** Give the Giant Prompt finding one session occurrence so it renders a Why? button. */
async function showGiantPromptOccurrence(page: Page) {
  await page.evaluate(() => {
    const root = window as HarnessWindow;
    const original = root.getMockData;
    root.getMockData = (method, params) => {
      const base = original(method, params);
      if (method !== 'getAntiPatterns') return base;
      const data = base as { patterns: Array<Record<string, unknown>> };
      return {
        ...data,
        patterns: data.patterns.map(p => p.id === 'ap-1' ? {
          ...p,
          details: [{
            timestamp: Date.parse('2026-09-29T10:00:00Z'), workspace: 'my-api', sessionId: 'session-why-1',
            message: 'Pasted a 5200-token spec', model: 'gpt', kind: 'session',
          }],
        } : p),
      };
    };
  });
  await page.locator('#sidebar [data-page="anti-patterns"]').click();
  const group = page.locator('.ap-group-details').first();
  await group.locator('summary').first().click();
  const finding = group.locator('.ap-finding').filter({ hasText: 'Giant Prompt Detected' });
  await finding.locator('.ap-occurrences > summary').click();
  return finding;
}

function pushCapabilities(page: Page, llm: boolean) {
  return page.evaluate(value => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'capabilities', host: 'vscode', llm: value } }));
  }, llm);
}

test.describe('Anti-Patterns Why? explanations', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-30T12:00:00Z'));
    await navigateToAntiPatterns(page);
  });

  test('replaces the loading text with the explanation and asks again after hiding', async ({ page }) => {
    await page.evaluate(() => {
      const root = window as HarnessWindow;
      const original = root.getMockData;
      let calls = 0;
      root.getMockData = (method, params) => method === 'explainOccurrence'
        ? { ok: true, explanation: ++calls === 1 ? 'First explanation.' : 'Second explanation.' }
        : original(method, params);
      root.mockResponseDelay = method => method === 'explainOccurrence' ? 400 : 5;
    });
    const finding = await showGiantPromptOccurrence(page);
    const why = finding.locator('.occ-explain-btn');
    const result = finding.locator('.occ-explain-result');

    await why.click();
    await expect(result).toHaveText('Asking AI for an explanation...');
    await expect(why).toBeDisabled();
    await expect(result).toHaveText('First explanation.');
    await expect(result).toHaveClass(/occ-explain-ok/);
    await expect(why).toHaveText('Why?');

    await why.click();
    await expect(result).toBeHidden();

    await why.click();
    await expect(result).toHaveText('Second explanation.');
    await expect(result).toBeVisible();
  });

  test('shows why an explanation is unavailable instead of spinning', async ({ page }) => {
    const message = "GitHub Copilot isn't available. Sign in to GitHub Copilot in VS Code to use AI features.";
    await page.evaluate(error => {
      const root = window as HarnessWindow;
      const original = root.getMockData;
      root.getMockData = (method, params) => method === 'explainOccurrence'
        ? { ok: false, explanation: '', error }
        : original(method, params);
    }, message);
    const finding = await showGiantPromptOccurrence(page);

    await finding.locator('.occ-explain-btn').click();

    const result = finding.locator('.occ-explain-result');
    await expect(result).toHaveText(message);
    await expect(result).toHaveClass(/occ-explain-error/);
  });

  test('updates AI controls in place when GitHub Copilot availability changes', async ({ page }) => {
    const finding = await showGiantPromptOccurrence(page);
    const why = finding.locator('.occ-explain-btn');
    const occurrences = finding.locator('.ap-occurrences');
    const skills = page.locator('#sidebar [data-page="skills"]');
    const levelUp = page.locator('#sidebar [data-page="level-up"]');
    await expect(why).toBeVisible();
    await expect(skills).toBeVisible();

    await pushCapabilities(page, false);
    await expect(why).toBeHidden();
    await expect(skills).toBeHidden();
    await expect(levelUp).toBeHidden();
    // The page is not rebuilt: the expanded occurrence list stays open.
    await expect(occurrences).toHaveAttribute('open', '');

    await pushCapabilities(page, true);
    await expect(why).toBeVisible();
    await expect(skills).toBeVisible();
    await expect(levelUp).toBeVisible();
    await expect(occurrences).toHaveAttribute('open', '');
  });

  test('keeps an unsaved Rule Editor draft when GitHub Copilot availability changes', async ({ page }) => {
    await page.locator('.ap-tab[data-tab="rules"]').click();
    await page.locator('#rule-new-btn').click();
    const modal = page.locator('#rule-editor-modal');
    const name = page.locator('#rf-name');
    await expect(modal).toBeVisible();
    await name.fill('Draft rule that must survive');

    await pushCapabilities(page, false);
    await pushCapabilities(page, true);

    await expect(modal).toBeVisible();
    await expect(name).toHaveValue('Draft rule that must survive');
  });
});
