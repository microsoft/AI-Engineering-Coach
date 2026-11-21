/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Vitest setup file: every test file runs against a throwaway home directory, so no test can
 * read, write or delete the developer's real ~/.copilot-analytics-cache (parse cache, runtime.log,
 * sidebar stats), session logs or other harness data. Every per-user data root the code reads is
 * redirected into it, as isolatedEnvironment() in tests/vscode/fixtures.ts does for VS Code. The
 * temp-dir variables keep the OS temp dir, where the home itself lives. Paths resolve lazily from
 * these variables (core/cache-paths.ts), and child processes and worker threads that tests start
 * inherit them. src/test/hermetic-home.test.ts fails if a root the code reads is not redirected.
 *
 * The variables are deliberately not restored afterwards: work still in flight when a file
 * finishes must not land in the real home directory. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll } from 'vitest';

// On Windows the temp dir can be an 8.3 short name (C:\Users\LONGNA~1\...). getTrustedRoots()
// trusts it as spelled, so long paths that tests build under it would be untrusted; the real
// %LOCALAPPDATA%, which contains it in full, used to hide that.
if (process.platform === 'win32') {
  const tempDir = fs.realpathSync.native(os.tmpdir());
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-test-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  COPILOT_HOME: path.join(home, '.copilot'),
});

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // A child process may still hold a file open on Windows; the OS temp dir cleans up later.
  }
});
