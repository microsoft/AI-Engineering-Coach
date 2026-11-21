/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* Builds the dated changelog from CHANGELOG.md and the fragments in changelog.d/. A fragment's
 * date is the UTC day of the main commit that added it (the merge or squash commit), read from
 * git, so nothing has to be stamped or committed after a merge. Fragments that aren't on main
 * yet, or whose date git can't tell (no main branch, shallow clone), go under [Unreleased].
 *   npm run changelog [-- --out <file>]   prints the changelog, or writes it to <file>
 * scripts/package-readme-swap.mjs packages the result as the VSIX changelog. */

import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { renderChangelog } from './changelog.mjs';

export const FRAGMENT_DIR = 'changelog.d';
const BASE_REFS = ['origin/main', 'main'];

/** @param {string} cwd */
function gitRunner(cwd) {
  /** @param {string[]} args */
  return args => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
    } catch {
      return undefined;
    }
  };
}

/**
 * When each fragment reached main: "changelog.d/<name>.md" → YYYY-MM-DD (UTC), from the first-parent
 * history of origin/main (or main). `reason` explains why there are no dates at all.
 * @param {(args: string[]) => string | undefined} run
 * @returns {{ dates: Map<string, string>, reason?: string }}
 */
export function fragmentDates(run) {
  const shallow = run(['rev-parse', '--is-shallow-repository']);
  if (shallow === undefined) return { dates: new Map(), reason: 'git is unavailable' };
  if (shallow === 'true') return { dates: new Map(), reason: 'the clone is shallow; fetch the full history' };
  const base = BASE_REFS.find(ref => run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined);
  if (!base) return { dates: new Map(), reason: `there is no ${BASE_REFS.join(' or ')} branch` };
  const log = run([
    'log', base, '--first-parent', '--diff-merges=first-parent', '--diff-filter=A', '--no-renames',
    '--name-only', '--format=@%ct', '--', `${FRAGMENT_DIR}/`,
  ]) ?? '';
  /** @type {Map<string, string>} */
  const dates = new Map();
  let date = '';
  // Newest first: a file added, deleted and added again keeps the date it was first added.
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('@')) date = new Date(Number(line.slice(1)) * 1000).toISOString().slice(0, 10);
    else if (line.trim() && date) dates.set(line.trim(), date);
  }
  return { dates };
}

/**
 * Fragment file names in changelog.d, sorted; README.md documents the folder and isn't one.
 * @param {string} root
 */
export function listFragments(root) {
  let names;
  try {
    names = readdirSync(join(root, FRAGMENT_DIR));
  } catch {
    return [];
  }
  return names.filter(name => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort();
}

/**
 * The dated changelog for the checkout at `root`.
 * @param {{ root?: string, run?: (args: string[]) => string | undefined, warn?: (message: string) => void }} [options]
 */
export function buildChangelog({ root = join(import.meta.dirname, '..'), run = gitRunner(root), warn = console.warn } = {}) {
  const names = listFragments(root);
  const { dates, reason } = names.length > 0 ? fragmentDates(run) : { dates: new Map() };
  if (reason) warn(`Changelog fragments are listed as [Unreleased]: ${reason}.`);
  const fragments = names
    .map(name => ({
      name,
      text: readFileSync(join(root, FRAGMENT_DIR, name), 'utf8'),
      date: dates.get(`${FRAGMENT_DIR}/${name}`),
    }))
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.name.localeCompare(b.name));
  return renderChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), fragments);
}

/** @param {string[]} args */
function main(args) {
  let out;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else throw new Error(`Unknown option "${args[i]}"\nUsage: npm run changelog [-- --out <file>]`);
  }
  const text = buildChangelog({ warn: message => console.error(message) });
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
