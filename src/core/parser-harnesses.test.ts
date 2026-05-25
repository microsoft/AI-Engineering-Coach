/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for external-harness source discovery used by the dashboard load gate,
 * so a host with only non-VS Code logs (e.g. Claude Code on a headless
 * Remote-SSH box, with no VS Code/Copilot directories) still loads. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import { hasExternalHarnessSources } from './parser-harnesses';

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;

function withHome(setup: (home: string) => void, run: () => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    setup(home);
    run();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIG_USERPROFILE;
});

describe('hasExternalHarnessSources', () => {
  it('returns false when no external-harness directories exist', () => {
    withHome(() => { /* empty home */ }, () => {
      expect(hasExternalHarnessSources()).toBe(false);
    });
  });

  it('returns true when a Claude Code projects directory exists', () => {
    withHome(home => {
      fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    }, () => {
      expect(hasExternalHarnessSources()).toBe(true);
    });
  });
});
