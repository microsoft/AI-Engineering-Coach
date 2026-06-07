/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * AUTHLESS real-VS-Code UI test.
 *
 * Verifies the *installed* VSIX inside a real VS Code instance (driven by
 * ExTester under xvfb), with synthetic fixture logs seeded into HOME — no login
 * and no real account data. It proves:
 *   - the extension installs and activates,
 *   - the "Open Dashboard" command works,
 *   - the webview boots from the parsed fixtures,
 *   - every top-level view renders without an error boundary.
 *
 * This is the real-VS-Code counterpart of tests/vm/specs/authless-ui.spec.ts.
 * It is fully coded; running it requires downloading VS Code + chromedriver,
 * which is done by `npm run e2e` inside the container (see tests/vm/Dockerfile).
 */

import { expect } from 'chai';
import { WebView } from 'vscode-extension-tester';
import {
  TOP_LEVEL_VIEWS,
  openDashboard,
  waitForShell,
  gotoView,
  countErrorBoundaries,
} from '../support/dashboard';

describe('AI Engineer Coach — authless real-VS-Code UI', function () {
  this.timeout(180000);
  let webview: WebView;

  before(async () => {
    webview = await openDashboard();
    await waitForShell(webview);
  });

  after(async () => {
    if (webview) {
      try {
        await webview.switchBack();
      } catch {
        /* frame already detached */
      }
    }
  });

  it('boots the dashboard from seeded fixture data', async () => {
    expect(await countErrorBoundaries(webview)).to.equal(0);
  });

  for (const id of TOP_LEVEL_VIEWS) {
    it(`renders the "${id}" view without an error boundary`, async () => {
      await gotoView(webview, id);
      expect(await countErrorBoundaries(webview), `view ${id}`).to.equal(0);
    });
  }

  it('round-trips back to the dashboard cleanly', async () => {
    await gotoView(webview, 'dashboard');
    expect(await countErrorBoundaries(webview)).to.equal(0);
  });
});
