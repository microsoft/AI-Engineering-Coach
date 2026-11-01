/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { createRequest, createSession } from '../core/parser-shared';
import type { ModelUsage, Session } from '../core/types';
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
        unmeasuredReturns: 1,
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
      returnsAfterExpiry: { expired: 2, of: 5, notMeasured: 1 },
      medianMinutesSinceCacheRefreshAtExpiry: 60,
      // The remainder isn't only new context: it also holds misses below the break threshold.
      cacheMissOrigins: [{ origin: 'new-context-and-minor-misses', pct: 33.3 }, { origin: 'rebuilt', pct: 66.7 }],
    });
    const json = JSON.stringify(summary);
    expect(json).not.toContain('secret-session-id');
    expect(json).not.toContain('secret-workspace');
    expect(json).not.toContain('secret prompt');
  });
});

describe('formatPromptCache returns without cache data', () => {
  it('reports Copilot returns apart, with no cache breaks, when only another harness logged cache tokens', () => {
    const at = Date.parse('2026-10-20T11:00:00Z');
    // The Copilot App call didn't report its cache, but its prompt returned to an earlier call whose cache had expired.
    const app = createSession({
      sessionId: 'a', workspaceId: 'ws', workspaceName: 'w', harness: 'GitHub Copilot App',
      requests: [createRequest({ messageText: 'prompt', responseText: '', timestamp: at, promptCache: { rows: [], returns: 1, expiredReturns: 1 } })],
    });
    const claude = createSession({
      sessionId: 'c', workspaceId: 'ws', workspaceName: 'w', harness: 'Claude',
      requests: [createRequest({ messageText: 'prompt', responseText: '', timestamp: at, promptCache: { rows: [{ stream: 'main', model: 'claude-sonnet-5', calls: 1, input: 31_010, cacheRead: 30_000, cacheWrite: 1_000 }] } })],
    });
    const summary = formatPromptCache(new PromptCacheAnalyzer([app, claude], new Map()).getPromptCache());
    expect(summary.cacheBreaks).toBeNull();
    expect(summary.returnsWithoutCacheData).toEqual({ harnesses: 'Copilot App', returnsAfterExpiry: { expired: 1, of: 1, notMeasured: 0 } });
    expect(summary.harnesses).toEqual(expect.arrayContaining([expect.objectContaining({ harness: 'GitHub Copilot App', reported: false, breaksPer100Calls: null })]));
  });

  it('leaves them out when the Copilot calls in range logged cache tokens', () => {
    const request = createRequest({ messageText: 'prompt', responseText: '', timestamp: Date.parse('2026-10-20T11:00:00Z'), promptCache: { rows: [{ stream: 'main', model: 'claude-opus-5.5', calls: 1, input: 100_000, cacheRead: 90_000, cacheWrite: 10_000 }], returns: 1 } });
    const session = createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'w', harness: 'GitHub Copilot App', requests: [request] });
    const summary = formatPromptCache(new PromptCacheAnalyzer([session], new Map()).getPromptCache());
    expect(summary.cacheBreaks).toMatchObject({ returnsAfterExpiry: { expired: 0, of: 1, notMeasured: 0 } });
    expect(summary.returnsWithoutCacheData).toBeNull();
  });
});

describe('formatPromptCache harness rows', () => {
  it('calls a harness reported only when requests in range carried cache data', () => {
    // An older Copilot App build logs no per-call usage: the harness would log the cache per call, but didn't.
    const request = createRequest({ messageText: 'prompt', responseText: '', timestamp: Date.parse('2026-10-20T11:00:00Z') });
    const session = createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'w', harness: 'GitHub Copilot App', requests: [request] });
    const summary = formatPromptCache(new PromptCacheAnalyzer([session], new Map()).getPromptCache());
    expect(summary.harnesses).toEqual([expect.objectContaining({ harness: 'GitHub Copilot App', reported: false, granularity: 'per-call', hitPct: null, requestsWithData: 0, totalRequests: 1 })]);
  });

  it('reports a negative saving, and says so, when caching cost more than it saved', () => {
    // 100K tokens written at 1.25× the input price and never read back.
    const request = createRequest({
      messageText: 'prompt',
      responseText: '',
      timestamp: Date.parse('2026-10-20T11:00:00Z'),
      promptCache: { rows: [{ stream: 'main', model: 'claude-opus-5.5', calls: 1, input: 100_000, cacheRead: 0, cacheWrite: 100_000, cost: 125_000, missCost: 125_000, baselineCost: 100_000, ratedInput: 100_000 }] },
    });
    const session = createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'w', harness: 'GitHub Copilot App', requests: [request] });
    const [row] = formatPromptCache(new PromptCacheAnalyzer([session], new Map()).getPromptCache()).harnesses;
    expect(row).toMatchObject({ inputCostSavedPct: -25, inputCostOnMissesPct: 100 });
    expect(row.costNote).toContain('Caching cost more than it saved');
  });
});

describe('formatPromptCache with Codex session totals', () => {
  function codexSession(usage: ModelUsage): Session {
    const request = createRequest({ messageText: 'prompt', responseText: '', timestamp: Date.parse('2026-10-20T11:00:00Z') });
    return createSession({ sessionId: 'c', workspaceId: 'ws', workspaceName: 'w', harness: 'Codex', requests: [request], modelUsage: { 'gpt-5.3-codex': usage } });
  }

  it('reports Codex usage without cached-token counts as not reported, not as a 0% hit ratio', () => {
    const usage: ModelUsage = { inputTokens: 50_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, cacheTokensReported: false };
    const data = new PromptCacheAnalyzer([codexSession(usage)], new Map()).getPromptCache();
    // The dashboard's harness row has no cache data, so it reads "No cache usage logged in this range".
    expect(data.harnesses).toEqual([expect.objectContaining({ harness: 'Codex', reporting: 'per-session', all: null, cost: null, requestsWithData: 0 })]);
    expect(data.coverage).toMatchObject({ requestsWithData: 0, totalRequests: 1 });
    expect(formatPromptCache(data).harnesses).toEqual([expect.objectContaining({ harness: 'Codex', reported: false, hitPct: null })]);
  });

  it('still reports a logged zero as a 0% hit ratio', () => {
    const usage: ModelUsage = { inputTokens: 50_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const data = new PromptCacheAnalyzer([codexSession(usage)], new Map()).getPromptCache();
    expect(formatPromptCache(data).harnesses).toEqual([expect.objectContaining({ harness: 'Codex', reported: true, hitPct: 0 })]);
  });
});
