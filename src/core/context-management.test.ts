/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { Analyzer } from './analyzer';
import { Session, SessionRequest, CompactionEvent, ContextManagementData } from './types';
import { createRequest, createSession } from './parser-shared';
import {
  CONTEXT_WINDOW_DEFAULT,
  CONTEXT_OPTIMAL_UTILIZATION,
  CONTEXT_LIMITED_UTILIZATION,
  CONTEXT_COMPACTION_STORM_MIN,
  CONTEXT_MIN_TOKEN_REQUESTS,
  CONTEXT_GROWING_SESSION_MIN_REQS,
} from './constants';

/* ── helpers ─────────────────────────────────────────────────────── */

const BASE_TS = new Date(2025, 5, 15, 10, 0, 0).getTime();

function req(overrides: Partial<SessionRequest> & { messageText?: string; responseText?: string } = {}): SessionRequest {
  return createRequest({
    messageText: overrides.messageText ?? 'tell me something',
    responseText: overrides.responseText ?? 'here is the answer',
    requestId: overrides.requestId ?? `r-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: overrides.timestamp ?? BASE_TS,
    promptTokens: overrides.promptTokens ?? null,
    completionTokens: overrides.completionTokens ?? null,
    compaction: overrides.compaction ?? null,
    ...overrides,
  });
}

function compaction(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    mode: 'full',
    numRounds: 30,
    numRoundsSinceLastSummarization: 15,
    contextLengthBefore: 120_000,
    durationMs: 3000,
    model: 'claude-opus-4.6',
    outcome: 'success',
    ...overrides,
  };
}

function sess(overrides: Partial<Session> & { requests?: SessionRequest[] } = {}): Session {
  const requests = overrides.requests ?? [req()];
  return createSession({
    sessionId: overrides.sessionId ?? `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: overrides.workspaceId ?? 'ws-1',
    workspaceName: overrides.workspaceName ?? 'test-project',
    harness: overrides.harness ?? 'VS Code Insiders',
    requests,
    ...overrides,
  });
}

/** Build N requests with linearly increasing promptTokens. */
function linearTokenRequests(count: number, start: number, step: number, tsBase = BASE_TS): SessionRequest[] {
  return Array.from({ length: count }, (_, i) =>
    req({ requestId: `r-${i}`, timestamp: tsBase + i * 60_000, promptTokens: start + i * step }),
  );
}

/** Build N requests where all have the same promptTokens. */
function flatTokenRequests(count: number, tokens: number, tsBase = BASE_TS): SessionRequest[] {
  return Array.from({ length: count }, (_, i) =>
    req({ requestId: `r-${i}`, timestamp: tsBase + i * 60_000, promptTokens: tokens }),
  );
}

function getCtxMgmt(sessions: Session[], filter?: Record<string, string>): ContextManagementData {
  const a = new Analyzer(sessions);
  return a.getContextManagement(filter);
}

/* ── createRequest token defaults ────────────────────────────────── */

describe('createRequest token fields', () => {
  it('defaults promptTokens, completionTokens, compaction to null', () => {
    const r = createRequest({ messageText: 'hi', responseText: 'hello' });
    expect(r.promptTokens).toBeNull();
    expect(r.completionTokens).toBeNull();
    expect(r.compaction).toBeNull();
  });

  it('passes through explicit token values', () => {
    const r = createRequest({
      messageText: 'hi',
      responseText: 'hello',
      promptTokens: 42_000,
      completionTokens: 1_500,
    });
    expect(r.promptTokens).toBe(42_000);
    expect(r.completionTokens).toBe(1_500);
  });

  it('passes through compaction event', () => {
    const c = compaction({ mode: 'simple', contextLengthBefore: 99_000 });
    const r = createRequest({
      messageText: 'hi',
      responseText: 'hello',
      compaction: c,
    });
    expect(r.compaction).not.toBeNull();
    expect(r.compaction!.mode).toBe('simple');
    expect(r.compaction!.contextLengthBefore).toBe(99_000);
  });

  it('compacts stored text but preserves original message and response lengths', () => {
    const messageText = 'm'.repeat(25_000);
    const responseText = 'r'.repeat(35_000);
    const r = createRequest({ messageText, responseText });

    expect(r.messageLength).toBe(25_000);
    expect(r.responseLength).toBe(35_000);
    expect(r.messageText.length).toBeLessThan(messageText.length);
    expect(r.responseText.length).toBeLessThan(responseText.length);
    expect(r.messageText).toContain('[truncated ');
    expect(r.responseText).toContain('[truncated ');
  });
});

/* ── VS Code-style data (token + compaction) ─────────────────────── */

describe('VS Code data source tokens & compaction', () => {
  it('sessions with promptTokens are counted as having token data', () => {
    const sessions = [
      sess({
        harness: 'VS Code Insiders',
        requests: flatTokenRequests(6, 40_000),
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.sessionsWithTokenData).toBe(1);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].requestsWithTokens).toBe(6);
  });

  it('compaction events are counted per-workspace', () => {
    const reqs = flatTokenRequests(6, 50_000);
    reqs[2] = req({ requestId: 'r-cmp1', timestamp: BASE_TS + 120_000, promptTokens: 50_000, compaction: compaction() });
    reqs[5] = req({ requestId: 'r-cmp2', timestamp: BASE_TS + 300_000, promptTokens: 20_000, compaction: compaction({ mode: 'simple' }) });
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    expect(data.totalCompactions).toBe(2);
    expect(data.fullCompactions).toBe(1);
    expect(data.simpleCompactions).toBe(1);
    expect(data.workspaces[0].compactionCount).toBe(2);
  });

  it('extracts both full and simple compaction modes', () => {
    const fullC = compaction({ mode: 'full' });
    const simpleC = compaction({ mode: 'simple' });
    expect(fullC.mode).toBe('full');
    expect(simpleC.mode).toBe('simple');
  });

  it('tracks only full compactions when all are full', () => {
    const reqs = flatTokenRequests(4, 50_000);
    reqs[1] = req({ requestId: 'r-cmp1', timestamp: BASE_TS + 60_000, promptTokens: 50_000, compaction: compaction({ mode: 'full' }) });
    reqs[3] = req({ requestId: 'r-cmp2', timestamp: BASE_TS + 180_000, promptTokens: 50_000, compaction: compaction({ mode: 'full' }) });
    const data = getCtxMgmt([sess({ requests: reqs })]);
    expect(data.fullCompactions).toBe(2);
    expect(data.simpleCompactions).toBe(0);
  });
});

