# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: navigation.spec.ts >> Navigation >> all nav links work
- Location: tests/e2e/navigation.spec.ts:18:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('[data-page="burndown"]').first()

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
  9  |     return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  10 |   }, { timeout: 10000 });
  11 | }
  12 | 
  13 | test.describe('Navigation', () => {
  14 |   test.beforeEach(async ({ page }) => {
  15 |     await waitForDashboard(page);
  16 |   });
  17 | 
  18 |   test('all nav links work', async ({ page }) => {
  19 |     const pages = ['dashboard', 'timeline', 'output', 'burndown', 'patterns', 'anti-patterns', 'config-health'];
  20 |     for (const p of pages) {
  21 |       const link = page.locator(`[data-page="${p}"]`).first();
> 22 |       await link.click();
     |                  ^ Error: locator.click: Test timeout of 30000ms exceeded.
  23 |       await page.waitForTimeout(500);
  24 |       const content = await page.locator('#content');
  25 |       const text = await content.textContent();
  26 |       expect(text!.length).toBeGreaterThan(50);
  27 |     }
  28 |   });
  29 | 
  30 |   test('page content changes on navigation', async ({ page }) => {
  31 |     const dashboardContent = await page.textContent('#content');
  32 |     await page.locator('[data-page="output"]').first().click();
  33 |     await page.waitForFunction(() => {
  34 |       const content = document.getElementById('content');
  35 |       return content && !content.querySelector('.loading-spinner');
  36 |     }, { timeout: 10000 });
  37 |     const outputContent = await page.textContent('#content');
  38 |     expect(outputContent).not.toEqual(dashboardContent);
  39 |   });
  40 | 
  41 |   test('no JS errors on any page navigation', async ({ page }) => {
  42 |     const errors: string[] = [];
  43 |     page.on('pageerror', (err) => errors.push(err.message));
  44 | 
  45 |     const pages = ['timeline', 'output', 'burndown', 'patterns', 'anti-patterns', 'config-health', 'dashboard'];
  46 |     for (const p of pages) {
  47 |       await page.locator(`[data-page="${p}"]`).first().click();
  48 |       await page.waitForTimeout(500);
  49 |     }
  50 | 
  51 |     expect(errors).toHaveLength(0);
  52 |   });
  53 | 
  54 |   test('badges populate after data loads', async ({ page }) => {
  55 |     await page.waitForTimeout(500);
  56 |     const sessionsBadge = page.locator('#badge-sessions');
  57 |     const text = await sessionsBadge.textContent();
  58 |     expect(text!.trim().length).toBeGreaterThan(0);
  59 |   });
  60 | });
  61 | 
```