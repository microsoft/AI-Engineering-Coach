/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallTimeline, ContextVerdictThresholds, SessionContextDetail, SessionTimelineData } from '../core/types';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), destroyChartById: vi.fn(), renderChart: vi.fn(), table: vi.fn(() => 'values table') }));
vi.mock('./shared', () => ({
  rpc: mocks.rpc,
  destroyChartById: mocks.destroyChartById,
  formatNum: (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)),
  COLORS: new Proxy({}, { get: (_t, key) => `#${String(key)}` }),
}));
vi.mock('./call-timeline-chart', () => ({ renderCallTimelineChart: mocks.renderChart, callTimelineTable: mocks.table }));

import { compactionLayer, contextLimitLayer, contextPeakLayer, outputLayer, truncationLayer, turnEndBuckets, turnEndLayer } from './context-timeline-layers';
import { closeContextTimeline, contextTimelineLayers, renderContextTimeline } from './context-session-timeline';

const THRESHOLDS: ContextVerdictThresholds = { optimalUtilization: 50, limitedUtilization: 80, adaptive: false, sampleSize: 0 };

const TIMELINE: CallTimeline = {
  calls: 6,
  bucketSize: 2,
  buckets: [
    { firstCall: 0, lastCall: 1, firstRequest: 0, lastRequest: 0, startTs: 1, endTs: 2, cacheCalls: 2, cacheRead: 1, cacheWrite: 1, uncached: 1, peakPrompt: 200_000, contextLimit: 968_000, output: 4_000, reasoning: 2_000, truncatedCalls: 0 },
    { firstCall: 2, lastCall: 3, firstRequest: 0, lastRequest: 1, startTs: 3, endTs: 4, cacheCalls: 2, cacheRead: 1, cacheWrite: 1, uncached: 1, peakPrompt: 790_000, contextLimit: 968_000, output: 40_000, reasoning: 20_000, truncatedCalls: 1 },
    { firstCall: 4, lastCall: 5, firstRequest: 1, lastRequest: 1, startTs: 5, endTs: 6, cacheCalls: 2, cacheRead: 1, cacheWrite: 1, uncached: 1, peakPrompt: 120_000, contextLimit: 968_000 },
  ],
};

const DATA: SessionTimelineData = {
  sessionId: 's1',
  harness: 'GitHub Copilot App',
  unit: 'calls',
  timeline: TIMELINE,
  cache: null,
  context: {
    compactions: [{ callIndex: 4, requestIndex: 1, tokensBefore: 790_000, tokensAfter: 70_000, tokenLimit: 968_000, trigger: 'automatic', failed: false }],
    omittedCompactions: 0,
    turnEnds: [300_000, 120_000],
  },
};

function detail(): SessionContextDetail {
  return {
    sessionId: 's1', date: '2026-10-28', harness: 'GitHub Copilot App', requestCount: 3, requestsWithTokens: 2,
    avgPromptTokens: 210_000, maxPromptTokens: 300_000, avgUtilization: 21.7, peakUtilization: 31, contextWindow: 968_000,
    compactionCount: 1, tokenCurve: [300_000, 120_000, null], saturation: 0, costEfficiency: null, verdict: 'optimal',
    events: [{ requestIndex: 1, type: 'compaction', label: 'Compaction 790K\u219270K' }], requestQueries: ['a', 'b', 'c'],
    hasPerRequestTokens: true, windowSource: 'reported', turnLimits: [968_000, 968_000, null], turnPeaks: [300_000, 790_000, null],
    turnCalls: [3, 3, null], turnCacheHitPct: [92.5, 88, null], hasCallTimeline: true,
  };
}

