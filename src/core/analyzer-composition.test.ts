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

  it('falls back to request weighting when no prompt sizes are known', () => {
    const data = composition([
      sess('Local Agent', 'api', [req(MONDAY, vscodeComposition(60, null)), req(MONDAY + 1, vscodeComposition(20, null))]),
    ]);
    expect(data.overall?.weighting).toBe('requests');
    expect(pct(data.overall, 'toolDefinitions')).toBe(40);
    expect(data.overall?.avgPromptTokens).toBeNull();
    expect(data.overall?.slices[0].tokens).toBeNull();
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
    expect(data.overall).toBeNull();
  });

  it('honours the date filter', () => {
    const data = composition([
      sess('Local Agent', 'api', [
        req(MONDAY - 30 * DAY, vscodeComposition(90, 10_000)),
        req(MONDAY, vscodeComposition(10, 10_000)),
      ]),
    ], { fromDate: new Date(MONDAY - DAY).toISOString().slice(0, 10) });
    expect(data.coverage.requestsWithData).toBe(1);
    expect(pct(data.overall, 'toolDefinitions')).toBe(10);
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

  it('ranks workspaces by sampled requests and lists their harnesses', () => {
    const data = composition([
      sess('Local Agent', 'small', [req(MONDAY, vscodeComposition(40, 1000))]),
      sess('Local Agent', 'big', [req(MONDAY, vscodeComposition(40, 1000)), req(MONDAY + 1, vscodeComposition(40, 1000))]),
      sess('GitHub Copilot CLI', 'big', [req(MONDAY, cliComposition(10, 5, 100_000))]),
      sess('Claude', 'none', [req(MONDAY)]),
    ]);
    expect(data.workspaces.map(w => w.workspaceName)).toEqual(['big', 'small']);
    expect(data.workspaces[0].harnesses).toEqual(['GitHub Copilot CLI', 'Local Agent']);
    expect(data.workspaces[0].breakdown.samples).toBe(3);
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
