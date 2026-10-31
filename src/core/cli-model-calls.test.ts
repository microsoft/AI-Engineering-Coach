/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { readCliModelCall } from './cli-model-calls';
import { addUsage, emptyTotals, toCost } from './prompt-cache-totals';
import { RequestCacheBuilder } from './prompt-cache-usage';

const LOGGED_AT = Date.parse('2026-10-28T09:05:00Z');

function usage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usage: {
      model: 'claude-opus-5.5',
      interactionType: 'conversation-agent',
      initiator: 'user',
      inputTokens: 120_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 15_000,
      cacheDetailsReported: true,
      cacheExpiresAt: '2026-10-28T09:09:30Z',
      cacheTtlSeconds: 300,
      ...extra,
    },
  };
}

describe('readCliModelCall', () => {
  it('derives when the call started from its logged duration', () => {
    const call = readCliModelCall(usage({ duration: 30_000 }), LOGGED_AT, 'fallback');
    expect(call).toMatchObject({ timestamp: LOGGED_AT, durationMs: 30_000, startTs: LOGGED_AT - 30_000, stream: 'main', initiator: 'user' });
    // The cache lifetime counts from the start.
    expect(call!.cacheExpiresAt! - call!.cacheTtlSeconds! * 1000).toBe(call!.startTs);
  });

  it('falls back to the logged time without a duration, and to null without a timestamp', () => {
    expect(readCliModelCall(usage(), LOGGED_AT, 'fallback')).toMatchObject({ durationMs: null, startTs: LOGGED_AT });
    expect(readCliModelCall(usage({ duration: -5 }), LOGGED_AT, 'fallback')).toMatchObject({ durationMs: null, startTs: LOGGED_AT });
    expect(readCliModelCall(usage({ duration: 30_000 }), null, 'fallback')).toMatchObject({ durationMs: 30_000, startTs: null });
  });

  it('keeps cached tokens inside the prompt-token count and skips records without prompt tokens', () => {
    expect(readCliModelCall(usage({ inputTokens: 5_000 }), LOGGED_AT, 'fallback')).toMatchObject({ inputTokens: 120_000, cacheReadTokens: 100_000, cacheWriteTokens: 15_000 });
    expect(readCliModelCall(usage({ inputTokens: 0 }), LOGGED_AT, 'fallback')).toBeNull();
  });
});

/** `copilotUsage` whose token details price each token type per token (cost per batch ÷ batch size). */
function priced(input: number, read: number, write: number): Record<string, unknown> {
  const detail = (tokenType: string, price: number) => ({ tokenType, tokenCount: 0, batchSize: 1_000_000, costPerBatch: price * 1_000_000 });
  return { tokenDetails: [detail('input', input), detail('cache_read', read), detail('cache_write', write)] };
}

describe('cost shares across models with different prices', () => {
  it('adds costs up in the logged price unit, so pricier calls weigh more', () => {
    // 100K uncached tokens at input price 20, and 100K cached tokens at input price 1 and read price 0.1. Weighing
    // each call by its own input price reported 45% saved; in the logged unit it is 4.3%.
    const expensive = readCliModelCall(usage({ model: 'gpt-6-astra', inputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, copilotUsage: priced(20, 2, 25) }), LOGGED_AT, 'fallback');
    const cheap = readCliModelCall(usage({ inputTokens: 100_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, copilotUsage: priced(1, 0.1, 1.25) }), LOGGED_AT, 'fallback');
    expect(expensive?.rates).toEqual({ inputPrice: 20, cacheRead: 0.1, cacheWrite: 1.25 });
    const builder = new RequestCacheBuilder();
    for (const call of [expensive, cheap]) {
      if (call) builder.addCall('main', call.model, { input: call.inputTokens, cacheRead: call.cacheReadTokens, cacheWrite: call.cacheWriteTokens, rates: call.rates });
    }
    const rows = builder.take()?.rows ?? [];
    expect(rows.map(row => [row.model, row.cost, row.missCost, row.baselineCost])).toEqual([
      ['gpt-6-astra', 2_000_000, 2_000_000, 2_000_000],
      ['claude-opus-5.5', 10_000, 0, 100_000],
    ]);
    const totals = emptyTotals();
    for (const row of rows) addUsage(totals, row);
    expect(toCost(totals)).toEqual({ savedPct: 4.3, missCostPct: 99.5, ratedPct: 100 });
  });
});
