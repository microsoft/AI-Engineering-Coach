/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { describe, expect, it } from 'vitest';
import { DATE_BEFORE_TRACKING, findChangelogName, isChangelogDate, latestChangelogDate, shouldAnnounceUpdate } from './whats-new';

const NOW = new Date('2026-11-23T10:00:00Z');

describe('isChangelogDate', () => {
  it('accepts real dates up to tomorrow in UTC', () => {
    expect(isChangelogDate('2026-05-06', NOW)).toBe(true);
    expect(isChangelogDate('2026-11-24', NOW)).toBe(true); // A build from a time zone ahead of the user's clock
  });

  it('rejects impossible and future dates', () => {
    for (const value of ['2026-02-30', '2026-13-01', '2026-11-25', '2099-01-01', '2026-1-2', '']) {
      expect(isChangelogDate(value, NOW), value).toBe(false);
    }
  });
});

describe('latestChangelogDate', () => {
  it('returns the newest dated section and ignores [Unreleased] and dates in text', () => {
    const changelog = [
      '# Changelog', '', 'Dated like 2027-01-01 in prose.', '', '## [Unreleased]', '', '- Pending', '',
      '## 2026-11-01', '', '### Fixed', '', '- A fix', '', '## 2026-11-20', '', '- Out of order', '',
      '## 2026-05-06', '', '- First',
    ].join('\r\n');
    expect(latestChangelogDate(changelog, NOW)).toBe('2026-11-20');
  });

  it('ignores future and impossible dates, which would otherwise hide every later update', () => {
    expect(latestChangelogDate('## 2099-01-01\n\n## 2026-02-30\n\n## 2026-11-20\n', NOW)).toBe('2026-11-20');
    expect(latestChangelogDate('## 2099-01-01\n', NOW)).toBeUndefined();
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

  it('ignores dates it cannot parse or trust', () => {
    expect(shouldAnnounceUpdate('0.1.0', '2026-11-01', true, NOW)).toBe(false);
    expect(shouldAnnounceUpdate('2026-11-01', '01/12/2026', true, NOW)).toBe(false);
    expect(shouldAnnounceUpdate('2026-11-01', '2099-01-01', true, NOW)).toBe(false);
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
