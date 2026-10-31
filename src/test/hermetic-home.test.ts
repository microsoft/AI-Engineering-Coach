/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Guards for src/test/hermetic-home.ts: no test may read, write or delete the developer's real
 * per-user data, such as the parse cache, session logs or harness databases. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { getCacheDir } from '../core/cache-paths';
import { getRuntimeDebugLogPath } from '../core/runtime-debug';

/** Canonical spelling of a path: resolves Windows 8.3 short names and casing, through the nearest
 *  existing ancestor for paths that do not exist yet. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  }
}

function isInsideTempDir(p: string): boolean {
  const relative = path.relative(canonical(os.tmpdir()), canonical(p));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Names of the environment variables that production code (src/, minus tests) reads. */
function productionEnvVars(): string[] {
  const names = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.resolve('src', 'test')) visit(file);
      } else if (entry.name.endsWith('.ts') && !/\.(test|bench)\.ts$/.test(entry.name)) {
        const source = fs.readFileSync(file, 'utf-8');
        for (const match of source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)) {
          names.add(match[1] ?? match[2]);
        }
      }
    }
  };
  visit(path.resolve('src'));
  return [...names].sort();
}

describe('hermetic test home', () => {
  it('keeps the cache dir and runtime log out of the real home directory', () => {
    // clearCache() and the sidebar stats tests would otherwise delete or overwrite the
    // developer's real ~/.copilot-analytics-cache.
    const cacheDir = getCacheDir();
    fs.mkdirSync(cacheDir, { recursive: true });
    const resolved = canonical(cacheDir);
    let realHome: string | undefined;
    try {
      realHome = os.userInfo().homedir;
    } catch {
      // Some containers have no passwd entry; the temp-dir check below still applies.
    }

    if (realHome) expect(resolved).not.toBe(path.join(canonical(realHome), '.copilot-analytics-cache'));
    expect(isInsideTempDir(resolved)).toBe(true);
    expect(canonical(path.dirname(getRuntimeDebugLogPath()))).toBe(resolved);
  });

  it('points every per-user root the production code reads into the temp dir', () => {
    // A root left alone still reaches real data even with HOME redirected: for example the
    // OpenCode databases under %LOCALAPPDATA% or $XDG_DATA_HOME that a real parse worker reads.
    const names = productionEnvVars();
    expect(names).toEqual(expect.arrayContaining(['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_DATA_HOME']));

    const leaked = names.filter(name => {
      const value = process.env[name];
      return !value || !isInsideTempDir(value);
    });
    expect(leaked, 'Point these at the temp home in src/test/hermetic-home.ts, or exclude them '
      + 'here if they never hold a per-user path').toEqual([]);
  });
});
