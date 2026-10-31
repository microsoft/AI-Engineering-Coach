/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTokenTypes, TokenTypesData } from '../core/types';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./shared', () => ({
  rpc: mocks.rpc,
  formatNum: (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)),
}));

import { render } from './render';
import { renderSessionStrip, renderSourcePanel } from './token-types-view';
import { renderTokenTypes } from './page-token-types';

const CLI: SourceTokenTypes = {
  source: 'copilot-cli',
  label: 'Copilot App and Copilot CLI',
  harnesses: ['GitHub Copilot App', 'GitHub Copilot CLI'],
  requests: 120,
  reasoning: {
    basis: 'calls',
    main: { outputTokens: 100_000, reasoningTokens: 61_400, sharePct: 61.4 },
    subagent: { outputTokens: 10_000, reasoningTokens: 890, sharePct: 8.9 },
    byEffort: [
      { effort: 'max', stream: 'main', calls: 400, outputTokens: 50_000, reasoningTokens: 30_950, sharePct: 61.9 },
      { effort: 'medium', stream: 'main', calls: 50, outputTokens: 5_000, reasoningTokens: 1_565, sharePct: 31.3 },
      { effort: 'low', stream: 'subagent', calls: 80, outputTokens: 10_000, reasoningTokens: 890, sharePct: 8.9 },
    ],
  },
  compaction: {
    count: 186, automatic: 186, manual: 0, failed: 3, avgTokensBefore: 245_000, avgTokensAfter: 52_000, yieldPct: 78.8,
    withUsage: 27, inputTokens: 47_900_000, outputTokens: 1_500_000, shareOfMainInputPct: 1.3, modelTimeMs: 15_720_000,
  },
  subagents: {
    runs: 320, totalTokens: 1_120_000_000, shareOfAllTokensPct: 11.8,
    byType: [
      { agentType: 'research', runs: 96, totalTokens: 483_000_000, toolCalls: 4_000, durationMs: 9_000_000, cancelled: 1, background: 90 },
      { agentType: 'explore', runs: 55, totalTokens: 5_900_000, toolCalls: 500, durationMs: 600_000, cancelled: 0, background: 0 },
    ],
  },
  truncation: { calls: 12_954, truncatedCalls: 7, filteredCalls: 4 },
  latency: [{ model: 'claude-opus-5.5', calls: 2_104, ttftP50Ms: 3_200, ttftP90Ms: 4_700, durationP50Ms: 7_800, durationP90Ms: 32_200 }],
};

const CLAUDE: SourceTokenTypes = {
  source: 'claude', label: 'Claude Code', harnesses: ['Claude'], requests: 40,
  reasoning: null, compaction: null, subagents: null, truncation: { calls: 300, truncatedCalls: 2, filteredCalls: null }, latency: null,
};

const DATA: TokenTypesData = {
  sources: [CLI, CLAUDE],
  harnesses: [
    { harness: 'GitHub Copilot App', source: 'copilot-cli', requests: 100, reports: { reasoning: 'reported', compaction: 'reported', subagents: 'reported', truncation: 'reported', latency: 'reported' } },
    { harness: 'Local Agent', source: null, requests: 30, reports: { reasoning: 'not-reported', compaction: 'not-reported', subagents: 'not-reported', truncation: 'not-reported', latency: 'not-reported' } },
  ],
  tips: ['Reasoning is 61% of Copilot App and Copilot CLI output tokens.'],
  coverage: { requests: 170, requestsWithData: 140 },
};

