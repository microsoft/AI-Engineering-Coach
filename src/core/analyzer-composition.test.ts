/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { Analyzer } from './analyzer';
import { createRequest, createSession } from './parser-shared';
import type { ContextCompositionData, PromptComposition, Session, SessionContextComposition, SessionRequest } from './types';

const MONDAY = new Date(2026, 8, 7, 10, 0, 0).getTime();
const DAY = 86_400_000;

function vscodeComposition(tools: number, promptTokens: number | null, extra: PromptComposition['shares'] = {}): PromptComposition {
  const system = 10;
  const toolResults = 20;
  const files = 0;
  return {
    source: 'vscode',
    promptTokens,
    shares: { systemInstructions: system, toolDefinitions: tools, messages: 100 - system - tools - toolResults - files, toolResults, files, ...extra },
  };
}

function cliComposition(tools: number, system: number, promptTokens: number, calls = 4): PromptComposition {
  return {
    source: 'copilot-cli',
    promptTokens,
    calls,
    toolDefinitionTokens: Math.round((tools / 100) * promptTokens),
    availableTools: 271,
    shares: { toolDefinitions: tools, systemInstructions: system, conversation: 100 - tools - system },
  };
}

function req(ts: number, composition?: PromptComposition, promptTokens: number | null = null): SessionRequest {
  return createRequest({
    messageText: 'a prompt',
    responseText: 'an answer',
    requestId: `r-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: ts,
    promptTokens,
    ...(composition ? { promptComposition: composition } : {}),
  });
}

function sess(harness: string, workspaceName: string, requests: SessionRequest[], contextComposition?: SessionContextComposition): Session {
  return createSession({
    sessionId: `s-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: workspaceName,
    workspaceName,
    harness,
    requests,
    ...(contextComposition ? { contextComposition } : {}),
  });
}

function composition(sessions: Session[], filter?: Record<string, string>): ContextCompositionData {
  const data = new Analyzer(sessions).getContextManagement(filter).composition;
  expect(data).toBeDefined();
  return data as ContextCompositionData;
}

function pct(data: { slices: { category: string; pct: number }[] } | null | undefined, category: string): number | undefined {
  return data?.slices.find(slice => slice.category === category)?.pct;
}

