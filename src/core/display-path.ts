/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Display forms of local paths for the loading screen. The screen is often shared or captured,
 * so it shows `~` instead of the home folder (which usually contains the user name) and leads
 * with the folder name. Full paths stay in the output channel. Pure string code: no Node
 * imports, so the webview and tests can use it too. */

function normalizeSeparators(p: string): string {
  return p.replaceAll('\\', '/');
}

function decodeFileUri(p: string): string {
  if (!/^file:\/\//i.test(p)) return p;
  let rest = p.replace(/^file:\/\//i, '');
  try { rest = decodeURIComponent(rest); } catch { /* keep the raw text */ }
  // file:///c:/Users/... → c:/Users/...
  if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
  return rest;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A pattern matching `home` with either separator, case-insensitively, as a whole path prefix
 *  (followed by a separator, a quote, whitespace or the end), so `/home/ann` never matches
 *  inside `/home/anna`. */
function homePattern(home: string): RegExp | null {
  const trimmed = normalizeSeparators(home).replace(/\/+$/, '');
  // An empty, root or bare-drive home would match every path on the disk.
  if (trimmed.length < 2 || /^[A-Za-z]:$/.test(trimmed)) return null;
  const parts = trimmed.split('/').map(escapeRegExp);
  return new RegExp(`${parts.join('[\\\\/]')}(?=[\\\\/]|$|[\\s'"),;:])`, 'gi');
}

/** `path` with the home folder replaced by `~`, file URIs decoded. Other paths keep their form. */
export function shortenHomePath(p: string, home: string): string {
  const decoded = decodeFileUri(p);
  const pattern = homePattern(home);
  if (!pattern) return decoded;
  pattern.lastIndex = 0;
  const match = pattern.exec(decoded);
  if (!match || match.index !== 0) return decoded;
  // A whole path: the home folder must end at a separator or the end, so `/home/dev team`
  // is not under `/home/dev`.
  const rest = decoded.slice(match[0].length);
  if (rest !== '' && rest[0] !== '/' && rest[0] !== '\\') return decoded;
  return `~${rest}`;
}

/** Every occurrence of the home folder in free text replaced by `~` (progress details can embed
 *  a path anywhere). */
export function redactHomePaths(text: string, home: string): string {
  const pattern = homePattern(home);
  if (!pattern || !text) return text;
  return text.replace(pattern, '~');
}

/** The last non-empty segment of a path or URI, for the folder name shown on screen. */
export function displayFolderName(p: string): string {
  const parts = normalizeSeparators(decodeFileUri(p)).split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}
