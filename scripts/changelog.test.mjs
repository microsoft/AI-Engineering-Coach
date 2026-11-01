/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  extractReleaseNotes,
  isPreRelease,
  nextVersion,
  releaseUnreleased,
  repositoryUrl,
  setLockfileVersion,
  setManifestVersion,
} from './changelog.mjs';

const ROOT = join(import.meta.dirname, '..');
const REPO = 'https://github.com/owner/repo';

const SAMPLE = [
  '# Changelog',
  '',
  'All notable changes are documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- A new view (#2)',
  '',
  '### Deprecated',
  '',
  '### Fixed',
  '',
  '- A crash on start (#3)',
  '',
  '## [0.1.0] - 2026-05-06',
  '',
  '### Added',
  '',
  '- First release',
  '',
  '[Unreleased]: https://github.com/owner/repo/commits/main',
  '[0.1.0]: https://github.com/owner/repo/tree/abc1234',
  '',
].join('\n');

const RELEASED = [
  '# Changelog',
  '',
  'All notable changes are documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '## [0.2.0] - 2026-11-03',
  '',
  '### Added',
  '',
  '- A new view (#2)',
  '',
  '### Fixed',
  '',
  '- A crash on start (#3)',
  '',
  '## [0.1.0] - 2026-05-06',
  '',
  '### Added',
  '',
  '- First release',
  '',
  '[Unreleased]: https://github.com/owner/repo/compare/v0.2.0...HEAD',
  '[0.2.0]: https://github.com/owner/repo/releases/tag/v0.2.0',
  '[0.1.0]: https://github.com/owner/repo/tree/abc1234',
  '',
].join('\n');

describe('nextVersion', () => {
  it('bumps major, minor, and patch', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.3', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.9.3', 'major')).toBe('1.0.0');
  });

  it('accepts an explicit, greater major.minor.patch version', () => {
    expect(nextVersion('0.1.0', '0.4.0')).toBe('0.4.0');
    expect(() => nextVersion('0.2.0', '0.2.0')).toThrow('must be greater than 0.2.0');
    expect(() => nextVersion('0.2.0', '0.1.9')).toThrow('must be greater');
  });

  it('rejects pre-release suffixes and unknown bumps', () => {
    expect(() => nextVersion('0.1.0', '0.2.0-beta.1')).toThrow('Expected patch, minor, major');
    expect(() => nextVersion('0.1.0', 'Minor')).toThrow('Expected patch, minor, major');
    expect(() => nextVersion('0.1.0-dev', 'minor')).toThrow('Expected a major.minor.patch version');
  });

  it('rejects versions with leading zeros, which are not Semantic Versioning and vsce refuses', () => {
    for (const padded of ['0.02.0', '01.0.0', '0.1.00', '00.1.0']) {
      expect(() => nextVersion('0.1.0', padded)).toThrow(`without leading zeros, got "${padded}"`);
    }
    expect(() => nextVersion('0.01.0', 'minor')).toThrow('without leading zeros, got "0.01.0"');
    expect(() => isPreRelease('0.03.0')).toThrow('without leading zeros');
    expect(nextVersion('9.0.0', '10.0.0')).toBe('10.0.0');
    expect(nextVersion('0.9.9', '0.10.0')).toBe('0.10.0');
  });
});

describe('version helpers', () => {
  it('compares numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats odd minor versions as pre-releases', () => {
    expect(isPreRelease('0.2.0')).toBe(false);
    expect(isPreRelease('0.3.1')).toBe(true);
    expect(isPreRelease('1.10.0')).toBe(false);
  });

  it('derives the repository URL from package.json', () => {
    expect(repositoryUrl({ repository: { url: 'https://github.com/microsoft/AI-Engineering-Coach.git' } }))
      .toBe('https://github.com/microsoft/AI-Engineering-Coach');
    expect(repositoryUrl({ repository: 'git+https://github.com/owner/repo/' })).toBe(REPO);
    expect(() => repositoryUrl({})).toThrow('no repository URL');
  });
});

describe('releaseUnreleased', () => {
  it('moves Unreleased into a dated section, drops empty types, and links the new tag', () => {
    expect(releaseUnreleased(SAMPLE, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO })).toBe(RELEASED);
  });

  it('links a compare view when the previous version was tagged', () => {
    const result = releaseUnreleased(SAMPLE, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO, hasTag: tag => tag === 'v0.1.0' });
    expect(result).toContain('[0.2.0]: https://github.com/owner/repo/compare/v0.1.0...v0.2.0\n');
  });

  it('keeps Windows line endings', () => {
    const result = releaseUnreleased(SAMPLE.replaceAll('\n', '\r\n'), { version: '0.2.0', date: '2026-11-03', repoUrl: REPO });
    expect(result).toBe(RELEASED.replaceAll('\n', '\r\n'));
  });

  it('accepts the unbracketed Unreleased heading and a changelog with no releases yet', () => {
    const text = '# Changelog\n\n## Unreleased\n\n- Initial work\n';
    expect(releaseUnreleased(text, { version: '0.1.0', date: '2026-01-02', repoUrl: REPO })).toBe([
      '# Changelog', '', '## [Unreleased]', '', '## [0.1.0] - 2026-01-02', '', '- Initial work', '',
      '[Unreleased]: https://github.com/owner/repo/compare/v0.1.0...HEAD',
      '[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0', '',
    ].join('\n'));
  });

  it('refuses to release without entries, twice, or with a bad date', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [0.1.0] - 2026-05-06\n\n- First\n';
    expect(() => releaseUnreleased(empty, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO })).toThrow('Nothing to release');
    expect(() => releaseUnreleased(RELEASED, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO })).toThrow('already has a section');
    expect(() => releaseUnreleased('# Changelog\n', { version: '0.2.0', date: '2026-11-03', repoUrl: REPO })).toThrow('no "## [Unreleased]"');
    expect(() => releaseUnreleased(SAMPLE, { version: '0.2.0', date: '03/11/2026', repoUrl: REPO })).toThrow('YYYY-MM-DD');
  });
});

