/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessLabel, lastSegment, PERSONAL_REPOSITORY, scrubBranch, scrubLabel, scrubRepository } from './session-labels';
import { isPromptText, readCliClient, readCliWorkspaceMeta, yamlScalar } from './session-workspace-meta';

const ctx = { home: 'C:\\Users\\Dev', names: ['Dev', 'octo-dev', 'me'], handles: ['octo-dev'] };

describe('session labels', () => {
  it('removes links, email addresses, paths and the user’s names', () => {
    expect(scrubLabel('Fix https://github.com/x/y/pull/1 for a@b.io', ctx)).toBe('Fix [link] for [email]');
    expect(scrubLabel('Open D:\\work\\repo\\a.ts and /Users/someone/x', ctx)).toBe('Open [path] and [path]');
    expect(scrubLabel('Review octo-dev/shop, as Dev asked me', ctx)).toBe('Review shop, as asked me');
    expect(scrubLabel('Notes in ~/x', { home: '/home/dev', names: [] })).toBe('Notes in ~/x');
    expect(scrubLabel('Read /home/dev/notes.md', { home: '/home/dev', names: [] })).toBe('Read ~/notes.md');
    expect(scrubLabel('Logs in /mnt/c/Users/someone/repo and /workspaces/shop, run /fork', { names: [] })).toBe('Logs in [path] and [path], run /fork');
    expect(scrubLabel('x'.repeat(120), ctx)).toHaveLength(90);
    // A path with spaces goes whole: quoted, or as long as the following words still carry a separator.
    expect(scrubLabel('See "C:\\Program Files\\My App\\log.txt" now', ctx)).toBe('See [path] now');
    expect(scrubLabel('See C:\\My Docs\\notes.md now', ctx)).toBe('See [path] now');
    // Unquoted, a path runs on to a word with a file extension, or to the end: no tail of it is left.
    expect(scrubLabel('See C:\\Users\\Jane Doe\\notes final draft.txt now', ctx)).toBe('See [path] now');
    expect(scrubLabel('Fix C:\\Users\\Jane Doe\\Secret Project', ctx)).toBe('Fix [path]');
    expect(scrubLabel('Fix /Users/Jane Doe/Secret Project/notes.txt now', ctx)).toBe('Fix [path] now');
    expect(scrubLabel('Fix /home/Jane Doe/Secret Project', ctx)).toBe('Fix [path]');
    expect(scrubLabel('See C:\\Users\\jane\\My Docs\\file name.txt now', ctx)).toBe('See [path] now');
    expect(scrubLabel('model "/Users/jane doe/models/x" here', { names: [] })).toBe('model [path] here');
    expect(scrubLabel('weights=/opt/jane/w.bin', { names: [] })).toBe('weights=[path]');
  });

  it('drops only a signed-in handle as a branch prefix', () => {
    expect(scrubBranch('octo-dev/timeline-revamp', ctx)).toBe('timeline-revamp');
    expect(scrubBranch('octo-dev-timeline', ctx)).toBe('timeline');
    expect(scrubBranch('feat/timeline', ctx)).toBe('feat/timeline');
    // The OS account name is no handle: it is marked where it stands, so the branch doesn't pass for its topic alone.
    expect(scrubBranch('zed9-cache', { names: ['zed9'], handles: [] })).toBe('[name]-cache');
    expect(scrubBranch('zed9/cache', { names: ['zed9'], handles: [] })).toBe('[name]/cache');
    expect(scrubBranch('zed9_cache', { names: ['zed9'], handles: [] })).toBe('[name]_cache');
    expect(scrubBranch('release-zed9', ctx)).toBe('release-zed9');
    // A signed-in handle is known exactly, so even a short one goes as the branch's first word.
    expect(scrubBranch('ab/fix', { names: [], handles: ['ab'] })).toBe('fix');
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
      'id: 1', "name: 'Ship it: Dev''s fix'", 'user_named: true', 'branch: octo-dev/fix-cache', 'repository: octo-dev/shop',
      'git_root: C:\\Users\\Dev\\shop', 'fork_count: 2', 'cwd: C:\\Users\\Dev\\shop',
    ].join('\n'));
    expect(readCliWorkspaceMeta(dir, ctx)).toEqual({ displayName: "Ship it: 's fix", branch: 'fix-cache', repository: 'shop', forkCount: 2 });
    expect(yamlScalar('name: "a \\"b\\""', 'name')).toBe('a "b"');
    expect(yamlScalar('name: Fix issue#12 cache # set by the App', 'name')).toBe('Fix issue#12 cache');
    expect(yamlScalar("name: 'quoted # kept' # comment", 'name')).toBe('quoted # kept');
    expect(yamlScalar('name: |\n  First line\n  second line\nbranch: x', 'name')).toBe('First line\nsecond line');
    expect(yamlScalar('name: >-\n  Folded\n  title\n\nbranch: x', 'name')).toBe('Folded title');
    expect(yamlScalar('summary: x\nname: ~', 'name')).toBe('');
    // Quoted, `~` and `null` are text; a quoted value can go on over several lines.
    expect([yamlScalar("name: 'null'", 'name'), yamlScalar('name: "~"', 'name')]).toEqual(['null', '~']);
    expect(yamlScalar("name: 'First\n  second'\nbranch: x", 'name')).toBe('First second');
    expect(readCliWorkspaceMeta(path.join(dir, 'missing'), ctx)).toEqual({});
  });
});

describe('automatic Copilot titles', () => {
  let dir = '';
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const write = (lines: string[]) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-ws-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), lines.join('\n'));
    return dir;
  };

  it('never shows a title you didn’t give: an automatic one often repeats your first prompt', () => {
    expect(readCliWorkspaceMeta(write(['name: Fix the flaky cache test', 'user_named: false']), ctx).displayName).toBeUndefined();
    expect(readCliWorkspaceMeta(write(['name: Fix the flaky cache test', 'user_named: true']), ctx).displayName).toBe('Fix the flaky cache test');
    // Where the file doesn't say who named it, the title may still be prompt text: not shown.
    expect(readCliWorkspaceMeta(write(['name: Cache work']), ctx, 'please fix the flaky cache test').displayName).toBeUndefined();
    // A name you gave that repeats your first prompt is prompt text too.
    expect(readCliWorkspaceMeta(write(['name: Please fix the flaky cache test…', 'user_named: true']), ctx, 'please fix the flaky cache test in ci and push').displayName).toBeUndefined();
  });

  it('matches a title to the prompt it was made from, ignoring case, spacing and a trailing ellipsis', () => {
    expect(isPromptText('Fix  the BUILD...', 'fix the build')).toBe(true);
    // A short title that is the prompt's first words is prompt text too (B17); part of a word isn't.
    expect(isPromptText('Fix the', 'Fix the build now')).toBe(true);
    expect(isPromptText('Fix th', 'Fix the build now')).toBe(false);
    expect(isPromptText('Refactor', '')).toBe(false);
  });

  it('reads which client started the session', () => {
    expect(readCliClient(write(['name: x', 'client_name: github/cli']))).toBe('github/cli');
    expect(readCliClient(path.join(dir, 'missing'))).toBe('');
  });
});