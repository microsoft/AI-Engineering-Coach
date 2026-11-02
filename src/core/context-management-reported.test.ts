/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context Management with context limits the harness reports (Copilot CLI and Copilot App, Codex):
 * turns count against their own limit, adaptive thresholds come from estimated windows only, and
 * every compaction in a turn counts. */

import { describe, it, expect } from 'vitest';
import { Analyzer } from './analyzer';
import { buildContextLayer } from './context-timeline';
import { createRequest, createSession } from './parser-shared';
import { CONTEXT_OPTIMAL_UTILIZATION } from './constants';
import type { CompactionEvent, Session, SessionRequest } from './types';

const BASE_TS = new Date(2026, 9, 20, 10, 0, 0).getTime();
const LIMIT = 968_000;

let counter = 0;

function compaction(before: number, after: number, tokenLimit?: number): CompactionEvent {
  return {
    mode: 'full', numRounds: 0, numRoundsSinceLastSummarization: 0, contextLengthBefore: before, contextLengthAfter: after,
    durationMs: 30_000, model: 'claude-opus-5.5', outcome: 'success', trigger: 'threshold', ...(tokenLimit ? { tokenLimit } : {}),
  };
}

function cliTurn(i: number, lastPromptTokens: number, overrides: Partial<SessionRequest> = {}): SessionRequest {
  return createRequest({
    requestId: `cli-${counter++}`,
    timestamp: BASE_TS + i * 60_000,
    messageText: `turn ${i}`,
    responseText: 'done',
    contextUsage: { lastPromptTokens, peakPromptTokens: lastPromptTokens, contextLimit: LIMIT, calls: 1 },
    ...overrides,
  });
}

function cliSession(workspaceName: string, prompts: number[], extra: (i: number) => Partial<SessionRequest> = () => ({})): Session {
  return createSession({
    sessionId: `cli-session-${counter++}`,
    workspaceId: workspaceName,
    workspaceName,
    harness: 'GitHub Copilot CLI',
    requests: prompts.map((p, i) => cliTurn(i, p, extra(i))),
  });
}

function vscodeSession(workspaceName: string, prompts: number[], tsOffset = 0): Session {
  return createSession({
    sessionId: `vs-session-${counter++}`,
    workspaceId: workspaceName,
    workspaceName,
    harness: 'VS Code',
    requests: prompts.map((p, i) => createRequest({
      requestId: `vs-${counter++}`, timestamp: BASE_TS + tsOffset + i * 60_000, messageText: 'q', responseText: 'a', promptTokens: p,
    })),
  });
}

