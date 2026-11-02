/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./shared', () => ({
  rpc: vi.fn(),
  escapeHtml: (s: string) => s,
}));
vi.mock('./dsl-cheatsheet', () => ({ DSL_CHEATSHEET: '' }));

import { rpc } from './shared';
import { parseThresholdsFromMarkdown, applyThresholdOverrides, openRuleEditor } from './page-antipatterns-editor';

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
});

describe('openRuleEditor', () => {
  function editorHost(): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = `
      <div id="rule-editor-modal" style="display:none;">
        <span id="rule-editor-modal-title"></span>
        <button class="rule-editor-tab" data-editor-tab="form"></button>
        <button class="rule-editor-tab" data-editor-tab="source"></button>
        <div id="rule-editor-form">
          <input id="rf-id"><input id="rf-name"><input id="rf-tags"><input id="rf-version">
          <select id="rf-group"><option>prompt-quality</option></select>
          <select id="rf-severity"><option>medium</option></select>
          <select id="rf-scope"><option>requests</option></select>
          <textarea id="rf-description"></textarea>
        </div>
        <div id="rule-editor-source"><textarea id="rule-editor-raw"></textarea></div>
        <input id="rule-ai-input"><div id="rule-ai-status"></div>
      </div>`;
    document.body.replaceChildren(host);
    return host;
  }

  const source = (id: string) => `---\nid: ${id}\nname: Rule ${id}\n---\n# Description\nAbout ${id}\n`;

  it('ignores a late source response for a rule opened earlier', async () => {
    const pending = new Map<string, (value: { source: string }) => void>();
    vi.mocked(rpc).mockImplementation(((_method: string, params: { ruleId: string }) =>
      new Promise<{ source: string }>(resolve => { pending.set(params.ruleId, resolve); })) as typeof rpc);
    const host = editorHost();

    openRuleEditor(host, 'rule-a');
    openRuleEditor(host, 'rule-b');
    pending.get('rule-b')!({ source: source('rule-b') });
    await Promise.resolve();
    pending.get('rule-a')!({ source: source('rule-a') });
    await Promise.resolve();

    const modal = host.querySelector<HTMLElement>('#rule-editor-modal')!;
    expect(modal.dataset.ruleId).toBe('rule-b');
    expect(host.querySelector<HTMLInputElement>('#rf-id')!.value).toBe('rule-b');
    expect(host.querySelector<HTMLTextAreaElement>('#rf-description')!.value).toBe('About rule-b');
    expect(host.querySelector<HTMLTextAreaElement>('#rule-editor-raw')!.value).toBe(source('rule-b'));
  });
});