/* ── Claude data source tokens ───────────────────────────────────── */

describe('Claude data source tokens', () => {
  it('sessions with Claude-style token data are scored', () => {
    const sessions = [
      sess({
        harness: 'Claude',
        workspaceId: 'claude-proj',
        workspaceName: 'claude-project',
        requests: Array.from({ length: 6 }, (_, i) =>
          req({
            requestId: `claude-r-${i}`,
            timestamp: BASE_TS + i * 60_000,
            agentName: 'Claude',
            agentMode: 'agent',
            promptTokens: 8_000 + i * 2_000, // 8K → 18K — lean
            completionTokens: 500 + i * 100,
          }),
        ),
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.sessionsWithTokenData).toBe(1);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].harness).toBe('Claude');
    expect(data.workspaces[0].avgPromptTokens).toBeGreaterThan(0);
    expect(data.workspaces[0].verdict).toBe('optimal'); // low token counts
  });

  it('Claude sessions without compaction have compactionCount 0', () => {
    const sessions = [
      sess({
        harness: 'Claude',
        requests: flatTokenRequests(6, 10_000),
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.totalCompactions).toBe(0);
    expect(data.workspaces[0].compactionCount).toBe(0);
  });
});

/* ── OpenCode data source tokens ─────────────────────────────────── */

describe('OpenCode data source tokens', () => {
  it('sessions with OpenCode-style token data are scored', () => {
    const sessions = [
      sess({
        harness: 'OpenCode',
        workspaceId: 'oc-proj',
        workspaceName: 'opencode-project',
        requests: Array.from({ length: 6 }, (_, i) =>
          req({
            requestId: `oc-r-${i}`,
            timestamp: BASE_TS + i * 60_000,
            agentName: 'OpenCode',
            agentMode: 'build',
            promptTokens: 5_000 + i * 1_000,
            completionTokens: 300,
          }),
        ),
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.sessionsWithTokenData).toBe(1);
    expect(data.workspaces[0].harness).toBe('OpenCode');
    expect(data.workspaces[0].avgPromptTokens).toBeGreaterThan(0);
  });
});

/* ── Codex data source (no per-request tokens) ───────────────────── */

describe('Codex data source (no native tokens)', () => {
  it('Codex sessions without native tokens are excluded from token-based stats', () => {
    const sessions = [
      sess({
        harness: 'Codex',
        workspaceId: 'codex-proj',
        workspaceName: 'codex-project',
        requests: Array.from({ length: 10 }, (_, i) =>
          req({
            requestId: `codex-r-${i}`,
            timestamp: BASE_TS + i * 60_000,
            agentName: 'Codex',
            agentMode: 'agent',
            // no promptTokens — Codex doesn't provide per-request tokens
          }),
        ),
      }),
    ];
    const data = getCtxMgmt(sessions);
    // Approximation has been removed — sessions without native token data
    // are not scored or surfaced as workspaces with token data.
    expect(data.sessionsWithTokenData).toBe(0);
    expect(data.workspaces).toHaveLength(0);
    expect(data.totalSessions).toBe(1);
  });
});

/* ── Mixed harness end-to-end ────────────────────────────────────── */

describe('session-level usage totals', () => {
  it('counts a session whose session-level prompt tokens were all written to the cache', () => {
    const withTokens = sess({
      sessionId: 's-tokens', harness: 'GitHub Copilot CLI', workspaceId: 'ws-cli', workspaceName: 'cli-project',
      requests: flatTokenRequests(5, 50_000),
    });
    const totalsOnly: Session = {
      ...sess({
        sessionId: 's-totals', harness: 'GitHub Copilot CLI', workspaceId: 'ws-cli', workspaceName: 'cli-project',
        requests: [req({ requestId: 'r-totals', timestamp: BASE_TS + 3_600_000 })],
      }),
      modelUsage: { 'claude-opus-5.5': { inputTokens: 0, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 40_000 } },
    };
    expect(getCtxMgmt([withTokens, totalsOnly]).sessionsWithTokenData).toBe(2);
  });
});

describe('mixed harness end-to-end', () => {
  it('combines VS Code + Claude + Codex sessions correctly', () => {
    const sessions = [
      // VS Code with high token usage
      sess({
        sessionId: 's-vsc',
        harness: 'VS Code Insiders',
        workspaceId: 'ws-vsc',
        workspaceName: 'vscode-project',
        requests: flatTokenRequests(10, 100_000),
      }),
      // Claude with low token usage
      sess({
        sessionId: 's-claude',
        harness: 'Claude',
        workspaceId: 'ws-claude',
        workspaceName: 'claude-project',
        requests: flatTokenRequests(8, 10_000),
      }),
      // Codex with no token data
      sess({
        sessionId: 's-codex',
        harness: 'Codex',
        workspaceId: 'ws-codex',
        workspaceName: 'codex-project',
        requests: Array.from({ length: 5 }, (_, i) => req({ requestId: `cx-${i}`, timestamp: BASE_TS + i * 60_000 })),
      }),
    ];
    const data = getCtxMgmt(sessions);

    // Codex has no native tokens and is no longer scored — only VS Code and
    // Claude have native data, so we expect 2 workspaces.
    expect(data.workspaces).toHaveLength(2);
    expect(data.sessionsWithTokenData).toBe(2);
    expect(data.totalSessions).toBe(3);

    // VS Code workspace should be limited or degraded (100K tokens)
    const vscWs = data.workspaces.find(w => w.workspaceName === 'vscode-project');
    expect(vscWs).toBeDefined();
    expect(vscWs!.avgPromptTokens).toBe(100_000);

    // Claude workspace should be optimal
    const claudeWs = data.workspaces.find(w => w.workspaceName === 'claude-project');
    expect(claudeWs).toBeDefined();
    expect(claudeWs!.verdict).toBe('optimal');
    expect(claudeWs!.score).toBeGreaterThan(vscWs!.score);

    // Codex workspace should not appear at all
    expect(data.workspaces.find(w => w.workspaceName === 'codex-project')).toBeUndefined();
  });

  it('filters by harness correctly', () => {
    const sessions = [
      sess({ sessionId: 's1', harness: 'VS Code Insiders', workspaceId: 'ws-1', requests: flatTokenRequests(6, 80_000) }),
      sess({ sessionId: 's2', harness: 'Claude', workspaceId: 'ws-2', requests: flatTokenRequests(6, 10_000) }),
    ];
    const data = getCtxMgmt(sessions, { harness: 'Claude' });
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].harness).toBe('Claude');
    expect(data.totalSessions).toBe(1);
  });

  it('filters by workspace correctly', () => {
    const sessions = [
      sess({ sessionId: 's1', workspaceName: 'alpha', workspaceId: 'ws-a', requests: flatTokenRequests(6, 50_000) }),
      sess({ sessionId: 's2', workspaceName: 'beta', workspaceId: 'ws-b', requests: flatTokenRequests(6, 10_000) }),
    ];
    const data = getCtxMgmt(sessions, { workspaceId: 'ws-a' });
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].workspaceName).toBe('alpha');
  });
});