describe('context composition aggregation', () => {
  it('weights shares by prompt size and estimates tokens per category', () => {
    const data = composition([
      sess('Local Agent', 'api', [
        req(MONDAY, vscodeComposition(60, 30_000)),
        req(MONDAY + 60_000, vscodeComposition(20, 10_000)),
      ]),
    ]);
    const vscode = data.harnesses[0];
    expect(vscode.breakdown?.weighting).toBe('tokens');
    // (60 × 30K + 20 × 10K) / 40K = 50%
    expect(pct(vscode.breakdown, 'toolDefinitions')).toBe(50);
    expect(vscode.breakdown?.avgPromptTokens).toBe(20_000);
    expect(vscode.breakdown?.slices.find(slice => slice.category === 'toolDefinitions')?.tokens).toBe(10_000);
    expect(vscode.breakdown?.slices.map(slice => slice.category)).toEqual(['systemInstructions', 'toolDefinitions', 'messages', 'toolResults', 'files']);
    expect(vscode.toolHeavyPct).toBe(50);
  });

  it('weights Copilot CLI turns by their model calls and averages the prompt size per call', () => {
    // One turn of ten 100K-token calls and one turn of a single 20K-token call.
    const session = sess('GitHub Copilot CLI', 'cli', [
      req(MONDAY, cliComposition(20, 5, 100_000, 10)),
      req(MONDAY + 60_000, cliComposition(50, 5, 20_000, 1)),
    ]);
    const cli = composition([session]).harnesses[0];
    // 1,020K tokens over 11 calls, not the 60K mean of the two turns.
    expect(cli.breakdown?.avgPromptTokens).toBe(92_727);
    // (20 × 1,000K + 50 × 20K) / 1,020K, not (20 × 100K + 50 × 20K) / 120K = 25%.
    expect(pct(cli.breakdown, 'toolDefinitions')).toBe(20.6);
    // The per-call estimate now agrees with the measured per-call tool tokens.
    expect(cli.breakdown?.slices.find(slice => slice.category === 'toolDefinitions')?.tokens).toBe(19_091);
    expect(cli.avgToolDefinitionTokens).toBe(19_091);
    // Samples and coverage still count turns.
    expect(cli.breakdown?.samples).toBe(2);
    expect(cli.requestsWithData).toBe(2);
    const detail = new Analyzer([session]).getWorkspaceContextSessions('cli').sessions[0].composition?.breakdown;
    expect(detail?.avgPromptTokens).toBe(92_727);
    expect(pct(detail, 'toolDefinitions')).toBe(20.6);
  });

  it('summarizes VS Code and Copilot CLI separately instead of pooling them', () => {
    const data = composition([
      sess('Local Agent', 'api', [req(MONDAY, vscodeComposition(40, 50_000)), req(MONDAY + 1, vscodeComposition(60, 50_000))]),
      sess('Local Agent (Insiders)', 'web', [req(MONDAY, vscodeComposition(20, 50_000))]),
      sess('GitHub Copilot App', 'app', [req(MONDAY, cliComposition(8, 4, 300_000, 40))]),
      sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(12, 4, 200_000, 10))]),
    ]);
    expect(data.sources.map(s => [s.source, s.label, s.harnesses, s.requestsWithData])).toEqual([
      ['vscode', 'VS Code', ['Local Agent', 'Local Agent (Insiders)'], 3],
      ['copilot-cli', 'Copilot App and Copilot CLI', ['GitHub Copilot App', 'GitHub Copilot CLI'], 2],
    ]);
    const [vscode, cli] = data.sources;
    // VS Code records one call per request, so equal prompt sizes weigh equally.
    expect(pct(vscode.breakdown, 'toolDefinitions')).toBe(40);
    expect(vscode.breakdown.avgPromptTokens).toBe(50_000);
    expect(vscode.toolHeavyPct).toBe(33.3);
    // Every Copilot CLI call counts: (8 × 12,000K + 12 × 2,000K) / 14,000K over 50 calls.
    expect(pct(cli.breakdown, 'toolDefinitions')).toBe(8.6);
    expect(cli.breakdown.avgPromptTokens).toBe(280_000);
    expect(cli).toMatchObject({ avgToolDefinitionTokens: 24_000, maxAvailableTools: 271 });
    // Pooled, the 50 Copilot CLI calls would pull VS Code's 40% down to about 9%.
    expect(data).not.toHaveProperty('overall');
  });

  it('falls back to request weighting when no prompt sizes are known', () => {
    const data = composition([
      sess('Local Agent', 'api', [req(MONDAY, vscodeComposition(60, null)), req(MONDAY + 1, vscodeComposition(20, null))]),
    ]);
    const vscode = data.sources[0].breakdown;
    expect(vscode.weighting).toBe('requests');
    expect(pct(vscode, 'toolDefinitions')).toBe(40);
    expect(vscode.avgPromptTokens).toBeNull();
    expect(vscode.slices[0].tokens).toBeNull();
  });

  it('normalizes rounding noise and reports a large shortfall as other', () => {
    const data = composition([
      sess('Local Agent', 'api', [
        req(MONDAY, { source: 'vscode', promptTokens: 1000, shares: { systemInstructions: 26, toolDefinitions: 61, messages: 5, toolResults: 8, files: 1 } }),
      ]),
      sess('Local Agent (Insiders)', 'web', [
        req(MONDAY, { source: 'vscode', promptTokens: 1000, shares: { systemInstructions: 20, toolDefinitions: 50, messages: 10, toolResults: 0, files: 0 } }),
      ]),
    ]);
    const stable = data.harnesses.find(h => h.harness === 'Local Agent');
    const insiders = data.harnesses.find(h => h.harness === 'Local Agent (Insiders)');
    expect(stable?.breakdown?.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 0);
    expect(pct(stable?.breakdown, 'other')).toBeUndefined();
    expect(pct(insiders?.breakdown, 'other')).toBe(20);
  });

  it('reports per-harness coverage and the not-reported state honestly', () => {
    const data = composition([
      sess('Local Agent', 'api', [req(MONDAY, vscodeComposition(40, 50_000)), req(MONDAY + 1)]),
      sess('Local Agent', 'api', [req(MONDAY + 2)]),
      sess('GitHub Copilot CLI', 'api', [req(MONDAY, cliComposition(10, 5, 300_000))]),
      sess('Claude', 'api', [req(MONDAY, undefined, 90_000), req(MONDAY + 1, undefined, 95_000)]),
      sess('Codex', 'api', [req(MONDAY)]),
    ]);
    const byName = new Map(data.harnesses.map(h => [h.harness, h]));
    expect(byName.get('Local Agent')).toMatchObject({ source: 'vscode', requestsWithData: 1, totalRequests: 3, sessions: 2, sessionsWithData: 1 });
    expect(byName.get('GitHub Copilot CLI')).toMatchObject({ source: 'copilot-cli', requestsWithData: 1, avgToolDefinitionTokens: 30_000, maxAvailableTools: 271 });
    expect(byName.get('Claude')).toMatchObject({ source: null, breakdown: null, requestsWithData: 0, totalRequests: 2, toolHeavyPct: null });
    expect(byName.get('Codex')?.source).toBeNull();
    expect(data.coverage).toEqual({ requestsWithData: 2, totalRequests: 7, sessionsWithData: 2, totalSessions: 5 });
    // Ties on sampled requests fall back to total requests.
    expect(data.harnesses.map(h => h.harness).slice(0, 2)).toEqual(['Local Agent', 'GitHub Copilot CLI']);
  });

  it('marks capable harnesses without data in range as reporting-capable, not unsupported', () => {
    const data = composition([sess('Local Agent', 'api', [req(MONDAY)]), sess('GitHub Copilot App', 'api', [req(MONDAY)])]);
    expect(data.harnesses.map(h => [h.harness, h.source, h.breakdown])).toEqual([
      ['GitHub Copilot App', 'copilot-cli', null],
      ['Local Agent', 'vscode', null],
    ]);
    expect(data.sources).toEqual([]);
  });

  it('honours the date filter', () => {
    const data = composition([
      sess('Local Agent', 'api', [
        req(MONDAY - 30 * DAY, vscodeComposition(90, 10_000)),
        req(MONDAY, vscodeComposition(10, 10_000)),
      ]),
    ], { fromDate: new Date(MONDAY - DAY).toISOString().slice(0, 10) });
    expect(data.coverage.requestsWithData).toBe(1);
    expect(pct(data.sources[0].breakdown, 'toolDefinitions')).toBe(10);
  });

  it('builds a weekly trend per harness aligned to shared labels', () => {
    const data = composition([
      sess('Local Agent', 'api', [req(MONDAY, vscodeComposition(60, 1000)), req(MONDAY + 7 * DAY, vscodeComposition(30, 1000))]),
      sess('GitHub Copilot CLI', 'cli', [req(MONDAY + 7 * DAY + 3600_000, cliComposition(12, 6, 100_000))]),
    ]);
    expect(data.trend.labels).toHaveLength(2);
    const vscode = data.trend.series.find(s => s.harness === 'Local Agent');
    const cli = data.trend.series.find(s => s.harness === 'GitHub Copilot CLI');
    expect(vscode?.toolDefinitions).toEqual([60, 30]);
    expect(vscode?.systemInstructions).toEqual([10, 10]);
    expect(cli?.toolDefinitions).toEqual([null, 12]);
    expect(cli?.samples).toEqual([0, 1]);
  });

  it('ranks workspace rows by sampled requests, one row per workspace and source', () => {
    const data = composition([
      sess('Local Agent', 'small', [req(MONDAY, vscodeComposition(40, 1000))]),
      sess('Local Agent', 'big', [req(MONDAY, vscodeComposition(40, 1000)), req(MONDAY + 1, vscodeComposition(40, 1000))]),
      sess('Local Agent (Insiders)', 'big', [req(MONDAY + 2, vscodeComposition(20, 1000))]),
      sess('GitHub Copilot CLI', 'big', [req(MONDAY, cliComposition(10, 5, 100_000))]),
      sess('Claude', 'none', [req(MONDAY)]),
    ]);
    // A workspace used from VS Code and Copilot CLI gets a row per source instead of a pooled bar.
    expect(data.workspaces.map(w => [w.workspaceName, w.source, w.label, w.harnesses, w.breakdown.samples])).toEqual([
      ['big', 'vscode', 'VS Code', ['Local Agent', 'Local Agent (Insiders)'], 3],
      ['big', 'copilot-cli', 'Copilot CLI', ['GitHub Copilot CLI'], 1],
      ['small', 'vscode', 'VS Code', ['Local Agent'], 1],
    ]);
    expect(pct(data.workspaces[0].breakdown, 'toolDefinitions')).toBe(33.3);
    expect(pct(data.workspaces[1].breakdown, 'toolDefinitions')).toBe(10);
  });

  it('averages Copilot CLI system-prompt segments over the sessions that have them, ranked by total contribution', () => {
    const segments = (memory: number, rare = 0): SessionContextComposition => ({
      systemSegments: [
        { name: 'tool_instructions', tokens: 9_000 },
        ...(memory > 0 ? [{ name: 'memory', tokens: memory }] : []),
        ...(rare > 0 ? [{ name: 'customized_prompt', tokens: rare }] : []),
      ],
      toolCount: 64,
      toolTokens: 33_000,
      compactions: [],
    });
    const data = composition([
      sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(10, 5, 100_000))], segments(1_000, 12_000)),
      sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(10, 5, 100_000))], segments(3_000)),
      sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(10, 5, 100_000))], segments(0)),
    ]);
    expect(data.systemSegmentSessions).toBe(3);
    expect(data.systemSegments).toEqual([
      { name: 'tool_instructions', avgTokens: 9_000, sessions: 3 },
      { name: 'customized_prompt', avgTokens: 12_000, sessions: 1 },
      { name: 'memory', avgTokens: 2_000, sessions: 2 },
    ]);
  });
});

