# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: burndown.spec.ts >> Burndown >> shows projected number
- Location: tests/e2e/burndown.spec.ts:35:7

# Error details

```
Test timeout of 30000ms exceeded while running "beforeEach" hook.
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
        - link "▲ Output 15K" [ref=e13] [cursor=pointer]:
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
      - generic [ref=e51]:
        - generic [ref=e52]:
          - img [ref=e54]:
            - generic [ref=e57]: "79"
          - generic [ref=e58]:
            - generic [ref=e59]: Ship Goblin Deluxe
            - generic [ref=e60]: Dashboard vibes sampled across 4 dimensions
        - generic [ref=e61]:
          - 'generic "TypeScript: 8.2K AI LoC" [ref=e62]': TypeScript
          - 'generic "Python: 3.1K AI LoC" [ref=e63]': Python
          - 'generic "GO: 2.1K AI LoC" [ref=e64]': GO
          - 'generic "Rust: 1.1K AI LoC" [ref=e65]': Rust
      - generic [ref=e66]:
        - generic [ref=e67]:
          - generic [ref=e68]:
            - generic [ref=e69]: 2.5K
            - generic [ref=e70]: Requests
          - generic [ref=e71]:
            - generic [ref=e72]: "150"
            - generic [ref=e73]: Sessions
          - generic [ref=e74]:
            - generic [ref=e75]: 16.9K
            - generic [ref=e76]: AI LoC
          - generic [ref=e77]:
            - generic [ref=e78]: "12"
            - generic [ref=e79]: Workspaces
        - generic [ref=e80]:
          - generic [ref=e81]: Local Agent
          - generic [ref=e82]: Local Agent (Insiders)
          - generic [ref=e83]: GitHub Copilot CLI
          - generic [ref=e84]: Claude Code
    - generic [ref=e85]:
      - generic [ref=e86]: ℹ
      - generic [ref=e87]:
        - strong [ref=e88]: Token Usage & Burndown temporarily hidden
        - paragraph [ref=e89]: These features are disabled until we can verify that reported numbers align with GitHub's billing data. They will be re-enabled once validated.
    - generic [ref=e90]:
      - generic [ref=e91]:
        - heading "Anti-Patterns Summary" [level=3] [ref=e92]
        - link "View All Anti-Patterns →" [ref=e93] [cursor=pointer]:
          - /url: "#"
      - generic [ref=e94]:
        - link "Prompt Quality Good -3% WoW +5% MoM Giant prompts detected" [ref=e95] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e96]:
            - img [ref=e97]:
              - generic [ref=e100]: "72"
            - generic [ref=e101]:
              - generic [ref=e102]: Prompt Quality
              - generic [ref=e103]: Good
              - generic [ref=e104]:
                - generic [ref=e105]: "-3% WoW"
                - generic [ref=e106]: +5% MoM
          - generic [ref=e107]: Giant prompts detected
        - link "Session Hygiene Excellent +2% WoW +8% MoM Fewer abandoned sessions this week" [ref=e108] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e109]:
            - img [ref=e110]:
              - generic [ref=e113]: "85"
            - generic [ref=e114]:
              - generic [ref=e115]: Session Hygiene
              - generic [ref=e116]: Excellent
              - generic [ref=e117]:
                - generic [ref=e118]: +2% WoW
                - generic [ref=e119]: +8% MoM
          - generic [ref=e121]: Fewer abandoned sessions this week
        - link "Code Review Good -1% WoW +3% MoM AI code accepted without review" [ref=e122] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e123]:
            - img [ref=e124]:
              - generic [ref=e127]: "68"
            - generic [ref=e128]:
              - generic [ref=e129]: Code Review
              - generic [ref=e130]: Good
              - generic [ref=e131]:
                - generic [ref=e132]: "-1% WoW"
                - generic [ref=e133]: +3% MoM
          - generic [ref=e134]: AI code accepted without review
        - link "Tool Mastery Excellent +1% WoW +4% MoM Great tool usage diversity" [ref=e135] [cursor=pointer]:
          - /url: "#"
          - generic [ref=e136]:
            - img [ref=e137]:
              - generic [ref=e140]: "91"
            - generic [ref=e141]:
              - generic [ref=e142]: Tool Mastery
              - generic [ref=e143]: Excellent
              - generic [ref=e144]:
                - generic [ref=e145]: +1% WoW
                - generic [ref=e146]: +4% MoM
          - generic [ref=e148]: Great tool usage diversity
    - generic [ref=e149]:
      - generic [ref=e150]:
        - heading "Skill Finder" [level=3] [ref=e151]
        - link "Open Full View →" [ref=e152] [cursor=pointer]:
          - /url: "#"
      - paragraph [ref=e153]: Scans your prompt history for repeated patterns that waste time re-explaining the same tasks.
      - generic [ref=e155]:
        - paragraph [ref=e156]: Analyze your prompt history to discover skill opportunities.
        - button "Scan for Skills" [ref=e157] [cursor=pointer]
    - generic [ref=e159]:
      - heading "Daily Activity" [level=3] [ref=e160]
      - generic [ref=e161]:
        - button "Requests 2.5K" [ref=e162] [cursor=pointer]:
          - text: Requests
          - strong [ref=e163]: 2.5K
        - button "Sessions 150" [ref=e164] [cursor=pointer]:
          - text: Sessions
          - strong [ref=e165]: "150"
        - button "LoC 16.9K" [ref=e166] [cursor=pointer]:
          - text: LoC
          - strong [ref=e167]: 16.9K
        - button "Workspaces 12" [ref=e168] [cursor=pointer]:
          - text: Workspaces
          - strong [ref=e169]: "12"
    - generic [ref=e172]:
      - generic [ref=e174] [cursor=pointer]: Top Workspaces by Requests
      - generic [ref=e177]: Requests by Harness
```