/* ── Context window estimation ───────────────────────────────────── */

describe('context window estimation', () => {
  it('defaults to 128K when no token data exists', () => {
    const data = getCtxMgmt([sess({ requests: [req()] })]);
    expect(data.estimatedContextWindow).toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('defaults to 128K when max observed is below it', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 40_000) })]);
    expect(data.estimatedContextWindow).toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('rounds up to nearest 32K bucket when max exceeds 128K', () => {
    // Max token = 140_000 → rounds up to ceil(140000/32000)*32000 = 160_000
    const reqs = flatTokenRequests(6, 50_000);
    reqs[3] = req({ requestId: 'peak', timestamp: BASE_TS + 180_000, promptTokens: 140_000 });
    const data = getCtxMgmt([sess({ requests: reqs })]);
    expect(data.estimatedContextWindow).toBe(160_000);
  });

  it('uses 128K floor even with very small token values', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 1_000) })]);
    expect(data.estimatedContextWindow).toBe(CONTEXT_WINDOW_DEFAULT);
  });
});

/* ── Verdict classification ──────────────────────────────────────── */

describe('verdict classification', () => {
  it('optimal when avg utilization ≤ 50%', () => {
    // 50% of 128K = 64K, use 50K to be safely under
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 50_000) })]);
    const ws = data.workspaces[0];
    expect(ws.avgUtilization).toBeLessThanOrEqual(50);
    expect(ws.verdict).toBe('optimal');
  });

  it('degraded when avg utilization between 50% and 80%', () => {
    // target avg ~90K / 128K ≈ 70.3%
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 90_000) })]);
    const ws = data.workspaces[0];
    expect(ws.avgUtilization).toBeGreaterThan(CONTEXT_OPTIMAL_UTILIZATION);
    expect(ws.avgUtilization).toBeLessThanOrEqual(CONTEXT_LIMITED_UTILIZATION);
    expect(ws.verdict).toBe('degraded');
    expect(ws.saturation).toBeGreaterThan(0);
  });

  it('limited when avg utilization > 80%', () => {
    // 110K / 128K ≈ 85.9%
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 110_000) })]);
    const ws = data.workspaces[0];
    expect(ws.avgUtilization).toBeGreaterThan(CONTEXT_LIMITED_UTILIZATION);
    expect(ws.verdict).toBe('limited');
  });

  it('adapts verdict thresholds upward for representative high-utilization datasets', () => {
    const sessions = Array.from({ length: 24 }, (_, i) =>
      sess({
        sessionId: `adaptive-${i}`,
        workspaceId: `ws-${i}`,
        workspaceName: `proj-${i}`,
        requests: flatTokenRequests(6, i < 18 ? 90_000 : 110_000, BASE_TS + i * 86_400_000),
      }),
    );

    const data = getCtxMgmt(sessions);
    expect(data.thresholds.adaptive).toBe(true);
    expect(data.thresholds.optimalUtilization).toBeGreaterThan(CONTEXT_OPTIMAL_UTILIZATION);
    expect(data.thresholds.limitedUtilization).toBeGreaterThanOrEqual(CONTEXT_LIMITED_UTILIZATION);
  });

  it('uses workspace-specific adaptive thresholds in session drilldown', () => {
    const sessions = Array.from({ length: 24 }, (_, i) =>
      sess({
        sessionId: `workspace-adaptive-${i}`,
        workspaceId: 'ws-high',
        workspaceName: 'high-util-project',
        requests: flatTokenRequests(6, i < 18 ? 90_000 : 110_000, BASE_TS + i * 86_400_000),
      }),
    );

    const analyzer = new Analyzer(sessions);
    const detail = analyzer.getWorkspaceContextSessions('high-util-project');
    expect(detail.thresholds.adaptive).toBe(true);
    expect(detail.thresholds.optimalUtilization).toBeGreaterThan(CONTEXT_OPTIMAL_UTILIZATION);
  });
});

/* ── Score calculation ───────────────────────────────────────────── */

describe('score calculation', () => {
  it('optimal workspace has high score', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 20_000) })]);
    expect(data.workspaces[0].score).toBeGreaterThanOrEqual(70);
  });

  it('limited workspace has low score', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 120_000) })]);
    expect(data.workspaces[0].score).toBeLessThan(40);
  });

  it('compactions reduce the score further', () => {
    const reqsNoCompact = flatTokenRequests(6, 60_000);
    const reqsWithCompact = flatTokenRequests(6, 60_000);
    reqsWithCompact[2] = req({ requestId: 'c1', timestamp: BASE_TS + 120_000, promptTokens: 60_000, compaction: compaction() });
    reqsWithCompact[4] = req({ requestId: 'c2', timestamp: BASE_TS + 240_000, promptTokens: 60_000, compaction: compaction() });

    const scoreNoC = getCtxMgmt([sess({ sessionId: 'a', requests: reqsNoCompact })]).workspaces[0].score;
    const scoreWithC = getCtxMgmt([sess({ sessionId: 'b', requests: reqsWithCompact })]).workspaces[0].score;
    expect(scoreWithC).toBeLessThan(scoreNoC);
  });

  it('overall score is weighted by request count', () => {
    const sessions = [
      sess({ sessionId: 's1', workspaceId: 'ws-big', workspaceName: 'big', requests: flatTokenRequests(20, 100_000) }),
      sess({ sessionId: 's2', workspaceId: 'ws-small', workspaceName: 'small', requests: flatTokenRequests(6, 10_000) }),
    ];
    const data = getCtxMgmt(sessions);
    const bigWs = data.workspaces.find(w => w.workspaceName === 'big')!;
    const smallWs = data.workspaces.find(w => w.workspaceName === 'small')!;

    // Overall should be closer to big workspace's low score since it has more requests
    expect(data.overallScore).toBeLessThan(smallWs.score);
    // But not as low as big's score alone because small pulls it up
    expect(data.overallScore).toBeGreaterThan(bigWs.score);
  });

  it('sessions without native tokens are not scored (no estimation fallback)', () => {
    const sessions = [sess({ requests: [req(), req()] })];
    const data = getCtxMgmt(sessions);
    // Approximation has been removed — no native tokens means no score.
    expect(data.workspaces).toHaveLength(0);
    expect(data.overallScore).toBe(0);
  });

  it('score is clamped to 0 minimum even with extreme utilization', () => {
    // Create a workspace with very high utilization and many compactions
    const reqs = flatTokenRequests(10, 127_000);
    for (let i = 0; i < 10; i++) {
      reqs[i] = req({ requestId: `extreme-${i}`, timestamp: BASE_TS + i * 60_000, promptTokens: 127_000, compaction: compaction() });
    }
    const data = getCtxMgmt([sess({ requests: reqs })]);
    expect(data.workspaces[0].score).toBeGreaterThanOrEqual(0);
  });
});