describe('context composition tips', () => {
  function tips(sessions: Session[]): string[] {
    return new Analyzer(sessions).getContextManagement().tips;
  }

  it('coaches on tool definitions per source with a link to GitHub guidance', () => {
    const many = Array.from({ length: 12 }, (_, i) => req(MONDAY + i, vscodeComposition(55, 40_000)));
    const result = tips([sess('Local Agent', 'api', many.slice(0, 6)), sess('Local Agent (Insiders)', 'api', many.slice(6))]);
    const toolTips = result.filter(tip => tip.startsWith('Tool definitions take'));
    expect(toolTips).toHaveLength(1);
    expect(toolTips[0]).toContain('VS Code');
    expect(toolTips[0]).toContain('100% of requests');
    expect(toolTips[0]).toContain('optimize-ai-usage');
  });

  it('mentions per-call tool tokens for Copilot CLI and flags conversation-heavy prompts', () => {
    const turns = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, cliComposition(31, 3, 100_000)));
    const result = tips([sess('GitHub Copilot CLI', 'cli', turns)]);
    expect(result.some(tip => tip.includes('31.0K tokens to every Copilot CLI model call') && tip.includes('271 tools') && tip.includes('31% of your prompts'))).toBe(true);
    const lean = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, cliComposition(4, 3, 400_000)));
    const leanTips = tips([sess('GitHub Copilot CLI', 'cli', lean)]);
    expect(leanTips.some(tip => tip.startsWith('Tool definitions'))).toBe(false);
    expect(leanTips.some(tip => tip.startsWith('Conversation history fills 93%'))).toBe(true);
  });

  it('flags large per-call tool definitions in Copilot CLI even when their share is small', () => {
    const turns = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, cliComposition(8, 4, 330_000)));
    const result = tips([sess('GitHub Copilot CLI', 'cli', turns)]);
    expect(result.some(tip => tip.startsWith('Tool definitions add about 26.4K tokens to every Copilot CLI model call') && tip.includes('8% of your prompts'))).toBe(true);
  });

  it('names the Copilot App when its sessions supply the data', () => {
    const app = Array.from({ length: 6 }, (_, i) => req(MONDAY + i, cliComposition(8, 4, 330_000)));
    const cli = Array.from({ length: 6 }, (_, i) => req(MONDAY + i, cliComposition(8, 4, 330_000)));
    expect(tips([sess('GitHub Copilot App', 'app', [...app, ...cli])]).some(tip => tip.includes('every Copilot App model call'))).toBe(true);
    const both = tips([sess('GitHub Copilot App', 'app', app), sess('GitHub Copilot CLI', 'cli', cli)]);
    expect(both.some(tip => tip.includes('every Copilot App and Copilot CLI model call'))).toBe(true);
  });

  it('coaches on large system instructions and tool results', () => {
    const heavy = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, {
      source: 'vscode',
      promptTokens: 20_000,
      shares: { systemInstructions: 25, toolDefinitions: 10, messages: 20, toolResults: 45, files: 0 },
    }));
    const result = tips([sess('Local Agent', 'api', heavy)]);
    expect(result.some(tip => tip.startsWith('System instructions take 25%'))).toBe(true);
    expect(result.some(tip => tip.startsWith('Tool results fill 45%'))).toBe(true);
  });

  it('stays quiet below the minimum sample size', () => {
    const few = Array.from({ length: 3 }, (_, i) => req(MONDAY + i, vscodeComposition(80, 40_000)));
    expect(tips([sess('Local Agent', 'api', few)]).some(tip => tip.startsWith('Tool definitions take'))).toBe(false);
  });
});

