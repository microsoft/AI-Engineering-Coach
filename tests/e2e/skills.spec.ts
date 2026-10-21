import { test, expect, type Page } from '@playwright/test';
import type { CatalogItem, SkillTriageResult, WorkflowOptimizationData } from '../../src/core/types';

const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';

type CatalogScenario = 'success' | 'discovery-error' | 'empty-catalog' | 'triage-error' | 'no-matches';

type MockWindow = Window & {
  getMockData: (method: string, params: Record<string, unknown>) => unknown;
  catalogInstallParams?: Record<string, unknown>;
  releaseSkillRequest?: () => void;
};

const workflow: WorkflowOptimizationData = {
  clusters: [{
    id: 'testing', label: 'Run focused tests', canonicalPrompt: 'Run focused tests',
    occurrences: 6, sessions: 3, workspaces: ['my-api'], harnesses: ['Local Agent'],
    avgCorrectionTurns: 0, totalTurns: 6, cancelRate: 0,
    firstSeen: '2026-10-01', lastSeen: '2026-10-19',
    examples: ['Run the focused tests', 'Run the verification tests'], skillDraft: '',
  }],
  totalRepetitions: 6,
  estimatedTimeSavedMins: 15,
  topWorkspaces: [{ name: 'my-api', clusters: 1 }],
};

const triage: SkillTriageResult = {
  triaged: [{
    id: 'testing', label: 'Run focused tests', verdict: 'strong',
    reason: 'You repeatedly run the verification tests.', suggestedSkillName: 'run-focused-tests',
  }],
};

const catalog: CatalogItem[] = [
  {
    kind: 'skill', id: 'skill:skills/testing/SKILL.md', title: 'Focused Testing',
    description: 'Run focused tests.', category: '', path: 'skills/testing/SKILL.md',
    url: 'https://github.com/github/awesome-copilot/blob/main/skills/testing/SKILL.md',
    relevanceScore: 0, matchReasons: [],
  },
  {
    kind: 'agent', id: 'agent:agents/reviewer.agent.md', title: 'Code Reviewer',
    description: 'Review code.', category: '', path: 'agents/reviewer.agent.md',
    url: 'https://github.com/github/awesome-copilot/blob/main/agents/reviewer.agent.md',
    relevanceScore: 0, matchReasons: [],
  },
  {
    kind: 'instruction', id: 'instruction:instructions/typescript.instructions.md', title: 'TypeScript',
    description: 'TypeScript guidance.', category: '', path: 'instructions/typescript.instructions.md',
    url: 'https://github.com/github/awesome-copilot/blob/main/instructions/typescript.instructions.md',
    relevanceScore: 0, matchReasons: [],
  },
];

async function mockSkillCatalog(page: Page, scenario: CatalogScenario): Promise<void> {
  await page.evaluate(({ scenario, workflow, triage, catalog }) => {
    const root = window as MockWindow;
    const original = root.getMockData;
    root.getMockData = (method, params) => {
      switch (method) {
        case 'getWorkflowOptimization': return workflow;
        case 'triageSkills': return triage;
        case 'discoverCatalog':
          if (scenario === 'discovery-error') return { error: 'Catalog feed unavailable' };
          return { items: scenario === 'empty-catalog' ? [] : catalog, totalScanned: catalog.length };
        case 'triageCatalog':
          if (scenario === 'triage-error') return { error: 'Recommendation model unavailable' };
          return {
            items: scenario === 'no-matches' ? [] : [{
              ...catalog[0], relevanceScore: 100, matchReasons: ['Matches your repeated verification workflow.'],
            }],
          };
        case 'installCatalogItem':
          root.catalogInstallParams = params;
          return { content: '# Focused Testing', filename: 'focused-testing/SKILL.md' };
        default: return original(method, params);
      }
    };
  }, { scenario, workflow, triage, catalog });
}

async function openSkillFinder(page: Page): Promise<void> {
  await page.locator('#sidebar [data-page="skills"]').click();
  await expect(page.getByRole('heading', { name: 'Skill Finder', exact: true })).toBeVisible();
}

async function analyzeSkills(page: Page): Promise<void> {
  await openSkillFinder(page);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.locator('#customResults')).toContainText('run-focused-tests');
}

async function holdSkillRequest(page: Page, method: 'discoverCatalog' | 'triageCatalog'): Promise<void> {
  await page.evaluate(method => {
    const root = window as MockWindow;
    const original = root.getMockData;
    let pending = true;
    root.releaseSkillRequest = undefined;
    root.getMockData = (name, params) => {
      if (name === method && pending) {
        pending = false;
        return new Promise(resolve => {
          root.releaseSkillRequest = () => resolve({ error: 'Stale catalog failure' });
        });
      }
      return original(name, params);
    };
  }, method);
}

async function failHeldSkillRequest(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const root = window as MockWindow;
    if (!root.releaseSkillRequest) throw new Error('No pending skill request');
    const delivered = (event: MessageEvent) => {
      if (event.data?.type !== 'response' || event.data.data?.error !== 'Stale catalog failure') return;
      window.removeEventListener('message', delivered);
      setTimeout(resolve, 0);
    };
    window.addEventListener('message', delivered);
    root.releaseSkillRequest();
  }));
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS_URL);
  await expect(page.locator('#dailyChart')).toBeVisible();
});

