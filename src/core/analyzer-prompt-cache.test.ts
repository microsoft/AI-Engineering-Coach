/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { PromptCacheAnalyzer } from './analyzer-prompt-cache';
import { createRequest, createSession } from './parser-shared';
import type { CacheBreak, CacheBreakCause, CallTimeline, ModelCallRow, RequestPromptCache, Session, SessionRequest } from './types';

const DAY = '2026-10-20';

function row(stream: ModelCallRow['stream'], [calls, input, cacheRead, cacheWrite]: [number, number, number, number], extra: Partial<ModelCallRow> = {}): ModelCallRow {
  return { stream, model: 'claude-opus-5.5', calls, input, cacheRead, cacheWrite, ...extra };
}

function request(time: string, promptCache?: RequestPromptCache): SessionRequest {
  return createRequest({ messageText: 'secret prompt', responseText: '', timestamp: Date.parse(time), ...(promptCache ? { promptCache } : {}) });
}

function brk(requestIndex: number, causes: CacheBreakCause[], extra: Partial<CacheBreak> = {}): CacheBreak {
  return {
    requestIndex,
    callIndex: requestIndex,
    timestamp: null,
    model: 'claude-opus-5.5',
    causes,
    confidence: causes.length > 0 ? 'logged' : 'unattributed',
    rebuiltTokens: 100_000,
    idleSeconds: 3_000,
    ttlSeconds: 300,
    initiator: 'user',
    ...extra,
  };
}

function session(id: string, harness: string, requests: SessionRequest[], extra: Partial<Session> = {}): Session {
  return createSession({ sessionId: id, workspaceId: 'ws-alpha', workspaceName: 'alpha', harness, requests, ...extra });
}

/** A Copilot App session: 60 main calls over two requests, two breaks, rates logged on every call. */
function appSession(): Session {
  const rated = { cost: 0, missCost: 0, baselineCost: 0, ratedInput: 0 };
  const first: RequestPromptCache = {
    rows: [
      row('main', [30, 3_000_000, 2_900_000, 100_000], { ...rated, cost: 415_000, missCost: 125_000, baselineCost: 3_000_000, ratedInput: 3_000_000, ttlSeconds: 300 }),
      row('subagent', [10, 500_000, 450_000, 50_000], { model: 'gpt-6-astra', cost: 107_500, missCost: 62_500, baselineCost: 500_000, ratedInput: 500_000 }),
    ],
    coldStart: 40_000,
    coldStartCost: 50_000,
  };
  const second: RequestPromptCache = {
    rows: [
      row('main', [30, 3_000_000, 2_700_000, 300_000], { cost: 645_000, missCost: 375_000, baselineCost: 3_000_000, ratedInput: 3_000_000, ttlSeconds: 300, cacheBreaks: 2 }),
      row('compaction', [1, 400_000, 380_000, 20_000], { cost: 63_000, missCost: 25_000, baselineCost: 400_000, ratedInput: 400_000 }),
    ],
    rebuilt: 200_000,
    rebuiltCost: 250_000,
    returns: 4,
    expiredReturns: 1,
  };
  return session('app-1', 'GitHub Copilot App', [request(`${DAY}T10:30:00Z`, first), request(`${DAY}T11:30:00Z`, second)], {
    promptCache: {
      breaks: [
        brk(1, ['ttl-expired', 'resume'], { rebuiltCost: 150_000, idleSeconds: 3_600 }),
        brk(1, ['system-prompt'], { confidence: 'checkpoint', inferred: ['system-prompt'], segments: ['custom_instructions'], initiator: 'agent', rebuiltCost: 100_000 }),
      ],
    },
    callTimeline: {
      calls: 60,
      bucketSize: 1,
      buckets: [{ firstCall: 0, lastCall: 0, firstRequest: 0, lastRequest: 0, startTs: null, endTs: null, cacheCalls: 1, cacheRead: 0, cacheWrite: 40_000, uncached: 0 }],
    } satisfies CallTimeline,
  });
}

