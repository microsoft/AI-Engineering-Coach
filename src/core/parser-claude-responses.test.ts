/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The Claude Code response accumulator: one record per `message.id`, from which a request's token totals, its context,
 * its prompt-cache rows and its rows without cache data come. Claude Code writes one line per content block, repeats
 * the response's usage on each, and logs why the response stopped on some of its lines only. Fixtures mirror those
 * shapes. */

import { describe, expect, it } from 'vitest';
import { ClaudeResponseAccumulator, type ClaudeResponseMessage } from './parser-claude-responses';

type Usage = Record<string, number>;
type Line = [message: ClaudeResponseMessage, sidechain?: boolean];
type CacheState = Parameters<ClaudeResponseAccumulator['finish']>[0];

const A: Usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 };
const B: Usage = { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 80 };
const ZERO: Usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
const prompt = (u: Usage): number => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/** One line of a response; `stop` undefined omits `stop_reason`, as the lines before the last one often do. */
function line(id: string | undefined, usage?: Usage, stop?: string | null): ClaudeResponseMessage {
  return { ...(id ? { id } : {}), model: 'claude-opus-4-6-20251001', ...(usage ? { usage } : {}), ...(stop !== undefined ? { stop_reason: stop } : {}) };
}

/** `requestSidechain`: the request is a sub-agent's prompt. */
function finish(lines: Line[], cacheState: CacheState = { sawMain: false }, requestSidechain = false) {
  const responses = new ClaudeResponseAccumulator(requestSidechain);
  for (const [message, sidechain] of lines) responses.add(message, sidechain === true);
  return responses.finish(cacheState);
}

describe('Claude Code response accumulator: one record per response', () => {
  it('derives the token totals, the context and the prompt-cache rows from one record per response', () => {
    const usage = finish([[line('msg_a', A)], [line('msg_a', A)], [line('msg_a', A)], [line('msg_b', B)], [line('msg_b', B)]]);
    expect(usage).toMatchObject({ promptTokens: prompt(A) + prompt(B), completionTokens: 130, cacheReadTokens: 40_000, cacheWriteTokens: 42_000, cacheReported: true });
    expect(usage.contextUsage).toEqual({ lastPromptTokens: prompt(B), peakPromptTokens: prompt(B), contextLimit: null, calls: 2 });
    expect(usage.promptCache).toEqual({
      rows: [{ stream: 'main', model: 'claude-opus-4.6', calls: 2, input: prompt(A) + prompt(B), cacheRead: 40_000, cacheWrite: 42_000 }],
      coldStart: prompt(A),
    });
    expect(usage).not.toHaveProperty('callRowsWithoutCacheData');
  });

  it('keeps the largest value of each field over the lines of a response, in the totals and the rows alike', () => {
    const usage = finish([[line('msg_a', { ...A, output_tokens: 12, cache_creation_input_tokens: 1_000 })], [line('msg_a', A)], [line('msg_a', { ...A, output_tokens: 3 })]]);
    expect(usage).toMatchObject({ promptTokens: prompt(A), completionTokens: 50, cacheWriteTokens: 40_000 });
    expect(usage.promptCache?.rows).toEqual([expect.objectContaining({ calls: 1, input: prompt(A), cacheWrite: 40_000 })]);
  });

  it('counts each line without an id as a response of its own, and skips one without usage', () => {
    const usage = finish([[line(undefined, A)], [line(undefined, A)], [line(undefined, undefined, 'max_tokens')]]);
    expect(usage).toMatchObject({ promptTokens: 2 * prompt(A), completionTokens: 100 });
    expect(usage.promptCache?.rows).toEqual([expect.objectContaining({ calls: 2, input: 2 * prompt(A) })]);
    expect(usage.promptCache?.rows[0]).not.toHaveProperty('truncatedCalls');
  });
});