describe('Context Management with reported context limits', () => {
  it('lists Copilot CLI workspaces and measures turns against the reported limit', () => {
    const data = new Analyzer([cliSession('cli-only', [96_800, 193_600, 290_400, 387_200, 484_000])]).getContextManagement();
    expect(data.workspaces).toHaveLength(1);
    const ws = data.workspaces[0];
    expect(ws).toMatchObject({ workspaceName: 'cli-only', windowSource: 'reported', requestsWithTokens: 5 });
    expect(ws.avgUtilization).toBe(30);
    expect(ws.peakUtilization).toBe(50);
    expect(data.sessionsWithTokenData).toBe(1);
  });

  it('labels a workspace used from both an estimated and a reported harness as mixed', () => {
    const data = new Analyzer([cliSession('shared', [100_000]), vscodeSession('shared', [40_000, 60_000])]).getContextManagement();
    expect(data.workspaces[0].windowSource).toBe('mixed');
  });

  it('scores a turn without a reported limit against the estimate, not another turn\u2019s limit', () => {
    const noLimit = { contextUsage: { lastPromptTokens: 150_000, peakPromptTokens: 150_000, contextLimit: null, calls: 1 } };
    const partial = cliSession('partial', [100_000, 150_000], i => (i === 1 ? noLimit : {}));
    const analyzer = new Analyzer([partial]);
    expect(analyzer.getContextManagement().workspaces[0].windowSource).toBe('mixed');
    const detail = analyzer.getWorkspaceContextSessions('partial').sessions[0];
    expect(detail).toMatchObject({ windowSource: 'mixed', contextWindow: 160_000, turnLimits: [LIMIT, null] });
    // 150K of the 160K estimate, where the other turn's 968K limit would have said 15.5%.
    expect(detail.peakUtilization).toBe(93.8);
  });

  it('keeps adaptive thresholds from estimated windows only', () => {
    // 25 VS Code sessions whose average sits well above the default optimal cutoff.
    const estimated = Array.from({ length: 25 }, (_, i) => vscodeSession(`vs-${i}`, [90_000, 95_000, 100_000, 105_000, 110_000], i * 3_600_000));
    const before = new Analyzer(estimated).getContextManagement().thresholds;
    expect(before.adaptive).toBe(true);
    expect(before.optimalUtilization).toBeGreaterThan(CONTEXT_OPTIMAL_UTILIZATION);

    const reported = Array.from({ length: 25 }, (_, i) => cliSession(`cli-${i}`, [20_000, 30_000, 40_000, 50_000, 60_000]));
    const after = new Analyzer([...estimated, ...reported]).getContextManagement().thresholds;
    expect(after).toEqual(before);

    // Sessions with a reported limit on only some turns don't shift the cutoffs either.
    const noLimit = { contextUsage: { lastPromptTokens: 20_000, peakPromptTokens: 20_000, contextLimit: null, calls: 1 } };
    const mixed = Array.from({ length: 25 }, (_, i) => cliSession(`mixed-${i}`, [20_000, 30_000, 40_000, 50_000, 60_000], j => (j === 0 ? noLimit : {})));
    expect(new Analyzer([...estimated, ...mixed]).getContextManagement().thresholds).toEqual(before);
  });

  it('counts every compaction of a turn', () => {
    const many = [compaction(780_000, 120_000), compaction(790_000, 110_000), compaction(785_000, 115_000)];
    const session = cliSession('compacting', [100_000, 200_000, 300_000], i => (i === 1 ? { compaction: many[0], compactions: many } : {}));
    const data = new Analyzer([session]).getContextManagement();
    expect(data.totalCompactions).toBe(3);
    expect(data.fullCompactions).toBe(3);
    expect(data.workspaces[0].compactionCount).toBe(3);
  });

  it('judges Context Amnesia against the limit the compaction reported', () => {
    // An older build: no per-turn usage, so the session has no prompt sizes and the default window is 128K.
    const older = createSession({
      sessionId: 'older', workspaceId: 'old', workspaceName: 'old', harness: 'GitHub Copilot CLI',
      requests: [createRequest({ requestId: 'o1', timestamp: BASE_TS, messageText: 'q', responseText: 'a', compaction: compaction(245_000, 52_000, 300_000) })],
    });
    const amnesia = (sessions: Session[]) => new Analyzer(sessions).getContextManagement().antiPatterns.find(p => p.id === 'context-amnesia');
    expect(amnesia([older])).toBeUndefined();

    const nearLimit = createSession({
      sessionId: 'near', workspaceId: 'near', workspaceName: 'near', harness: 'GitHub Copilot CLI',
      requests: [createRequest({ requestId: 'n1', timestamp: BASE_TS, messageText: 'q', responseText: 'a', compaction: compaction(290_000, 50_000, 300_000) })],
    });
    expect(amnesia([nearLimit])?.occurrences).toBe(1);
  });

  it('returns per-turn limits, peaks and compaction labels for the session drill-down', () => {
    const turns = [
      cliTurn(0, 120_000),
      cliTurn(1, 80_000, { contextUsage: { lastPromptTokens: 80_000, peakPromptTokens: 780_000, contextLimit: LIMIT, calls: 6 }, compaction: compaction(780_000, 70_000) }),
      createRequest({ requestId: 'no-calls', timestamp: BASE_TS + 3 * 60_000, messageText: 'relayed', responseText: '' }),
    ];
    const session = createSession({ sessionId: 'drill', workspaceId: 'drill', workspaceName: 'drill', harness: 'GitHub Copilot App', requests: turns });
    const details = new Analyzer([session]).getWorkspaceContextSessions('drill');
    const detail = details.sessions[0];
    expect(detail).toMatchObject({
      hasPerRequestTokens: true,
      windowSource: 'reported',
      contextWindow: LIMIT,
      tokenCurve: [120_000, 80_000, null],
      turnLimits: [LIMIT, LIMIT, null],
      turnPeaks: [120_000, 780_000, null],
      compactionCount: 1,
    });
    expect(detail.events).toContainEqual({ requestIndex: 1, type: 'compaction', label: 'Compaction 780K\u219270K' });
    expect(detail.peakUtilization).toBeCloseTo((120_000 / LIMIT) * 100, 1);
  });

  it('keeps VS Code sessions on the estimated window with unchanged labels', () => {
    const vs = vscodeSession('vs', [30_000, 60_000, 90_000]);
    vs.requests[1].compaction = { mode: 'simple', numRounds: 3, numRoundsSinceLastSummarization: 1, contextLengthBefore: 60_000, durationMs: 100, model: 'gpt-5.4', outcome: '' };
    const detail = new Analyzer([vs]).getWorkspaceContextSessions('vs').sessions[0];
    expect(detail).toMatchObject({ windowSource: 'estimated', contextWindow: 128_000 });
    expect(detail.turnLimits).toBeUndefined();
    expect(detail.turnPeaks).toBeUndefined();
    expect(detail.events).toContainEqual({ requestIndex: 1, type: 'compaction', label: 'Compaction (simple)' });
  });

  it('offers time ranges for Copilot CLI turns with per-turn usage', () => {
    const recent = cliSession('cli-range', [100_000, 120_000]);
    for (const r of recent.requests) r.timestamp = Date.now() - 2 * 86_400_000;
    const availability = new Analyzer([recent]).getContextRangeAvailability();
    expect(availability.sessionsWithRequestTokens).toBe(1);
    expect(availability.harnessesWithoutRequestTokens).toEqual([]);
    expect(availability.rangesWithTokens.length).toBeGreaterThan(0);
  });

  it('adds per-turn calls, cache hit and the token-types strip to the drill-down', () => {
    const promptCache = { rows: [{ stream: 'main' as const, model: 'claude-opus-5.5', calls: 6, reasoningEffort: 'high', input: 600_000, cacheRead: 540_000, cacheWrite: 60_000, outputTokens: 9_000, reasoningTokens: 5_400, truncatedCalls: 0, filteredCalls: 0, ttftMs: [3_000], durationMs: [9_000] }] };
    const session = createSession({
      sessionId: 'strip', workspaceId: 'strip', workspaceName: 'strip', harness: 'GitHub Copilot App',
      requests: [cliTurn(0, 120_000, { promptCache, contextUsage: { lastPromptTokens: 120_000, peakPromptTokens: 130_000, contextLimit: LIMIT, calls: 6 } }), cliTurn(1, 90_000)],
    });
    const detail = new Analyzer([session]).getWorkspaceContextSessions('strip').sessions[0];
    expect(detail.turnCalls).toEqual([6, 1]);
    expect(detail.turnCacheHitPct).toEqual([90, null]);
    expect(detail.tokenTypes).toMatchObject({ reasoningPct: 60, effort: 'high', truncatedCalls: 0, calls: 6, ttftMedianMs: 3_000 });

    const vs = new Analyzer([vscodeSession('vs-strip', [30_000])]).getWorkspaceContextSessions('vs-strip').sessions[0];
    expect(vs.turnCalls).toBeUndefined();
    expect(vs.turnCacheHitPct).toBeUndefined();
    expect(vs.tokenTypes).toBeUndefined();
  });
});

