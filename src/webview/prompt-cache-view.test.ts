/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import type { CacheAttribution, CacheIdleSummary } from '../core/types';
import { renderAttribution } from './prompt-cache-view';
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
