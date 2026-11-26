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
import { describe, it, expect } from 'vitest';
import { collectExternalHarnessesAsync, hasExternalHarnessSources } from './parser-harnesses';

function setEnv(key: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

/** Run `body` with HOME/USERPROFILE pointed at a fresh temp dir, restoring the
 *  previous values (and removing the temp dir) afterwards. Self-contained so it
 *  leaks no env state across tests. */
function withHome(setup: (home: string) => void, body: () => void): void {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    setup(home);
    body();
  } finally {
    setEnv('HOME', prevHome);
    setEnv('USERPROFILE', prevUserProfile);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

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

  it('returns false when no home directory is set (avoids relative-path probing)', () => {
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    setEnv('HOME', undefined);
    setEnv('USERPROFILE', undefined);
    try {
      expect(hasExternalHarnessSources()).toBe(false);
    } finally {
      setEnv('HOME', prevHome);
      setEnv('USERPROFILE', prevUserProfile);
    }
  });
});

describe('Claude Code progress detail', () => {
  const user = (cwd: string, sessionId: string) => JSON.stringify({
    type: 'user', timestamp: '2025-06-15T10:00:00Z', sessionId, cwd,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  const assistant = (sessionId: string) => JSON.stringify({
    type: 'assistant', timestamp: '2025-06-15T10:00:02Z', sessionId,
    message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } },
  });

  it('names a project opened in the home folder "~", never by the home folder name', async () => {
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const projects = path.join(home, '.claude', 'projects');
      for (const [cwd, id] of [[home, 's-home'], [path.join(home, 'work', 'api'), 's-api']]) {
        const dir = path.join(projects, cwd.replaceAll(/[^A-Za-z0-9]/g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${user(cwd, id)}\n${assistant(id)}\n`);
      }
      const details: string[] = [];
      await collectExternalHarnessesAsync(new Map(), [], new Map(), {
        onHarnessDetail: (name, detail) => { if (name === 'Claude Code') details.push(detail); },
      });
      expect(details.map(d => d.replace(/^\d+\/\d+: /, '')).sort()).toEqual(['api', '~']);
      expect(details.join(' ')).not.toContain(path.basename(home));
    } finally {
      setEnv('HOME', prevHome);
      setEnv('USERPROFILE', prevUserProfile);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
