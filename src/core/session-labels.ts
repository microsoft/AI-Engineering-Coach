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
  /** OS user name and GitHub handles. Names shorter than 3 characters and generic account names (`vscode`, `root`,
   *  `runner`…) are ignored, so ordinary words survive. */
  names: string[];
  /** GitHub handles the user signed in with: the only branch prefixes removed (`handle/topic`). */
  handles?: string[];
}

const MAX_NAME = 90;
const MAX_BRANCH = 60;
const MIN_NAME = 3;

/** Account names shared by many machines and containers: they say nothing about the user and are ordinary words in
 *  names and repositories, so they are never removed. */
const GENERIC_ACCOUNTS = new Set([
  'vscode', 'codespace', 'codespaces', 'node', 'root', 'runner', 'ubuntu', 'user', 'users', 'admin', 'administrator',
  'developer', 'default', 'guest', 'vagrant', 'azureuser', 'docker', 'app', 'coder', 'gitpod', 'test', 'owner', 'home',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usableNames(names: readonly string[]): string[] {
  return [...new Set(names.map(name => name.trim()).filter(name => name.length >= MIN_NAME && !GENERIC_ACCOUNTS.has(name.toLowerCase())))]
    .sort((a, b) => b.length - a.length);
}

/** The names removed, or with `mark` replaced where they stand (in a branch, so `name/topic` doesn't pass for `topic`). */
function removeNames(value: string, names: string[], mark = ''): string {
  let out = value;
  for (const name of names) {
    const n = escapeRegExp(name);
    if (mark) {
      // `_` separates words here too: `name_topic` reads `[name]_topic`.
      out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${n}(?![A-Za-z0-9])`, 'gi'), `$1${mark}`);
      continue;
    }
    // `handle/repo`, `handle-topic` and `handle_topic` keep what follows; a standalone name goes.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${n}[/_-](?=[A-Za-z0-9])`, 'gi'), '$1');
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, 'gi'), '$1');
  }
  return out;
}

function tidy(value: string): string {
  return value.replaceAll(/\s+/g, ' ').replaceAll(/^[\s/_\-:·,]+|[\s/_\-:·,]+$/g, '').trim();
}

