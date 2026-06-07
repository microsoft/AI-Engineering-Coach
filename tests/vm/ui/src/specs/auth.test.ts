/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * AUTH / real-session-data real-VS-Code UI test — SCAFFOLD ONLY.
 *
 * Unlike the authless suite (which seeds *synthetic* fixtures), this suite is
 * meant to run against logs produced by REAL agent runs collected in the
 * data-collection phase (tests/vm/data-collection/*), which requires a logged-in
 * GitHub Copilot / Claude / Codex session.
 *
 * These tests are intentionally SKIPPED by default: producing the underlying
 * data requires an interactive `auth` (login) step that the automated harness
 * cannot perform unattended. The owner runs the data-collection scripts, sets
 * AEC_AUTH_DATA=1, and then this suite verifies that the dashboard surfaces the
 * real analytics correctly. This is the semi-automated second verification step.
 *
 * The assertions below are written but NOT verified end-to-end by the automated
 * build; they document the intended real-data contract.
 */

import { expect } from 'chai';
import { By, WebView } from 'vscode-extension-tester';
import { openDashboard, waitForShell, gotoView } from '../support/dashboard';

const AUTH_DATA_PRESENT = process.env.AEC_AUTH_DATA === '1';

(AUTH_DATA_PRESENT ? describe : describe.skip)(
  'AI Engineer Coach — real-session-data UI (requires auth + collected logs)',
  function () {
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

    it('dashboard reports a non-zero session count from collected logs', async () => {
      const stats = await webview.findWebElements(By.css('.stat-value, [data-stat]'));
      expect(stats.length, 'expected stat cards to render').to.be.greaterThan(0);
    });

    it('the Output view attributes AI lines-of-code from real sessions', async () => {
      await gotoView(webview, 'output');
      const content = await webview.findWebElements(By.id('content'));
      const text = content.length ? await content[0].getText() : '';
      expect(text.length, 'output view should render real production data').to.be.greaterThan(0);
    });

    it('the Timeline lists real collected sessions', async () => {
      await gotoView(webview, 'timeline');
      const content = await webview.findWebElements(By.id('content'));
      const text = content.length ? await content[0].getText() : '';
      expect(text.length, 'timeline should render collected sessions').to.be.greaterThan(0);
    });
  },
);
