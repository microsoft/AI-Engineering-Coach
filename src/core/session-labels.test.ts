/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessLabel, lastSegment, PERSONAL_REPOSITORY, scrubBranch, scrubLabel, scrubRepository, scrubText } from './session-labels';
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

describe('session labels with several paths', () => {
  it('removes every path in a clause, not only the first (C4)', () => {
    expect(scrubLabel('C:\\models\\a.bin and D:\\private\\jane\\b.bin', { names: [] })).toBe('[path] and [path]');
    expect(scrubLabel('Copy C:\\a\\b.txt to D:\\Jane Doe\\c.txt and E:\\x\\y.md', { names: [] })).toBe('Copy [path] to [path] and [path]');
    expect(scrubLabel('From C:\\Program Files\\App to D:\\Secret Project\\Plans', { names: [] })).toBe('From [path] to [path]');
    expect(scrubLabel('Logs C:\\a\\b.log and \\\\server\\share\\c.log done', { names: [] })).toBe('Logs [path] and [path] done');
    expect(scrubLabel('/opt/a/b.bin and /home/Jane Doe/c.bin', { names: [] })).toBe('[path] and [path]');
    expect(scrubLabel('C:\\a\\b.bin and /srv/jane/c.bin', { names: [] })).toBe('[path] and [path]');
  });

  it('leaves no word of a path with no extension with spaces before the next path (E6)', () => {
    expect(scrubLabel('C:\\Users\\Jane Doe\\Secret Project and D:\\x\\y.txt', { names: [] })).toBe('[path] and [path]');
    expect(scrubLabel('Move C:\\Data\\Private Plans to D:\\Archive\\Old Notes', { names: [] })).toBe('Move [path] to [path]');
    expect(scrubLabel('\\\\server\\share\\Board Minutes and \\\\server\\other\\x', { names: [] })).toBe('[path] and [path]');
    expect(scrubLabel('/home/jane/Secret Project and /srv/x/y', { names: [] })).toBe('[path] and [path]');
    expect(scrubLabel('/data/Private Plans /srv/x/y', { names: [] })).toBe('[path] [path]');
    // Ordinary text after a path with an extension stays.
    expect(scrubLabel('C:\\a\\b.txt and the notes', { names: [] })).toBe('[path] and the notes');
    expect(scrubLabel('/srv/a/b.log has the answer', { names: [] })).toBe('[path] has the answer');
  });
});

describe('scrubText', () => {
  const text = { home: 'C:\\Users\\jdoe', names: ['jdoe', 'vscode'], handles: ['octo-dev'] };

  it('keeps the text readable: line breaks and ordinary paths stay, the home folder becomes ~ and names [name]', () => {
    expect(scrubText('Edit C:\\Users\\jdoe\\repo\\a.ts\nthen D:\\work\\b.ts, asked by jdoe and octo-dev in vscode', text))
      .toBe('Edit ~\\repo\\a.ts\nthen D:\\work\\b.ts, asked by [name] and [name] in vscode');
    expect(scrubText('See https://x.io/a?token=1 or mail a@b.io', text)).toBe('See [link] or mail [email]');
  });

  it('replaces secret-like tokens but keeps hashes and IDs', () => {
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0123456789_abcdefghij', 'AKIAABCDEFGHIJKLMNOP',
      'sk-proj-abcdefghijklmnopqrstuvwx', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', 'Q2xpZW50U2VjcmV0VmFsdWUxMjM0NTY3OEFC',
    ];
    for (const s of secrets) expect(scrubText(`key ${s} end`, text)).toBe('key [secret] end');
    expect(scrubText('Authorization: Bearer abcdef0123456789xyz', text)).toBe('Authorization: Bearer [secret]');
    expect(scrubText('set password=hunter2hunter and api_key: "abc123def456"', text)).toBe('set password=[secret] and api_key: "[secret]"');
    expect(scrubText('-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----', text)).toBe('[secret]');
    const ids = 'commit 3f2a9c4e1b7d8a6f5e4d3c2b1a0f9e8d7c6b5a49 session 7e470000-0000-4000-8000-000000000001';
    expect(scrubText(ids, text)).toBe(ids);
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
