/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Session names and branches as a harness logged them, made safe to display: links, email addresses, drive and
 * home paths, and the user's own names (OS account, GitHub handles) are removed. Browser-safe: no Node imports. */

/** What to remove from a label: the user's home directory and the names that identify them. */
export interface ScrubContext {
  /** Home directory, replaced by `~` (after drive paths are replaced). */
  home?: string;
  /** OS user name and GitHub handles. Names shorter than 3 characters are ignored, so short words survive. */
  names: string[];
}

const MAX_NAME = 90;
const MAX_BRANCH = 60;
const MIN_NAME = 3;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usableNames(ctx: ScrubContext): string[] {
  return [...new Set(ctx.names.map(name => name.trim()).filter(name => name.length >= MIN_NAME))]
    .sort((a, b) => b.length - a.length);
}

function removeNames(value: string, names: string[]): string {
  let out = value;
  for (const name of names) {
    const n = escapeRegExp(name);
    // `handle/repo`, `handle-topic` and `handle_topic` keep what follows; a standalone name goes.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${n}[/_-](?=[A-Za-z0-9])`, 'gi'), '$1');
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, 'gi'), '$1');
  }
  return out;
}

function tidy(value: string): string {
  return value.replaceAll(/\s+/g, ' ').replaceAll(/^[\s/_\-:·,]+|[\s/_\-:·,]+$/g, '').trim();
}

/** A label without links, email addresses, drive or UNC paths, the home directory or the user's names. */
export function scrubLabel(value: string, ctx: ScrubContext, max = MAX_NAME): string {
  let out = value
    .replaceAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replaceAll(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s,;)"'`]*/g, '[path]');
  if (ctx.home && ctx.home.length > 1) {
    const home = ctx.home.replace(/[\\/]+$/, '');
    const variants = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')]);
    for (const variant of variants) out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  out = out.replaceAll(/(^|[\s("'`])\/(?:Users|home)\/[^\s,;)"'`]*/g, '$1[path]');
  out = tidy(removeNames(out, usableNames(ctx)));
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}

/** A branch without the user's handle prefix (`handle/topic`, `handle-topic`) and scrubbed like a label. */
export function scrubBranch(value: string, ctx: ScrubContext): string {
  let out = value.trim();
  for (const name of usableNames(ctx)) {
    out = out.replace(new RegExp(`^${escapeRegExp(name)}[/_-]`, 'i'), '');
  }
  return scrubLabel(out, ctx, MAX_BRANCH);
}

/** Branch prefixes that name a kind of work or a bot, never a person. */
const COMMON_PREFIXES = new Set([
  'feat', 'feature', 'features', 'fix', 'fixes', 'bugfix', 'hotfix', 'docs', 'doc', 'chore', 'refactor', 'test', 'tests',
  'release', 'releases', 'copilot', 'dependabot', 'renovate', 'main', 'master', 'dev', 'develop', 'user', 'users', 'wip',
  'build', 'ci', 'perf', 'style', 'revert', 'update', 'add', 'experiment', 'exp', 'spike', 'topic', 'bump', 'deps', 'gh', 'pr',
]);

/** A personal prefix most branches share (`handle-topic`, `handle/topic`), as tools that create branches for you add
 *  the user's handle. Null unless at least 3 branches and 30% of them share it. */
export function inferBranchOwner(branches: readonly string[]): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const branch of branches) {
    const token = /^([A-Za-z0-9][A-Za-z0-9_.]*)[/-][A-Za-z0-9]/.exec(branch.trim())?.[1]?.toLowerCase();
    if (!token) continue;
    total++;
    if (token.length >= MIN_NAME && !COMMON_PREFIXES.has(token) && !/^\d+$/.test(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 3 && top[1] >= 0.3 * total ? top[0] : null;
}

/** Short harness label for chips and filters: `GitHub Copilot App` → `Copilot App`, `Claude` → `Claude Code`. */
export function harnessLabel(harness: string): string {
  if (/^claude$/i.test(harness)) return 'Claude Code';
  return harness.replace(/^GitHub Copilot /, 'Copilot ');
}

/** The last segment of a path or `owner/name`, whichever separator it uses. Never a whole path. */
export function lastSegment(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