describe('extractReleaseNotes', () => {
  it('returns the section body without its heading, other sections, or link references', () => {
    expect(extractReleaseNotes(RELEASED, '0.2.0')).toBe('### Added\n\n- A new view (#2)\n\n### Fixed\n\n- A crash on start (#3)');
    expect(extractReleaseNotes(RELEASED, '0.1.0')).toBe('### Added\n\n- First release');
  });

  it('fails when the version has no section or no entries', () => {
    expect(() => extractReleaseNotes(RELEASED, '0.3.0')).toThrow('no "## [0.3.0]" section');
    expect(() => extractReleaseNotes('## [0.3.0] - 2026-12-01\n\n### Added\n', '0.3.0')).toThrow('has no entries');
    expect(() => extractReleaseNotes(RELEASED, 'v0.2.0')).toThrow('major.minor.patch');
  });
});

describe('package version files', () => {
  /** Pairs of [before, after] for each line that differs; both texts must have the same line count. */
  function changedLines(before, after) {
    const a = before.split(/\r?\n/);
    const b = after.split(/\r?\n/);
    expect(b).toHaveLength(a.length);
    return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]]));
  }

  it('changes only the top-level version line of this repository\'s package.json', () => {
    const text = readFileSync(join(ROOT, 'package.json'), 'utf8');
    const { version } = JSON.parse(text);
    const next = nextVersion(version, 'minor');
    expect(changedLines(text, setManifestVersion(text, version, next)))
      .toEqual([[`  "version": "${version}",`, `  "version": "${next}",`]]);
  });

  it('changes only the two root versions of this repository\'s package-lock.json', () => {
    const text = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
    const { version } = JSON.parse(text);
    const changes = changedLines(text, setLockfileVersion(text, version, '9.9.9'));
    expect(changes).toEqual([[`  "version": "${version}",`, '  "version": "9.9.9",'], [`      "version": "${version}",`, '      "version": "9.9.9",']]);
  });

  it('keeps Windows line endings in package-lock.json', () => {
    const lock = '{\r\n  "name": "x",\r\n  "version": "0.1.0",\r\n  "packages": {\r\n    "": {\r\n      "version": "0.1.0"\r\n    }\r\n  }\r\n}\r\n';
    expect(setLockfileVersion(lock, '0.1.0', '0.2.0')).toBe(lock.replaceAll('0.1.0', '0.2.0'));
  });

  it('refuses unexpected versions and nested version keys', () => {
    expect(() => setManifestVersion('{ "version": "0.3.0" }', '0.1.0', '0.2.0')).toThrow('package.json version is 0.3.0');
    expect(() => setLockfileVersion('{ "version": "0.1.0", "packages": {} }', '0.1.0', '0.2.0')).toThrow('package-lock.json version is not 0.1.0');
    const nested = '{\n  "name": "x",\n  "engines": {\n    "version": "0.1.0"\n  },\n  "version": "0.1.0"\n}\n';
    expect(() => setManifestVersion(nested, '0.1.0', '0.2.0')).toThrow('Could not change only the top-level version');
    expect(() => setManifestVersion('{ "version": "0.1.0" }', '0.1.0', '0.2.0-beta')).toThrow('major.minor.patch');
    expect(() => setManifestVersion('{ "version": "0.1.0" }', '0.1.0', '0.02.0')).toThrow('without leading zeros');
  });
});

describe('this repository', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

  it('uses a Marketplace-compatible major.minor.patch version', () => {
    expect(pkg.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });

  it('documents the packaged version and keeps an Unreleased section', () => {
    expect(extractReleaseNotes(changelog, pkg.version)).not.toBe('');
    expect(changelog).toMatch(/^## \[Unreleased\]\r?$/m);
  });

  it('prints the release notes for the packaged version from the CLI', () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'notes', pkg.version], { encoding: 'utf8' });
    expect(output).toBe(`${extractReleaseNotes(changelog, pkg.version)}\n`);
  });

  it('refuses an invalid release version before changing any file', () => {
    const files = ['package.json', 'package-lock.json', 'CHANGELOG.md'].map(name => join(ROOT, name));
    const before = files.map(file => readFileSync(file));
    try {
      let failure;
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts', 'release.mjs'), 'prepare', '0.02.0'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        failure = err;
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain('without leading zeros, got "0.02.0"');
      files.forEach((file, i) => expect(readFileSync(file).equals(before[i]), `${file} changed`).toBe(true));
    } finally {
      // Restore the files if a regression ever lets the command write them.
      files.forEach((file, i) => { if (!readFileSync(file).equals(before[i])) writeFileSync(file, before[i]); });
    }
  });
});
