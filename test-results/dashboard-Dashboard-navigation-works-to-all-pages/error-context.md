# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard.spec.ts >> Dashboard >> navigation works to all pages
- Location: tests/e2e/dashboard.spec.ts:57:7

# Error details

```
Error: Page output has error

expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - navigation [ref=e3]:
    - list [ref=e4]:
      - listitem: Observe
      - listitem [ref=e5]:
        - link "■ Dashboard" [ref=e6] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e7]: ■
          - text: Dashboard
      - listitem [ref=e8]:
        - link "─ Timeline 127" [ref=e9] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e10]: ─
          - text: Timeline
          - generic [ref=e11]: "127"
      - listitem: Measure
      - listitem [ref=e12]:
        - link "▲ Output 15K" [active] [ref=e13] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e14]: ▲
          - text: Output
          - generic [ref=e15]: 15K
      - listitem [ref=e16]:
        - link "■ Patterns" [ref=e17] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e18]: ■
          - text: Patterns
      - listitem: Improve
      - listitem [ref=e19]:
        - link "⚠ Anti-Patterns 5" [ref=e20] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e21]: ⚠
          - text: Anti-Patterns
          - generic [ref=e22]: "5"
      - listitem [ref=e23]:
        - link "★ Skill Finder" [ref=e24] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e25]: ★
          - text: Skill Finder
      - listitem [ref=e26]:
        - link "◆ Context Health" [ref=e27] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e28]: ◆
          - text: Context Health
      - listitem [ref=e29]:
        - link "★ Level Up" [ref=e30] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e31]: ★
          - text: Level Up
      - listitem: Explore
      - listitem [ref=e32]:
        - link "☰ Data Explorer" [ref=e33] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e34]: ☰
          - text: Data Explorer
      - listitem [ref=e35]:
        - link "⚙ Rule Playground" [ref=e36] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e37]: ⚙
          - text: Rule Playground
    - generic [ref=e38]:
      - generic [ref=e39]:
        - generic [ref=e40]: Workspace
        - generic [ref=e41]:
          - button "Current" [ref=e42] [cursor=pointer]
          - button "All" [ref=e43] [cursor=pointer]
        - textbox "Search workspaces..." [ref=e45]
      - generic [ref=e46]:
        - generic [ref=e47]: Harness
        - combobox "Harness" [ref=e48]:
          - option "All Harnesses" [selected]
          - option "Local Agent"
          - option "Local Agent (Insiders)"
          - option "GitHub Copilot CLI"
          - option "Claude Code"
  - main [ref=e49]:
    - generic [ref=e50]:
      - heading "⚠️ Failed to render Output" [level=3] [ref=e51]
      - paragraph [ref=e52]: Cannot convert undefined or null to object
      - paragraph [ref=e53]: "Try reloading the dashboard (Ctrl+Shift+P → \"AI Engineer Coach: Reload Data\")"
```

# Test source

```ts
  1  | import { test, expect, Page } from '@playwright/test';
  2  | 
  3  | const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';
  4  | 
  5  | async function waitForDashboard(page: Page) {
  6  |   await page.goto(HARNESS_URL);
  7  |   await page.waitForFunction(() => {
  8  |     const content = document.getElementById('content');
  9  |     return content && content.innerHTML.length > 200 && !content.querySelector('.loading-screen') && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  10 |   }, { timeout: 10000 });
  11 | }
  12 | 
  13 | test.describe('Dashboard', () => {
  14 |   test.beforeEach(async ({ page }) => {
  15 |     await waitForDashboard(page);
  16 |   });
  17 | 
  18 |   test('renders practice score cards', async ({ page }) => {
  19 |     const cards = page.locator('.ap-score-card');
  20 |     await expect(cards).toHaveCount(4);
  21 |     const content = await page.textContent('#content');
  22 |     // Scores: 72, 85, 68, 91
  23 |     expect(content).toContain('72');
  24 |     expect(content).toContain('85');
  25 |     expect(content).toContain('68');
  26 |     expect(content).toContain('91');
  27 |   });
  28 | 
  29 |   test('shows total workspaces stat', async ({ page }) => {
  30 |     const content = await page.textContent('#content');
  31 |     expect(content).toContain('12');
  32 |     expect(content).toContain('Workspaces');
  33 |   });
  34 | 
  35 |   test('shows session and request stats', async ({ page }) => {
  36 |     const content = await page.textContent('#content');
  37 |     expect(content).toContain('Requests');
  38 |     expect(content).toContain('Sessions');
  39 |   });
  40 | 
  41 |   test('renders daily activity chart area', async ({ page }) => {
  42 |     const canvas = page.locator('canvas#dailyChart');
  43 |     await expect(canvas).toBeAttached();
  44 |   });
  45 | 
  46 |   test('shows harness breakdown', async ({ page }) => {
  47 |     const content = await page.textContent('#content');
  48 |     expect(content).toContain('Local Agent');
  49 |     expect(content).toContain('Claude Code');
  50 |   });
  51 | 
  52 |   test('shows workspace breakdown chart', async ({ page }) => {
  53 |     const canvas = page.locator('canvas#wsChart');
  54 |     await expect(canvas).toBeAttached();
  55 |   });
  56 | 
  57 |   test('navigation works to all pages', async ({ page }) => {
  58 |     const pages = ['timeline', 'output', 'burndown', 'patterns', 'anti-patterns'];
  59 |     for (const p of pages) {
  60 |       await page.locator(`[data-page="${p}"]`).first().click();
  61 |       await page.waitForTimeout(800);
  62 |       // Check no uncaught error boundary
  63 |       const hasError = await page.locator('.error-boundary').count();
> 64 |       expect(hasError, `Page ${p} has error`).toBe(0);
     |                                               ^ Error: Page output has error
  65 |       await page.locator('[data-page="dashboard"]').first().click();
  66 |       await page.waitForTimeout(800);
  67 |     }
  68 |   });
  69 | 
  70 |   test('shows AI LoC stat', async ({ page }) => {
  71 |     const content = await page.textContent('#content');
  72 |     expect(content).toContain('AI LoC');
  73 |   });
  74 | });
  75 | 
```