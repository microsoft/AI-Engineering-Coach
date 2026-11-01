/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

/* The Prompt Cache page for a range in which no call logged cache tokens: the returns its prompts counted still
 * show, measured against the calls they returned to, which can be outside the range. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheAttribution, CacheIdleSummary, HarnessPromptCache, PromptCacheData } from '../core/types';
import { renderPromptCache } from './page-prompt-cache';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('./shared', () => ({
  rpc,
  Chart: class {},
  trackChart: vi.fn(),
  createChart: vi.fn(),
  destroyChartById: vi.fn(),
  formatNum: (n: number) => String(n),
  harnessColor: () => '#888888',
  COLORS: new Proxy({}, { get: () => '#888888' }),
}));

/** A Copilot App harness whose requests in range logged no cache tokens. */
const HARNESS: HarnessPromptCache = {
  harness: 'GitHub Copilot App', reporting: 'per-call', attribution: false,
  all: null, main: null, subagents: null, compaction: null, cost: null,
  breaks: null, breaksPer100: null, totalRequests: 1, requestsWithData: 0, sessions: 1, sessionsWithData: 0,
};

function attribution(idle: Partial<CacheIdleSummary>): CacheAttribution {
  return {
    label: 'Copilot App', harnesses: ['GitHub Copilot App'], mainCalls: 0, breaks: 0, breaksPer100: 0, omittedBreaks: 0, rebuiltTokens: 0,
    causes: [], confidence: { logged: 0, checkpoint: 0, unattributed: 0 }, controlPct: { you: 0, partly: 0, harness: 0, unknown: 0 },
    misses: 0, origins: [],
    idle: { ttlByModel: [], returns: 0, expiredReturns: 0, unmeasuredReturns: 0, buckets: [], medianIdleMinutes: null, ...idle },
  };
}

async function page(a: CacheAttribution | null): Promise<HTMLElement> {
  const data: PromptCacheData = {
    harnesses: [HARNESS], attribution: a, models: [], workspaces: [], trend: { labels: [], series: [] }, topSessions: [], tips: [],
    coverage: { requestsWithData: 0, totalRequests: 1, sessionsWithData: 0, totalSessions: 1 },
  };
  rpc.mockResolvedValueOnce(data);
  const host = document.createElement('div');
  await renderPromptCache(host, {});
  return host;
}

describe('Prompt Cache page for a range without cache data', () => {
  beforeEach(() => rpc.mockReset());

  it.each([
    [{ returns: 1, expiredReturns: 1 }, 'You came back after the cache expired in 1 of 1 returns (100%).'],
    [{ unmeasuredReturns: 2 }, '2 returns came after a call that didn\u2019t log when its cache expires, so expiry can\u2019t be measured.'],
  ])('still shows the returns its prompts counted (%j)', async (idle, text) => {
    const host = await page(attribution(idle));
    expect(host.querySelector('#ctxCacheEmpty')).not.toBeNull();
    expect(host.querySelector('#ctxCacheEmptyReturns')?.textContent).toContain(text);
  });

  it('shows no returns without any', async () => {
    const host = await page(null);
    expect(host.querySelector('#ctxCacheEmpty')).not.toBeNull();
    expect(host.querySelector('#ctxCacheEmptyReturns')).toBeNull();
  });
});
