/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Authless full-UI walkthrough.
 *
 * Boots the real webview bundle against analyzer-computed fixture data and
 * "clicks around" every view in the sidebar, asserting each renders without an
 * error boundary or stuck spinner. A screenshot of every page is written to
 * tests/vm/.artifacts/screenshots for the visual record.
 *
 * This is the authless equivalent of "install the extension and check that all
 * views load" — it exercises the production rendering code, navigation, charts,
 * and RPC contract, with no login or session-data collection.
 */

import { test, expect, Page } from '@playwright/test';
import * as path from 'path';

const HARNESS_URL = 'http://localhost:3998/tests/vm/harness.html';
const SHOT_DIR = path.resolve(__dirname, '..', '.artifacts', 'screenshots');

// Every top-level view reachable from the sidebar (burndown is feature-flagged
// off in production, so it is intentionally excluded).
const PAGES: { id: string; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'image-gallery', label: 'Coding Moments' },
  { id: 'output', label: 'Output' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'anti-patterns', label: 'Anti-Patterns' },
  { id: 'skills', label: 'Skill Finder' },
  { id: 'config-health', label: 'Context Health' },
  { id: 'level-up', label: 'Level Up' },
  { id: 'data-explorer', label: 'Data Explorer' },
  { id: 'rule-playground', label: 'Rule Playground' },
];

async function waitForShellReady(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    if (!content) return false;
    const visibleSpinner = [...content.querySelectorAll('.loading-spinner')]
      .some(el => (el as HTMLElement).offsetParent !== null);
    return content.innerHTML.length > 150
      && !content.querySelector('.loading-screen')
      && !visibleSpinner
      && !content.querySelector('.error-boundary');
  }, { timeout: 15_000 });
}

async function gotoPage(page: Page, id: string): Promise<void> {
  await page.locator(`[data-page="${id}"]`).first().click();
  // Wait for the page renderer to replace the transient loading spinner. Only
  // *visible* spinners count — several pages keep a spinner inside a hidden
  // (display:none) modal that is part of their static markup.
  await page.waitForFunction(() => {
    const content = document.getElementById('content');
    if (!content) return false;
    const spinners = [...content.querySelectorAll('.loading-spinner')];
    return spinners.every(el => (el as HTMLElement).offsetParent === null);
  }, { timeout: 15_000 });
  // Allow async chart/RPC fills to settle.
  await page.waitForTimeout(600);
}

test.describe('Authless full-UI walkthrough', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    (page as unknown as { __errors: string[] }).__errors = errors;
    await waitForShellReady(page);
  });

  test('dashboard boots from real fixture data', async ({ page }) => {
    const content = (await page.textContent('#content')) ?? '';
    // The dashboard summarizes the fixtures (sessions/requests/workspaces).
    expect(content.length).toBeGreaterThan(200);
    expect(await page.locator('.error-boundary').count()).toBe(0);
  });

  for (const { id, label } of PAGES) {
    test(`view "${label}" loads without errors`, async ({ page }) => {
      await gotoPage(page, id);

      const errorBoundaries = await page.locator('.error-boundary').count();
      expect(errorBoundaries, `view ${id} rendered an error boundary`).toBe(0);

      const spinners = await page.locator('#content .loading-spinner:visible').count();
      expect(spinners, `view ${id} is stuck on a spinner`).toBe(0);

      const content = (await page.textContent('#content')) ?? '';
      expect(content.trim().length, `view ${id} rendered empty`).toBeGreaterThan(0);

      await page.screenshot({ path: path.join(SHOT_DIR, `${id}.png`), fullPage: true });

      const pageErrors = (page as unknown as { __errors: string[] }).__errors ?? [];
      expect(pageErrors, `view ${id} threw: ${pageErrors.join('; ')}`).toEqual([]);
    });
  }

  test('round-trips across all views without leaking error boundaries', async ({ page }) => {
    for (const { id } of PAGES) {
      await gotoPage(page, id);
      expect(await page.locator('.error-boundary').count(), `view ${id}`).toBe(0);
    }
    // Return home cleanly.
    await gotoPage(page, 'dashboard');
    expect(await page.locator('.error-boundary').count()).toBe(0);
  });
});