describe('context timeline layers', () => {
  it('plots the largest prompt and the reported limit with the verdict thresholds, each on its own stack', () => {
    const [peak] = contextPeakLayer().datasets!(TIMELINE);
    expect(peak).toMatchObject({ type: 'line', data: [200_000, 790_000, 120_000] });
    const limit = contextLimitLayer(THRESHOLDS).datasets!(TIMELINE);
    expect(limit.map(d => d.label)).toEqual(['Context limit (reported)', 'Limited from 80%', 'Degraded from 50%']);
    expect(limit[1].data).toEqual([774_400, 774_400, 774_400]);
    expect(new Set([peak, ...limit].map(d => d.stack)).size).toBe(4);
    expect(contextLimitLayer(THRESHOLDS).datasets!({ ...TIMELINE, buckets: TIMELINE.buckets.map(b => ({ ...b, contextLimit: undefined })) })).toEqual([]);
  });

  it('marks each turn end at the bar of its last call, and compactions at the call after them', () => {
    expect([...turnEndBuckets(TIMELINE)]).toEqual([[0, 1], [1, 2]]);
    expect(turnEndLayer(DATA).datasets!(TIMELINE)[0].data).toEqual([null, 300_000, 120_000]);
    const markers = compactionLayer(DATA).markers!(TIMELINE);
    expect([...markers.keys()]).toEqual([2]);
    expect(markers.get(2)?.[0]).toMatchObject({ label: 'Compacted 790K\u219270K' });
    expect(markers.get(2)?.[0].detail).toContain('Automatic compaction');
    const failed = compactionLayer({ ...DATA, context: { ...DATA.context!, compactions: [{ ...DATA.context!.compactions[0], failed: true }] } }).markers!(TIMELINE);
    expect(failed.get(2)?.[0].label).toBe('Compaction failed');
  });

  it('marks truncated calls and puts output per call on the right-hand axis', () => {
    const truncated = truncationLayer().markers!(TIMELINE);
    expect([...truncated.keys()]).toEqual([1]);
    expect(truncated.get(1)?.[0].detail).toBe('1 call stopped at the output-token limit.');
    const output = outputLayer().datasets!(TIMELINE);
    expect(output.map(d => d.yAxisID)).toEqual(['y1', 'y1']);
    expect(output[0].data).toEqual([2_000, 20_000, null]);
    expect(output[1].data).toEqual([1_000, 10_000, null]);
    expect(outputLayer().defaultOn).toBe(false);
    // Reasoning per call counts only the calls that logged it.
    const partial = outputLayer().datasets!({ ...TIMELINE, buckets: [{ ...TIMELINE.buckets[0], reasoningCalls: 1 }] });
    expect(partial.map(d => d.data)).toEqual([[2_000], [2_000]]);
  });

  it('keeps the cache layers available but off in Context Management', () => {
    const layers = contextTimelineLayers(DATA, THRESHOLDS);
    expect(layers.map(l => [l.id, l.defaultOn])).toEqual([
      ['context', true], ['limit', true], ['turns', true], ['compactions', true], ['truncations', true], ['output', false], ['cache-tokens', false], ['cache-breaks', false],
    ]);
  });
});

