/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { TurnContextAccumulator, type ContextCall } from './cli-turn-context';

function main(inputTokens: number, maxPromptTokens: number | null = 968_000, model?: string): ContextCall {
  return { stream: 'main', inputTokens, maxPromptTokens, ...(model ? { model } : {}) };
}

describe('TurnContextAccumulator', () => {
  it('reports the last and largest main-agent prompt and the last reported limit', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(120_000));
    acc.addCall(main(250_000));
    // Compaction during the turn: the next prompt is much smaller.
    acc.addCall(main(60_000));
    acc.addCall(main(75_000));
    expect(acc.result()).toEqual({ lastPromptTokens: 75_000, peakPromptTokens: 250_000, contextLimit: 968_000, calls: 4 });
  });

  it('ignores sub-agent calls, which have their own context', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(100_000));
    acc.addCall({ stream: 'subagent', inputTokens: 900_000, maxPromptTokens: 128_000 });
    expect(acc.result()).toEqual({ lastPromptTokens: 100_000, peakPromptTokens: 100_000, contextLimit: 968_000, calls: 1 });
  });

  it('keeps the latest limit when a call does not report one, and falls back to a compaction limit', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(10_000, 272_000));
    acc.addCall(main(12_000, null));
    expect(acc.result()?.contextLimit).toBe(272_000);

    const noLimit = new TurnContextAccumulator();
    noLimit.addCall(main(10_000, null));
    expect(noLimit.result()?.contextLimit).toBeNull();
    noLimit.addLimit(200_000);
    expect(noLimit.result()?.contextLimit).toBe(200_000);
  });

  it('returns undefined when the turn logged no usable main-agent call', () => {
    const acc = new TurnContextAccumulator();
    expect(acc.result()).toBeUndefined();
    acc.addCall(main(0));
    acc.addCall(main(Number.NaN));
    acc.addLimit(300_000);
    expect(acc.result()).toBeUndefined();
  });
});

describe('TurnContextAccumulator when the model changes within a turn', () => {
  it('applies a reported limit only to calls of the model that reported it', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(100_000, 968_000, 'claude-opus-5.5'));
    // The model changes within the turn and its call reports no limit: the other model's 968K doesn't apply.
    acc.addCall(main(150_000, null, 'gpt-6.1-sol'));
    expect(acc.result()?.contextLimit).toBeNull();
    // Back on the first model, its own limit applies again.
    acc.addCall(main(160_000, null, 'claude-opus-5.5'));
    expect(acc.result()?.contextLimit).toBe(968_000);
  });

  it('applies a compaction limit only to the model whose context it compacted', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(10_000, null, 'gpt-6.1-sol'));
    acc.addLimit(272_000);
    expect(acc.result()?.contextLimit).toBe(272_000);
    acc.addCall(main(12_000, null, 'claude-opus-5.5'));
    expect(acc.result()?.contextLimit).toBeNull();

    // A compaction logged before a turn's first call compacted the context of the previous call's model.
    acc.take();
    acc.addLimit(200_000);
    acc.addCall(main(30_000, null, 'claude-opus-5.5'));
    expect(acc.result()?.contextLimit).toBe(200_000);
  });

  it('applies a compaction logged before the session\u2019s first call to the selected model only', () => {
    const acc = new TurnContextAccumulator();
    acc.addLimit(300_000, 'claude-opus-5.5');
    acc.addCall(main(50_000, null, 'claude-opus-5.5'));
    expect(acc.result()?.contextLimit).toBe(300_000);

    const other = new TurnContextAccumulator();
    other.addLimit(300_000, 'claude-opus-5.5');
    other.addCall(main(50_000, null, 'gpt-6.1-sol'));
    expect(other.result()?.contextLimit).toBeNull();
  });
});
