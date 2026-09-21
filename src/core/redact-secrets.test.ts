/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact-secrets';

describe('redactSecrets', () => {
  it('masks GitHub tokens', () => {
    const out = redactSecrets('push failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('[REDACTED:github-token]');
  });

  it('masks AWS access key ids', () => {
    expect(redactSecrets('key AKIAIOSFODNN7EXAMPLE here')).toContain('[REDACTED:aws-key-id]');
  });

  it('masks sk- style API keys', () => {
    expect(redactSecrets('use sk-abcdefghijklmnopqrstuvwx please')).toContain('[REDACTED:api-key]');
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactSecrets(`auth ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED:jwt]');
  });

  it('masks slack tokens', () => {
    expect(redactSecrets('xoxb-1234567890-abcdef')).toContain('[REDACTED:slack-token]');
  });

  it('masks slack app-level tokens', () => {
    expect(redactSecrets('xapp-1-A0123456789-abcdef')).toContain('[REDACTED:slack-token]');
  });

  it('masks Google API keys', () => {
    const key = 'AIza' + 'a'.repeat(35);
    const out = redactSecrets(`key=${key} end`);
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED:google-api-key]');
  });

  it('masks npm tokens', () => {
    expect(redactSecrets('npm_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('[REDACTED:npm-token]');
  });

  it('masks GitLab personal access tokens', () => {
    expect(redactSecrets('glpat-abcdefghijklmnopqrst')).toContain('[REDACTED:gitlab-token]');
  });

  it('masks Stripe-style underscore keys (sk_live_, rk_test_)', () => {
    expect(redactSecrets('sk_live_abcdefghijklmnop0123')).toContain('[REDACTED:stripe-key]');
    expect(redactSecrets('rk_test_ABCDEFGHIJ1234567890')).toContain('[REDACTED:stripe-key]');
  });

  it('masks credentials in connection-string URIs but keeps scheme/host', () => {
    const out = redactSecrets('DB=postgres://admin:s3cr3tP4ss@db.example.com:5432/app');
    expect(out).not.toContain('s3cr3tP4ss');
    expect(out).toContain('postgres://[REDACTED]@db.example.com');
  });

  it('masks quoted assignment values that contain spaces', () => {
    expect(redactSecrets('"password": "two words here"')).toBe('"password": "[REDACTED]"');
    expect(redactSecrets("secret = 'a longer pass phrase'")).toBe("secret = '[REDACTED]'");
  });

  it('masks bearer headers but keeps the scheme', () => {
    const out = redactSecrets('Authorization: Bearer abcdef0123456789abcdef');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abcdef0123456789abcdef');
  });

  it('masks key=value assignments and keeps the key name', () => {
    expect(redactSecrets('api_key=super-secret-value-123')).toBe('api_key=[REDACTED]');
  });

  it('masks quoted JSON-style assignment values', () => {
    expect(redactSecrets('"password": "hunter2hunter2"')).toBe('"password": "[REDACTED]"');
  });

  it('masks private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`cert:\n${pem}`)).toBe('cert:\n[REDACTED:private-key]');
  });

  it('masks truncated private key blocks (sliced text)', () => {
    const out = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEow');
    expect(out).not.toContain('MIIEow');
  });

  it('leaves ordinary prose and code untouched', () => {
    const text = 'Refactor the parser to use async/await and add a test for empty input.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('leaves short non-secret values untouched', () => {
    const text = 'the secret: keep it';
    expect(redactSecrets(text)).toBe(text);
  });

  it('handles empty strings', () => {
    expect(redactSecrets('')).toBe('');
  });

  // The MCP tool egress redacts the serialized JSON in one pass (tools.ts
  // textResult). Verify secrets inside JSON values are masked and the result
  // stays valid JSON.
  it('masks secrets embedded in a serialized JSON payload and stays parseable', () => {
    const payload = {
      sessions: [
        { prompt: 'deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789', note: 'ok' },
        { prompt: 'db is postgres://admin:s3cr3tPass@host/db', note: 'fine' },
      ],
    };
    const out = redactSecrets(JSON.stringify(payload, null, 2));
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('s3cr3tPass');
    expect(out).toContain('[REDACTED:github-token]');
    // Still valid JSON after redaction.
    const reparsed = JSON.parse(out) as { sessions: { prompt: string; note: string }[] };
    expect(reparsed.sessions).toHaveLength(2);
    expect(reparsed.sessions[0].note).toBe('ok');
  });
});

describe('compound secret key names', () => {
  it('redacts underscore-prefixed key names that a word boundary would skip', () => {
    for (const name of ['client_secret', 'refresh_token', 'app_token', 'db_password']) {
      const out = redactSecrets(`"${name}":"abcdefgh12345678"`);
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain('abcdefgh12345678');
    }
  });

  it('redacts JSON escaped by doubling its quotes inside a shell command', () => {
    const rule = 'Bash(curl -d \'{""client_secret"":""8bavjPwL9uoXDp""}\')';
    const out = redactSecrets(rule);
    expect(out).not.toContain('8bavjPwL9uoXDp');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a Context7 api key', () => {
    const out = redactSecrets('"CONTEXT7_API_KEY": "ctx7sk-1234abcd-5678-efgh-9012-ijklmnop"');
    expect(out).not.toContain('ctx7sk-1234abcd');
  });

  it('leaves ordinary prose mentioning those words intact', () => {
    for (const text of [
      'The token bucket algorithm smooths bursty traffic.',
      'Set a secret in your CI provider, then reference it.',
      'const tokenizer = new Tokenizer();',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});
