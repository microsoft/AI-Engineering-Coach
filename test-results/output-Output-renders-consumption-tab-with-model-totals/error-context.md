# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: output.spec.ts >> Output >> renders consumption tab with model totals
- Location: tests/e2e/output.spec.ts:41:7

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected substring: "gpt-4o"
Received string:    "·····
      ⚠️ Failed to render Output
      Cannot convert undefined or null to object
      Try reloading the dashboard (Ctrl+Shift+P → \"AI Engineer Coach: Reload Data\")
    "
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
  5  | async function navigateToOutput(page: Page) {
  6  |   await page.goto(HARNESS_URL);
  7  |   await page.waitForFunction(() => {
  8  |     const content = document.getElementById('content');
  9  |     return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  10 |   }, { timeout: 10000 });
  11 |   await page.locator('[data-page="output"]').first().click();
  12 |   await page.waitForFunction(() => {
  13 |     const content = document.getElementById('content');
  14 |     return content && !content.querySelector('.loading-spinner');
  15 |   }, { timeout: 10000 });
  16 | }
  17 | 
  18 | test.describe('Output', () => {
  19 |   test.beforeEach(async ({ page }) => {
  20 |     await navigateToOutput(page);
  21 |   });
  22 | 
  23 |   test('renders code production summary with AI LoC', async ({ page }) => {
  24 |     const content = await page.textContent('#content');
  25 |     // totalAiLoc: 14520 → formatted as 14,520 or 14.5K
  26 |     expect(content).toMatch(/14[.,]?5/);
  27 |   });
  28 | 
  29 |   test('shows AI ratio', async ({ page }) => {
  30 |     const content = await page.textContent('#content');
  31 |     // Production tab shows AI-Generated LoC and cost
  32 |     expect(content).toContain('AI-Generated LoC');
  33 |   });
  34 | 
  35 |   test('shows language breakdown chart', async ({ page }) => {
  36 |     // Production tab has language chart
  37 |     const content = await page.textContent('#content');
  38 |     expect(content).toContain('Language');
  39 |   });
  40 | 
  41 |   test('renders consumption tab with model totals', async ({ page }) => {
  42 |     // Click consumption tab
  43 |     const tabs = page.locator('#output-tabs .tab');
  44 |     const consumptionTab = tabs.filter({ hasText: /consumption/i });
  45 |     if (await consumptionTab.count() > 0) {
  46 |       await consumptionTab.click();
  47 |       await page.waitForFunction(() => {
  48 |         const content = document.getElementById('content');
  49 |         return content && !content.querySelector('.loading-spinner');
  50 |       }, { timeout: 10000 });
  51 |     }
  52 |     const content = await page.textContent('#content');
> 53 |     expect(content).toContain('gpt-4o');
     |                     ^ Error: expect(received).toContain(expected) // indexOf
  54 |   });
  55 | 
  56 |   test('shows AI credits tab', async ({ page }) => {
  57 |     const tabs = page.locator('#output-tabs .tab');
  58 |     const creditsTab = tabs.filter({ hasText: /Credit/i });
  59 |     await creditsTab.first().click();
  60 |     await page.waitForTimeout(2000);
  61 |     const content = await page.textContent('#content');
  62 |     // totalCredits: 142.5 displayed as 143 (rounded)
  63 |     expect(content).toMatch(/143|Total AI Credits/);
  64 |   });
  65 | });
  66 | 
```