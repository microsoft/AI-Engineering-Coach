/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { TurnContextAccumulator, type ContextCall } from './cli-turn-context';

function main(inputTokens: number, maxPromptTokens: number | null = 968_000): ContextCall {
  return { stream: 'main', inputTokens, maxPromptTokens };
}

describe('TurnContextAccumulator', () => {
  it('reports the last and largest main-agent prompt and the last reported limit', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(120_000));
    acc.addCall(main(250_000));
    // Compaction during the turn: the next prompt is much smaller.
    acc.addCall(main(60_000));
    acc.addCall(main(75_000));
    expect(acc.result()).toEqual({ lastPromptTokens: 75_000, peakPromptTokens: 250_000, contextLimit: 968_000 });
  });

  it('ignores sub-agent calls, which have their own context', () => {
    const acc = new TurnContextAccumulator();
    acc.addCall(main(100_000));
    acc.addCall({ stream: 'subagent', inputTokens: 900_000, maxPromptTokens: 128_000 });
    expect(acc.result()).toEqual({ lastPromptTokens: 100_000, peakPromptTokens: 100_000, contextLimit: 968_000 });
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
