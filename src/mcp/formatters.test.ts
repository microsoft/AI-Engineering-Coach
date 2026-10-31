/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { createRequest, createSession } from '../core/parser-shared';
import { formatPromptCache } from './formatters';

describe('formatPromptCache', () => {
  it('summarizes efficiency per harness and why the cache broke, without session ids or workspace names', () => {
    const request = createRequest({
      messageText: 'secret prompt',
      responseText: '',
      timestamp: Date.parse('2026-10-20T11:00:00Z'),
      promptCache: {
        rows: [{ stream: 'main', model: 'claude-opus-5.5', calls: 60, input: 6_000_000, cacheRead: 5_700_000, cacheWrite: 300_000, ttlSeconds: 300, cacheBreaks: 1 }],
        rebuilt: 200_000,
        returns: 5,
        expiredReturns: 2,
      },
    });
    const session = createSession({
      sessionId: 'secret-session-id', workspaceId: 'ws', workspaceName: 'secret-workspace', harness: 'GitHub Copilot App', requests: [request],
      promptCache: { breaks: [{ requestIndex: 0, callIndex: 3, timestamp: null, model: 'claude-opus-5.5', causes: ['ttl-expired'], confidence: 'logged', rebuiltTokens: 200_000, idleSeconds: 3_600, ttlSeconds: 300, initiator: 'user' }] },
    });
    const summary = formatPromptCache(new PromptCacheAnalyzer([session], new Map()).getPromptCache());

    expect(summary.harnesses).toEqual([expect.objectContaining({ harness: 'GitHub Copilot App', reported: true, hitPct: 95, breaksPer100Calls: 1.7 })]);
    expect(summary.cacheBreaks).toMatchObject({
      harnesses: 'Copilot App',
      breaks: 1,
      rebuiltYouCanChangePct: 100,
      causes: [{ cause: 'ttl-user', who: 'you', breaks: 1, rebuiltPct: 100 }],
      cacheLifetimes: [{ model: 'claude-opus-5.5', seconds: 300 }],
      returnsAfterExpiry: { expired: 2, of: 5 },
      medianMinutesSinceCacheRefreshAtExpiry: 60,
    });
    const json = JSON.stringify(summary);
    expect(json).not.toContain('secret-session-id');
    expect(json).not.toContain('secret-workspace');
    expect(json).not.toContain('secret prompt');
  });
});
