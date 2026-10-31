/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { TokenTypesAnalyzer } from '../core/analyzer-token-types';
import { createRequest, createSession } from '../core/parser-shared';
import { formatPromptCache, formatTokenTypes } from './formatters';

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

describe('formatTokenTypes', () => {
  it('summarizes token types per source with counts and ratios only', () => {
    const request = createRequest({
      messageText: 'secret prompt',
      responseText: '',
      timestamp: Date.parse('2026-10-20T11:00:00Z'),
      promptCache: { rows: [{ stream: 'main', model: 'claude-opus-5.5', calls: 10, reasoningEffort: 'max', input: 1_000_000, cacheRead: 950_000, cacheWrite: 50_000, outputTokens: 20_000, reasoningTokens: 12_000, truncatedCalls: 1, filteredCalls: 0, ttftMs: [3_000, 4_000, 5_000], durationMs: [8_000] }] },
      subagentRuns: [{ agentType: 'custom', model: 'gpt-6.1-sol', mode: 'sync', totalTokens: 50_000, toolCalls: 4, durationMs: 30_000, cancelled: false }],
    });
    const local = createRequest({ messageText: 'q', responseText: '', timestamp: Date.parse('2026-10-20T12:00:00Z') });
    const sessions = [
      createSession({ sessionId: 'secret-session-id', workspaceId: 'ws', workspaceName: 'secret-workspace', harness: 'GitHub Copilot CLI', requests: [request] }),
      createSession({ sessionId: 'vs', workspaceId: 'ws', workspaceName: 'secret-workspace', harness: 'Local Agent', requests: [local] }),
    ];
    const summary = formatTokenTypes(new TokenTypesAnalyzer(sessions, new Map()).getTokenTypes());
    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0]).toMatchObject({
      source: 'Copilot CLI',
      reasoning: { basis: 'calls', mainPctOfOutput: 60, byEffort: [{ effort: 'max', stream: 'main', pctOfOutput: 60, calls: 10 }] },
      subagents: { runs: 1, totalTokens: 50_000, byType: [{ type: 'custom', runs: 1, tokens: 50_000 }] },
      truncation: { calls: 10, truncatedCalls: 1, filteredCalls: 0 },
      latency: [{ model: 'claude-opus-5.5', calls: 10, firstTokenP50Ms: 4_000, firstTokenP90Ms: 5_000, callP50Ms: 8_000 }],
    });
    expect(summary.harnessesWithoutTokenTypes).toEqual(['Local Agent']);
    const json = JSON.stringify(summary);
    for (const secret of ['secret-session-id', 'secret-workspace', 'secret prompt']) expect(json).not.toContain(secret);
  });
});