describe('Claude Code response accumulator: cache fields and stop reasons', () => {
  it('keeps reported zero cache tokens as reported, and usage without cache fields as not reported', () => {
    const off = { input_tokens: 40_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 };
    const caching = finish([[line('msg_off', off)]]);
    expect(caching).toMatchObject({ cacheReported: true, cacheReadTokens: 0 });
    expect(caching.promptCache?.rows).toEqual([expect.objectContaining({ calls: 1, input: 40_000, cacheRead: 0 })]);
    const old = finish([[line('msg_old', { input_tokens: 30_000, output_tokens: 40 })]]);
    expect(old).toMatchObject({ promptTokens: 30_000, cacheReported: false, contextUsage: { lastPromptTokens: 30_000, calls: 1 } });
    expect(old).not.toHaveProperty('promptCache');
    expect(old.callRowsWithoutCacheData).toEqual([{ stream: 'main', model: 'claude-opus-4.6', calls: 1, input: 30_000 }]);
  });

  it('makes a response a prompt-cache call once one of its lines reports cache tokens for a prompt', () => {
    expect(finish([[line('msg_1', ZERO)], [line('msg_1', A)]]).promptCache?.rows).toEqual([expect.objectContaining({ calls: 1, input: prompt(A) })]);
    // Neither line qualifies on its own: one reports cache tokens without a prompt, the other a prompt without them.
    const split = finish([[line('msg_2', ZERO)], [line('msg_2', { input_tokens: 30_000, output_tokens: 40 })]]);
    expect(split).toMatchObject({ promptTokens: 30_000, cacheReported: true });
    expect(split).not.toHaveProperty('promptCache');
    expect(split.callRowsWithoutCacheData).toEqual([expect.objectContaining({ calls: 1, input: 30_000 })]);
  });

  it('takes a response\u2019s stop reason from any of its lines, before or after its usage', () => {
    const usage = finish([
      [line('msg_1', ZERO, 'max_tokens')], [line('msg_1', A, null)],
      [line('msg_2', A, null)], [line('msg_2', undefined, 'end_turn')],
      [line('msg_3', A, 'max_tokens')], [line('msg_3', A, 'end_turn')],
      [line('msg_4', A, null)], [line('msg_4', A)],
    ]);
    expect(usage.promptCache?.rows).toEqual([expect.objectContaining({ calls: 4, truncatedCalls: 2, stopCalls: 3 })]);
  });

  it('counts a response whose lines report no cache fields on a row without cache data, with its final stop reason', () => {
    const old = { input_tokens: 30_000, output_tokens: 40 };
    const usage = finish([
      [line('msg_old', old)], [line('msg_old', old, 'max_tokens')],
      [line(undefined, { input_tokens: 2_000, output_tokens: 5 }, 'end_turn')],
      // A later line that reports the cache makes the response a prompt-cache call instead.
      [line('msg_late', { input_tokens: 10, output_tokens: 1 })], [line('msg_late', A)],
    ]);
    expect(usage.callRowsWithoutCacheData).toEqual([{ stream: 'main', model: 'claude-opus-4.6', calls: 2, input: 32_000, truncatedCalls: 1 }]);
    expect(usage.promptCache?.rows).toEqual([expect.objectContaining({ calls: 1, input: prompt(A) })]);
  });

  it('takes a call without cache data\u2019s prompt from the largest of its lines, the value the totals count', () => {
    const growing = finish([[line('msg_g', { input_tokens: 10, output_tokens: 1 })], [line('msg_g', { input_tokens: 20, output_tokens: 5 })]]);
    expect(growing.callRowsWithoutCacheData).toEqual([expect.objectContaining({ calls: 1, input: 20 })]);
    const shrinking = finish([[line('msg_s', { input_tokens: 20, output_tokens: 1 })], [line('msg_s', { input_tokens: 10, output_tokens: 5 })]]);
    expect(shrinking).toMatchObject({ promptTokens: 20, completionTokens: 5 });
    expect(shrinking.callRowsWithoutCacheData).toEqual([expect.objectContaining({ calls: 1, input: 20 })]);
  });
});

describe('Claude Code response accumulator: streams and cold start', () => {
  it('puts sub-agent responses on their own stream, and counts only the session\u2019s first main-agent call as its cold start', () => {
    const cacheState: CacheState = { sawMain: false };
    const first = finish([[line('msg_s', A), true], [line('msg_m', B)]], cacheState);
    expect(first.promptCache?.rows.map(row => [row.stream, row.calls])).toEqual([['main', 1], ['subagent', 1]]);
    expect(first.promptCache?.coldStart).toBe(prompt(B) - 40_000);
    expect(finish([[line('msg_n', A)]], cacheState).promptCache).not.toHaveProperty('coldStart');
  });

  it('keeps a stop reason logged on a later line of a sub-agent\u2019s response on its sub-agent row', () => {
    const usage = finish([[line('msg_s', A, null), true], [line('msg_s', undefined, 'max_tokens'), true], [line('msg_m', B, 'end_turn')]]);
    expect(usage.promptCache?.rows).toEqual([
      expect.objectContaining({ stream: 'main', calls: 1, truncatedCalls: 0 }),
      expect.objectContaining({ stream: 'subagent', calls: 1, truncatedCalls: 1 }),
    ]);
  });
});

describe('Claude Code response accumulator: order and own chain', () => {
  it('takes a response\u2019s place from its first usage, not from an earlier line without usage', () => {
    const usage = finish([[line('msg_x')], [line('msg_y', B)], [line('msg_x', A)]]);
    expect(usage.contextUsage).toMatchObject({ lastPromptTokens: prompt(A), calls: 2 });
  });

  it('takes a call\u2019s stream and model from the line that counts it, and measures the context on that stream', () => {
    // Claude Code writes one stream and model on every line of a response; these lines disagree only to pin the rule.
    const usage = finish([
      [{ id: 'msg_x', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 30_000, output_tokens: 1 } }, true],
      [{ id: 'msg_x', model: 'claude-opus-4-6-20251001', usage: A }],
    ]);
    expect(usage.promptCache?.rows).toEqual([expect.objectContaining({ stream: 'main', model: 'claude-opus-4.6', calls: 1 })]);
    expect(usage.contextUsage).toMatchObject({ calls: 1 });
  });

  it('measures the context from the calls on the request\u2019s own chain only', () => {
    const lines: Line[] = [[line('msg_s', B), true], [line('msg_m', A)]];
    expect(finish(lines).contextUsage).toEqual({ lastPromptTokens: prompt(A), peakPromptTokens: prompt(A), contextLimit: null, calls: 1 });
    expect(finish(lines, undefined, true).contextUsage).toEqual({ lastPromptTokens: prompt(B), peakPromptTokens: prompt(B), contextLimit: null, calls: 1 });
    // Only sub-agent calls logged usage: the turn has no context of its own, but keeps their tokens.
    expect(finish([[line('msg_s', B), true]])).toMatchObject({ promptTokens: prompt(B), contextUsage: { lastPromptTokens: 0, peakPromptTokens: 0, contextLimit: null, calls: 0 } });
    const unmeasured = finish([[line('msg_bare', undefined, 'end_turn')]]);
    expect(unmeasured).not.toHaveProperty('contextUsage');
    expect(unmeasured).not.toHaveProperty('promptCache');
  });
});