/* ── Workspaces sorted worst-first ───────────────────────────────── */

describe('workspace sorting', () => {
  it('sorts workspaces by score ascending (worst first)', () => {
    const sessions = [
      sess({ sessionId: 's1', workspaceId: 'ws-lean', workspaceName: 'lean', requests: flatTokenRequests(6, 10_000) }),
      sess({ sessionId: 's2', workspaceId: 'ws-bloated', workspaceName: 'bloated', requests: flatTokenRequests(6, 120_000) }),
      sess({ sessionId: 's3', workspaceId: 'ws-moderate', workspaceName: 'moderate', requests: flatTokenRequests(6, 80_000) }),
    ];
    const data = getCtxMgmt(sessions);
    const scores = data.workspaces.map(w => w.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });
});

/* ── Weekly trend ────────────────────────────────────────────────── */

describe('weekly trend', () => {
  it('groups requests into weekly buckets', () => {
    const week1 = BASE_TS;
    const week2 = BASE_TS + 7 * 86_400_000;
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'w1-1', timestamp: week1, promptTokens: 40_000 }),
          req({ requestId: 'w1-2', timestamp: week1 + 86_400_000, promptTokens: 60_000 }),
          req({ requestId: 'w2-1', timestamp: week2, promptTokens: 80_000 }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.trend.length).toBeGreaterThanOrEqual(2);
    // Labels should be sorted
    for (let i = 1; i < data.trend.length; i++) {
      expect(data.trend[i].label > data.trend[i - 1].label).toBe(true);
    }
  });

  it('counts compactions per week', () => {
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 50_000, compaction: compaction() }),
          req({ requestId: 'r2', timestamp: BASE_TS + 60_000, promptTokens: 30_000, compaction: compaction() }),
          req({ requestId: 'r3', timestamp: BASE_TS + 120_000, promptTokens: 40_000 }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    const week = data.trend[0];
    expect(week.compactions).toBe(2);
  });

  it('tracks sessions over threshold per week', () => {
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 120_000 }), // over 80%
          req({ requestId: 'r2', timestamp: BASE_TS + 60_000, promptTokens: 30_000 }), // under
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.trend[0].sessionsOverThreshold).toBe(1);
  });

  it('returns empty trend when no requests have timestamps', () => {
    const sessions = [sess({ requests: [req({ timestamp: null, promptTokens: 50_000 })] })];
    const data = getCtxMgmt(sessions);
    expect(data.trend).toHaveLength(0);
  });
});

/* ── Anti-pattern: context-bloat ─────────────────────────────────── */

describe('anti-pattern: context-bloat', () => {
  it('detects when a session avg utilization exceeds threshold', () => {
    // Need CONTEXT_MIN_TOKEN_REQUESTS (5) requests with >80% avg utilization
    const sessions = [
      sess({
        requests: flatTokenRequests(CONTEXT_MIN_TOKEN_REQUESTS + 1, 110_000),
      }),
    ];
    const data = getCtxMgmt(sessions);
    const bloat = data.antiPatterns.find(p => p.id === 'context-bloat');
    expect(bloat).toBeDefined();
    expect(bloat!.severity).toBe('high');
    expect(bloat!.group).toBe('context-management');
    expect(bloat!.occurrences).toBe(1);
  });

  it('does not trigger for optimal sessions', () => {
    const sessions = [
      sess({ requests: flatTokenRequests(CONTEXT_MIN_TOKEN_REQUESTS + 1, 30_000) }),
    ];
    const data = getCtxMgmt(sessions);
    const bloat = data.antiPatterns.find(p => p.id === 'context-bloat');
    expect(bloat).toBeUndefined();
  });

  it('does not trigger when a session has too few token requests', () => {
    // Only 3 requests, below CONTEXT_MIN_TOKEN_REQUESTS (5)
    const sessions = [
      sess({ requests: flatTokenRequests(3, 110_000) }),
    ];
    const data = getCtxMgmt(sessions);
    const bloat = data.antiPatterns.find(p => p.id === 'context-bloat');
    expect(bloat).toBeUndefined();
  });
});

/* ── Anti-pattern: compaction-storm ──────────────────────────────── */

describe('anti-pattern: compaction-storm', () => {
  it('detects sessions with many compaction events', () => {
    const reqs = flatTokenRequests(CONTEXT_COMPACTION_STORM_MIN + 2, 60_000);
    for (let i = 0; i < CONTEXT_COMPACTION_STORM_MIN; i++) {
      reqs[i] = req({
        requestId: `storm-${i}`,
        timestamp: BASE_TS + i * 60_000,
        promptTokens: 60_000,
        compaction: compaction(),
      });
    }
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const storm = data.antiPatterns.find(p => p.id === 'compaction-storm');
    expect(storm).toBeDefined();
    expect(storm!.severity).toBe('high');
    expect(storm!.occurrences).toBe(1);
  });

  it('does not trigger with few compaction events', () => {
    const reqs = flatTokenRequests(6, 60_000);
    reqs[2] = req({ requestId: 'c1', timestamp: BASE_TS + 120_000, promptTokens: 60_000, compaction: compaction() });
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const storm = data.antiPatterns.find(p => p.id === 'compaction-storm');
    expect(storm).toBeUndefined();
  });

  it('counts across multiple sessions independently', () => {
    // Two sessions each with enough compactions
    function stormSession(id: string): Session {
      const reqs = Array.from({ length: CONTEXT_COMPACTION_STORM_MIN + 1 }, (_, i) =>
        req({ requestId: `${id}-r${i}`, timestamp: BASE_TS + i * 60_000, promptTokens: 60_000, compaction: compaction() }),
      );
      return sess({ sessionId: id, requests: reqs });
    }
    const sessions = [stormSession('s1'), stormSession('s2')];
    const data = getCtxMgmt(sessions);
    const storm = data.antiPatterns.find(p => p.id === 'compaction-storm');
    expect(storm).toBeDefined();
    expect(storm!.occurrences).toBe(2);
  });
});