describe('context composition tips with mixed prompt sizes', () => {
  const heavy: PromptComposition['shares'] = { systemInstructions: 25, toolDefinitions: 55, messages: 0, toolResults: 20, files: 0 };
  const compositionTips = (sessions: Session[]) => new Analyzer(sessions).getContextManagement().tips
    .filter(tip => /^(System instructions|Tool definitions|Tool results|Conversation history)/.test(tip));

  it('counts only requests that shape the breakdown toward the minimum sample size', () => {
    // Ten requests with composition, but only one recorded a prompt size, so the token-weighted shares rest on one request.
    const mixed = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, { source: 'vscode', promptTokens: i === 0 ? 20_000 : null, shares: heavy }));
    const data = new Analyzer([sess('Local Agent', 'api', mixed)]).getContextManagement();
    expect(data.composition?.sources[0]).toMatchObject({ requestsWithData: 10, breakdown: { weighting: 'tokens', samples: 1 } });
    expect(compositionTips([sess('Local Agent', 'api', mixed)])).toEqual([]);
  });

  it('still coaches when no request recorded a prompt size, because each one then shapes the breakdown', () => {
    const unsized = Array.from({ length: 10 }, (_, i) => req(MONDAY + i, { source: 'vscode', promptTokens: null, shares: heavy }));
    expect(compositionTips([sess('Local Agent', 'api', unsized)]).map(tip => tip.slice(0, 30))).toEqual([
      'Tool definitions take 55% of y',
      'System instructions take 25% o',
    ]);
  });
});

