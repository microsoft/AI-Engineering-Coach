/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { changelogDates, stampUnreleased } from './changelog.mjs';

const ROOT = join(import.meta.dirname, '..');

const SAMPLE = [
  '# Changelog',
  '',
  'All notable changes are documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- New feature (#12)',
  '',
  '### Deprecated',
  '',
  '### Fixed',
  '',
  '- A fix (#13)',
  '  that wraps',
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
  '[Unreleased]: https://github.com/owner/repo/commits/main',
  '',
].join('\n');

describe('stampUnreleased', () => {
  it('moves Unreleased under a new date on top and drops empty types', () => {
    expect(stampUnreleased(SAMPLE, { date: '2026-11-03' })).toBe([
      '# Changelog',
      '',
      'All notable changes are documented in this file.',
      '',
      '## [Unreleased]',
      '',
      '## 2026-11-03',
      '',
      '### Added',
      '',
      '- New feature (#12)',
      '',
      '### Fixed',
      '',
      '- A fix (#13)',
      '  that wraps',
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
      '[Unreleased]: https://github.com/owner/repo/commits/main',
      '',
    ].join('\n'));
  });

  it('joins an existing section for the same date, type by type in Keep a Changelog order', () => {
    const stamped = stampUnreleased(SAMPLE, { date: '2026-11-01' });
    expect(stamped).toContain([
      '## [Unreleased]',
      '',
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
    expect(changelogDates(stamped)).toEqual(['2026-11-01', '2026-05-06']);
  });

  it('keeps Windows line endings and stamps a changelog with no dates yet', () => {
    const stamped = stampUnreleased(SAMPLE.replaceAll('\n', '\r\n'), { date: '2026-11-03' });
    expect(stamped).toContain('## 2026-11-03\r\n');
    expect(stamped.replaceAll('\r\n', '')).not.toContain('\n');
    expect(stampUnreleased('# Changelog\n\n## Unreleased\n\n- Initial work\n', { date: '2026-01-02' })).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## 2026-01-02\n\n- Initial work\n');
  });

  it('refuses empty, missing, invalid, or out-of-order input', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n## 2026-05-06\n\n- First\n';
    expect(() => stampUnreleased(empty, { date: '2026-11-03' })).toThrow('Nothing to stamp');
    expect(() => stampUnreleased('# Changelog\n\n## 2026-05-06\n\n- First\n', { date: '2026-11-03' })).toThrow('no "## [Unreleased]"');
    expect(() => stampUnreleased(SAMPLE, { date: '03/11/2026' })).toThrow('YYYY-MM-DD');
    expect(() => stampUnreleased(SAMPLE, { date: '2026-10-31' })).toThrow('older than the newest section, 2026-11-01');
  });
});

describe('changelogDates', () => {
  it('lists dated sections newest first', () => {
    expect(changelogDates(SAMPLE)).toEqual(['2026-11-01', '2026-05-06']);
  });

  it('rejects version headings, duplicates, and dates out of order', () => {
    expect(() => changelogDates('## [0.1.0] - 2026-05-06\n\n- First\n')).toThrow('Expected "## YYYY-MM-DD"');
    expect(() => changelogDates('## 2026-05-06\n\n## 2026-05-06\n')).toThrow('newest first');
    expect(() => changelogDates('## 2026-05-06\n\n## 2026-11-01\n')).toThrow('newest first');
  });
});

describe('this repository', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

  it('keeps an Unreleased section and dated sections newest first', () => {
    expect(changelog).toMatch(/^## \[Unreleased\]\r?$/m);
    expect(changelogDates(changelog).length).toBeGreaterThan(0);
  });

  it('refuses an invalid date from the CLI before changing CHANGELOG.md', () => {
    const file = join(ROOT, 'CHANGELOG.md');
    const before = readFileSync(file);
    try {
      let failure;
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts', 'stamp-changelog.mjs'), '--date', '2026-1-2'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        failure = err;
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain('Expected a YYYY-MM-DD date, got "2026-1-2"');
      expect(readFileSync(file).equals(before), 'CHANGELOG.md changed').toBe(true);
    } finally {
      // Restore the file if a regression ever lets the command write it.
      if (!readFileSync(file).equals(before)) writeFileSync(file, before);
    }
  });
});