/* ── Anti-pattern: context-amnesia ───────────────────────────────── */

describe('anti-pattern: context-amnesia', () => {
  it('detects compaction near context limit (>85% utilization before)', () => {
    // contextLengthBefore = 115_000, window = 128_000 → 89.8% > 85%
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 50_000 }),
          req({
            requestId: 'r2', timestamp: BASE_TS + 60_000, promptTokens: 20_000,
            compaction: compaction({ contextLengthBefore: 115_000 }),
          }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    const amnesia = data.antiPatterns.find(p => p.id === 'context-amnesia');
    expect(amnesia).toBeDefined();
    expect(amnesia!.severity).toBe('medium');
  });

  it('does not trigger when compaction happens at lower utilization', () => {
    // contextLengthBefore = 60_000, window = 128_000 → 46.9% < 85%
    const sessions = [
      sess({
        requests: [
          req({
            requestId: 'r1', timestamp: BASE_TS, promptTokens: 50_000,
            compaction: compaction({ contextLengthBefore: 60_000 }),
          }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    const amnesia = data.antiPatterns.find(p => p.id === 'context-amnesia');
    expect(amnesia).toBeUndefined();
  });
});

/* ── Anti-pattern: runaway-context ───────────────────────────────── */

describe('anti-pattern: runaway-context', () => {
  it('detects monotonically increasing token counts', () => {
    // Need CONTEXT_GROWING_SESSION_MIN_REQS (8) requests with >80% sequential increases
    const reqs = linearTokenRequests(CONTEXT_GROWING_SESSION_MIN_REQS + 2, 10_000, 5_000);
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const runaway = data.antiPatterns.find(p => p.id === 'runaway-context');
    expect(runaway).toBeDefined();
    expect(runaway!.severity).toBe('medium');
    expect(runaway!.occurrences).toBe(1);
  });

  it('does not trigger for flat token counts', () => {
    const reqs = flatTokenRequests(CONTEXT_GROWING_SESSION_MIN_REQS + 2, 50_000);
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const runaway = data.antiPatterns.find(p => p.id === 'runaway-context');
    expect(runaway).toBeUndefined();
  });

  it('does not trigger for too few requests', () => {
    // 5 requests, below threshold of 8
    const reqs = linearTokenRequests(5, 10_000, 5_000);
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const runaway = data.antiPatterns.find(p => p.id === 'runaway-context');
    expect(runaway).toBeUndefined();
  });

  it('does not trigger when growth rate is below threshold', () => {
    // Alternating pattern: up, down, up, down — only ~50% increases
    const reqs = Array.from({ length: 10 }, (_, i) =>
      req({
        requestId: `alt-${i}`,
        timestamp: BASE_TS + i * 60_000,
        promptTokens: i % 2 === 0 ? 50_000 : 40_000,
      }),
    );
    const sessions = [sess({ requests: reqs })];
    const data = getCtxMgmt(sessions);
    const runaway = data.antiPatterns.find(p => p.id === 'runaway-context');
    expect(runaway).toBeUndefined();
  });
});

/* ── Tips generation ─────────────────────────────────────────────── */

describe('tips generation', () => {
  it('generates tips for excellent context management', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 10_000) })]);
    expect(data.tips.length).toBeGreaterThan(0);
    expect(data.tips.some(t => t.toLowerCase().includes('excellent') || t.toLowerCase().includes('optimal'))).toBe(true);
  });

  it('generates tips for limited workspaces', () => {
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 120_000) })]);
    expect(data.tips.some(t => t.includes('limited'))).toBe(true);
  });

  it('generates compaction tips when events exist', () => {
    const reqs = flatTokenRequests(6, 50_000);
    reqs[2] = req({ requestId: 'c1', timestamp: BASE_TS + 120_000, promptTokens: 50_000, compaction: compaction() });
    const data = getCtxMgmt([sess({ requests: reqs })]);
    expect(data.tips.some(t => t.includes('compaction'))).toBe(true);
  });
});

/* ── Empty and edge cases ────────────────────────────────────────── */

describe('edge cases', () => {
  it('handles empty session list', () => {
    const data = getCtxMgmt([]);
    expect(data.overallScore).toBe(0);
    expect(data.workspaces).toHaveLength(0);
    expect(data.trend).toHaveLength(0);
    expect(data.totalCompactions).toBe(0);
    expect(data.sessionsWithTokenData).toBe(0);
    expect(data.totalSessions).toBe(0);
    expect(data.antiPatterns).toHaveLength(0);
  });

  it('handles session with single request', () => {
    const data = getCtxMgmt([sess({ requests: [req({ promptTokens: 50_000 })] })]);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].requestsWithTokens).toBe(1);
  });

  it('handles sessions with null timestamps', () => {
    const sessions = [
      sess({
        requests: [
          req({ timestamp: null, promptTokens: 40_000 }),
          req({ timestamp: null, promptTokens: 60_000 }),
        ],
      }),
    ];
    // Should not crash; sessions still have token data but no trend
    const data = getCtxMgmt(sessions);
    // Requests without timestamps are excluded by filter()
    expect(data.trend).toHaveLength(0);
  });

  it('handles mixed requests with and without native tokens in same session', () => {
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 40_000 }),
          req({ requestId: 'r2', timestamp: BASE_TS + 60_000 }), // no native tokens → ignored
          req({ requestId: 'r3', timestamp: BASE_TS + 120_000, promptTokens: 60_000 }),
          req({ requestId: 'r4', timestamp: BASE_TS + 180_000 }), // no native tokens → ignored
          req({ requestId: 'r5', timestamp: BASE_TS + 240_000, promptTokens: 50_000 }),
          req({ requestId: 'r6', timestamp: BASE_TS + 300_000, promptTokens: 45_000 }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.workspaces).toHaveLength(1);
    // Only the 4 native requests are counted (no estimation fallback).
    expect(data.workspaces[0].requestsWithTokens).toBe(4);
  });

  it('multiple sessions in same workspace are merged', () => {
    const sessions = [
      sess({ sessionId: 's1', workspaceId: 'ws-1', workspaceName: 'proj', requests: flatTokenRequests(3, 30_000) }),
      sess({ sessionId: 's2', workspaceId: 'ws-1', workspaceName: 'proj', requests: flatTokenRequests(3, 50_000) }),
    ];
    const data = getCtxMgmt(sessions);
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0].sessionCount).toBe(2);
    expect(data.workspaces[0].requestsWithTokens).toBe(6);
    // avg = (30K*3 + 50K*3) / 6 = 40K
    expect(data.workspaces[0].avgPromptTokens).toBe(40_000);
  });
});