describe('Token Types views', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.rpc.mockReset();
  });

  it('shows every type a source logs, with figures', () => {
    const el = document.createElement('div');
    render(renderSourcePanel(CLI), el);
    const kpis = [...el.querySelectorAll('.ctx-tt-kpi')].map(k => [k.getAttribute('data-type'), k.querySelector('.ctx-tt-kpi-value')?.textContent]);
    expect(kpis).toEqual([['reasoning', '61%'], ['compaction', '1.3%'], ['subagents', '12%'], ['truncation', '7'], ['latency', '3.2 s']]);
    expect([...el.querySelectorAll('[aria-label="Reasoning share by effort"] .ctx-tt-bar-label')].map(l => l.textContent)).toEqual(['max \u00b7 main agent', 'medium \u00b7 main agent', 'low \u00b7 sub-agents']);
    expect(el.textContent).toContain('186 compactions: 186 automatic \u00b7 3 failed.');
    expect(el.textContent).toContain('7 of 13K model calls');
  });

  it('marks types a source does not log as not reported, never zero', () => {
    const el = document.createElement('div');
    render(renderSourcePanel(CLAUDE), el);
    const muted = [...el.querySelectorAll('.ctx-tt-kpi.muted')].map(k => k.getAttribute('data-type'));
    expect(muted).toEqual(['reasoning', 'compaction', 'subagents', 'latency']);
    expect(el.querySelector('[data-type="reasoning"] .ctx-tt-kpi-value')?.textContent).toBe('Not reported');
    expect(el.querySelector('[data-type="truncation"] .ctx-tt-kpi-value')?.textContent).toBe('2');
  });

  it('renders the session strip from the per-session summary', () => {
    const el = document.createElement('div');
    render(renderSessionStrip({
      reasoningPct: 58, effort: 'high', subagentRuns: 3, subagentTokens: 4_100_000, subagentTypes: [{ agentType: 'research', runs: 2 }, { agentType: 'explore', runs: 1 }],
      compactionCalls: 2, compactionTokens: 1_200_000, compactionTimeMs: 126_000, truncatedCalls: 1, calls: 610, ttftMedianMs: 3_200,
    }), el);
    expect(el.textContent).toBe('Token types in this session: reasoning 58% of output (high effort) \u00b7 3 sub-agent runs, 4.1M tokens (research 2, explore 1) \u00b7 compaction calls 1.2M tokens, 2.1 min \u00b7 1 of 610 model calls truncated \u00b7 first token median 3.2 s');
    const empty = document.createElement('div');
    render(renderSessionStrip(undefined), empty);
    expect(empty.textContent).toBe('');
  });

  it('renders the tab with its own Insights box, a harness picker and the availability matrix', async () => {
    mocks.rpc.mockResolvedValue(DATA);
    const el = document.createElement('div');
    document.body.append(el);
    await renderTokenTypes(el, { fromDate: '2026-10-01' });
    expect(mocks.rpc).toHaveBeenCalledWith('getTokenTypes', { filter: { fromDate: '2026-10-01' } });
    expect(el.querySelector('.ctx-tt-tips')?.textContent).toContain('Reasoning is 61%');
    const picks = [...el.querySelectorAll<HTMLButtonElement>('.ctx-tt-pick')];
    expect(picks.map(p => [p.textContent, p.getAttribute('aria-pressed')])).toEqual([['Copilot App and Copilot CLI', 'true'], ['Claude Code', 'false']]);
    picks[1].click();
    await vi.waitFor(() => expect(el.querySelector('.ctx-tt-source')?.getAttribute('data-source')).toBe('claude'));
    const local = [...el.querySelectorAll('.ctx-tt-matrix tbody tr')].find(tr => tr.textContent?.includes('Local Agent'));
    expect(local?.querySelectorAll('.not-reported')).toHaveLength(5);
    expect(el.textContent).toContain('not for evaluating anyone');
  });

  it('explains an empty range and drops superseded responses', async () => {
    mocks.rpc.mockResolvedValue({ ...DATA, sources: [] });
    const el = document.createElement('div');
    await renderTokenTypes(el, {});
    expect(el.querySelector('#ctxTokenTypesEmpty')?.textContent).toContain('No request in this range logged token types');

    const stale = document.createElement('div');
    stale.textContent = 'previous';
    await renderTokenTypes(stale, {}, () => false);
    expect(stale.textContent).toBe('previous');

    mocks.rpc.mockRejectedValue(new Error('down'));
    const failed = document.createElement('div');
    await renderTokenTypes(failed, {});
    expect(failed.querySelector('#ctxTokenTypesError')).not.toBeNull();
  });
});