function analyzer(sessions: Session[]): PromptCacheAnalyzer {
  return new PromptCacheAnalyzer(sessions, new Map());
}

describe('PromptCacheAnalyzer harness rows', () => {
  it('reports each harness separately with its own granularity, never pooled', () => {
    const claude = session('claude-1', 'Claude', [request(`${DAY}T11:00:00Z`, { rows: [row('main', [2, 100_000, 50_000, 50_000])] })]);
    const codex = session('codex-1', 'Codex', [request(`${DAY}T11:00:00Z`)], {
      modelUsage: { 'gpt-6.1-sol': { inputTokens: 20_000, outputTokens: 1_000, cacheReadTokens: 180_000, cacheWriteTokens: 0 } },
    });
    const vscode = session('vs-1', 'Local Agent', [request(`${DAY}T11:00:00Z`)]);
    const data = analyzer([appSession(), claude, codex, vscode]).getPromptCache({ fromDate: DAY, toDate: DAY });
    const byHarness = new Map(data.harnesses.map(h => [h.harness, h]));

    const app = byHarness.get('GitHub Copilot App');
    expect(app).toMatchObject({ reporting: 'per-call', attribution: true, breaks: 2, breaksPer100: 3.3, requestsWithData: 2 });
    expect(app?.all).toMatchObject({ calls: 71, input: 6_900_000, cacheRead: 6_430_000, hitPct: 93.2 });
    expect(app?.main?.hitPct).toBe(93.3);
    expect(app?.cost).toEqual({ savedPct: 82.2, missCostPct: 47.7, ratedPct: 100 });
    expect(byHarness.get('Claude')).toMatchObject({ reporting: 'per-call', attribution: false, breaks: null, all: { hitPct: 50, writePct: 50 }, cost: null });
    expect(byHarness.get('Codex')).toMatchObject({ reporting: 'per-session', all: { calls: 0, input: 200_000, hitPct: 90, writePct: 0 } });
    expect(byHarness.get('Local Agent')).toMatchObject({ reporting: 'none', all: null, requestsWithData: 0, totalRequests: 1 });
    expect(data.coverage).toEqual({ requestsWithData: 4, totalRequests: 5, sessionsWithData: 3, totalSessions: 4 });
  });

  it('shows harnesses without cache data as not reported, and nothing else', () => {
    const data = analyzer([session('vs-1', 'Local Agent', [request(`${DAY}T11:00:00Z`)])]).getPromptCache({ fromDate: DAY });
    expect(data.attribution).toBeNull();
    expect(data.tips).toEqual([]);
    expect(data.topSessions).toEqual([]);
    expect(data.models).toEqual([]);
  });
});