/* ── Analyzer facade integration ─────────────────────────────────── */

describe('Analyzer.getContextManagement integration', () => {
  it('is callable via the Analyzer facade', () => {
    const sessions = [sess({ requests: flatTokenRequests(6, 50_000) })];
    const analyzer = new Analyzer(sessions);
    const data = analyzer.getContextManagement();
    expect(data).toBeDefined();
    expect(data.overallScore).toBeGreaterThan(0);
    expect(data.workspaces).toHaveLength(1);
  });

  it('date filter narrows results', () => {
    const oldTs = new Date(2024, 0, 15).getTime();
    const newTs = new Date(2025, 5, 15).getTime();
    const sessions = [
      sess({
        sessionId: 's-old', creationDate: oldTs, lastMessageDate: oldTs,
        requests: flatTokenRequests(6, 100_000).map((r, i) => ({ ...r, timestamp: oldTs + i * 60_000 })),
      }),
      sess({
        sessionId: 's-new', creationDate: newTs, lastMessageDate: newTs,
        requests: flatTokenRequests(6, 20_000).map((r, i) => ({ ...r, timestamp: newTs + i * 60_000 })),
      }),
    ];
    const analyzer = new Analyzer(sessions);

    const all = analyzer.getContextManagement();
    expect(all.totalSessions).toBe(2);

    // Filter to just 2025
    const filtered = analyzer.getContextManagement({ fromDate: '2025-01-01' });
    expect(filtered.totalSessions).toBe(1);
    expect(filtered.workspaces[0].avgPromptTokens).toBe(20_000);
  });
});

/* ── Realistic multi-source simulation ───────────────────────────── */

describe('realistic multi-source simulation', () => {
  it('simulates a real scenario with VS Code bloat, Claude lean, Codex no data', () => {
    const tsBase = new Date(2025, 5, 1, 10, 0, 0).getTime();

    // VS Code Insiders: long agent session with growing context hitting compaction
    const vscReqs: SessionRequest[] = [];
    for (let i = 0; i < 15; i++) {
      const tokens = 20_000 + i * 8_000; // 20K → 132K
      const hasCompaction = i === 10 || i === 13;
      vscReqs.push(req({
        requestId: `vsc-${i}`,
        timestamp: tsBase + i * 120_000,
        promptTokens: hasCompaction ? 25_000 : tokens, // tokens drop after compaction
        completionTokens: 1_000 + i * 100,
        compaction: hasCompaction ? compaction({ contextLengthBefore: tokens, mode: i === 10 ? 'full' : 'simple' }) : null,
        agentName: 'Copilot',
        agentMode: 'agent',
        modelId: 'claude-sonnet-4',
      }));
    }

    // Claude Code: focused short sessions with low token usage
    const claudeReqs: SessionRequest[] = [];
    for (let i = 0; i < 8; i++) {
      claudeReqs.push(req({
        requestId: `claude-${i}`,
        timestamp: tsBase + i * 90_000,
        promptTokens: 6_000 + i * 500, // 6K → 9.5K — very lean
        completionTokens: 400,
        agentName: 'Claude',
        agentMode: 'agent',
        modelId: 'claude-sonnet-4',
      }));
    }

    // OpenCode: moderate usage
    const ocReqs: SessionRequest[] = [];
    for (let i = 0; i < 6; i++) {
      ocReqs.push(req({
        requestId: `oc-${i}`,
        timestamp: tsBase + 86_400_000 + i * 60_000, // next day
        promptTokens: 40_000 + i * 3_000,
        completionTokens: 800,
        agentName: 'OpenCode',
        agentMode: 'build',
      }));
    }

    // Codex: no token data
    const codexReqs: SessionRequest[] = [];
    for (let i = 0; i < 5; i++) {
      codexReqs.push(req({
        requestId: `codex-${i}`,
        timestamp: tsBase + 2 * 86_400_000 + i * 60_000,
        agentName: 'Codex',
        agentMode: 'agent',
      }));
    }

    const sessions = [
      sess({ sessionId: 's-vsc', harness: 'VS Code Insiders', workspaceId: 'ws-vsc', workspaceName: 'main-project', requests: vscReqs }),
      sess({ sessionId: 's-claude', harness: 'Claude', workspaceId: 'ws-claude', workspaceName: 'side-project', requests: claudeReqs }),
      sess({ sessionId: 's-oc', harness: 'OpenCode', workspaceId: 'ws-oc', workspaceName: 'oc-project', requests: ocReqs }),
      sess({ sessionId: 's-codex', harness: 'Codex', workspaceId: 'ws-codex', workspaceName: 'codex-project', requests: codexReqs }),
    ];

    const data = getCtxMgmt(sessions);

    // Basic structure
    expect(data.totalSessions).toBe(4);
    expect(data.sessionsWithTokenData).toBe(3); // Codex has no native tokens — excluded
    expect(data.workspaces).toHaveLength(3);

    // Compaction tracking
    expect(data.totalCompactions).toBe(2); // only VS Code had compactions

    // VS Code workspace is the most bloated
    const vscWs = data.workspaces.find(w => w.workspaceName === 'main-project')!;
    expect(vscWs).toBeDefined();
    expect(vscWs.compactionCount).toBe(2);
    expect(vscWs.requestsWithTokens).toBe(15);

    // Claude workspace is optimal
    const claudeWs = data.workspaces.find(w => w.workspaceName === 'side-project')!;
    expect(claudeWs).toBeDefined();
    expect(claudeWs.verdict).toBe('optimal');
    expect(claudeWs.compactionCount).toBe(0);

    // OpenCode workspace
    const ocWs = data.workspaces.find(w => w.workspaceName === 'oc-project')!;
    expect(ocWs).toBeDefined();
    expect(ocWs.requestsWithTokens).toBe(6);

    // Claude should have the best score
    expect(claudeWs.score).toBeGreaterThan(vscWs.score);
    expect(claudeWs.score).toBeGreaterThanOrEqual(ocWs.score);

    // Trend should span multiple weeks (different days)
    expect(data.trend.length).toBeGreaterThanOrEqual(1);

    // Tips should be generated
    expect(data.tips.length).toBeGreaterThan(0);

    // Anti-patterns should include runaway context (VS Code has monotonically growing early requests)
    // and possibly context-amnesia (compaction at high utilization)
    expect(data.antiPatterns.length).toBeGreaterThan(0);
    // All anti-patterns should be in context-management group
    for (const ap of data.antiPatterns) {
      expect(ap.group).toBe('context-management');
    }
  });

  it('Xcode sessions without native tokens are excluded (no estimation)', () => {
    const sessions = [
      sess({
        harness: 'Xcode',
        workspaceId: 'xcode-proj',
        workspaceName: 'ios-app',
        requests: Array.from({ length: 8 }, (_, i) =>
          req({ requestId: `xc-${i}`, timestamp: BASE_TS + i * 60_000 }),
        ),
      }),
    ];
    const data = getCtxMgmt(sessions);
    // Approximation has been removed — Xcode sessions without native token
    // data are no longer surfaced as workspaces with token data.
    expect(data.sessionsWithTokenData).toBe(0);
    expect(data.workspaces).toHaveLength(0);
    expect(data.totalSessions).toBe(1);
  });
});

