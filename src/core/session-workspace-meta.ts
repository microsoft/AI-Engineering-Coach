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

export interface CliWorkspaceMeta {
  displayName?: string;
  branch?: string;
  repository?: string;
  forkCount?: number;
}

/** One top-level value from `workspace.yaml`: plain (a trailing `# comment` dropped), quoted, or a block (`|`, `>`). */
export function yamlScalar(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(line => line.startsWith(`${key}:`));
  if (at < 0) return '';
  const raw = lines[at].slice(key.length + 1).trim();
  const block = /^([|>])[+-]?\d*[+-]?(?:\s+#.*)?$/.exec(raw);
  if (block) return yamlBlock(lines.slice(at + 1), block[1] === '>');
  let value: string;
  if (raw.startsWith("'")) {
    const end = /^'((?:[^']|'')*)'/.exec(raw);
    value = end ? end[1].replaceAll("''", "'") : raw.slice(1);
  } else if (raw.startsWith('"')) {
    const end = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    try { value = end ? JSON.parse(`"${end[1]}"`) as string : raw.slice(1); } catch { value = end ? end[1] : raw.slice(1); }
  } else {
    value = raw.replace(/(?:^|\s+)#.*$/, '').trim();
  }
  return value === '~' || value === 'null' ? '' : value;
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
export function readCliWorkspaceMeta(sessionDir: string, ctx: ScrubContext = localScrubContext()): CliWorkspaceMeta {
  let text: string;
  try {
    text = fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8');
  } catch {
    return {};
  }
  const meta: CliWorkspaceMeta = {};
  const name = scrubLabel(yamlScalar(text, 'name'), ctx);
  if (name) meta.displayName = name;
  const branch = scrubBranch(yamlScalar(text, 'branch'), ctx);
  if (branch) meta.branch = branch;
  const repo = scrubRepository(yamlScalar(text, 'repository') || yamlScalar(text, 'git_root'), ctx);
  if (repo) meta.repository = repo;
  const forks = Number.parseInt(yamlScalar(text, 'fork_count'), 10);
  if (Number.isFinite(forks) && forks > 0) meta.forkCount = forks;
  return meta;
}