describe('PromptCacheAnalyzer date range and break counts', () => {
  it('counts only requests sent in range and the breaks that happened in them', () => {
    const data = analyzer([appSession()]).getPromptCache({ fromDate: DAY, toDate: DAY });
    expect(data.attribution?.breaks).toBe(2);
    const late = session('app-2', 'GitHub Copilot App', [
      request('2026-10-18T11:00:00Z', { rows: [row('main', [10, 1_000_000, 900_000, 100_000], { cacheBreaks: 1 })] }),
      request(`${DAY}T11:00:00Z`, { rows: [row('main', [10, 1_000_000, 500_000, 500_000], { cacheBreaks: 1 })], rebuilt: 400_000 }),
    ], { promptCache: { breaks: [brk(0, ['model-switch']), brk(1, ['model-switch'], { autoModel: true, rebuiltTokens: 400_000 })] } });
    const ranged = analyzer([late]).getPromptCache({ fromDate: DAY, toDate: DAY });
    expect(ranged.harnesses[0].all?.input).toBe(1_000_000);
    expect(ranged.attribution).toMatchObject({ breaks: 1, omittedBreaks: 0 });
    expect(ranged.attribution?.causes.map(c => [c.key, c.breaks, c.control])).toEqual([['model-auto', 1, 'harness']]);
  });

  it('counts breaks over the listing cap from the request rows, within the date range', () => {
    // 3 breaks the day before the range (1 listed) and 5 in it (2 listed); the rest went over the cap.
    const capped = session('app-3', 'GitHub Copilot App', [
      request('2026-10-18T11:00:00Z', { rows: [row('main', [50, 5_000_000, 4_500_000, 500_000], { cacheBreaks: 3, ttlSeconds: 300 })], rebuilt: 300_000 }),
      request(`${DAY}T11:00:00Z`, { rows: [row('main', [100, 10_000_000, 9_000_000, 1_000_000], { cacheBreaks: 5, ttlSeconds: 300 })], rebuilt: 500_000 }),
    ], { promptCache: { breaks: [brk(0, ['ttl-expired']), brk(1, ['ttl-expired']), brk(1, ['tools-changed'])], omittedBreaks: 5 } });
    const ranged = analyzer([capped]).getPromptCache({ fromDate: DAY, toDate: DAY });
    expect(ranged.harnesses[0]).toMatchObject({ breaks: 5, breaksPer100: 5 });
    expect(ranged.attribution).toMatchObject({ mainCalls: 100, breaks: 5, breaksPer100: 5, omittedBreaks: 3 });
    expect(ranged.attribution?.causes.reduce((sum, cause) => sum + cause.breaks, 0)).toBe(2);
    expect(ranged.models[0]).toMatchObject({ calls: 100, breaksPer100: 5 });
    expect(ranged.workspaces[0]).toMatchObject({ breaks: 5 });
    expect(ranged.trend.series[0]).toMatchObject({ breaksPer100: [5], calls: [100] });
    // Without a range, both requests count; the session row always covers the whole session.
    const all = analyzer([capped]).getPromptCache({});
    expect(all.attribution).toMatchObject({ mainCalls: 150, breaks: 8, omittedBreaks: 5 });
    expect(all.trend.series[0]).toMatchObject({ breaksPer100: [6, 5], calls: [50, 100] });
    expect(ranged.topSessions[0]).toMatchObject({ breaks: 8 });
  });

  it('counts the rebuilt tokens of unlisted breaks as unknown in who can change the cause', () => {
    // In range: 500K rebuilt tokens, of which the two listed breaks account for 100K each (you, partly).
    const capped = session('app-4', 'GitHub Copilot App', [
      request(`${DAY}T11:00:00Z`, { rows: [row('main', [100, 10_000_000, 9_000_000, 1_000_000], { cacheBreaks: 5 })], rebuilt: 500_000 }),
    ], { promptCache: { breaks: [brk(0, ['ttl-expired']), brk(0, ['tools-changed'])], omittedBreaks: 3 } });
    const a = analyzer([capped]).getPromptCache({ fromDate: DAY, toDate: DAY }).attribution;
    expect(a?.causes.map(c => [c.key, c.pctOfRebuilt])).toEqual([['ttl-user', 20], ['tools-changed', 20]]);
    expect(a?.controlPct).toEqual({ you: 20, partly: 20, harness: 0, unknown: 60 });
  });

  it('reports counted breaks without listed causes when the listed ones fall outside the range', () => {
    const capped = session('app-5', 'GitHub Copilot App', [
      request('2026-10-18T11:00:00Z', { rows: [row('main', [50, 5_000_000, 4_500_000, 500_000], { cacheBreaks: 2 })], rebuilt: 200_000 }),
      request(`${DAY}T11:00:00Z`, { rows: [row('main', [50, 5_000_000, 4_600_000, 400_000], { cacheBreaks: 3 })], rebuilt: 300_000 }),
    ], { promptCache: { breaks: [brk(0, ['ttl-expired']), brk(0, ['resume'])], omittedBreaks: 3 } });
    const a = analyzer([capped]).getPromptCache({ fromDate: DAY, toDate: DAY }).attribution;
    expect(a).toMatchObject({ breaks: 3, omittedBreaks: 3, causes: [], rebuiltTokens: 300_000 });
    expect(a?.controlPct).toEqual({ you: 0, partly: 0, harness: 0, unknown: 100 });
  });
});