describe('session composition detail', () => {
  it('aligns per-request shares with the token curve for VS Code sessions', () => {
    const session = sess('Local Agent', 'api', [
      req(MONDAY, vscodeComposition(60, 40_000), 40_000),
      req(MONDAY + 60_000, undefined, 45_000),
      req(MONDAY + 120_000, vscodeComposition(30, 50_000), 50_000),
    ]);
    const detail = new Analyzer([session]).getWorkspaceContextSessions('api').sessions[0];
    expect(detail.tokenCurve).toEqual([40_000, 45_000, 50_000]);
    expect(detail.composition?.source).toBe('vscode');
    expect(detail.composition?.perRequest).toHaveLength(3);
    expect(detail.composition?.perRequest[1]).toBeNull();
    expect(detail.composition?.perRequest[0]?.toolDefinitions).toBe(60);
    expect(detail.composition?.breakdown?.samples).toBe(2);
  });

  it('includes Copilot CLI sessions with composition but no per-request tokens, with segments and compactions', () => {
    const session = sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(5, 2, 700_000))], {
      systemSegments: [{ name: 'tool_instructions', tokens: 9_570 }, { name: 'memory', tokens: 1_172 }],
      toolCount: 64,
      toolTokens: 33_370,
      compactions: [{ timestamp: MONDAY, systemTokens: 17_190, toolDefinitionTokens: 33_370, conversationTokens: 675_206, currentTokens: 774_836, tokenLimit: 968_000 }],
    });
    const detail = new Analyzer([session]).getWorkspaceContextSessions('cli').sessions[0];
    expect(detail.hasPerRequestTokens).toBe(false);
    expect(detail.composition?.systemSegments).toHaveLength(2);
    const snapshot = detail.composition?.compactions[0];
    expect(snapshot?.slices.map(slice => slice.category)).toEqual(['systemInstructions', 'toolDefinitions', 'conversation', 'other']);
    expect(snapshot?.slices.find(slice => slice.category === 'other')?.tokens).toBe(774_836 - 17_190 - 33_370 - 675_206);
    expect(snapshot?.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBeCloseTo(100, 0);
  });

  it('omits a negligible residual and leaves harnesses without composition untouched', () => {
    const cli = sess('GitHub Copilot CLI', 'cli', [req(MONDAY, cliComposition(5, 2, 100_000))], {
      systemSegments: [],
      toolCount: null,
      toolTokens: null,
      compactions: [{ timestamp: null, systemTokens: 17_051, toolDefinitionTokens: 30_000, conversationTokens: 433_328, currentTokens: 480_383, tokenLimit: null }],
    });
    const claude = sess('Claude', 'claude', [req(MONDAY, undefined, 90_000)]);
    const analyzer = new Analyzer([cli, claude]);
    expect(analyzer.getWorkspaceContextSessions('cli').sessions[0].composition?.compactions[0].slices.map(s => s.category))
      .toEqual(['systemInstructions', 'toolDefinitions', 'conversation']);
    expect(analyzer.getWorkspaceContextSessions('claude').sessions[0]).not.toHaveProperty('composition');
  });
});

