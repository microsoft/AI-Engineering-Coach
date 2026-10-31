/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { SessionRequestSchema } from './schemas';
import { createRequest } from './parser-shared';
import { MAX_TURN_COMPACTIONS, MAX_TURN_SUBAGENT_RUNS } from './token-usage-schemas';
import type { CompactionEvent, SubagentRun } from './types';

const COMPACTION: CompactionEvent = {
  mode: 'full', numRounds: 0, numRoundsSinceLastSummarization: 0, contextLengthBefore: 245_000, durationMs: 45_000,
  model: 'claude-opus-5.5', outcome: 'success', contextLengthAfter: 52_000, tokenLimit: 300_000, trigger: 'threshold',
  checkpointNumber: 2, tokensUsed: { input: 260_000, output: 8_000, cacheRead: 200_000, cacheWrite: 18_000 },
};

const RUN: SubagentRun = { agentType: 'research', model: 'claude-sonnet-5', mode: 'background', totalTokens: 1_000_000, toolCalls: 12, durationMs: 60_000, cancelled: false };

function request(overrides: Record<string, unknown>) {
  return { ...createRequest({ messageText: 'q', responseText: 'a' }), ...overrides };
}

describe('token-usage fields on SessionRequest', () => {
  it('accepts per-turn context, every compaction and sub-agent runs', () => {
    const parsed = SessionRequestSchema.safeParse(request({
      contextUsage: { lastPromptTokens: 80_000, peakPromptTokens: 780_000, contextLimit: 968_000, calls: 6 },
      compaction: COMPACTION,
      compactions: [COMPACTION, COMPACTION],
      subagentRuns: [RUN],
    }));
    expect(parsed.success).toBe(true);
    // A turn whose calls were all sub-agent calls has no context of its own.
    const subagentsOnly = { lastPromptTokens: 0, peakPromptTokens: 0, contextLimit: null, calls: 0 };
    expect(SessionRequestSchema.safeParse(request({ contextUsage: subagentsOnly })).success).toBe(true);
    expect(SessionRequestSchema.safeParse(request({ contextUsage: { ...subagentsOnly, calls: -1 } })).success).toBe(false);
  });

  it('rejects unexpected keys, unknown agent types and oversized lists', () => {
    expect(SessionRequestSchema.safeParse(request({ contextUsage: { lastPromptTokens: 1, peakPromptTokens: 1, contextLimit: null, calls: 1, prompt: 'x' } })).success).toBe(false);
    expect(SessionRequestSchema.safeParse(request({ subagentRuns: [{ ...RUN, agentType: 'my-private-agent' }] })).success).toBe(false);
    expect(SessionRequestSchema.safeParse(request({ subagentRuns: [{ ...RUN, agentName: 'leak' }] })).success).toBe(false);
    expect(SessionRequestSchema.safeParse(request({ compactions: Array.from({ length: MAX_TURN_COMPACTIONS + 1 }, () => COMPACTION) })).success).toBe(false);
    expect(SessionRequestSchema.safeParse(request({ subagentRuns: Array.from({ length: MAX_TURN_SUBAGENT_RUNS + 1 }, () => RUN) })).success).toBe(false);
    expect(SessionRequestSchema.safeParse(request({ compaction: { ...COMPACTION, tokensUsed: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, nanoAiu: 5 } } })).success).toBe(false);
  });
});
