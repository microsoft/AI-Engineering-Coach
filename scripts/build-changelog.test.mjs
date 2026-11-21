/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChangelog, fragmentDates } from './build-changelog.mjs';

/** @param {Record<string, string>} responses git arguments joined by spaces → stdout */
function fakeGit(responses) {
  return (/** @type {string[]} */ args) => responses[args.join(' ')];
}

const LOG = 'log origin/main --first-parent --diff-merges=first-parent --diff-filter=A --no-renames --name-only --format=@%ct -- changelog.d/';
const REPO = {
  'rev-parse --is-shallow-repository': 'false',
  'rev-parse --verify --quiet origin/main^{commit}': 'abc',
};

describe('fragmentDates', () => {
  it('dates each fragment by the UTC day of the main commit that first added it', () => {
    const log = [
      '@1795300000', '', 'changelog.d/12.md', 'changelog.d/13.md', // 2026-11-21T22:26:40Z
      '@1793836799', '', 'changelog.d/12.md', // 2026-11-04T23:59:59Z: added before, deleted, added again
    ].join('\n');
    expect(fragmentDates(fakeGit({ ...REPO, [LOG]: log }))).toEqual({
      dates: new Map([['changelog.d/12.md', '2026-11-04'], ['changelog.d/13.md', '2026-11-21']]),
    });
  });

  it('falls back to a local main branch', () => {
    const local = { 'rev-parse --is-shallow-repository': 'false', 'rev-parse --verify --quiet main^{commit}': 'abc' };
    const log = LOG.replace('origin/main', 'main');
    expect(fragmentDates(fakeGit({ ...local, [log]: '@1793836799\n\nchangelog.d/1.md' })).dates.get('changelog.d/1.md')).toBe('2026-11-04');
  });

  it('explains why there are no dates', () => {
    expect(fragmentDates(fakeGit({})).reason).toBe('git is unavailable');
    expect(fragmentDates(fakeGit({ 'rev-parse --is-shallow-repository': 'true' })).reason).toContain('shallow');
    expect(fragmentDates(fakeGit({ 'rev-parse --is-shallow-repository': 'false' })).reason).toBe('there is no origin/main or main branch');
  });
});

describe('buildChangelog with git', () => {
  let root;
  const env = { ...process.env, TZ: 'UTC' };
  /** @param {string[]} args @param {string} [date] ISO commit date */
  function git(args, date) {
    const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, env: { ...env, ...dates }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  /** @param {string} name @param {string} text */
  function fragment(name, text) {
    writeFileSync(join(root, 'changelog.d', name), text);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aic-changelog-'));
    mkdirSync(join(root, 'changelog.d'));
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 2026-05-06\n\n### Added\n\n- First\n');
    writeFileSync(join(root, 'changelog.d', 'README.md'), '# Changelog fragments\n');
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init'], '2026-05-06T10:00:00Z');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('dates merged and squashed fragments by their main commit, and leaves branch-only ones unreleased', () => {
    // A merge commit: the branch commit is from November 2, the merge into main from November 3.
    git(['switch', '-q', '-c', 'feature']);
    fragment('12.md', '### Added\n\n- Feature (#12)\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feature'], '2026-11-02T09:00:00Z');
    git(['switch', '-q', 'main']);
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge #12'], '2026-11-03T23:30:00+00:00');
    // A squash merge on November 5, from a commit late on November 4 in UTC-8.
    fragment('13.md', '### Fixed\n\n- Fix (#13)\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Fix (#13)'], '2026-11-04T20:00:00-08:00');
    // An open pull request: the fragment is only on its branch.
    git(['switch', '-q', '-c', 'open-pr']);
    fragment('14.md', '### Changed\n\n- Change (#14)\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'Change (#14)'], '2026-11-06T09:00:00Z');

    const warnings = [];
    expect(buildChangelog({ root, warn: message => warnings.push(message) })).toBe([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Changed',
      '',
      '- Change (#14)',
      '',
      '## 2026-11-05',
      '',
      '### Fixed',
      '',
      '- Fix (#13)',
      '',
      '## 2026-11-03',
      '',
      '### Added',
      '',
      '- Feature (#12)',
      '',
      '## 2026-05-06',
      '',
      '### Added',
      '',
      '- First',
      '',
    ].join('\n'));
    expect(warnings).toEqual([]);
  });

  it('warns and lists fragments as unreleased in a clone without a main branch', () => {
    git(['branch', '-q', '-m', 'main', 'trunk']);
    fragment('12.md', '### Added\n\n- Feature (#12)\n');
    const warnings = [];
    expect(buildChangelog({ root, warn: message => warnings.push(message) })).toContain('## [Unreleased]\n\n### Added\n\n- Feature (#12)');
    expect(warnings).toEqual(['Changelog fragments are listed as [Unreleased]: there is no origin/main or main branch.']);
  });
});