/** An unquoted drive or network path to the end of its clause. */
const DRIVE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\)[^,;)"'`\n]*/g;
/** A word that starts a drive or network path. */
const DRIVE_START = /^[("'`]?(?:[A-Za-z]:[\\/]|\\\\)/;

/** Words that join two paths in one clause (`a and b`, `a to b`): kept between them. */
const PATH_JOINERS = new Set(['and', 'or', 'to', 'from', 'into', 'onto', 'with', 'then', 'vs', 'vs.', 'versus', '&', '+', '->', '→']);

/** The index of the last word of the path starting at `words[0]`: its first word with a file extension; else, when
 *  another path starts at `words[next]`, the word before it (before a joining word such as `and`), since a path's
 *  last part can hold spaces and no extension, so nothing between the two is taken for ordinary text; else the last. */
function pathEnd(words: readonly string[], next: number): number {
  const ext = words.findIndex((w, i) => /\.[A-Za-z0-9]{1,5}$/.test(w) && (next < 0 || i < next));
  if (ext >= 0) return ext;
  if (next < 0) return words.length - 1;
  return next > 1 && PATH_JOINERS.has(words[next - 1].toLowerCase()) ? next - 2 : next - 1;
}

/** An unquoted drive or network path, spaces and all (see `pathEnd`). What follows is scrubbed again, so a second path
 *  in the clause goes too. */
function unquotedPath(match: string): string {
  const words = match.split(' ');
  const last = pathEnd(words, words.findIndex((w, i) => i > 0 && DRIVE_START.test(w)));
  const rest = words.slice(last + 1).join(' ');
  return '[path]' + (rest ? ' ' + rest.replaceAll(DRIVE_PATH, unquotedPath) : '');
}

/** Unquoted absolute POSIX paths of two or more segments, spaces and all (see `pathEnd`). */
function posixPaths(value: string): string {
  const start = /(^|[\s("'`:=])(\/[^\s/,;)"'`]+\/[^,;)"'`\n]*)/.exec(value);
  if (!start) return value;
  const words = start[2].split(' ');
  const last = pathEnd(words, words.findIndex((w, i) => i > 0 && w.startsWith('/')));
  const rest = words.slice(last + 1).join(' ');
  const at = start.index + start[1].length;
  return value.slice(0, at) + '[path]' + (rest ? ' ' + posixPaths(rest) : '') + posixPaths(value.slice(at + start[2].length));
}

/** A label without links, email addresses, drive or UNC paths, the home directory or the user's names. */
export function scrubLabel(value: string, ctx: ScrubContext, max = MAX_NAME, nameMark = ''): string {
  let out = value
    .replaceAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    // A quoted path is one path, spaces and all; an unquoted one goes on through later words that carry a separator.
    .replaceAll(/(["'`])(?:[A-Za-z]:[\\/]|\\\\)[^"'`\n]*\1/g, '[path]')
    .replaceAll(DRIVE_PATH, unquotedPath)
    .replaceAll(/(["'`])\/[^"'`\n/]+\/[^"'`\n]*\1/g, '[path]');
  if (ctx.home && ctx.home.length > 1) {
    const home = ctx.home.replace(/[\\/]+$/, '');
    const variants = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')]);
    for (const variant of variants) out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  // Any absolute path of two or more segments (`/mnt/c/Users/…`, `/workspaces/…`); a single `/word`, such as a slash
  // command, stays.
  out = posixPaths(out);
  out = tidy(removeNames(out, usableNames(ctx.names), nameMark));
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}

/** A branch without a GitHub handle prefix (`handle/topic`, `handle-topic`), scrubbed like a label. Only signed-in
 *  handles are removed as prefixes: `vscode/fix` or `feature-x` keep theirs, and another of your names (the OS account)
 *  becomes `[name]` where it stands. */
export function scrubBranch(value: string, ctx: ScrubContext): string {
  let out = value.trim();
  // Handles are known exactly, so even a short one is removed when it is the branch's first word.
  const handles = [...new Set((ctx.handles ?? []).map(h => h.trim()).filter(h => h && !GENERIC_ACCOUNTS.has(h.toLowerCase())))];
  for (const name of handles.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`^${escapeRegExp(name)}[/_-]`, 'i'), '');
  }
  return scrubLabel(out, ctx, MAX_BRANCH, '[name]');
}

// cspell:ignore abposr apikey
/** Credentials that look like one: key blocks, well-known token formats, `Bearer …`, `password=…` style pairs (also
 *  as part of a longer name, such as `DB_PASSWORD=…`) and `--password …` style flags. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[secret]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})/g, '[secret]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[secret]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [secret]'],
  [/(?<![A-Za-z0-9_-])([-_]*(?:[A-Za-z0-9]+[_-]+)*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|account[_-]?key|shared[_-]?access[_-]?key|sig)["']?\s*[:=]\s*["']?)[^\s"'`,;&]{6,}/gi, '$1[secret]'],
  [/(?<![A-Za-z0-9_-])(--?(?:[A-Za-z0-9]+-)*(?:api-?key|secret|token|password|passwd|account-key)\s+["']?)(?!-)[^\s"'`,;&]{6,}/gi, '$1[secret]'],
];

/** A long run of letters and digits in both cases, as random keys are: hashes in lower-case hex and IDs with dashes
 *  aren't caught. */
function looksRandom(value: string): boolean {
  return value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

/** Free text (a prompt, a question, your answer, an agent's message) made safe to show on this machine: links, email
 *  addresses and secret-like tokens are replaced, the home directory becomes `~` and the user's names become `[name]`.
 *  Line breaks and other paths stay, so the text reads as written. */
export function scrubText(value: string, ctx: ScrubContext): string {
  let out = value.replaceAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]').replaceAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  for (const [pattern, mark] of SECRET_PATTERNS) out = out.replaceAll(pattern, mark);
  out = out.replaceAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g, m => (looksRandom(m) ? '[secret]' : m));
  if (ctx.home && ctx.home.length > 1) {
    const home = ctx.home.replace(/[\\/]+$/, '');
    const variants = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')]);
    for (const variant of variants) out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  return removeNames(out, usableNames([...ctx.names, ...(ctx.handles ?? [])]), '[name]');
}

/** Shown when a repository or folder name is nothing but the user's name, so scrubbing left nothing. */
export const PERSONAL_REPOSITORY = 'personal repository';

/** A repository or folder name for display: scrubbed, `personal repository` when only the user's name was left out,
 *  and empty when none was logged. */
export function scrubRepository(value: string, ctx: ScrubContext): string {
  const raw = lastSegment(value.trim());
  if (!raw) return '';
  const out = scrubLabel(raw, ctx);
  return out && out !== '[path]' ? out : PERSONAL_REPOSITORY;
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
