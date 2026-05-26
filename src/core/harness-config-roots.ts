/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Harness-specific configuration root discovery. */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export const CLAUDE_CONFIG_DIRS_ENV = 'AI_ENGINEER_COACH_CLAUDE_CONFIG_DIRS';

function expandHomeDir(dir: string, home: string): string {
  if (dir === '~') return home || dir;
  if (dir.startsWith(`~${path.sep}`) || dir.startsWith('~/') || dir.startsWith('~\\')) {
    return home ? path.join(home, dir.slice(2)) : dir;
  }
  return dir;
}

function parseDirList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(path.delimiter).map(part => part.trim()).filter(Boolean);
}

function uniqueResolvedDirs(dirs: string[], home: string): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];

  for (const dir of dirs) {
    if (!dir || dir.trim().length === 0) continue;
    const resolved = path.resolve(expandHomeDir(dir.trim(), home));
    let canonical = resolved;
    try {
      canonical = fs.realpathSync(resolved);
    } catch {
      /* Keep the unresolved path so future dirs can still be configured. */
    }
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }

  return roots;
}

export function getClaudeConfigRoots(): string[] {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || '';
  const configuredDirs = parseDirList(process.env[CLAUDE_CONFIG_DIRS_ENV]);
  if (configuredDirs.length > 0) return uniqueResolvedDirs(configuredDirs, home);

  const dirs = [
    process.env.CLAUDE_CONFIG_DIR || '',
  ];
  if (home) dirs.push(path.join(home, '.claude'));
  return uniqueResolvedDirs(dirs, home);
}
