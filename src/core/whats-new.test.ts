/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { describe, expect, it } from 'vitest';
import { DATE_BEFORE_TRACKING, findChangelogName, latestChangelogDate, shouldAnnounceUpdate } from './whats-new';

describe('latestChangelogDate', () => {
  it('returns the newest dated section and ignores [Unreleased] and dates in text', () => {
    const changelog = [
      '# Changelog', '', 'Dated like 2027-01-01 in prose.', '', '## [Unreleased]', '', '- Pending', '',
      '## 2026-11-01', '', '### Fixed', '', '- A fix', '', '## 2026-11-20', '', '- Out of order', '',
      '## 2026-05-06', '', '- First',
    ].join('\r\n');
    expect(latestChangelogDate(changelog)).toBe('2026-11-20');
  });

  it('returns undefined when there is no dated section', () => {
    expect(latestChangelogDate('# Changelog\n\n## [Unreleased]\n\n- Pending\n')).toBeUndefined();
    expect(latestChangelogDate('## [0.1.0] - 2026-05-06\n')).toBeUndefined();
  });
});

describe('shouldAnnounceUpdate', () => {
  it('announces changes newer than the recorded date', () => {
    expect(shouldAnnounceUpdate('2026-11-01', '2026-11-02', false)).toBe(true);
    expect(shouldAnnounceUpdate('2026-09-30', '2026-10-01', false)).toBe(true);
  });

  it('stays quiet for the same changes and for an older build', () => {
    expect(shouldAnnounceUpdate('2026-11-01', '2026-11-01', true)).toBe(false);
    expect(shouldAnnounceUpdate('2026-11-20', '2026-11-01', true)).toBe(false);
  });

  it('stays quiet on a fresh install and for a changelog without dates', () => {
    expect(shouldAnnounceUpdate(undefined, '2026-11-01', false)).toBe(false);
    expect(shouldAnnounceUpdate('2026-11-01', undefined, true)).toBe(false);
  });

  it('treats earlier dashboard use without a recorded date as having seen the first changes', () => {
    expect(DATE_BEFORE_TRACKING).toBe('2026-05-06');
    expect(shouldAnnounceUpdate(undefined, '2026-11-01', true)).toBe(true);
    expect(shouldAnnounceUpdate(undefined, '2026-05-06', true)).toBe(false);
  });

  it('ignores dates it cannot parse', () => {
    expect(shouldAnnounceUpdate('0.1.0', '2026-11-01', true)).toBe(false);
    expect(shouldAnnounceUpdate('2026-11-01', '01/12/2026', true)).toBe(false);
  });
});

describe('findChangelogName', () => {
  it('matches the packaged and the repository spelling', () => {
    expect(findChangelogName(['package.json', 'changelog.md', 'readme.md'])).toBe('changelog.md');
    expect(findChangelogName(['CHANGELOG.md', 'README.md'])).toBe('CHANGELOG.md');
  });

  it('returns undefined when there is no Markdown changelog', () => {
    expect(findChangelogName(['CHANGELOG.txt', 'changelog.md.bak', 'dist'])).toBeUndefined();
  });
});