describe('composition across a date-range boundary', () => {
  const SEP_30 = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const OCT_1 = new Date(2026, 9, 1, 12, 0, 0).getTime();
  const september = { fromDate: '2026-09-01', toDate: '2026-09-30' };

  function spanning(): Session {
    return sess('Local Agent', 'api', [
      req(SEP_30, vscodeComposition(30, 40_000), 40_000),
      req(OCT_1, vscodeComposition(50, 60_000), 60_000),
    ]);
  }

  it('keeps composition and its drill-down for a session that continues past the range, leaving utilization unchanged', () => {
    const session = spanning();
    const analyzer = new Analyzer([session]);
    const data = analyzer.getContextManagement(september);
    // Utilization keys on last activity (October 1), so September has no session, as before.
    expect(data).toMatchObject({ totalSessions: 0, workspaces: [], sessionsWithTokenData: 0, totalCompactions: 0 });
    expect(analyzer.getWorkspaceContextSessions('api', september).sessions).toEqual([]);
    // Composition counts the request sent on September 30.
    expect(data.composition?.coverage).toEqual({ requestsWithData: 1, totalRequests: 1, sessionsWithData: 1, totalSessions: 1 });
    expect(pct(data.composition?.sources[0]?.breakdown, 'toolDefinitions')).toBe(30);
    // No utilization advice for a range without sessions.
    expect(data.tips).toEqual([]);
    // The composition drill-down matches sessions by request overlap.
    expect(analyzer.getWorkspaceContextSessions('api', september, 'requests').sessions.map(s => s.sessionId)).toEqual([session.sessionId]);
  });

  it('lists the session in both drill-downs once its last activity is in range', () => {
    const october = { fromDate: '2026-10-01', toDate: '2026-10-31' };
    const analyzer = new Analyzer([spanning()]);
    expect(analyzer.getContextManagement(october).totalSessions).toBe(1);
    expect(analyzer.getWorkspaceContextSessions('api', october).sessions).toHaveLength(1);
    expect(analyzer.getWorkspaceContextSessions('api', october, 'requests').sessions).toHaveLength(1);
  });

  it('leaves sessions without a request in range out of the composition drill-down', () => {
    const august = { fromDate: '2026-08-01', toDate: '2026-08-31' };
    expect(new Analyzer([spanning()]).getWorkspaceContextSessions('api', august, 'requests').sessions).toEqual([]);
  });
});
