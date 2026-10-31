/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BUILD_INFO_ENV, computeBuildInfo, describeBuildInfo, parseBuildInfo } from './build-info.mjs';

const ROOT = join(import.meta.dirname, '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NOW = new Date('2026-10-31T11:15:02.000Z');

/** @param {Record<string, string>} responses git arguments joined by spaces → stdout */
function fakeGit(responses) {
  return (/** @type {string[]} */ args) => responses[args.join(' ')];
}

const CLEAN_BRANCH = {
  'rev-parse --short=7 HEAD': 'abc1234',
  'status --porcelain --untracked-files=no': '',
  'tag --points-at HEAD': '',
  'rev-parse --abbrev-ref HEAD': 'feature/stamp',
};

function stamp(responses, env = {}) {
  return computeBuildInfo({ cwd: ROOT, env, now: NOW, run: fakeGit(responses) });
}

let gitCommit;
try {
  gitCommit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  gitCommit = undefined;
}

describe('computeBuildInfo', () => {
  it('stamps a clean branch checkout as a dev build of that branch', () => {
    expect(stamp(CLEAN_BRANCH)).toEqual({
      version: VERSION, commit: 'abc1234', dirty: false, branch: 'feature/stamp', builtAt: '2026-10-31T11:15:02.000Z', dev: true,
    });
  });

  it('marks uncommitted changes to tracked files as dirty', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'status --porcelain --untracked-files=no': ' M src/extension.ts' });
    expect(info).toMatchObject({ dirty: true, dev: true });
  });

  it('treats a clean checkout of the version tag as a release build without a branch', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'tag --points-at HEAD': `other\nv${VERSION}`, 'rev-parse --abbrev-ref HEAD': 'HEAD' });
    expect(info).toMatchObject({ dirty: false, dev: false, branch: '' });
  });

  it('keeps a dirty tagged checkout a dev build', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'tag --points-at HEAD': `v${VERSION}`, 'status --porcelain --untracked-files=no': ' M CHANGELOG.md' });
    expect(info).toMatchObject({ dirty: true, dev: true, branch: 'feature/stamp' });
  });

  it('recognizes a GitHub Actions run for the version tag', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${VERSION}` });
    expect(info).toMatchObject({ dev: false, branch: '' });
  });

  it('ignores a GitHub Actions tag that does not match the version', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0' });
    expect(info).toMatchObject({ dev: true, branch: '' });
  });

  it('uses the pull request branch for a detached CI checkout', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' },
      { GITHUB_HEAD_REF: 'feat/pr-branch', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: '42/merge' });
    expect(info.branch).toBe('feat/pr-branch');
  });

  it('uses the pushed branch for a detached CI push checkout', () => {
    const info = stamp({ ...CLEAN_BRANCH, 'rev-parse --abbrev-ref HEAD': 'HEAD' }, { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' });
    expect(info.branch).toBe('main');
  });

  it('falls back to GITHUB_SHA, then "unknown", when git is unavailable', () => {
    expect(stamp({}, { GITHUB_SHA: 'def5678901234' })).toMatchObject({ commit: 'def5678', dirty: false, dev: true, branch: '' });
    expect(stamp({})).toMatchObject({ commit: 'unknown', dirty: false, dev: true });
  });

  it('returns the stamp passed through the environment unchanged', () => {
    const passed = { version: '9.8.7', commit: 'feedbee', dirty: false, branch: '', builtAt: '2026-01-02T03:04:05.000Z', dev: false };
    const env = { [BUILD_INFO_ENV]: JSON.stringify({ ...passed, extra: 'ignored' }), GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.0.1' };
    expect(stamp(CLEAN_BRANCH, env)).toEqual(passed);
  });

  it.runIf(gitCommit)('matches package.json and git HEAD in this repository', () => {
    const info = computeBuildInfo({ cwd: ROOT, env: {}, now: NOW });
    expect(info.version).toBe(VERSION);
    expect(info.commit).toBe(gitCommit);
  });
});

describe('parseBuildInfo', () => {
  it('treats an unset or empty variable as no override', () => {
    expect(parseBuildInfo(undefined)).toBeUndefined();
    expect(parseBuildInfo('')).toBeUndefined();
  });

  it('rejects malformed stamps instead of shipping them', () => {
    expect(() => parseBuildInfo('{')).toThrow(BUILD_INFO_ENV);
    expect(() => parseBuildInfo(JSON.stringify({ version: '1.0.0' }))).toThrow(BUILD_INFO_ENV);
  });
});

describe('describeBuildInfo', () => {
  it('summarizes dev and release builds for build logs', () => {
    expect(describeBuildInfo({ version: '0.2.0', commit: 'abc1234', dirty: true, branch: 'main', builtAt: 't', dev: true }))
      .toBe('v0.2.0 dev build, commit abc1234-dirty on main, built t');
    expect(describeBuildInfo({ version: '0.2.0', commit: 'abc1234', dirty: false, branch: '', builtAt: 't', dev: false }))
      .toBe('v0.2.0 release build, commit abc1234, built t');
  });
});
