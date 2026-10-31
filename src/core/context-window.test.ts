/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import {
  estimateContextWindow,
  requestCompactions,
  requestContextLimit,
  requestContextTokens,
  sessionContextWindow,
  sessionUtilization,
} from './context-window';
import { createRequest, createSession } from './parser-shared';
import { CONTEXT_WINDOW_DEFAULT } from './constants';
import type { CompactionEvent, SessionRequest } from './types';

function req(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return createRequest({ messageText: 'q', responseText: 'a', ...overrides });
}

function compaction(before: number): CompactionEvent {
  return { mode: 'full', numRounds: 0, numRoundsSinceLastSummarization: 0, contextLengthBefore: before, durationMs: 0, model: '', outcome: 'success' };
}

describe('request accessors', () => {
  it('prefers the per-turn context of the last call over promptTokens', () => {
    expect(requestContextTokens(req({ promptTokens: 900_000, contextUsage: { lastPromptTokens: 80_000, peakPromptTokens: 240_000, contextLimit: 968_000, calls: 1 } }))).toBe(80_000);
    expect(requestContextTokens(req({ promptTokens: 52_000 }))).toBe(52_000);
    expect(requestContextTokens(req())).toBe(0);
  });

  it('returns the reported limit only when one was logged', () => {
    expect(requestContextLimit(req({ contextUsage: { lastPromptTokens: 1, peakPromptTokens: 1, contextLimit: 272_000, calls: 1 } }))).toBe(272_000);
    expect(requestContextLimit(req({ contextUsage: { lastPromptTokens: 1, peakPromptTokens: 1, contextLimit: null, calls: 1 } }))).toBeNull();
    expect(requestContextLimit(req({ promptTokens: 50_000 }))).toBeNull();
  });

  it('lists every compaction of a turn, or the single one', () => {
    const many = [compaction(1), compaction(2)];
    expect(requestCompactions(req({ compaction: many[0], compactions: many }))).toBe(many);
    expect(requestCompactions(req({ compaction: compaction(3) }))).toHaveLength(1);
    expect(requestCompactions(req())).toEqual([]);
  });
});

describe('sessionContextWindow', () => {
  it('uses the reported limits when the harness logs them', () => {
    const session = createSession({
      sessionId: 's', workspaceId: 'w', workspaceName: 'w', harness: 'GitHub Copilot CLI',
      requests: [
        req({ contextUsage: { lastPromptTokens: 100_000, peakPromptTokens: 100_000, contextLimit: 968_000, calls: 1 } }),
        req(),
        req({ contextUsage: { lastPromptTokens: 150_000, peakPromptTokens: 150_000, contextLimit: 272_000, calls: 1 } }),
      ],
    });
    const window = sessionContextWindow(session);
    expect(window).toEqual({ source: 'reported', window: 968_000, perRequest: [968_000, 968_000, 272_000] });
    const util = sessionUtilization(session, window);
    expect(util[0]).toBeCloseTo(10.33, 1);
    expect(util[1]).toBeNull();
    expect(util[2]).toBeCloseTo(55.15, 1);
  });

  it('estimates the window from the largest prompt otherwise', () => {
    const session = createSession({
      sessionId: 's', workspaceId: 'w', workspaceName: 'w', harness: 'VS Code',
      requests: [req({ promptTokens: 40_000 }), req({ promptTokens: 150_000 })],
    });
    expect(sessionContextWindow(session)).toEqual({ source: 'estimated', window: 160_000, perRequest: [160_000, 160_000] });
    expect(estimateContextWindow(0)).toBe(CONTEXT_WINDOW_DEFAULT);
    expect(estimateContextWindow(10_000)).toBe(CONTEXT_WINDOW_DEFAULT);
  });
});
