/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from '@playwright/test';
import * as path from 'path';

/*
 * Authless webview UI suite.
 *
 * Serves the repository root (so the built bundle at /dist/webview and the
 * harness at /tests/vm/harness.html are reachable) and drives the REAL webview
 * bundle against analyzer-computed fixture data. Requires `npm run build`
 * beforehand. No VS Code install, login, or network access is required.
 */
export default defineConfig({
  testDir: path.join(__dirname, 'specs'),
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  timeout: 30_000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'off',
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'npx serve . -p 3998 --no-clipboard',
    port: 3998,
    reuseExistingServer: true,
    cwd: path.resolve(__dirname, '..', '..'),
  },
});