describe('PromptCacheAnalyzer attribution', () => {
  it('splits causes by who can change them and sums origins to every cache miss', () => {
    const a = analyzer([appSession()]).getPromptCache({ fromDate: DAY }).attribution;
    expect(a).toMatchObject({ label: 'Copilot App', mainCalls: 60, breaks: 2, rebuiltTokens: 200_000, confidence: { logged: 1, checkpoint: 1, unattributed: 0 } });
    expect(a?.causes).toEqual([
      expect.objectContaining({ key: 'ttl-user', control: 'you', breaks: 1, pctOfRebuilt: 50, costPct: 12.2, alsoSeen: [{ cause: 'resume', breaks: 1 }] }),
      expect.objectContaining({ key: 'instructions-changed', control: 'you', breaks: 1, checkpoint: 1, segments: [{ name: 'custom_instructions', breaks: 1 }] }),
    ]);
    expect(a?.controlPct).toEqual({ you: 100, partly: 0, harness: 0, unknown: 0 });
    // main misses 400K = 40K cold start + 200K rebuilt + 160K growth; sub-agents 50K; compaction 20K.
    expect(a?.misses).toBe(470_000);
    expect(a?.origins.map(o => [o.origin, o.tokens])).toEqual([
      ['growth', 160_000], ['rebuilt', 200_000], ['subagents', 50_000], ['compaction', 20_000], ['cold-start', 40_000],
    ]);
    expect(a?.origins.reduce((sum, o) => sum + o.pct, 0)).toBeCloseTo(100, 0);
    expect(a?.idle).toMatchObject({ returns: 4, expiredReturns: 1, medianIdleMinutes: 60, ttlByModel: [{ model: 'claude-opus-5.5', ttlSeconds: 300, calls: 60 }] });
    expect(a?.idle.buckets.find(b => b.label === '6\u201324\u00d7')).toMatchObject({ user: 1, agent: 0 });
  });

  it('classifies harness-driven system-prompt changes and agent waits apart from your own causes', () => {
    const s = appSession();
    s.promptCache = { breaks: [brk(1, ['system-prompt'], { segments: ['workspace_context'] }), brk(1, ['ttl-expired'], { initiator: 'agent' })] };
    const keys = analyzer([s]).getPromptCache({ fromDate: DAY }).attribution?.causes.map(c => [c.key, c.control]);
    expect(keys).toEqual([['system-prompt', 'harness'], ['ttl-agent', 'partly']]);
  });

  it('lists models and workspaces with breaks per 100 main calls and the top cause', () => {
    const data = analyzer([appSession()]).getPromptCache({ fromDate: DAY });
    expect(data.models).toEqual([
      { harness: 'GitHub Copilot App', model: 'claude-opus-5.5', calls: 60, hitPct: 93.3, writePct: 6.7, breaksPer100: 3.3, ttlSeconds: 300 },
      { harness: 'GitHub Copilot App', model: 'gpt-6-astra', calls: 10, hitPct: 90, writePct: 10, breaksPer100: null, ttlSeconds: null },
    ]);
    expect(data.workspaces).toEqual([expect.objectContaining({ workspaceName: 'alpha', harness: 'GitHub Copilot App', sessions: 1, breaks: 2, rebuiltTokens: 200_000, topCause: 'ttl-user' })]);
    expect(data.trend.series[0]).toMatchObject({ harness: 'GitHub Copilot App', hitPct: [93.2], breaksPer100: [3.3], calls: [60] });
  });
});

