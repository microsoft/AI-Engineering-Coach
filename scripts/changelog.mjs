/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* Pure helpers for the changelog. CHANGELOG.md holds the dated history ("## YYYY-MM-DD", newest
 * first, Keep a Changelog 2.0.0 types). Each pull request adds a fragment, changelog.d/<name>.md,
 * and renderChangelog merges the fragments into that history under the date each one reached
 * main, or under "## [Unreleased]" when it hasn't yet. scripts/build-changelog.mjs reads the
 * files and the dates from git. */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_REFERENCE = /^\[([^\]]+)\]:\s*\S/;
export const CHANGE_TYPES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

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

/** @param {string} value */
function isDate(value) {
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The dated sections of CHANGELOG.md in file order, after checking that every "## " heading is a
 * valid YYYY-MM-DD date, used once, newest first.
 * @param {string} text CHANGELOG.md contents
 * @returns {string[]}
 */
export function changelogDates(text) {
  const dates = [];
  for (const { title } of outline(text).sections) {
    if (!isDate(title)) throw new Error(`Expected "## YYYY-MM-DD" in CHANGELOG.md, got "## ${title}"`);
    const previous = dates.at(-1);
    if (previous !== undefined && title >= previous) {
      throw new Error(`Dated sections must be unique and newest first: "## ${title}" follows "## ${previous}"`);
    }
    dates.push(title);
  }
  return dates;
}

/**
 * Checks a changelog fragment: one or more "### Type" headings from Keep a Changelog, each with
 * bullet entries, and nothing else.
 * @param {string} name file name, for error messages
 * @param {string} text
 * @returns {Map<string, string[]>} entries by type
 */
export function parseFragment(name, text) {
  const groups = groupByType(text.split(/\r?\n/));
  if (groups.has('')) throw new Error(`${name}: put every entry under a "### Type" heading (${CHANGE_TYPES.join(', ')})`);
  for (const type of groups.keys()) {
    if (!CHANGE_TYPES.includes(type)) throw new Error(`${name}: unknown type "### ${type}"; use ${CHANGE_TYPES.join(', ')}`);
  }
  if (groups.size === 0) throw new Error(`${name}: has no entries`);
  return groups;
}

/** @param {string} type */
function rank(type) {
  if (type === '') return -1;
  const position = CHANGE_TYPES.indexOf(type);
  return position < 0 ? CHANGE_TYPES.length : position;
}

/**
 * @param {string} title
 * @param {Map<string, string[]>[]} parts merged in order, type by type
 */
function renderSection(title, parts) {
  /** @type {Map<string, string[]>} */
  const merged = new Map();
  for (const part of parts) {
    for (const [type, entries] of part) merged.set(type, [...(merged.get(type) ?? []), ...entries]);
  }
  const lines = [`## ${title}`];
  for (const type of [...merged.keys()].sort((a, b) => rank(a) - rank(b))) {
    lines.push('');
    if (type) lines.push(`### ${type}`, '');
    lines.push(...(merged.get(type) ?? []));
  }
  return lines;
}

/**
 * @typedef {object} Fragment
 * @property {string} name file name in changelog.d
 * @property {string} text contents
 * @property {string} [date] YYYY-MM-DD when it reached main; undefined while it hasn't
 */

/**
 * The full changelog: the history in CHANGELOG.md with every fragment merged in. Fragments
 * without a date go under "## [Unreleased]" on top; dated ones join the section for their date.
 * Within a date and type, history entries come first, then fragments in the given order.
 * @param {string} history CHANGELOG.md contents
 * @param {Fragment[]} fragments
 */
export function renderChangelog(history, fragments) {
  changelogDates(history);
  const { eol, lines, sections, refsStart } = outline(history);
  const preamble = trimBlankLines(lines.slice(0, sections[0]?.start ?? refsStart));
  /** @type {Map<string, Map<string, string[]>[]>} */
  const byDate = new Map();
  for (const section of sections) byDate.set(section.title, [groupByType(lines.slice(section.start + 1, section.end))]);
  /** @type {Map<string, string[]>[]} */
  const unreleased = [];
  for (const fragment of fragments) {
    const groups = parseFragment(fragment.name, fragment.text);
    if (fragment.date === undefined) {
      unreleased.push(groups);
      continue;
    }
    if (!isDate(fragment.date)) throw new Error(`${fragment.name}: expected a YYYY-MM-DD date, got "${fragment.date}"`);
    byDate.set(fragment.date, [...(byDate.get(fragment.date) ?? []), groups]);
  }
  const rendered = [];
  if (unreleased.length > 0) rendered.push(renderSection('[Unreleased]', unreleased));
  for (const date of [...byDate.keys()].sort().reverse()) rendered.push(renderSection(date, byDate.get(date) ?? []));
  const refs = trimBlankLines(lines.slice(refsStart));
  return [
    ...preamble,
    ...rendered.flatMap(section => ['', ...section]),
    ...(refs.length > 0 ? ['', ...refs] : []),
    '',
  ].join(eol);
}
