/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Session metadata Copilot CLI and Copilot App keep beside events.jsonl in `workspace.yaml`: the session's display
 * name, branch, repository and fork count. Values are scrubbed here, in the parse worker, so the user's paths and
 * names never reach the analyzer or the webview. Read-only. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scrubBranch, scrubLabel, scrubRepository, type ScrubContext } from './session-labels';

/** Which client started a Copilot session (`client_name`): `github/cli` for Copilot CLI. */
export function readCliClient(sessionDir: string): string {
  try {
    return yamlScalar(fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8'), 'client_name');
  } catch {
    return '';
  }
}

export interface CliWorkspaceMeta {
  /** The name you gave the session. Automatic titles (`user_named: false`) are often your first prompt, word for
   *  word, so they are never kept. */
  displayName?: string;
  branch?: string;
  repository?: string;
  forkCount?: number;
}

/** One top-level value from `workspace.yaml`: plain (a trailing `# comment` dropped), single- or double-quoted (also
 *  over several lines), or a block (`|`, `>`). A plain `~` or `null` is no value; a quoted one is the text. Not a
 *  general YAML parser: only the forms Copilot writes. */
export function yamlScalar(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(line => line.startsWith(`${key}:`));
  if (at < 0) return '';
  const raw = lines[at].slice(key.length + 1).trim();
  const block = /^([|>])[+-]?\d*[+-]?(?:\s+#.*)?$/.exec(raw);
  if (block) return yamlBlock(lines.slice(at + 1), block[1] === '>');
  if (raw.startsWith("'") || raw.startsWith('"')) return yamlQuoted(raw, lines.slice(at + 1));
  const value = raw.replace(/(?:^|\s+)#.*$/, '').trim();
  return value === '~' || value === 'null' ? '' : value;
}

/** A quoted value, continued over the following indented lines until its closing quote; line breaks fold to spaces. */
function yamlQuoted(first: string, rest: readonly string[]): string {
  const quote = first[0];
  const closed = quote === "'" ? /^'((?:[^']|'')*)'/ : /^"((?:[^"\\]|\\.)*)"/;
  let joined = first;
  for (let i = 0; !closed.test(joined) && i < rest.length && i < 50; i++) {
    if (rest[i].trim() && !/^\s/.test(rest[i])) break;
    joined += ' ' + rest[i].trim();
  }
  const match = closed.exec(joined);
  const body = match ? match[1] : joined.slice(1);
  if (quote === "'") return body.replaceAll("''", "'");
  try { return JSON.parse(`"${body}"`) as string; } catch { return body; }
}
/** The indented lines of a block value: kept as lines (`|`) or folded into one (`>`). */
function yamlBlock(lines: readonly string[], folded: boolean): string {
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line);
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const indent = Math.min(...body.filter(line => line.trim()).map(line => /^\s*/.exec(line)![0].length));
  const text = body.map(line => line.slice(Number.isFinite(indent) ? indent : 0));
  return (folded ? text.join(' ').replaceAll(/ {2,}/g, ' ') : text.join('\n')).trim();
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** GitHub handles Copilot CLI and Copilot App signed in with (`~/.copilot/config.json`). */
function copilotLogins(home: string): string[] {
  const config = readJson(path.join(home, '.copilot', 'config.json'));
  if (typeof config !== 'object' || config === null) return [];
  const record = config as { lastLoggedInUser?: { login?: unknown }; loggedInUsers?: unknown };
  const logins: string[] = [];
  if (typeof record.lastLoggedInUser?.login === 'string') logins.push(record.lastLoggedInUser.login);
  if (Array.isArray(record.loggedInUsers)) {
    for (const user of record.loggedInUsers as unknown[]) {
      const login = typeof user === 'object' && user !== null ? (user as { login?: unknown }).login : undefined;
      if (typeof login === 'string') logins.push(login);
    }
  }
  return logins;
}

let cached: { home: string; ctx: ScrubContext } | undefined;

/** GitHub handles the GitHub CLI signed in with (`hosts.yml`: `user: <handle>`). */
function ghLogins(home: string): string[] {
  const dirs = [
    process.env.GH_CONFIG_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'GitHub CLI') : undefined,
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'gh') : undefined,
    path.join(home, '.config', 'gh'),
  ];
  const logins: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const text = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8');
      for (const match of text.matchAll(/^\s+user:\s*['"]?([A-Za-z0-9-]+)['"]?\s*$/gm)) logins.push(match[1]);
    } catch { /* not signed in with gh */ }
  }
  return logins;
}

/** The current user's home, account name and GitHub handles, resolved when first needed (per home directory). */
export function localScrubContext(): ScrubContext {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (cached?.home === home) return cached.ctx;
  const names = [path.basename(home)];
  try { names.push(os.userInfo().username); } catch { /* no account name */ }
  const handles = [...copilotLogins(home), ...ghLogins(home)];
  names.push(...handles);
  cached = { home, ctx: { home, names, handles } };
  return cached.ctx;
}

/** Scrubbed name, branch and repository of a Copilot CLI or Copilot App session from its `workspace.yaml`. */
export function readCliWorkspaceMeta(sessionDir: string, ctx: ScrubContext = localScrubContext(), firstPrompt = ''): CliWorkspaceMeta {
  let text: string;
  try {
    text = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8');
  } catch {
    return {};
  }
  const meta: CliWorkspaceMeta = {};
  const raw = yamlScalar(text, 'name');
  const name = scrubLabel(raw, ctx);
  if (name && yamlScalar(text, 'user_named') !== 'false' && !isPromptText(raw, firstPrompt)) meta.displayName = name;
  const branch = scrubBranch(yamlScalar(text, 'branch'), ctx);
  if (branch) meta.branch = branch;
  const repo = scrubRepository(yamlScalar(text, 'repository') || yamlScalar(text, 'git_root'), ctx);
  if (repo) meta.repository = repo;
  const forks = Number.parseInt(yamlScalar(text, 'fork_count'), 10);
  if (Number.isFinite(forks) && forks > 0) meta.forkCount = forks;
  return meta;
}

/** The title is the prompt, or its start: an automatic title made from it. */
export function isPromptText(title: string, prompt: string): boolean {
  const norm = (s: string) => s.toLowerCase().replaceAll(/\s+/g, ' ').replace(/[.…]+$/, '').trim();
  const t = norm(title);
  const p = norm(prompt);
  return t.length > 0 && p.length > 0 && (p === t || (t.length >= 12 && p.startsWith(t)));
}