describe('Context Management session timeline panel', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.renderChart.mockReset();
    mocks.table.mockClear();
    mocks.destroyChartById.mockClear();
    document.body.innerHTML = '';
  });

  it('loads the timeline lazily, draws the default layers and toggles them', async () => {
    mocks.rpc.mockResolvedValue(DATA);
    const panel = document.createElement('div');
    document.body.append(panel);
    renderContextTimeline(panel, detail(), THRESHOLDS);
    expect(panel.textContent).toContain('Loading the session timeline');
    await vi.waitFor(() => expect(mocks.renderChart).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith('getSessionTimeline', { sessionId: 's1' });
    const [, , , options] = mocks.renderChart.mock.calls[0] as [string, unknown, unknown, { enabled: Set<string> }];
    const enabled = options.enabled;
    expect([...enabled]).toEqual(['context', 'limit', 'turns', 'compactions', 'truncations']);
    expect(panel.querySelector('canvas')?.getAttribute('aria-label')).toContain('1 compaction marked');
    expect(panel.textContent).toContain('Each bar covers 2 model calls of 6');
    // The chart's values as the shared table, with every layer.
    expect(mocks.table).toHaveBeenCalledWith(TIMELINE, expect.any(Array), 'calls', expect.stringContaining('Values of each bar'));
    expect((mocks.table.mock.calls[0] as unknown[])[1]).toHaveLength(8);
    expect(panel.textContent).toContain('values table');

    const output = panel.querySelector<HTMLButtonElement>('[data-layer="output"]')!;
    output.click();
    expect(output.getAttribute('aria-pressed')).toBe('true');
    expect(mocks.renderChart).toHaveBeenCalledTimes(2);
  });

  it('shows each turn as a table row behind a native expand button', async () => {
    mocks.rpc.mockResolvedValue(DATA);
    const panel = document.createElement('div');
    document.body.append(panel);
    renderContextTimeline(panel, detail(), THRESHOLDS);
    await vi.waitFor(() => expect(panel.querySelector('.ctx-tl-turns-toggle')).not.toBeNull());
    const toggle = panel.querySelector<HTMLButtonElement>('.ctx-tl-turns-toggle')!;
    const table = document.getElementById('ctxTlTurnTable')!;
    expect(table.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(table.hidden).toBe(false);
    const rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent?.trim()));
    expect(rows).toEqual([
      ['1', '300K', '300K', '968K', '31%', '3', '92.5%', '0'],
      ['2', '120K', '790K', '968K', '12.4%', '3', '88%', '1'],
    ]);
  });

  it('drops a response once the row was closed or another load started', async () => {
    let resolve: (value: SessionTimelineData) => void = () => {};
    mocks.rpc.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const panel = document.createElement('div');
    document.body.append(panel);
    renderContextTimeline(panel, detail(), THRESHOLDS);
    closeContextTimeline();
    resolve(DATA);
    await new Promise(r => setTimeout(r, 0));
    expect(mocks.renderChart).not.toHaveBeenCalled();
    expect(mocks.destroyChartById).toHaveBeenCalledWith('ctxSessionTimelineChart');
  });

  it('reports a failed load', async () => {
    mocks.rpc.mockRejectedValue(new Error('gone'));
    const panel = document.createElement('div');
    document.body.append(panel);
    renderContextTimeline(panel, detail(), THRESHOLDS);
    await vi.waitFor(() => expect(panel.textContent).toContain('Could not load the session timeline.'));
  });
});

describe('session timelines in the workspace table and in Context Composition', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.renderChart.mockReset();
    mocks.destroyChartById.mockClear();
    document.body.innerHTML = '';
  });

  it('keeps the two places apart, so both can be open', async () => {
    let resolveTable: (value: SessionTimelineData) => void = () => {};
    mocks.rpc.mockReturnValueOnce(new Promise(r => { resolveTable = r; })).mockResolvedValueOnce(DATA);
    const table = document.createElement('div');
    const composition = document.createElement('div');
    document.body.append(table, composition);
    renderContextTimeline(table, detail(), THRESHOLDS);
    renderContextTimeline(composition, detail(), THRESHOLDS, 'composition');
    await vi.waitFor(() => expect(mocks.renderChart).toHaveBeenCalledTimes(1));
    expect(composition.querySelector('canvas')?.id).toBe('ctxCompSessionTimelineChart');
    expect(composition.querySelector('.ctx-tl-turns-toggle')?.getAttribute('aria-controls')).toBe('ctxCompTlTurnTable');

    // Closing one place neither drops the other's load nor destroys its chart.
    closeContextTimeline('composition');
    expect(mocks.destroyChartById).toHaveBeenCalledWith('ctxCompSessionTimelineChart');
    expect(mocks.destroyChartById).not.toHaveBeenCalledWith('ctxSessionTimelineChart');
    resolveTable(DATA);
    await vi.waitFor(() => expect(mocks.renderChart).toHaveBeenCalledTimes(2));
    expect(mocks.renderChart.mock.calls.map(call => String(call[0]))).toEqual(['ctxCompSessionTimelineChart', 'ctxSessionTimelineChart']);
    expect(table.querySelector('canvas')?.id).toBe('ctxSessionTimelineChart');
  });
});
