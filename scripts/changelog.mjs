/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Pure helpers for CHANGELOG.md in Keep a Changelog 2.0.0 format: compute the next version,
 * move the [Unreleased] notes into a dated release section, and extract one release's notes.
 * scripts/release.mjs does the file and git I/O. */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_REFERENCE = /^\[([^\]]+)\]:\s*\S/;

/**
 * @param {string} version
 * @returns {number[]}
 */
function parseVersion(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Expected a major.minor.patch version, got "${version}"`);
  return match.slice(1).map(Number);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The next release version. Only `major.minor.patch` is allowed, because the VS Code
 * Marketplace rejects pre-release suffixes such as `-beta`.
 * @param {string} current
 * @param {string} bump "patch", "minor", "major", or an explicit major.minor.patch version
 */
export function nextVersion(current, bump) {
  const [major, minor, patch] = parseVersion(current);
  /** @type {string} */
  let next;
  if (bump === 'major') next = `${major + 1}.0.0`;
  else if (bump === 'minor') next = `${major}.${minor + 1}.0`;
  else if (bump === 'patch') next = `${major}.${minor}.${patch + 1}`;
  else if (VERSION.test(bump)) next = bump;
  else throw new Error(`Expected patch, minor, major, or a major.minor.patch version, got "${bump}"`);
  if (compareVersions(next, current) <= 0) throw new Error(`The new version ${next} must be greater than ${current}`);
  return next;
}

/**
 * True when the minor version is odd, which marks a pre-release.
 * @param {string} version
 */
export function isPreRelease(version) {
  return parseVersion(version)[1] % 2 === 1;
}

/** @param {string} title text after "## " */
function sectionKey(title) {
  const match = /^\[?([^\]\s]+)\]?/.exec(title);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Splits the changelog into lines, "## " sections, and the trailing link-reference block.
 * @param {string} text
 */
function outline(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let refsStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue;
    if (!LINK_REFERENCE.test(lines[i])) break;
    refsStart = i;
  }
  /** @type {{ key: string, start: number, end: number }[]} */
  const sections = [];
  for (let i = 0; i < refsStart; i++) {
    const match = /^## (.*)$/.exec(lines[i]);
    if (match) sections.push({ key: sectionKey(match[1].trim()), start: i, end: refsStart });
  }
  for (let i = 0; i + 1 < sections.length; i++) sections[i].end = sections[i + 1].start;
  return { eol, lines, sections, refsStart };
}

/** @param {string} body */
function hasEntries(body) {
  return /^\s*[-*] \S/m.test(body);
}

/** @param {string[]} lines */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * Drops "### Type" headings that have no entries, such as an unused "### Deprecated".
 * @param {string[]} lines
 */
function dropEmptySubsections(lines) {
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) {
      let next = i + 1;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (next === lines.length || lines[next].startsWith('### ')) {
        i = next - 1;
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return kept;
}

/**
 * Notes for one released version: the body of its "## [X.Y.Z]" section, without the heading.
 * @param {string} text CHANGELOG.md contents
 * @param {string} version
 */
export function extractReleaseNotes(text, version) {
  parseVersion(version);
  const { lines, sections } = outline(text);
  const section = sections.find(s => s.key === version);
  if (!section) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const body = trimBlankLines(lines.slice(section.start + 1, section.end)).join('\n');
  if (!hasEntries(body)) throw new Error(`The CHANGELOG.md section for ${version} has no entries`);
  return body;
}

/**
 * Moves the [Unreleased] notes into "## [version] - date", leaves an empty [Unreleased]
 * section on top, and points the link references at the new tag.
 * @param {string} text CHANGELOG.md contents
 * @param {{ version: string, date: string, repoUrl: string, hasTag?: (tag: string) => boolean }} release
 */
export function releaseUnreleased(text, { version, date, repoUrl, hasTag = () => false }) {
  parseVersion(version);
  if (!DATE.test(date)) throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  const { eol, lines, sections, refsStart } = outline(text);
  const index = sections.findIndex(s => s.key === 'unreleased');
  if (index < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (sections.some(s => s.key === version)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const unreleased = sections[index];
  const body = trimBlankLines(dropEmptySubsections(lines.slice(unreleased.start + 1, unreleased.end)));
  if (!hasEntries(body.join('\n'))) throw new Error('Nothing to release: add entries under "## [Unreleased]" first');

  const previous = sections.slice(index + 1).map(s => s.key).find(key => VERSION.test(key));
  const releaseLink = previous && hasTag(`v${previous}`)
    ? `${repoUrl}/compare/v${previous}...v${version}`
    : `${repoUrl}/releases/tag/v${version}`;
  const otherRefs = lines.slice(refsStart).filter(line => {
    const match = LINK_REFERENCE.exec(line);
    return match && !['unreleased', version].includes(match[1].toLowerCase());
  });
  const olderSections = trimBlankLines(lines.slice(unreleased.end, refsStart));

  return [
    ...lines.slice(0, unreleased.start),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    '',
    ...body,
    '',
    ...(olderSections.length > 0 ? [...olderSections, ''] : []),
    `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`,
    `[${version}]: ${releaseLink}`,
    ...otherRefs,
    '',
  ].join(eol);
}

/**
 * The repository web URL from package.json's `repository` field.
 * @param {{ repository?: string | { url?: string } }} pkg
 */
export function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) throw new Error('package.json has no repository URL');
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}
