/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { escapeHtmlAttr, isSafeExternalHttpsUrl, safeJoinUnder, isRequestMessage } from './panel-shared';

describe('escapeHtmlAttr', () => {
  it('escapes all HTML-special characters', () => {
    expect(escapeHtmlAttr('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtmlAttr('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes single quotes', () => {
    expect(escapeHtmlAttr("it's")).toBe('it&#39;s');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeHtmlAttr('VS Code')).toBe('VS Code');
    expect(escapeHtmlAttr('Claude')).toBe('Claude');
  });

  it('handles empty string', () => {
    expect(escapeHtmlAttr('')).toBe('');
  });
});

describe('safeJoinUnder', () => {
  const base = path.resolve('/tmp/agents/skills');

  it('joins a simple safe filename under the base', () => {
    expect(safeJoinUnder(base, ['my-skill.md'])).toBe(path.join(base, 'my-skill.md'));
  });

  it('joins nested safe segments', () => {
    expect(safeJoinUnder(base, ['my-slug', 'file.md'])).toBe(path.join(base, 'my-slug', 'file.md'));
  });

  it('rejects parent-traversal segments', () => {
    expect(safeJoinUnder(base, ['..', 'evil.md'])).toBeNull();
    expect(safeJoinUnder(base, ['..'])).toBeNull();
  });

  it('rejects segments containing a path separator', () => {
    expect(safeJoinUnder(base, ['foo/bar.md'])).toBeNull();
    expect(safeJoinUnder(base, ['foo\\bar.md'])).toBeNull();
  });

  it('rejects absolute-path-like and special segments', () => {
    expect(safeJoinUnder(base, ['.'])).toBeNull();
    expect(safeJoinUnder(base, [''])).toBeNull();
    expect(safeJoinUnder(base, ['a:b'])).toBeNull();
  });

  it('rejects empty segment list', () => {
    expect(safeJoinUnder(base, [])).toBeNull();
  });

  it('enforces an extension allowlist on the final segment', () => {
    expect(safeJoinUnder(base, ['note.txt'], { allowedExts: ['.md'] })).toBeNull();
    expect(safeJoinUnder(base, ['note.md'], { allowedExts: ['.md'] })).toBe(path.join(base, 'note.md'));
  });
});

describe('isSafeExternalHttpsUrl', () => {
  it('accepts a normal HTTPS URL', () => {
    expect(isSafeExternalHttpsUrl('https://example.com/docs?q=1#top')).toBe(true);
  });

  it('rejects non-HTTPS and protocol-handler URLs', () => {
    expect(isSafeExternalHttpsUrl('http://example.com')).toBe(false);
    expect(isSafeExternalHttpsUrl('file:///tmp/a')).toBe(false);
    expect(isSafeExternalHttpsUrl('vscode://file/tmp/a')).toBe(false);
    expect(isSafeExternalHttpsUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects malformed, credentialed, and control-character URLs', () => {
    expect(isSafeExternalHttpsUrl('https:example.com')).toBe(false);
    expect(isSafeExternalHttpsUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeExternalHttpsUrl('https://example.com/\nfile://x')).toBe(false);
  });
});

describe('isRequestMessage', () => {
  it('accepts a well-formed request with object params', () => {
    expect(isRequestMessage({ type: 'request', id: '1', method: 'foo', params: { a: 1 } })).toBe(true);
  });

  it('accepts a request without params', () => {
    expect(isRequestMessage({ type: 'request', id: '1', method: 'foo' })).toBe(true);
  });

  it('rejects array params', () => {
    expect(isRequestMessage({ type: 'request', id: '1', method: 'foo', params: [1, 2] })).toBe(false);
  });

  it('rejects primitive params', () => {
    expect(isRequestMessage({ type: 'request', id: '1', method: 'foo', params: 'x' })).toBe(false);
  });

  it('rejects missing id/method or wrong type', () => {
    expect(isRequestMessage({ type: 'request', method: 'foo' })).toBe(false);
    expect(isRequestMessage({ type: 'event', id: '1', method: 'foo' })).toBe(false);
    expect(isRequestMessage(null)).toBe(false);
  });
});