describe('PromptCacheAnalyzer tips', () => {
  function withBreaks(count: number, causes: CacheBreakCause[], extra: Partial<CacheBreak> = {}): Session {
    const s = appSession();
    s.promptCache = { breaks: Array.from({ length: count }, () => brk(1, causes, extra)) };
    s.requests[1].promptCache!.rows[0].cacheBreaks = count;
    return s;
  }

  it('coaches a cause you control once it has enough breaks, quoting the logged cache lifetime', () => {
    const tips = analyzer([withBreaks(3, ['ttl-expired'])]).getPromptCache({ fromDate: DAY }).tips;
    expect(tips.some(t => t.includes('came back after the prompt cache had expired') && t.includes('5 minutes for claude-opus-5.5') && t.includes('/compact'))).toBe(true);
  });

  it('keeps agent waits informational and never suggests changing models for a longer cache', () => {
    const tips = analyzer([withBreaks(3, ['ttl-expired'], { initiator: 'agent' })]).getPromptCache({ fromDate: DAY }).tips;
    const wait = tips.find(t => t.includes('waited on long-running tools'));
    expect(wait).toContain('not something you did');
    expect(tips.join(' ')).not.toMatch(/switch(?:ing)? (?:to )?(?:a )?(?:different )?model[^.]*(?:longer|lifetime)/i);
  });

  it('does not coach harness-driven causes or causes with too few breaks', () => {
    expect(analyzer([withBreaks(5, ['compaction'])]).getPromptCache({ fromDate: DAY }).tips.some(t => t.toLowerCase().includes('compaction'))).toBe(false);
    expect(analyzer([withBreaks(2, ['ttl-expired'])]).getPromptCache({ fromDate: DAY }).tips.some(t => t.includes('came back'))).toBe(false);
  });

  it('stays quiet below the minimum number of main-agent calls', () => {
    const s = withBreaks(5, ['ttl-expired']);
    for (const r of s.requests) for (const cacheRow of r.promptCache?.rows ?? []) cacheRow.calls = 10;
    expect(analyzer([s]).getPromptCache({ fromDate: DAY }).tips).toEqual([]);
  });
});

describe('PromptCacheAnalyzer sessions and timelines', () => {
  it('lists a workspace\u2019s sessions with cache data, newest first, with a sparkline', () => {
    const older = appSession();
    older.sessionId = 'app-0';
    older.lastMessageDate = Date.parse('2026-10-18T10:00:00Z');
    const data = analyzer([older, appSession()]).getPromptCacheSessions('alpha', 'GitHub Copilot App');
    expect(data.total).toBe(2);
    expect(data.sessions.map(s => s.sessionId)).toEqual(['app-1', 'app-0']);
    expect(data.sessions[0]).toMatchObject({ calls: 71, breaks: 2, rebuiltTokens: 200_000, misses: 470_000, topCause: 'ttl-user', sparkline: [40_000] });
    expect(analyzer([appSession()]).getPromptCacheSessions('alpha', 'Claude').total).toBe(0);
  });

  it('serves a call timeline for Copilot App and a per-request one elsewhere', () => {
    const claude = session('claude-1', 'Claude', [
      request(`${DAY}T11:00:00Z`, { rows: [row('main', [2, 100_000, 50_000, 50_000])] }),
      request(`${DAY}T11:05:00Z`),
      request(`${DAY}T11:10:00Z`, { rows: [row('main', [1, 120_000, 110_000, 10_000])] }),
    ]);
    const a = analyzer([appSession(), claude]);
    const app = a.getSessionTimeline('app-1');
    expect(app).toMatchObject({ unit: 'calls', harness: 'GitHub Copilot App', timeline: { calls: 60 } });
    expect(app?.cache?.breaks.map(b => [b.key, b.control])).toEqual([['ttl-user', 'you'], ['instructions-changed', 'you']]);
    const perRequest = a.getSessionTimeline('claude-1');
    expect(perRequest).toMatchObject({ unit: 'requests', cache: { reporting: 'per-call', breaks: [] } });
    expect(perRequest?.timeline?.buckets.map(b => [b.firstRequest, b.cacheCalls, b.cacheRead])).toEqual([[0, 1, 50_000], [1, 0, 0], [2, 1, 110_000]]);
    expect(a.getSessionTimeline('missing')).toBeNull();
  });
});
