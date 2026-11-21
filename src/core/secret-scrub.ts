/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Credentials removed from free text before the Timeline shows it (prompts, questions, answers, replies, permission
 * requests). Three layers, so one missed shape is caught by another:
 *   1. `redactSecrets`, the conservative masking the chat tools use;
 *   2. well-known token formats, `Authorization` headers, connection strings, `key = value` pairs in env, JSON, YAML
 *      and query strings (quoted values whole, spaces and all), command-line flags, and long hex or base32 keys;
 *   3. on any line that names a credential (password, token, API key…), every long run of letters and digits.
 * It runs where the text is read, in the extension host, so unredacted text never reaches the webview. Each pattern
 * starts only where a name starts and is bounded, so the scan stays linear. Browser-safe: no Node imports. */

import { redactSecrets } from './redact-secrets';

const MARK = '[secret]';

// cspell:ignore abposr apikey passwd passphrase xoxb glpat AGPA AIDA AROA ANPA ABIA ACCA unredacted sharedaccesssignature
/** Token formats with a known prefix or shape, wherever they stand. */
const TOKEN_FORMATS = new RegExp(String.raw`\b(?:${[
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`, String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}`, String.raw`AIza[0-9A-Za-z_-]{35}`, String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
  String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`, String.raw`xapp-\d-[A-Za-z0-9-]{10,}`,
  String.raw`sk-[A-Za-z0-9_-]{20,}`, String.raw`[srp]k_(?:live|test)_[A-Za-z0-9]{10,}`, String.raw`npm_[A-Za-z0-9]{36}`,
  String.raw`glpat-[A-Za-z0-9_-]{20,}`, String.raw`hf_[A-Za-z0-9]{30,}`, String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
  String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
].join('|')})`, 'g');

/** A private key block, to its end line or, cut off, to the end of the text. */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;

/** A quoted value whole, to its closing quote (the same quote, optionally backslash-escaped); or, when the quote is
 *  never closed, the rest of the line. Group `n` is the quote, `n + 1` the closed value, `n + 2` the unclosed one. No
 *  length limit: a value is consumed to its delimiter, however long, in one pass. */
const QUOTED = String.raw`(\\?["'])(?:((?:(?!\QQ)[^\r\n])+)\QQ|([^\r\n]+))`;
const quoted = (group: number) => QUOTED.replaceAll('QQ', String(group));

/** An `Authorization` (or API key) header: its whole value, scheme and all, to the closing quote or the line's end. */
const AUTH_HEADER = new RegExp(
  String.raw`\b((?:proxy-)?authorization|x-api-key|api-key|ocp-apim-subscription-key)(\\?["']?[ \t]*[:=][ \t]*)(?:${quoted(3)}|([^\r\n"'\`]+))`, 'gi');

/** `Bearer …` and other schemes outside a header. */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|SharedKey)\s+([A-Za-z0-9._~+/=:%-]{12,})/gi;

/** A connection string's secret field, to the next `;`, spaces and all. */
const CONNECTION_FIELD = /((?:^|[;\s"'])(?:password|pwd|account[ _]?key|shared[ _]?access[ _]?key|shared[ _]?access[ _]?signature|client[ _]?secret)[ \t]*=)([^;\r\n"']+)(?=;)/gim;

/** Names whose value is a secret whatever it looks like. A name may end with one (`DB_PASSWORD`, `clientSecret`). */
const STRONG_KEYS = String.raw`api[_-]?key|apikey|secret|token|passwords?|passwd|passphrase|pwd|account[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|shared[_-]?access[_-]?key|sharedaccesssignature|credentials?|subscription[_-]?key|client[_-]?secret`;
/** Names whose value is a secret only when it looks like a key: `key`, `sig`, `auth`, `pat`. */
const WEAK_KEYS = String.raw`key[_-]?id|key|signature|sig|auth|pat`;

/** `name = value`, `name: value`, `"name": "value"`, `name=value&…`: the value whole when quoted. */
const KEY_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{0,80}?(?:(${STRONG_KEYS})|(?:${WEAK_KEYS}))(?:\\?["'])?[ \t]*[:=][ \t]*)(?:${quoted(3)}|\\?["']?([^\s"'\`,;&]{4,}))`, 'gi');

/** `--token value`, `--password "two words"`, `--client-secret value`, `--account-key value`. */
const SECRET_FLAG = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(--?[A-Za-z0-9-]{0,40}?(?:api-?key|secret|token|password|passwd|passphrase|pass|account-?key|access-?key|sas(?:-token)?|subscription-key)[ \t]+)(?:${quoted(2)}|(?!-)([^\s"'\`,;&]+))`, 'gi');

/** A value that looks like a generated key: long, with a digit or a base64 sign. */
const keyShaped = (value: string) => value.length >= 8 && /[\d+/=]/.test(value) && value !== MARK;

/** The mark in place of a value: inside its quotes when they were closed, after the opening one when not. */
const quotedMark = (q: string | undefined, closed = true) => (q ? `${q}${MARK}${closed ? q : ''}` : MARK);

/** Layer 2: the shapes credentials take. */
function scrubShapes(text: string): string {
  return text
    .replaceAll(PRIVATE_KEY, MARK)
    .replaceAll(TOKEN_FORMATS, MARK)
    .replaceAll(AUTH_HEADER, (_m, ...groups: (string | undefined)[]) => {
      const [name, sep, q, closed] = groups;
      return `${name ?? ''}${sep ?? ''}${quotedMark(q, closed !== undefined)}`;
    })
    .replaceAll(AUTH_SCHEME, (m, scheme: string, value: string) => (/[\d+/=:%]/.test(value) ? `${scheme} ${MARK}` : m))
    .replaceAll(CONNECTION_FIELD, `$1${MARK}`)
    .replaceAll(KEY_VALUE, (m, ...groups: (string | undefined)[]) => {
      const [prefix, strong, q, closed, open, bare] = groups;
      return strong || keyShaped(closed ?? open ?? bare ?? '') ? (prefix ?? '') + quotedMark(q, closed !== undefined) : m;
    })
    .replaceAll(SECRET_FLAG, (_m, flag: string, q?: string, closed?: string) => flag + quotedMark(q, closed !== undefined))
    // curl -u user:password; docker login -u user -p password; mysql -u user -ppassword; sshpass -p password.
    .replaceAll(/((?:^|\s)(?:-u|--user)[ \t]+[^\s:"'`]{1,200}:)[^\s"'`]+/g, `$1${MARK}`)
    .replaceAll(/((?:^|\s)-u[ \t]*[^\s"'`]{1,200}[ \t]+-p)([ \t]*)(?!-)[^\s"'`]+/g, `$1$2${MARK}`)
    .replaceAll(/(\bsshpass[ \t]+-p[ \t]*)[^\s"'`]+/g, `$1${MARK}`)
    .replaceAll(/(?<![A-Za-z0-9])(pass:)(?!\s)[^\s"'`]+/g, `$1${MARK}`)
    // Long random strings: base64-like in both cases with a digit, 32 hex digits (a 40-digit commit stays), 52 base32.
    .replaceAll(/[A-Za-z0-9+/_-]{32,}={0,2}/g, m => (m.length >= 32 && /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? MARK : m))
    .replaceAll(/\b(?:[a-f0-9]{32}|[A-F0-9]{32}|[a-z2-7]{52})\b/g, MARK);
}

/** A line that names a credential. */
const SECRET_WORD = /password|passwd|passphrase|secret|token|api[ _-]?key|credential|private[ _-]?key|authorization|access[ _-]?key|\bpat\b/i;

/** Layer 3: on a line that names a credential, any run of 16 or more letters and digits (both) is taken for one. */
function scrubNearSecretWords(text: string): string {
  return text.split(/(\r?\n)/).map(line => (SECRET_WORD.test(line)
    ? line.replaceAll(/(?<![A-Za-z0-9+/=_~])[A-Za-z0-9+/=_~]{16,}(?![A-Za-z0-9+/=_~])/g, w => (/[A-Za-z]/.test(w) && /\d/.test(w) ? MARK : w))
    : line)).join('');
}

/** `text` with every credential-shaped part replaced by `[secret]`. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  const layer1 = redactSecrets(text).replaceAll(/\[REDACTED(?::[a-z0-9-]+)?\]/g, MARK);
  return scrubNearSecretWords(scrubShapes(layer1));
}
