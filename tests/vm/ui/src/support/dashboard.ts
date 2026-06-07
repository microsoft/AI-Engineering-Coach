/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Shared page-object helpers for the real-VS-Code (ExTester) UI tests.
 *
 * The extension renders its dashboard inside a webview that loads the very same
 * `dist/webview/app.js` bundle exercised by the headless Playwright suite, so
 * the DOM contract (`[data-page="..."]` nav items + `#content`) is identical.
 */

import { VSBrowser, WebView, Workbench, By, WebElement } from 'vscode-extension-tester';

export const OPEN_DASHBOARD_COMMAND = 'AI Engineer Coach: Open Dashboard';

/** Every top-level view reachable from the dashboard sidebar (burndown is
 *  feature-flagged off in production and intentionally excluded). */
export const TOP_LEVEL_VIEWS = [
  'dashboard',
  'timeline',
  'image-gallery',
  'output',
  'patterns',
  'anti-patterns',
  'skills',
  'config-health',
  'level-up',
  'data-explorer',
  'rule-playground',
] as const;

/** Run the "Open Dashboard" command and switch the driver into the webview. */
export async function openDashboard(): Promise<WebView> {
  const workbench = new Workbench();
  await workbench.executeCommand(OPEN_DASHBOARD_COMMAND);

  const webview = new WebView();
  // Give the webview time to be created before switching into its frame.
  await VSBrowser.instance.driver.sleep(2000);
  await webview.switchToFrame(15000);
  return webview;
}

/** Wait until the dashboard shell has rendered real content. */
export async function waitForShell(webview: WebView): Promise<void> {
  const driver = VSBrowser.instance.driver;
  await driver.wait(async () => {
    const content = await webview.findWebElements(By.id('content'));
    if (content.length === 0) return false;
    const html = await content[0].getAttribute('innerHTML');
    return !!html && html.length > 150 && !html.includes('error-boundary');
  }, 20000, 'dashboard shell did not finish rendering');
}

/** Click a sidebar nav item and wait for its view to settle (no visible spinner). */
export async function gotoView(webview: WebView, id: string): Promise<void> {
  const driver = VSBrowser.instance.driver;
  const navItems = await webview.findWebElements(By.css(`[data-page="${id}"]`));
  if (navItems.length === 0) throw new Error(`nav item for view "${id}" not found`);
  await navItems[0].click();

  await driver.wait(async () => {
    const content = await webview.findWebElements(By.id('content'));
    if (content.length === 0) return false;
    const spinners = await content[0].findElements(By.css('.loading-spinner'));
    for (const sp of spinners) {
      // Ignore spinners inside hidden (display:none) modals.
      if (await sp.isDisplayed()) return false;
    }
    return true;
  }, 20000, `view "${id}" stayed on a spinner`);

  // Let async chart/RPC fills settle.
  await driver.sleep(500);
}

/** Count error boundaries currently rendered inside the webview content. */
export async function countErrorBoundaries(webview: WebView): Promise<number> {
  const els: WebElement[] = await webview.findWebElements(By.css('.error-boundary'));
  return els.length;
}
