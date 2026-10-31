/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { addCallOutputs, emptyCallOutputs, finishCallOutputs, MAX_LATENCY_SAMPLES, readCallOutputs, thinSamples } from './call-outputs';

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

describe('readCallOutputs', () => {
  it('reads output, reasoning, limit, finish reason and latency', () => {
    expect(readCallOutputs(USAGE)).toEqual({
      outputTokens: 1_800,
      reasoningTokens: 1_100,
      maxPromptTokens: 968_000,
      finishReason: 'tool_calls',
      contentFilter: false,
      ttftMs: 3_210.4,
      durationMs: 7_800,
    });
  });

  it('caps reasoning at the output it is part of', () => {
    expect(readCallOutputs({ ...USAGE, outputTokens: 500, reasoningTokens: 900 }).reasoningTokens).toBe(500);
  });

  it('maps finish reasons and the content filter', () => {
    expect(readCallOutputs({ ...USAGE, finishReason: 'length' }).finishReason).toBe('length');
    expect(readCallOutputs({ ...USAGE, finishReason: 'something_new' }).finishReason).toBe('other');
    const filtered = readCallOutputs({ ...USAGE, finishReason: 'content_filter' });
    expect(filtered.finishReason).toBe('content_filter');
    expect(filtered.contentFilter).toBe(true);
    expect(readCallOutputs({ ...USAGE, contentFilterTriggered: true }).contentFilter).toBe(true);
  });

  it('returns nulls for fields older builds do not log', () => {
    expect(readCallOutputs({ inputTokens: 1000, outputTokens: 20 })).toEqual({
      outputTokens: 20, reasoningTokens: null, maxPromptTokens: null, finishReason: null, contentFilter: false, ttftMs: null, durationMs: null,
    });
  });

  it('never exposes tool names', () => {
    expect(JSON.stringify(readCallOutputs(USAGE))).not.toContain('secret_tool_name');
  });
});

describe('call output totals', () => {
  it('sums tokens, counts truncated and filtered calls, and keeps latency samples', () => {
    const totals = emptyCallOutputs();
    addCallOutputs(totals, readCallOutputs(USAGE));
    addCallOutputs(totals, readCallOutputs({ ...USAGE, finishReason: 'length', reasoningTokens: undefined, timeToFirstTokenMs: undefined }));
    addCallOutputs(totals, readCallOutputs({ ...USAGE, contentFilterTriggered: true }));
    expect(totals).toEqual({
      outputTokens: 5_400,
      reasoningTokens: 2_200,
      truncatedCalls: 1,
      filteredCalls: 1,
      ttftMs: [3_210, 3_210],
      durationMs: [7_800, 7_800, 7_800],
    });
  });

  it('leaves reasoning null when no call reported it', () => {
    const totals = emptyCallOutputs();
    addCallOutputs(totals, readCallOutputs({ outputTokens: 10 }));
    expect(totals.reasoningTokens).toBeNull();
  });

  it('thins long latency series evenly, keeping the first and last sample', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const thinned = thinSamples(values);
    expect(thinned).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(thinned[0]).toBe(0);
    expect(thinned.at(-1)).toBe(999);
    expect(thinSamples([1, 2, 3])).toEqual([1, 2, 3]);
    expect(thinSamples([1, 2, 3], 1)).toEqual([1]);

    const totals = { ...emptyCallOutputs(), ttftMs: values, durationMs: values };
    const finished = finishCallOutputs(totals);
    expect(finished.ttftMs).toHaveLength(MAX_LATENCY_SAMPLES);
    expect(finished.durationMs).toHaveLength(MAX_LATENCY_SAMPLES);
  });
});
