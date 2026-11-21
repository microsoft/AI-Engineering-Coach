/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessLabel, lastSegment, PERSONAL_REPOSITORY, scrubBranch, scrubLabel, scrubRepository } from './session-labels';
import { readCliWorkspaceMeta, yamlScalar } from './session-workspace-meta';

const ctx = { home: 'C:\\Users\\Dev', names: ['Dev', 'octo-dev', 'me'], handles: ['octo-dev'] };

describe('session labels', () => {
  it('removes links, email addresses, paths and the user’s names', () => {
    expect(scrubLabel('Fix https://github.com/x/y/pull/1 for a@b.io', ctx)).toBe('Fix [link] for [email]');
    expect(scrubLabel('Open D:\\work\\repo\\a.ts and /Users/someone/x', ctx)).toBe('Open [path] and [path]');
    expect(scrubLabel('Review octo-dev/shop, as Dev asked me', ctx)).toBe('Review shop, as asked me');
    expect(scrubLabel('Notes in ~/x', { home: '/home/dev', names: [] })).toBe('Notes in ~/x');
    expect(scrubLabel('Read /home/dev/notes.md', { home: '/home/dev', names: [] })).toBe('Read ~/notes.md');
    expect(scrubLabel('x'.repeat(120), ctx)).toHaveLength(90);
  });

  it('drops only a signed-in handle as a branch prefix', () => {
    expect(scrubBranch('octo-dev/timeline-revamp', ctx)).toBe('timeline-revamp');
    expect(scrubBranch('octo-dev-timeline', ctx)).toBe('timeline');
    expect(scrubBranch('feat/timeline', ctx)).toBe('feat/timeline');
    // The OS account name is no handle: it goes as a word, but a branch named after it keeps its topic.
    expect(scrubBranch('zed9-cache', { names: ['zed9'], handles: [] })).toBe('cache');
    expect(scrubBranch('release-zed9', ctx)).toBe('release-zed9');
  });

  it('never removes generic account names', () => {
    const generic = { home: '/home/vscode', names: ['vscode', 'node', 'root', 'runner', 'codespace', 'user', 'admin'], handles: ['vscode'] };
    expect(scrubLabel('Fix the vscode extension for node and root users', generic)).toBe('Fix the vscode extension for node and root users');
    expect(scrubBranch('vscode/fix-tabs', generic)).toBe('vscode/fix-tabs');
    expect(scrubRepository('vscode', generic)).toBe('vscode');
  });

  it('never turns a repository into unknown', () => {
    expect(scrubRepository('octo-dev/octo-dev', ctx)).toBe(PERSONAL_REPOSITORY);
    expect(scrubRepository('C:\\Users\\Dev\\octo-dev-shop', ctx)).toBe('shop');
    expect(scrubRepository('', ctx)).toBe('');
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
    expect(yamlScalar('name: Fix issue#12 cache # set by the App', 'name')).toBe('Fix issue#12 cache');
    expect(yamlScalar("name: 'quoted # kept' # comment", 'name')).toBe('quoted # kept');
    expect(yamlScalar('name: |\n  First line\n  second line\nbranch: x', 'name')).toBe('First line\nsecond line');
    expect(yamlScalar('name: >-\n  Folded\n  title\n\nbranch: x', 'name')).toBe('Folded title');
    expect(yamlScalar('summary: x\nname: ~', 'name')).toBe('');
    expect(readCliWorkspaceMeta(path.join(dir, 'missing'), ctx)).toEqual({});
  });
});