# Test source

```ts
  1  | import { test, expect, Page } from '@playwright/test';
  2  | 
  3  | const HARNESS_URL = 'http://localhost:3999/tests/e2e/harness.html';
  4  | 
  5  | async function navigateToBurndown(page: Page) {
  6  |   await page.goto(HARNESS_URL);
  7  |   await page.waitForFunction(() => {
  8  |     const content = document.getElementById('content');
  9  |     return content && content.innerHTML.length > 200 && !content.querySelector('.loading-spinner') && !content.querySelector('.error-boundary');
  10 |   }, { timeout: 10000 });
> 11 |   await page.locator('[data-page="burndown"]').first().click();
     |                                                        ^ Error: locator.click: Test timeout of 30000ms exceeded.
  12 |   await page.waitForFunction(() => {
  13 |     const content = document.getElementById('content');
  14 |     return content && !content.querySelector('.loading-spinner') && content.innerHTML.length > 200;
  15 |   }, { timeout: 10000 });
  16 | }
  17 | 
  18 | test.describe('Burndown', () => {
  19 |   test.beforeEach(async ({ page }) => {
  20 |     await navigateToBurndown(page);
  21 |   });
  22 | 
  23 |   test('renders budget info', async ({ page }) => {
  24 |     const content = await page.textContent('#content');
  25 |     // budget: 1500
  26 |     expect(content).toMatch(/1[,.]?500/);
  27 |   });
  28 | 
  29 |   test('shows consumed number', async ({ page }) => {
  30 |     const content = await page.textContent('#content');
  31 |     // consumed: 248
  32 |     expect(content).toContain('248');
  33 |   });
  34 | 
  35 |   test('shows projected number', async ({ page }) => {
  36 |     const content = await page.textContent('#content');
  37 |     // projected: 2480
  38 |     expect(content).toMatch(/2[,.]?480/);
  39 |   });
  40 | 
  41 |   test('status indicator visible', async ({ page }) => {
  42 |     const content = await page.textContent('#content');
  43 |     expect(content).toMatch(/on.?track|within budget|budget/i);
  44 |   });
  45 | 
  46 |   test('shows current month', async ({ page }) => {
  47 |     const content = await page.textContent('#content');
  48 |     // The burndown page defaults to the live current month (page-burndown.ts uses new Date()
  49 |     // and formatMonthLabel's toLocaleString), so derive the expected label the same way
  50 |     // instead of hard-coding it — otherwise the assertion goes stale every month rollover.
  51 |     const expectedMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
  52 |     expect(content).toContain(expectedMonth);
  53 |   });
  54 | });
  55 | 
```