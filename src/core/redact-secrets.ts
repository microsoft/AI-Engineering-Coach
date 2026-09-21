/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Best-effort masking of credential-shaped substrings in transcript text
 * before it is shared with a language model (chat participant / LM tools).
 *
 * Session logs routinely contain secrets users pasted while debugging (API
 * keys, tokens, private keys). Matching is intentionally conservative --
 * well-known token prefixes and explicit key/value assignments only -- so
 * ordinary prose and code remain readable.
 *
 * Key names are matched with an optional compound prefix, so `client_secret`
 * and `refresh_token` are caught as well as bare `secret` and `token`. Quote
 * runs of one or two characters are accepted, because JSON embedded in a
 * shell command is commonly escaped by doubling its quotes.
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,255}\b/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,250}\b/g;
const SLACK_APP_TOKEN = /\bxapp-[0-9]-[A-Za-z0-9-]{10,250}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{36}\b/g;
const GITLAB_PAT = /\bglpat-[A-Za-z0-9_-]{20,80}\b/g;
const CONTEXT7_KEY = /\bctx7sk-[A-Za-z0-9_-]{10,250}\b/g;
const SK_API_KEY = /\bsk-[A-Za-z0-9_-]{20,250}\b/g;
// Stripe / underscore-prefixed keys (sk_live_, sk_test_, rk_live_, pk_live_, …).
const STRIPE_KEY = /\b[srp]k_(?:live|test)_[0-9A-Za-z]{10,255}\b/g;
// Credentials embedded in a connection-string URI (scheme://user:pass@host).
const CONNECTION_STRING_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;
// Quoted assignment whose value may contain spaces: "password": "two words here".
const SECRET_KEY_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credentials?)`;
const QUOTED_SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_KEY_NAME})(["']{0,2}\s*[:=]\s*)(["']{1,2})((?:(?!\3).){4,512})\3`, 'gi');
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,512}/gi;
const KEY_VALUE_ASSIGNMENT = new RegExp(
  String.raw`\b(${SECRET_KEY_NAME})(["']{0,2}\s*[:=]\s*)(["']{0,2})[^\s"'\`;,]{8,512}\3`, 'gi');

/** Mask credential-shaped substrings, keeping surrounding text intact. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replaceAll(PRIVATE_KEY_BLOCK, '[REDACTED:private-key]')
    .replaceAll(GITHUB_TOKEN, '[REDACTED:github-token]')
    .replaceAll(AWS_ACCESS_KEY_ID, '[REDACTED:aws-key-id]')
    .replaceAll(SLACK_TOKEN, '[REDACTED:slack-token]')
    .replaceAll(SLACK_APP_TOKEN, '[REDACTED:slack-token]')
    .replaceAll(GOOGLE_API_KEY, '[REDACTED:google-api-key]')
    .replaceAll(NPM_TOKEN, '[REDACTED:npm-token]')
    .replaceAll(GITLAB_PAT, '[REDACTED:gitlab-token]')
    .replaceAll(CONTEXT7_KEY, '[REDACTED:api-key]')
    .replaceAll(STRIPE_KEY, '[REDACTED:stripe-key]')
    .replaceAll(SK_API_KEY, '[REDACTED:api-key]')
    .replaceAll(JWT, '[REDACTED:jwt]')
    .replaceAll(CONNECTION_STRING_CREDS, '$1[REDACTED]@')
    .replaceAll(AUTH_HEADER, '$1 [REDACTED]')
    .replaceAll(QUOTED_SECRET_ASSIGNMENT, '$1$2$3[REDACTED]$3')
    .replaceAll(KEY_VALUE_ASSIGNMENT, '$1$2$3[REDACTED]$3');
}
