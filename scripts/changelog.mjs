/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* Pure helpers for CHANGELOG.md, which follows Keep a Changelog 2.0.0 but groups changes by the
 * date they reached main ("## YYYY-MM-DD", newest first) instead of by version. Pull requests add
 * entries under "## [Unreleased]"; stampUnreleased moves them under a date. scripts/stamp-changelog.mjs
 * does the file I/O. */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_REFERENCE = /^\[([^\]]+)\]:\s*\S/;
const TYPE_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

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
  /** @type {{ key: string, title: string, start: number, end: number }[]} */
  const sections = [];
  for (let i = 0; i < refsStart; i++) {
    const match = /^## (.*)$/.exec(lines[i]);
    if (match) sections.push({ key: sectionKey(match[1].trim()), title: match[1].trim(), start: i, end: refsStart });
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
 * Groups a section body by its "### Type" headings; entries before the first heading go under "".
 * Headings without entries, such as an unused "### Deprecated", are dropped.
 * @param {string[]} lines
 * @returns {Map<string, string[]>}
 */
function groupByType(lines) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  let type = '';
  for (const line of lines) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      type = heading[1].trim();
      continue;
    }
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)?.push(line);
  }
  for (const [key, entries] of groups) {
    const trimmed = trimBlankLines(entries);
    if (hasEntries(trimmed.join('\n')) || (key === '' && trimmed.length > 0)) groups.set(key, trimmed);
    else groups.delete(key);
  }
  return groups;
}

/**
 * Dated sections in file order, after checking that every "## " heading other than
 * "[Unreleased]" is a valid YYYY-MM-DD date, used once, newest first.
 * @param {string} text CHANGELOG.md contents
 * @returns {string[]}
 */
export function changelogDates(text) {
  const dates = [];
  for (const { key, title } of outline(text).sections) {
    if (key === 'unreleased') continue;
    if (!DATE.test(title) || Number.isNaN(Date.parse(`${title}T00:00:00Z`))) {
      throw new Error(`Expected "## YYYY-MM-DD" or "## [Unreleased]", got "## ${title}"`);
    }
    const previous = dates.at(-1);
    if (previous !== undefined && title >= previous) {
      throw new Error(`Dated sections must be unique and newest first: "## ${title}" follows "## ${previous}"`);
    }
    dates.push(title);
  }
  return dates;
}

/**
 * Moves the [Unreleased] notes under "## date" and leaves an empty [Unreleased] section on top.
 * When that date already has a section, the notes join it, type by type.
 * @param {string} text CHANGELOG.md contents
 * @param {{ date: string }} options
 */
export function stampUnreleased(text, { date }) {
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  const latest = changelogDates(text)[0];
  if (latest !== undefined && date < latest) throw new Error(`${date} is older than the newest section, ${latest}`);
  const { eol, lines, sections, refsStart } = outline(text);
  const index = sections.findIndex(s => s.key === 'unreleased');
  if (index < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const unreleased = sections[index];
  const pending = groupByType(lines.slice(unreleased.start + 1, unreleased.end));
  if (!hasEntries([...pending.values()].flat().join('\n'))) {
    throw new Error('Nothing to stamp: add entries under "## [Unreleased]" first');
  }

  const sameDay = sections.find(s => s.title === date);
  const merged = sameDay ? groupByType(lines.slice(sameDay.start + 1, sameDay.end)) : new Map();
  for (const [type, entries] of pending) merged.set(type, [...(merged.get(type) ?? []), ...entries]);
  const types = [...merged.keys()].sort((a, b) => rank(a) - rank(b));
  /** @type {string[]} */
  const dated = [`## ${date}`];
  for (const type of types) {
    dated.push('');
    if (type) dated.push(`### ${type}`, '');
    dated.push(...(merged.get(type) ?? []));
  }

  const rest = sections.filter(s => s !== unreleased && s !== sameDay);
  const older = rest.flatMap(s => ['', ...trimBlankLines(lines.slice(s.start, s.end))]);
  const refs = trimBlankLines(lines.slice(refsStart));
  return [
    ...trimBlankLines(lines.slice(0, unreleased.start)),
    '',
    '## [Unreleased]',
    '',
    ...dated,
    ...older,
    ...(refs.length > 0 ? ['', ...refs] : []),
    '',
  ].join(eol);

  /** @param {string} type */
  function rank(type) {
    if (type === '') return -1;
    const position = TYPE_ORDER.indexOf(type);
    return position < 0 ? TYPE_ORDER.length : position;
  }
}
