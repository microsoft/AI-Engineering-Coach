/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Token types summed over the shared per-request rows, from calls accumulated by `RequestCacheBuilder`: only
 * calls that logged a value count toward it, and reasoning is split by the effort each call ran at. */

import { describe, it, expect } from 'vitest';
import { cliOutputSample, readCallOutputs } from './call-outputs';
import { RequestCacheBuilder, type CacheCallSample } from './prompt-cache-usage';
import { ModelCallRowSchema } from './schemas';
import { mainTokens, rowReasoning, rowTruncation } from './token-types-rows';
import type { CacheStream, ModelCallRow } from './types';

const MODEL = 'claude-opus-5.5';

/** A Copilot CLI call as `session.usage_record` logs it (counts and enums only). */
function cliCall(usage: Record<string, unknown>, reasoningEffort: string | null = 'high'): CacheCallSample {
  return { input: 100_000, cacheRead: 90_000, cacheWrite: 10_000, reasoningEffort, outputs: cliOutputSample({ ...readCallOutputs(usage), durationMs: null }) };
}

/** The rows of one request; every row must pass the stored schema. */
function rowsOf(calls: [CacheStream, CacheCallSample][]): ModelCallRow[] {
  const builder = new RequestCacheBuilder();
  for (const [stream, sample] of calls) builder.addCall(stream, MODEL, sample);
  const rows = builder.take()?.rows ?? [];
  for (const row of rows) expect(ModelCallRowSchema.safeParse(row).success).toBe(true);
  return rows;
}

describe('truncation over the calls that logged why they stopped', () => {
  it('leaves a call without a finish reason out of the rate instead of counting it as not truncated', () => {
    const rows = rowsOf([
      ['main', cliCall({ outputTokens: 900, finishReason: 'length', contentFilterTriggered: false })],
      ['main', cliCall({ outputTokens: 900, finishReason: 'stop', contentFilterTriggered: false })],
      ['main', cliCall({ outputTokens: 900 })],
    ]);
    expect(rows[0]).toMatchObject({ calls: 3, truncatedCalls: 1, stopCalls: 2, filteredCalls: 0 });
    expect(rowTruncation(rows)).toEqual({ calls: 2, truncatedCalls: 1, filteredCalls: 0 });
  });

  it('reports no content-filter count when no call logged one, rather than zero', () => {
    const rows = rowsOf([
      ['main', cliCall({ outputTokens: 900, finishReason: 'stop' })],
      ['main', cliCall({ outputTokens: 900, finishReason: 'length' })],
    ]);
    expect(rows[0]).not.toHaveProperty('filteredCalls');
    // Every call logged its stop reason, so the row needs no separate denominator.
    expect(rows[0]).not.toHaveProperty('stopCalls');
    expect(rowTruncation(rows)).toEqual({ calls: 2, truncatedCalls: 1, filteredCalls: null });
  });
});

describe('reasoning over the calls that logged it, by effort', () => {
  it('measures the share over the calls that logged reasoning, keeping total output unchanged', () => {
    const rows = rowsOf([
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 600 })],
      ['main', cliCall({ outputTokens: 1_000 })],
    ]);
    expect(rows[0]).toMatchObject({
      outputTokens: 2_000,
      reasoningTokens: 600,
      reasoningByEffort: [{ effort: 'high', calls: 1, outputTokens: 1_000, reasoningTokens: 600 }],
    });
    const reasoning = rowReasoning(rows);
    expect(reasoning?.main).toEqual({ outputTokens: 1_000, reasoningTokens: 600, sharePct: 60 });
    expect(reasoning?.byEffort).toEqual([{ effort: 'high', stream: 'main', calls: 1, outputTokens: 1_000, reasoningTokens: 600, sharePct: 60 }]);
    expect(mainTokens(rows)).toEqual({ input: 200_000, output: 2_000 });
  });

  it('attributes same-model calls at different efforts to their own effort, for the main agent and sub-agents', () => {
    const rows = rowsOf([
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 800 }, 'high')],
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 800 }, 'high')],
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 100 }, 'low')],
      ['subagent', cliCall({ outputTokens: 500, reasoningTokens: 50 }, 'low')],
      ['subagent', cliCall({ outputTokens: 500, reasoningTokens: 400 }, 'xhigh')],
    ]);
    const reasoning = rowReasoning(rows);
    expect(reasoning?.byEffort.map(e => [e.stream, e.effort, e.calls, e.sharePct])).toEqual([
      ['main', 'high', 2, 80],
      ['main', 'low', 1, 10],
      ['subagent', 'max', 1, 80],
      ['subagent', 'low', 1, 10],
    ]);
    expect(reasoning?.main?.sharePct).toBe(56.7);
    expect(reasoning?.subagent?.sharePct).toBe(45);
  });

  it('stores neither the effort split nor a denominator when the row already says it', () => {
    const rows = rowsOf([
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 600, finishReason: 'tool_calls', contentFilterTriggered: false })],
      ['main', cliCall({ outputTokens: 1_000, reasoningTokens: 200, finishReason: 'stop', contentFilterTriggered: false })],
    ]);
    for (const key of ['reasoningByEffort', 'stopCalls']) expect(rows[0]).not.toHaveProperty(key);
    expect(rowReasoning(rows)?.byEffort).toEqual([{ effort: 'high', stream: 'main', calls: 2, outputTokens: 2_000, reasoningTokens: 800, sharePct: 40 }]);
    expect(rowTruncation(rows)).toEqual({ calls: 2, truncatedCalls: 0, filteredCalls: 0 });
  });
});
