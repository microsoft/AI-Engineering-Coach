/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Release helper (see skills/cut-release.md):
 *   npm run release:prepare -- <patch|minor|major|X.Y.Z> [--date YYYY-MM-DD]
 *     moves the [Unreleased] notes into a dated section and sets the new version in
 *     package.json and package-lock.json. Committing, tagging, and publishing stay manual.
 *   npm run release:notes -- <X.Y.Z>
 *     prints one version's notes; .github/workflows/release.yml uses them as the release body. */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  extractReleaseNotes, isPreRelease, nextVersion, releaseUnreleased, repositoryUrl, setLockfileVersion, setManifestVersion,
} from './changelog.mjs';

const ROOT = join(import.meta.dirname, '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const MANIFEST = join(ROOT, 'package.json');
const LOCKFILE = join(ROOT, 'package-lock.json');
const USAGE = [
  'Usage: npm run release:prepare -- <patch|minor|major|X.Y.Z> [--date YYYY-MM-DD]',
  '       npm run release:notes -- <X.Y.Z>',
].join('\n');

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

/** @param {string} tag */
function hasTag(tag) {
  try {
    git(['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function today() {
  const now = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** @param {string[]} args */
function prepare(args) {
  const [bump, ...options] = args;
  if (!bump) throw new Error(USAGE);
  let date = today();
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--date' && options[i + 1]) date = options[++i];
    else throw new Error(`Unknown option "${options[i]}"\n${USAGE}`);
  }
  const manifestText = readFileSync(MANIFEST, 'utf8');
  const pkg = JSON.parse(manifestText);
  // Validate everything and compute every file before writing any, so bad input or a failure
  // leaves nothing half-done.
  const version = nextVersion(pkg.version, bump);
  const changelog = releaseUnreleased(readFileSync(CHANGELOG, 'utf8'), { version, date, repoUrl: repositoryUrl(pkg), hasTag });
  const manifest = setManifestVersion(manifestText, pkg.version, version);
  const lockfile = setLockfileVersion(readFileSync(LOCKFILE, 'utf8'), pkg.version, version);
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Commit or stash your changes first: release:prepare needs a clean working tree.');
  }
  writeFileSync(MANIFEST, manifest);
  writeFileSync(LOCKFILE, lockfile);
  writeFileSync(CHANGELOG, changelog);
  console.log([
    '',
    `Prepared v${version}${isPreRelease(version) ? ' (odd minor version: published as a pre-release)' : ''}:`,
    `  package.json and package-lock.json: ${pkg.version} -> ${version}`,
    `  CHANGELOG.md: [Unreleased] moved to [${version}] - ${date}`,
    '',
    'Next:',
    '  1. Review the notes in CHANGELOG.md, then commit:',
    `       git commit -am "chore(release): v${version}"`,
    `  2. Open a pull request to main. CI packages and tests ai-engineer-coach-${version}.vsix.`,
    '  3. After it merges, tag the merge commit and push the tag to run .github/workflows/release.yml:',
    `       git tag -a v${version} -m "v${version}" <merge-commit> && git push origin v${version}`,
  ].join('\n'));
}

/** @param {string[]} args */
function notes(args) {
  if (args.length !== 1) throw new Error(USAGE);
  process.stdout.write(`${extractReleaseNotes(readFileSync(CHANGELOG, 'utf8'), args[0])}\n`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare') prepare(args);
  else if (command === 'notes') notes(args);
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
