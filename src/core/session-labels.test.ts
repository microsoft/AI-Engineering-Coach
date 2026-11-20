/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessLabel, inferBranchOwner, lastSegment, scrubBranch, scrubLabel } from './session-labels';
import { readCliWorkspaceMeta, yamlScalar } from './session-workspace-meta';

const ctx = { home: 'C:\\Users\\Dev', names: ['Dev', 'octo-dev', 'me'] };

describe('session labels', () => {
  it('removes links, email addresses, paths and the user’s names', () => {
    expect(scrubLabel('Fix https://github.com/x/y/pull/1 for a@b.io', ctx)).toBe('Fix [link] for [email]');
    expect(scrubLabel('Open D:\\work\\repo\\a.ts and /Users/someone/x', ctx)).toBe('Open [path] and [path]');
    expect(scrubLabel('Review octo-dev/shop, as Dev asked me', ctx)).toBe('Review shop, as asked me');
    expect(scrubLabel('Notes in ~/x', { home: '/home/dev', names: [] })).toBe('Notes in ~/x');
    expect(scrubLabel('Read /home/dev/notes.md', { home: '/home/dev', names: [] })).toBe('Read ~/notes.md');
    expect(scrubLabel('x'.repeat(120), ctx)).toHaveLength(90);
  });

  it('drops the handle prefix from a branch', () => {
    expect(scrubBranch('octo-dev/timeline-revamp', ctx)).toBe('timeline-revamp');
    expect(scrubBranch('octo-dev-timeline', ctx)).toBe('timeline');
    expect(scrubBranch('feat/timeline', ctx)).toBe('feat/timeline');
  });

  it('infers a personal branch prefix only when most branches share it', () => {
    expect(inferBranchOwner(['zed9-a', 'zed9/b', 'zed9-c', 'feat/d'])).toBe('zed9');
    expect(inferBranchOwner(['feat/a', 'feat/b', 'feat/c'])).toBeNull();
    expect(inferBranchOwner(['zed9-a', 'zed9-b', 'x-1', 'y-2', 'z-3', 'w-4', 'v-5', 'u-6', 't-7', 's-8'])).toBeNull();
  });

  it('shortens harness names and never returns a whole path', () => {
    expect([harnessLabel('GitHub Copilot App'), harnessLabel('Claude'), harnessLabel('Codex')]).toEqual(['Copilot App', 'Claude Code', 'Codex']);
    expect([lastSegment('C:\\Users\\dev\\shop\\'), lastSegment('octo/shop')]).toEqual(['shop', 'shop']);
  });
});

describe('Copilot workspace.yaml', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads the scrubbed name, branch, repository and fork count', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-ws-'));
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), [
      'id: 1', "name: 'Ship it: Dev''s fix'", 'branch: octo-dev/fix-cache', 'repository: octo-dev/shop',
      'git_root: C:\\Users\\Dev\\shop', 'fork_count: 2', 'cwd: C:\\Users\\Dev\\shop',
    ].join('\n'));
    expect(readCliWorkspaceMeta(dir, ctx)).toEqual({ displayName: "Ship it: 's fix", branch: 'fix-cache', repository: 'shop', forkCount: 2 });
    expect(yamlScalar('name: "a \\"b\\""', 'name')).toBe('a "b"');
    expect(readCliWorkspaceMeta(path.join(dir, 'missing'), ctx)).toEqual({});
  });
});
