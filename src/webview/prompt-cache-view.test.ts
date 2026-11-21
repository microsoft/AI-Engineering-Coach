/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import type { CacheAttribution, CacheIdleSummary, HarnessPromptCache, PromptCacheData, PromptCacheTrend } from '../core/types';
import { renderAttribution, renderKpis, renderTrendPanel } from './prompt-cache-view';
import { render } from './render';

vi.mock('./shared', () => ({
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

const NO_RETURNS: CacheIdleSummary = { ttlByModel: [], returns: 0, expiredReturns: 0, unmeasuredReturns: 0, buckets: [], medianIdleMinutes: null };

/** 40 main-agent calls on 19K-token prompts that read nothing from the cache: below the break threshold. */
function attribution(extra: Partial<CacheAttribution> = {}): CacheAttribution {
  return {
    label: 'Copilot App',
    harnesses: ['GitHub Copilot App'],
    mainCalls: 40,
    breaks: 0,
    breaksPer100: 0,
    omittedBreaks: 0,
    rebuiltTokens: 0,
    causes: [],
    confidence: { logged: 0, checkpoint: 0, unattributed: 0 },
    controlPct: { you: 0, partly: 0, harness: 0, unknown: 0 },
    misses: 760_000,
    origins: [{ origin: 'growth', tokens: 760_000, pct: 100, costPct: null }],
    idle: NO_RETURNS,
    ...extra,
  };
}

function textOf(a: CacheAttribution): string {
  const host = document.createElement('div');
  render(renderAttribution(a), host);
  return host.textContent ?? '';
}

/** Prompt Cache data for one Copilot App harness, with the given cost effect and weekly trend. */
function cacheData(savedPct: number, trend: PromptCacheTrend = { labels: [], series: [] }): PromptCacheData {
  const harness: HarnessPromptCache = {
    harness: 'GitHub Copilot App', reporting: 'per-call', attribution: true,
    all: { calls: 1, input: 100_000, cacheRead: 0, cacheWrite: 100_000, uncached: 0, hitPct: 0, writePct: 100, uncachedPct: 0 },
    main: null, subagents: null, compaction: null,
    cost: { savedPct, missCostPct: 100, ratedPct: 100 },
    breaks: 0, breaksPer100: 0, totalRequests: 1, requestsWithData: 1, sessions: 1, sessionsWithData: 1,
  };
  return {
    harnesses: [harness], attribution: null, returnsWithoutCacheData: null, models: [], workspaces: [], trend, topSessions: [], tips: [],
    coverage: { requestsWithData: 1, totalRequests: 1, sessionsWithData: 1, totalSessions: 1 },
  };
}

function mount(children: ReturnType<typeof renderKpis>): HTMLElement {
  const host = document.createElement('div');
  render(children, host);
  return host;
}

describe('renderKpis', () => {
  it('shows a negative saving with the reason when caching cost more than it saved', () => {
    const chip = [...mount(renderKpis(cacheData(-25))).querySelectorAll('.ctx-comp-kpi')].find(el => el.textContent?.includes('Input cost saved'));
    expect(chip?.querySelector('.ctx-comp-kpi-value')?.textContent).toBe('\u221225%');
    expect(chip?.textContent).toContain('caching cost more than it saved');
    expect(chip?.getAttribute('data-tip')).toContain('Caching cost more than it saved for Copilot App prompts');
  });

  it('keeps the plain wording for a positive saving', () => {
    const chip = [...mount(renderKpis(cacheData(90.4))).querySelectorAll('.ctx-comp-kpi')].find(el => el.textContent?.includes('Input cost saved'));
    expect(chip?.querySelector('.ctx-comp-kpi-value')?.textContent).toBe('90%');
    expect(chip?.textContent).not.toContain('cost more');
  });
});

describe('renderTrendPanel', () => {
  it('offers the weekly trend as a keyboard-accessible table with the tooltip figures', () => {
    const trend: PromptCacheTrend = {
      labels: ['2026-10-19', '2026-10-26'],
      series: [
        { harness: 'GitHub Copilot App', hitPct: [96.8, 97], breaksPer100: [2.2, null], calls: [4100, 3800] },
        { harness: 'Claude', hitPct: [null, 91], breaksPer100: [null, null], calls: [0, 2100] },
      ],
    };
    const host = mount(renderTrendPanel(cacheData(90, trend)));
    const details = host.querySelector('details#ctxCacheTrendData');
    expect(details?.querySelector('summary')?.textContent).toBe('Show the chart as a table');
    expect(details?.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0');
    const rows = [...(details?.querySelectorAll('tbody tr') ?? [])].map(row => [...row.children].map(cell => cell.textContent?.trim()));
    expect(rows).toEqual([
      ['2026-10-19', 'Copilot App', '97%', '2.2', '4100'],
      ['2026-10-19', 'Claude', '\u2014', '\u2014', '0'],
      ['2026-10-26', 'Copilot App', '97%', '\u2014', '3800'],
      ['2026-10-26', 'Claude', '91%', '\u2014', '2100'],
    ]);
  });
});

describe('renderAttribution', () => {
  it('says no call crossed the break threshold rather than that every call reused the cache', () => {
    const text = textOf(attribution());
    expect(text).toContain('No cache breaks in this range: no main-agent call re-sent at least 30% (and 10K tokens) of a previous prompt of 20K tokens or more.');
    expect(text).not.toContain('reused the previous call');
  });

  it('labels the remaining cache misses as new context and minor misses', () => {
    expect(textOf(attribution())).toContain('New context and minor misses');
  });

  it('says expiry can’t be measured when no return followed a call that logged it', () => {
    const text = textOf(attribution({ idle: { ...NO_RETURNS, unmeasuredReturns: 2 } }));
    expect(text).toContain('2 returns came after a call that didn’t log when its cache expires, so expiry can’t be measured.');
    expect(text).not.toContain('No returns to an earlier call');
  });
});