test('renders and installs a community match and retains the full catalog count across navigation', async ({ page }) => {
  await mockSkillCatalog(page, 'success');
  await analyzeSkills(page);
  const results = page.locator('#catalogResults');
  await expect(results.locator('.sk-section-count')).toHaveText('1 curated from 3 catalog items');
  await expect(results.getByRole('link', { name: 'Focused Testing' })).toHaveAttribute(
    'href', 'https://github.com/github/awesome-copilot/blob/main/skills/testing/SKILL.md',
  );
  await results.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(results.getByRole('button', { name: 'Installed', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as MockWindow).catalogInstallParams)).toEqual({
    path: 'skills/testing/SKILL.md', kind: 'skill', title: 'Focused Testing',
  });

  await page.locator('#sidebar [data-page="dashboard"]').click();
  await expect(page.locator('#dashSkillContent')).toContainText('Focused Testing');
  await openSkillFinder(page);
  await expect(results.locator('.sk-section-count')).toHaveText('1 curated from 3 catalog items');
});

for (const [scenario, message] of [
  ['discovery-error', 'Catalog feed unavailable'],
  ['empty-catalog', 'Community catalog returned no items'],
  ['triage-error', 'Recommendation model unavailable'],
] as const) {
  test(`Skill Finder reports ${scenario} without caching it or hiding custom opportunities`, async ({ page }) => {
    await mockSkillCatalog(page, scenario);
    await analyzeSkills(page);
    await expect(page.locator('#catalogResults .sk-error')).toContainText(message);
    await expect(page.locator('#catalogResults')).not.toContainText('No community items matched');

    await page.locator('#sidebar [data-page="dashboard"]').click();
    await expect(page.getByRole('button', { name: 'Scan for Skills', exact: true })).toBeVisible();
    await mockSkillCatalog(page, 'success');
    await analyzeSkills(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
    await expect(page.locator('#catalogResults .sk-error')).toHaveCount(0);
  });

  test(`dashboard reports ${scenario} and retries while preserving custom opportunities`, async ({ page }) => {
    await mockSkillCatalog(page, scenario);
    await page.getByRole('button', { name: 'Scan for Skills', exact: true }).click();
    await expect(page.locator('#dashSkillContent')).toContainText('run-focused-tests');
    await expect(page.locator('#dashSkillContent .sk-error')).toContainText(message);
    await expect(page.locator('#dashSkillContent')).not.toContainText('None matched');

    await mockSkillCatalog(page, 'success');
    await page.getByRole('button', { name: 'Retry Scan', exact: true }).click();
    await expect(page.locator('#dashSkillContent')).toContainText('Focused Testing');
    await expect(page.locator('#dashSkillContent .sk-error')).toHaveCount(0);
    await openSkillFinder(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
  });
}

test('distinguishes a successfully reviewed catalog with no matches from a catalog failure', async ({ page }) => {
  await mockSkillCatalog(page, 'no-matches');
  await analyzeSkills(page);
  const results = page.locator('#catalogResults');
  await expect(results).toContainText('No community items matched your workflow patterns (3 reviewed).');
  await expect(results.locator('.sk-error')).toHaveCount(0);

  await page.locator('#sidebar [data-page="dashboard"]').click();
  await expect(page.locator('#dashSkillContent')).toContainText('run-focused-tests');
  await expect(page.locator('#dashSkillContent')).toContainText('None matched');
  await expect(page.locator('#dashSkillContent .sk-error')).toHaveCount(0);
  await openSkillFinder(page);
  await expect(results).toContainText('No community items matched your workflow patterns (3 reviewed).');
});

for (const scope of ['workspace', 'harness'] as const) {
  test(`dashboard preserves the new ${scope} result when an older catalog request fails`, async ({ page }) => {
    await mockSkillCatalog(page, 'success');
    await holdSkillRequest(page, 'discoverCatalog');
    await page.getByRole('button', { name: 'Scan for Skills', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as MockWindow).releaseSkillRequest)).toBe(true);

    if (scope === 'workspace') {
      await page.locator('#ws-filter-input').fill('frontend-app');
      await page.locator('#ws-filter-list [data-value="ws-2"]').click();
    } else {
      await page.locator('#harness-filter').selectOption('Claude Code');
    }
    await page.getByRole('button', { name: 'Scan for Skills', exact: true }).click();
    await expect(page.locator('#dashSkillContent')).toContainText('Focused Testing');

    await failHeldSkillRequest(page);
    await expect(page.locator('#dashSkillContent')).toContainText('Focused Testing');
    await expect(page.locator('#dashSkillContent .sk-error')).toHaveCount(0);
    await openSkillFinder(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
  });
}

for (const method of ['discoverCatalog', 'triageCatalog'] as const) {
  test(`Analyze stays disabled until ${method} finishes`, async ({ page }) => {
    await mockSkillCatalog(page, 'success');
    await holdSkillRequest(page, method);
    await analyzeSkills(page);
    await expect.poll(() => page.evaluate(() => !!(window as MockWindow).releaseSkillRequest)).toBe(true);
    await expect(page.getByRole('button', { name: 'Analyzing...', exact: true })).toBeDisabled();

    await failHeldSkillRequest(page);
    await expect(page.locator('#catalogResults .sk-error')).toContainText('Stale catalog failure');
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
  });

  test(`a newer Skill Finder success survives an older ${method} failure`, async ({ page }) => {
    await mockSkillCatalog(page, 'success');
    await holdSkillRequest(page, method);
    await analyzeSkills(page);
    await expect.poll(() => page.evaluate(() => !!(window as MockWindow).releaseSkillRequest)).toBe(true);

    await page.locator('#sidebar [data-page="dashboard"]').click();
    await expect(page.locator('#dailyChart')).toBeVisible();
    await analyzeSkills(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');

    await failHeldSkillRequest(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
    await expect(page.locator('#catalogResults .sk-error')).toHaveCount(0);
    await page.locator('#sidebar [data-page="dashboard"]').click();
    await expect(page.locator('#dashSkillContent')).toContainText('Focused Testing');
    await openSkillFinder(page);
    await expect(page.locator('#catalogResults .sk-section-count')).toHaveText('1 curated from 3 catalog items');
  });
}
