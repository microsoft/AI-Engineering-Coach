/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Vitest setup file: every test file runs against a throwaway HOME/USERPROFILE, so no test can
 * read, write or delete the developer's real ~/.copilot-analytics-cache (parse cache, runtime.log,
 * sidebar stats) or other per-user state. The cache paths resolve lazily from these variables
 * (core/cache-paths.ts), and child processes and worker threads that tests start inherit them.
 * The "test isolation" test in core/cache.test.ts fails if this stops working.
 *
 * HOME is deliberately not restored afterwards: work still in flight when a file finishes must
 * not land in the real home directory. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // A child process may still hold a file open on Windows; the OS temp dir cleans up later.
  }
});
