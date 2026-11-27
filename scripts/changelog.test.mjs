/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { changelogDates, parseFragment, renderChangelog } from './changelog.mjs';
import { listFragments } from './build-changelog.mjs';

const ROOT = join(import.meta.dirname, '..');

const HISTORY = [
  '# Changelog',
  '',
  'Grouped by date.',
  '',
  '## 2026-11-01',
  '',
  '### Fixed',
  '',
  '- Older fix (#10)',
  '',
  '## 2026-05-06',
  '',
  '### Added',
  '',
  '- First',
  '',
].join('\n');

const ADDED = '### Added\n\n- New feature (#12)\n\n### Deprecated\n';
const FIXED = '### Fixed\n\n- A fix (#13)\n  that wraps\n';

describe('renderChangelog', () => {
  it('adds a section for a new date and lists undated fragments under [Unreleased] on top', () => {
    expect(renderChangelog(HISTORY, [
      { name: '12.md', text: ADDED, date: '2026-11-03' },
      { name: '13.md', text: FIXED },
    ])).toBe([
      '# Changelog',
      '',
      'Grouped by date.',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '',
      '- A fix (#13)',
      '  that wraps',
      '',
      '## 2026-11-03',
      '',
      '### Added',
      '',
      '- New feature (#12)',
      '',
      '## 2026-11-01',
      '',
      '### Fixed',
      '',
      '- Older fix (#10)',
      '',
      '## 2026-05-06',
      '',
      '### Added',
      '',
      '- First',
      '',
    ].join('\n'));
  });

  it('merges fragments with the same date into one section, type by type in Keep a Changelog order', () => {
    const rendered = renderChangelog(HISTORY, [
      { name: '13.md', text: FIXED, date: '2026-11-01' },
      { name: '12.md', text: ADDED, date: '2026-11-01' },
    ]);
    expect(rendered).toContain([
      '## 2026-11-01',
      '',
      '### Added',
      '',
      '- New feature (#12)',
      '',
      '### Fixed',
      '',
      '- Older fix (#10)',
      '- A fix (#13)',
      '  that wraps',
      '',
      '## 2026-05-06',
    ].join('\n'));
  });

  it('returns the history unchanged without fragments, keeping Windows line endings and link references', () => {
    const history = `${HISTORY}\n[1]: https://example.com\n`.replaceAll('\n', '\r\n');
    expect(renderChangelog(history, [])).toBe(history);
  });

  it('refuses an invalid fragment date', () => {
    expect(() => renderChangelog(HISTORY, [{ name: '12.md', text: ADDED, date: '2026-1-3' }])).toThrow('12.md: expected a YYYY-MM-DD date');
  });
});

describe('parseFragment', () => {
  it('requires entries under known Keep a Changelog types', () => {
    expect([...parseFragment('ok.md', ADDED).keys()]).toEqual(['Added']);
    expect(() => parseFragment('bare.md', '- No heading (#1)\n')).toThrow('bare.md: put every entry under a "### Type" heading');
    expect(() => parseFragment('typo.md', '### Fixes\n\n- Typo (#1)\n')).toThrow('typo.md: unknown type "### Fixes"');
    expect(() => parseFragment('empty.md', '### Added\n')).toThrow('empty.md: has no entries');
  });

  it('rejects other headings, which would become sections of their own, such as a future date', () => {
    expect(() => parseFragment('date.md', '### Added\n\n- Feature (#1)\n\n## 2099-01-01\n')).toThrow(
      'date.md: only "### Type" headings are allowed, found "## 2099-01-01"');
    expect(() => parseFragment('h4.md', '### Added\n\n#### Details\n\n- Feature (#1)\n')).toThrow('only "### Type" headings');
  });
});

describe('changelogDates', () => {
  it('lists dated sections newest first', () => {
    expect(changelogDates(HISTORY)).toEqual(['2026-11-01', '2026-05-06']);
  });

  it('rejects other headings, duplicates, and dates out of order', () => {
    expect(() => changelogDates('## [Unreleased]\n\n- Pending\n')).toThrow('Expected "## YYYY-MM-DD"');
    expect(() => changelogDates('## [0.1.0] - 2026-05-06\n')).toThrow('Expected "## YYYY-MM-DD"');
    expect(() => changelogDates('## 2026-05-06\n\n## 2026-05-06\n')).toThrow('newest first');
    expect(() => changelogDates('## 2026-05-06\n\n## 2026-11-01\n')).toThrow('newest first');
    expect(() => changelogDates('## 2026-02-30\n')).toThrow('Expected "## YYYY-MM-DD"');
  });
});

describe('this repository', () => {
  it('keeps a dated history and only valid fragments', () => {
    const history = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const dates = changelogDates(history);
    expect(dates.length).toBeGreaterThan(0);
    // What's New never trusts a future date, so one here would hide those changes.
    expect(dates[0] <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)).toBe(true);
    for (const name of listFragments(ROOT)) {
      expect(() => parseFragment(name, readFileSync(join(ROOT, 'changelog.d', name), 'utf8'))).not.toThrow();
    }
  });
});
