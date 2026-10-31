/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { readCliModelCall } from './cli-model-calls';

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