/* ── CompactionEvent structure ───────────────────────────────────── */

describe('CompactionEvent fields', () => {
  it('full compaction event has all fields populated', () => {
    const c = compaction();
    expect(c.mode).toBe('full');
    expect(c.numRounds).toBeGreaterThan(0);
    expect(c.numRoundsSinceLastSummarization).toBeGreaterThan(0);
    expect(c.contextLengthBefore).toBeGreaterThan(0);
    expect(c.durationMs).toBeGreaterThan(0);
    expect(c.model).toBeTruthy();
    expect(c.outcome).toBe('success');
  });

  it('simple compaction mode is preserved', () => {
    const c = compaction({ mode: 'simple' });
    expect(c.mode).toBe('simple');
  });

  it('compaction with zero contextLengthBefore does not trigger amnesia', () => {
    const sessions = [
      sess({
        requests: [
          req({
            requestId: 'r1', timestamp: BASE_TS, promptTokens: 50_000,
            compaction: compaction({ contextLengthBefore: 0 }),
          }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    const amnesia = data.antiPatterns.find(p => p.id === 'context-amnesia');
    expect(amnesia).toBeUndefined();
  });
});

/* ── Utilization math ────────────────────────────────────────────── */

describe('utilization calculations', () => {
  it('avgUtilization is correctly calculated', () => {
    // 64K / 128K = exactly 50%
    const data = getCtxMgmt([sess({ requests: flatTokenRequests(6, 64_000) })]);
    expect(data.workspaces[0].avgUtilization).toBe(50);
  });

  it('peakUtilization uses the max token value', () => {
    const reqs = [
      req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 30_000 }),
      req({ requestId: 'r2', timestamp: BASE_TS + 60_000, promptTokens: 96_000 }),
      req({ requestId: 'r3', timestamp: BASE_TS + 120_000, promptTokens: 40_000 }),
    ];
    const data = getCtxMgmt([sess({ requests: reqs })]);
    // peak = 96K / 128K = 75%
    expect(data.workspaces[0].peakUtilization).toBe(75);
    expect(data.workspaces[0].maxPromptTokens).toBe(96_000);
  });

  it('utilization adjusts when context window is estimated larger', () => {
    // If max tokens = 140K, window becomes 160K
    // Then 140K / 160K = 87.5% peak utilization
    const reqs = flatTokenRequests(6, 50_000);
    reqs[3] = req({ requestId: 'peak', timestamp: BASE_TS + 180_000, promptTokens: 140_000 });
    const data = getCtxMgmt([sess({ requests: reqs })]);
    expect(data.estimatedContextWindow).toBe(160_000);
    expect(data.workspaces[0].peakUtilization).toBe(87.5);
  });
});

/* ── No-estimation behavior (formerly token estimation from text) ─── */

describe('no-estimation behavior', () => {
  it('sessions without native tokens are not surfaced as workspaces', () => {
    const sessions = [
      sess({
        requests: Array.from({ length: 10 }, (_, i) =>
          req({ requestId: `noest-${i}`, timestamp: BASE_TS + i * 60_000 }),
        ),
      }),
    ];
    const data = getCtxMgmt(sessions);
    // Approximation has been removed — without native tokens the workspace
    // produces no scored entries.
    expect(data.workspaces).toHaveLength(0);
    expect(data.sessionsWithTokenData).toBe(0);
  });

  it('referenced files / tool calls / message length do NOT influence token counts', () => {
    // Previously each of these inputs would inflate estimated tokens. After
    // removing approximation, only native promptTokens matter.
    const noExtras = [
      req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 10_000 }),
      req({ requestId: 'r2', timestamp: BASE_TS + 60_000, promptTokens: 12_000 }),
    ];
    const lotsOfExtras = [
      req({
        requestId: 'r1',
        timestamp: BASE_TS,
        promptTokens: 10_000,
        messageText: 'x'.repeat(20_000),
        responseText: 'y'.repeat(20_000),
        referencedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        toolsUsed: ['readFile', 'search', 'editFile'],
      }),
      req({
        requestId: 'r2',
        timestamp: BASE_TS + 60_000,
        promptTokens: 12_000,
        messageText: 'x'.repeat(20_000),
        responseText: 'y'.repeat(20_000),
        referencedFiles: ['e.ts'],
        toolsUsed: ['grep'],
      }),
    ];
    const d1 = getCtxMgmt([sess({ sessionId: 's1', workspaceId: 'ws-1', requests: noExtras })]);
    const d2 = getCtxMgmt([sess({ sessionId: 's2', workspaceId: 'ws-2', requests: lotsOfExtras })]);
    // Same native token totals → identical avg/max regardless of text/files/tools.
    expect(d2.workspaces[0].avgPromptTokens).toBe(d1.workspaces[0].avgPromptTokens);
    expect(d2.workspaces[0].maxPromptTokens).toBe(d1.workspaces[0].maxPromptTokens);
  });

  it('native tokens are counted; missing-token requests are skipped', () => {
    const sessions = [
      sess({
        requests: [
          req({ requestId: 'r1', timestamp: BASE_TS, promptTokens: 50_000 }),
          req({ requestId: 'r2', timestamp: BASE_TS + 60_000 }), // no native tokens
          req({ requestId: 'r3', timestamp: BASE_TS + 120_000, promptTokens: 60_000 }),
        ],
      }),
    ];
    const data = getCtxMgmt(sessions);
    // Only 2 of 3 requests had native data.
    expect(data.workspaces[0].requestsWithTokens).toBe(2);
    expect(data.workspaces[0].maxPromptTokens).toBe(60_000);
  });

  it('fullCompactions and simpleCompactions default to 0', () => {
    const sessions = [sess({ requests: [req({ promptTokens: 5000 })] })];
    const data = getCtxMgmt(sessions);
    expect(data.fullCompactions).toBe(0);
    expect(data.simpleCompactions).toBe(0);
  });
});

/* ── getContextRangeAvailability ─────────────────────────────────── */

describe('getContextRangeAvailability', () => {
  const NOW = Date.now();
  const DAY = 86_400_000;

  it('returns no ranges when no requests have native tokens', () => {
    const sessions = [sess({ requests: [req({ promptTokens: null, timestamp: NOW - DAY })] })];
    const a = new Analyzer(sessions);
    expect(a.getContextRangeAvailability().rangesWithTokens).toEqual([]);
  });

  it('returns only the smallest range when all data is recent', () => {
    const sessions = [sess({ requests: [
      req({ requestId: 'r1', promptTokens: 1000, timestamp: NOW - 5 * DAY }),
      req({ requestId: 'r2', promptTokens: 2000, timestamp: NOW - 10 * DAY }),
    ] })];
    const a = new Analyzer(sessions);
    // All data is < 30 days old, so wider ranges add nothing.
    expect(a.getContextRangeAvailability().rangesWithTokens).toEqual([30]);
  });

  it('includes wider ranges only when they capture strictly more data', () => {
    const sessions = [sess({ requests: [
      req({ requestId: 'r1', promptTokens: 1000, timestamp: NOW - 5 * DAY }),     // in 30
      req({ requestId: 'r2', promptTokens: 2000, timestamp: NOW - 60 * DAY }),    // in 90
      req({ requestId: 'r3', promptTokens: 3000, timestamp: NOW - 200 * DAY }),   // in 365
      req({ requestId: 'r4', promptTokens: 4000, timestamp: NOW - 400 * DAY }),   // in all-time
    ] })];
    const a = new Analyzer(sessions);
    // 30 → 1, 90 → 2, 180 → still 2 (skipped), 365 → 3, all-time (0) → 4
    expect(a.getContextRangeAvailability().rangesWithTokens).toEqual([30, 90, 365, 0]);
  });

  it('ignores requests with no native token data', () => {
    const sessions = [sess({ requests: [
      req({ requestId: 'r1', promptTokens: null, timestamp: NOW - 5 * DAY }),
      req({ requestId: 'r2', promptTokens: 1000, timestamp: NOW - 100 * DAY }),
    ] })];
    const a = new Analyzer(sessions);
    // Only the 100-day-old request counts.
    expect(a.getContextRangeAvailability().rangesWithTokens).toEqual([180]);
  });

  it('respects workspace filter', () => {
    const sessions = [
      sess({ workspaceId: 'ws-A', requests: [req({ promptTokens: 1000, timestamp: NOW - 5 * DAY })] }),
      sess({ workspaceId: 'ws-B', requests: [req({ promptTokens: 2000, timestamp: NOW - 200 * DAY })] }),
    ];
    const a = new Analyzer(sessions);
    expect(a.getContextRangeAvailability({ workspaceId: 'ws-A' }).rangesWithTokens).toEqual([30]);
    expect(a.getContextRangeAvailability({ workspaceId: 'ws-B' }).rangesWithTokens).toEqual([365]);
  });

  it('reports harnesses that emit no per-request token data', () => {
    const sessions = [
      sess({ harness: 'GitHub Copilot CLI', requests: [
        req({ requestId: 'r1', promptTokens: null, timestamp: NOW - 5 * DAY }),
        req({ requestId: 'r2', promptTokens: null, timestamp: NOW - 6 * DAY }),
      ] }),
      sess({ harness: 'Local Agent', requests: [req({ promptTokens: 1000, timestamp: NOW - 5 * DAY })] }),
    ];
    const a = new Analyzer(sessions);
    // No filter: both harnesses considered. Local Agent has tokens, CLI doesn't.
    const all = a.getContextRangeAvailability();
    expect(all.matchingSessions).toBe(2);
    expect(all.sessionsWithRequestTokens).toBe(1);
    expect(all.harnessesWithoutRequestTokens).toEqual(['GitHub Copilot CLI']);
    // Filter to CLI: empty ranges + diagnostic explains the gap.
    const cli = a.getContextRangeAvailability({ harness: 'GitHub Copilot CLI' });
    expect(cli.rangesWithTokens).toEqual([]);
    expect(cli.matchingSessions).toBe(1);
    expect(cli.sessionsWithRequestTokens).toBe(0);
    expect(cli.harnessesWithoutRequestTokens).toEqual(['GitHub Copilot CLI']);
  });

  it('reports zero matching sessions when filter excludes everything', () => {
    const sessions = [sess({ harness: 'Local Agent', requests: [req({ promptTokens: 1000 })] })];
    const a = new Analyzer(sessions);
    const out = a.getContextRangeAvailability({ harness: 'Codex' });
    expect(out.matchingSessions).toBe(0);
    expect(out.sessionsWithRequestTokens).toBe(0);
    expect(out.harnessesWithoutRequestTokens).toEqual([]);
  });
});
