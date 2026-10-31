/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest';

vi.mock('./shared', () => ({
  rpc: vi.fn(),
  escapeHtml: (s: string) => s,
}));
vi.mock('./dsl-cheatsheet', () => ({ DSL_CHEATSHEET: '' }));

import { parseThresholdsFromMarkdown, applyThresholdOverrides } from './page-antipatterns-editor';

describe('page-antipatterns-editor threshold helpers', () => {
  const sampleMd = [
    '---',
    'id: demo',
    'name: Demo',
    'group: prompt-quality',
    'severity: medium',
    'scope: requests',
    'version: 1',
    'tags: []',
    'thresholds:',
    '  shortLen: 50',
    '  ratioLimit: 0.25',
    '---',
    '',
    '# Description',
    'x',
  ].join('\n');

  describe('parseThresholdsFromMarkdown', () => {
    it('extracts numeric thresholds from the frontmatter block', () => {
      const t = parseThresholdsFromMarkdown(sampleMd);
      expect(t).toEqual({ shortLen: 50, ratioLimit: 0.25 });
    });

    it('returns empty when frontmatter is absent', () => {
      expect(parseThresholdsFromMarkdown('# Just a heading')).toEqual({});
    });

    it('returns empty when no thresholds block', () => {
      const md = '---\nid: x\nname: y\n---\n# Description\n';
      expect(parseThresholdsFromMarkdown(md)).toEqual({});
    });

    it('skips malformed numeric values', () => {
      const md = '---\nthresholds:\n  good: 5\n  bad: not-a-number\n---\n';
      expect(parseThresholdsFromMarkdown(md)).toEqual({ good: 5 });
    });
  });

  describe('applyThresholdOverrides', () => {
    it('replaces only specified keys, leaving others intact', () => {
      const out = applyThresholdOverrides(sampleMd, { shortLen: 100 });
      const parsed = parseThresholdsFromMarkdown(out);
      expect(parsed.shortLen).toBe(100);
      expect(parsed.ratioLimit).toBe(0.25);
    });

    it('rounds non-integer overrides to 3 decimals', () => {
      const out = applyThresholdOverrides(sampleMd, { ratioLimit: 0.123456789 });
      const parsed = parseThresholdsFromMarkdown(out);
      expect(parsed.ratioLimit).toBe(0.123);
    });

    it('preserves integer formatting', () => {
      const out = applyThresholdOverrides(sampleMd, { shortLen: 42 });
      expect(out).toContain('shortLen: 42');
      expect(out).not.toContain('shortLen: 42.0');
    });

    it('leaves markdown untouched when no thresholds block exists', () => {
      const md = '---\nid: x\n---\n# Description\n';
      expect(applyThresholdOverrides(md, { foo: 1 })).toBe(md);
    });

    it('does not mutate thresholds outside the frontmatter block', () => {
      const md = sampleMd + '\n\n  shortLen: 999\n';
      const out = applyThresholdOverrides(md, { shortLen: 10 });
      expect(out).toContain('shortLen: 10');
      expect(out).toContain('shortLen: 999');
    });
  });

  describe('with CRLF line endings', () => {
    const crlfMd = sampleMd.replaceAll('\n', '\r\n');

    it('parseThresholdsFromMarkdown reads the thresholds', () => {
      expect(parseThresholdsFromMarkdown(crlfMd)).toEqual({ shortLen: 50, ratioLimit: 0.25 });
    });

    it('applyThresholdOverrides applies the overrides', () => {
      const out = applyThresholdOverrides(crlfMd, { shortLen: 100 });
      expect(out).toContain('  shortLen: 100\n');
      expect(parseThresholdsFromMarkdown(out)).toEqual({ shortLen: 100, ratioLimit: 0.25 });
    });
  });
});
