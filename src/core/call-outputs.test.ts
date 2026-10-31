/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import {
  addRowOutputs,
  cliOutputSample,
  finishRowOutputs,
  MAX_LATENCY_SAMPLES,
  readCallOutputs,
  stopReasonSample,
  thinSamples,
} from './call-outputs';
import { RequestCacheBuilder } from './prompt-cache-usage';
import { ModelCallRowSchema } from './schemas';
import type { ModelCallRow } from './types';

/** A `usage` object shaped like a real `session.usage_record` call (counts only). */
const USAGE = {
  model: 'claude-opus-5.5',
  inputTokens: 210_000,
  outputTokens: 1_800,
  reasoningTokens: 1_100,
  cacheReadTokens: 205_000,
  cacheWriteTokens: 4_000,
  maxPromptTokens: 968_000,
  maxOutputTokens: 32_000,
  finishReason: 'tool_calls',
  contentFilterTriggered: false,
  timeToFirstTokenMs: 3_210.4,
  outputTtftMs: 5_100,
  duration: 7_800,
  toolCounts: { secret_tool_name: 2 },
};

function row(): ModelCallRow {
  return { stream: 'main', model: 'claude-opus-5.5', calls: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
}

describe('readCallOutputs', () => {
  it('reads output, reasoning, limit, finish reason and first-token time', () => {
    expect(readCallOutputs(USAGE)).toEqual({
      outputTokens: 1_800,
      reasoningTokens: 1_100,
      maxPromptTokens: 968_000,
      finishReason: 'tool_calls',
      contentFilter: false,
      ttftMs: 3_210.4,
    });
  });

  it('caps reasoning at output, maps unknown finish reasons and treats missing fields as not reported', () => {
    expect(readCallOutputs({ outputTokens: 100, reasoningTokens: 140, finishReason: 'tool_use_pending' })).toMatchObject({
      reasoningTokens: 100,
      finishReason: 'other',
    });
    expect(readCallOutputs({})).toEqual({
      outputTokens: 0, reasoningTokens: null, maxPromptTokens: null, finishReason: null, contentFilter: false, ttftMs: null,
    });
    expect(readCallOutputs({ finishReason: 'content_filter', maxPromptTokens: 0, timeToFirstTokenMs: -1 })).toMatchObject({
      contentFilter: true, maxPromptTokens: null, ttftMs: null,
    });
  });
});

describe('row outputs', () => {
  it('sums a Copilot CLI call onto its row, with truncation, content filter and latency', () => {
    const r = row();
    addRowOutputs(r, cliOutputSample({ ...readCallOutputs(USAGE), durationMs: 7_800 }));
    addRowOutputs(r, cliOutputSample({ ...readCallOutputs({ ...USAGE, finishReason: 'length', contentFilterTriggered: true, timeToFirstTokenMs: 900 }), durationMs: null }));
    expect(r).toMatchObject({ outputTokens: 3_600, reasoningTokens: 2_200, truncatedCalls: 1, filteredCalls: 1, ttftMs: [3_210, 900], durationMs: [7_800] });
  });

  it('keeps fields a harness does not log absent, not zero', () => {
    const r = row();
    addRowOutputs(r, stopReasonSample(false));
    addRowOutputs(r, stopReasonSample(true));
    expect(r).toMatchObject({ truncatedCalls: 1 });
    for (const key of ['outputTokens', 'reasoningTokens', 'filteredCalls', 'ttftMs', 'durationMs']) expect(r).not.toHaveProperty(key);
  });

  it('thins latency samples evenly, keeping the first and last', () => {
    const values = Array.from({ length: 1_000 }, (_, i) => i);
    const thinned = thinSamples(values);
    expect(thinned).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(thinned[0]).toBe(0);
    expect(thinned.at(-1)).toBe(999);
    expect(thinSamples([1, 2, 3])).toEqual([1, 2, 3]);
    expect(thinSamples([1, 2, 3], 1)).toEqual([1]);

    const r = row();
    for (let i = 0; i < 300; i++) addRowOutputs(r, cliOutputSample({ ...readCallOutputs({ outputTokens: 1, timeToFirstTokenMs: i }), durationMs: i }));
    finishRowOutputs(r);
    expect(r.ttftMs).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(r.durationMs).toHaveLength(MAX_LATENCY_SAMPLES);
  });

  it('goes through the shared request builder and passes the row schema', () => {
    const builder = new RequestCacheBuilder();
    for (let i = 0; i < 200; i++) {
      builder.addCall('main', 'claude-opus-5.5', {
        input: 100_000, cacheRead: 90_000, cacheWrite: 10_000,
        outputs: cliOutputSample({ ...readCallOutputs({ ...USAGE, finishReason: i === 7 ? 'length' : 'stop' }), durationMs: 5_000 + i }),
      });
    }
    builder.addCall('subagent', 'claude-haiku-4.5', { input: 10_000, cacheRead: 0, cacheWrite: 0, outputs: stopReasonSample(false) });
    builder.addTruncated('subagent', 'claude-haiku-4.5');
    const taken = builder.take();
    const [main, sub] = taken?.rows ?? [];
    expect(main).toMatchObject({ calls: 200, outputTokens: 360_000, reasoningTokens: 220_000, truncatedCalls: 1, filteredCalls: 0 });
    expect(main.ttftMs).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(main.durationMs?.[0]).toBe(5_000);
    expect(main.durationMs?.at(-1)).toBe(5_199);
    expect(sub).toMatchObject({ stream: 'subagent', calls: 1, truncatedCalls: 1 });
    for (const r of taken?.rows ?? []) expect(ModelCallRowSchema.safeParse(r).success).toBe(true);
    expect(JSON.stringify(taken)).not.toContain('secret_tool_name');
  });
});