describe('Session timeline context layer', () => {
  it('places compactions on the call timeline and lists each turn\u2019s context at its end', () => {
    const timeline = { calls: 6, bucketSize: 1, buckets: [] };
    const turns = [
      cliTurn(0, 120_000, { compaction: { ...compaction(780_000, 70_000, LIMIT), atCall: 3 } }),
      cliTurn(1, 90_000, { compaction: { ...compaction(300_000, 0), outcome: 'failed', trigger: 'manual', atCall: 5 } }),
      // A compaction from an older build has no position on the timeline.
      createRequest({ requestId: 'old', timestamp: BASE_TS, messageText: 'q', responseText: '', compaction: compaction(100_000, 20_000) }),
    ];
    const session = createSession({ sessionId: 'tl', workspaceId: 'tl', workspaceName: 'tl', harness: 'GitHub Copilot CLI', requests: turns, callTimeline: timeline });
    expect(buildContextLayer(session)).toEqual({
      compactions: [
        { callIndex: 3, requestIndex: 0, tokensBefore: 780_000, tokensAfter: 70_000, tokenLimit: LIMIT, trigger: 'automatic', failed: false },
        { callIndex: 5, requestIndex: 1, tokensBefore: 300_000, tokensAfter: 0, tokenLimit: null, trigger: 'manual', failed: true },
      ],
      omittedCompactions: 0,
      turnEnds: [120_000, 90_000, null],
    });
    expect(buildContextLayer(createSession({ sessionId: 'x', workspaceId: 'x', workspaceName: 'x', harness: 'Claude', requests: [] }))).toBeNull();
    expect(new Analyzer([session]).getSessionTimeline('tl')?.context?.compactions).toHaveLength(2);
  });
});
