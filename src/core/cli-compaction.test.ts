/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot CLI compaction events: current fields, legacy fields and privacy. Payloads mirror the shapes
 * in real `session.compaction_complete` events, with content replaced. */

import { describe, it, expect } from 'vitest';
import { addTurnCompaction, readCliCompaction } from './cli-compaction';
import { MAX_TURN_COMPACTIONS } from './token-usage-schemas';
import type { CompactionEvent } from './types';

const CURRENT = {
  success: true,
  trigger: 'threshold',
  preCompactionTokens: 245_000,
  postCompactionTokens: 52_000,
  tokensRemoved: 193_000,
  messagesRemoved: 120,
  tokenLimit: 300_000,
  checkpointNumber: 3,
  checkpointPath: 'C:/Users/someone/.copilot/session-state/abc/checkpoints/003.md',
  summaryContent: 'SECRET SUMMARY TEXT',
  requestId: 'req-123',
  serviceRequestId: 'svc-456',
  compactionTokensUsed: {
    inputTokens: 260_000,
    outputTokens: 8_000,
    cacheReadTokens: 200_000,
    cacheWriteTokens: 18_000,
    duration: 45_000,
    model: 'claude-opus-5.5',
    copilotUsage: { totalNanoAiu: 123, tokenDetails: [] },
  },
};

describe('readCliCompaction', () => {
  it('maps the fields current Copilot CLI builds log', () => {
    expect(readCliCompaction(CURRENT)).toEqual({
      mode: 'full',
      numRounds: 0,
      numRoundsSinceLastSummarization: 0,
      contextLengthBefore: 245_000,
      contextLengthAfter: 52_000,
      tokenLimit: 300_000,
      trigger: 'threshold',
      checkpointNumber: 3,
      durationMs: 45_000,
      model: 'claude-opus-5.5',
      outcome: 'success',
      tokensUsed: { input: 260_000, output: 8_000, cacheRead: 200_000, cacheWrite: 18_000 },
    });
  });

  it('never keeps summary text, paths, ids or credits', () => {
    const json = JSON.stringify(readCliCompaction({ ...CURRENT, error: 'Error: SECRET failure detail' }));
    for (const secret of ['SECRET', 'checkpoints', 'req-123', 'svc-456', 'Nano', 'Aiu']) expect(json).not.toContain(secret);
  });

  it('derives the size after compaction from the tokens removed when it is missing', () => {
    const { postCompactionTokens: _post, ...withoutPost } = CURRENT;
    expect(readCliCompaction(withoutPost).contextLengthAfter).toBe(52_000);
  });

  it('records a failed compaction and its error-free outcome', () => {
    const event = readCliCompaction({ ...CURRENT, success: false, error: 'boom' });
    expect(event.outcome).toBe('failed');
    expect(readCliCompaction({ ...CURRENT, outcome: 'compacted' }).outcome).toBe('compacted');
  });

  it('still reads the legacy fields of older builds', () => {
    const event = readCliCompaction({ mode: 'simple', numRounds: 12, numRoundsSinceLastSummarization: 4, contextLengthBefore: 90_000, durationMs: 1200, model: 'gpt-5.4', outcome: 'success' });
    expect(event).toMatchObject({ mode: 'simple', numRounds: 12, numRoundsSinceLastSummarization: 4, contextLengthBefore: 90_000, durationMs: 1200, model: 'gpt-5.4', outcome: 'success' });
    expect(event.contextLengthAfter).toBeUndefined();
    expect(event.tokenLimit).toBeUndefined();
    expect(event.tokensUsed).toBeUndefined();
  });

  it('ignores malformed values', () => {
    const event = readCliCompaction({
      preCompactionTokens: '245000',
      postCompactionTokens: -1,
      tokenLimit: 0,
      trigger: 'not a valid trigger!',
      checkpointNumber: Number.NaN,
      compactionTokensUsed: 'nope',
    });
    expect(event).toEqual({ mode: 'full', numRounds: 0, numRoundsSinceLastSummarization: 0, contextLengthBefore: 0, durationMs: 0, model: '', outcome: 'success' });
  });

  it('never reports more context after compaction than before', () => {
    expect(readCliCompaction({ ...CURRENT, postCompactionTokens: 400_000 }).contextLengthAfter).toBe(245_000);
  });
});

describe('addTurnCompaction', () => {
  it('keeps compactions in order up to the per-turn cap', () => {
    const list: CompactionEvent[] = [];
    for (let i = 0; i < MAX_TURN_COMPACTIONS + 5; i++) addTurnCompaction(list, readCliCompaction({ ...CURRENT, checkpointNumber: i }));
    expect(list).toHaveLength(MAX_TURN_COMPACTIONS);
    expect(list.map(e => e.checkpointNumber)).toEqual(Array.from({ length: MAX_TURN_COMPACTIONS }, (_, i) => i));
  });
});
