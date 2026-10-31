/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import { analyzeTokenTypes, sessionTokenTypes, tokenTypesSource } from './analyzer-token-types';
import { createRequest, createSession } from './parser-shared';
import type { CompactionEvent, ModelCallRow, Session, SessionRequest, SubagentRun } from './types';

function compaction(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    mode: 'full', numRounds: 0, numRoundsSinceLastSummarization: 0, contextLengthBefore: 245_000, contextLengthAfter: 52_000,
    durationMs: 60_000, model: 'claude-opus-5.5', outcome: 'success', trigger: 'threshold', tokenLimit: 300_000,
    tokensUsed: { input: 250_000, output: 8_000, cacheRead: 200_000, cacheWrite: 10_000 },
    ...overrides,
  };
}

function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return { agentType: 'research', model: 'claude-sonnet-5', mode: 'background', totalTokens: 1_000_000, toolCalls: 30, durationMs: 120_000, cancelled: false, ...overrides };
}

function session(harness: string, requests: SessionRequest[], extra: Partial<Session> = {}): Session {
  return createSession({ sessionId: `s-${harness}-${requests.length}`, workspaceId: 'w', workspaceName: 'w', harness, requests, ...extra });
}

function analyze(sessions: Session[]) {
  const owner = new Map<SessionRequest, Session>();
  for (const s of sessions) for (const r of s.requests) owner.set(r, s);
  return analyzeTokenTypes(sessions.flatMap(s => s.requests), r => owner.get(r));
}

function req(overrides: Partial<SessionRequest> = {}): SessionRequest {
  return createRequest({ messageText: 'q', responseText: 'a', ...overrides });
}

describe('tokenTypesSource', () => {
  it('maps harnesses to the source that logs their token types', () => {
    expect(tokenTypesSource('GitHub Copilot CLI')).toBe('copilot-cli');
    expect(tokenTypesSource('GitHub Copilot App')).toBe('copilot-cli');
    expect(tokenTypesSource('Codex')).toBe('codex');
    expect(tokenTypesSource('Claude')).toBe('claude');
    expect(tokenTypesSource('Claude Code')).toBe('claude');
    expect(tokenTypesSource('Codex CLI')).toBe('codex');
    expect(tokenTypesSource('OpenCode')).toBe('opencode');
    expect(tokenTypesSource('Local Agent')).toBeNull();
    expect(tokenTypesSource('Xcode')).toBeNull();
  });
});

describe('analyzeTokenTypes', () => {
  it('summarizes Copilot CLI compactions, including their own token use', () => {
    const cli = session('GitHub Copilot App', [
      req({ compaction: compaction(), compactions: [compaction(), compaction({ contextLengthBefore: 255_000, contextLengthAfter: 48_000 })] }),
      req({ compaction: compaction({ outcome: 'failed', contextLengthAfter: undefined, tokensUsed: undefined, durationMs: 0 }) }),
      req({ compaction: compaction({ trigger: 'manual', contextLengthBefore: 100_000, contextLengthAfter: 20_000 }) }),
    ]);
    const data = analyze([cli]);
    expect(data.sources).toHaveLength(1);
    const source = data.sources[0];
    expect(source).toMatchObject({ source: 'copilot-cli', label: 'Copilot App', harnesses: ['GitHub Copilot App'], requests: 3 });
    expect(source.compaction).toEqual({
      count: 4,
      automatic: 3,
      manual: 1,
      failed: 1,
      avgTokensBefore: Math.round((245_000 + 255_000 + 100_000) / 3),
      avgTokensAfter: Math.round((52_000 + 48_000 + 20_000) / 3),
      yieldPct: 80,
      withUsage: 3,
      inputTokens: 750_000,
      outputTokens: 24_000,
      shareOfMainInputPct: null,
      modelTimeMs: 180_000,
    });
  });

  it('summarizes sub-agent runs by type, largest first', () => {
    const cli = session('GitHub Copilot CLI', [
      req({ subagentRuns: [run(), run({ agentType: 'explore', totalTokens: 50_000, mode: 'sync', cancelled: true })] }),
      req({ subagentRuns: [run({ totalTokens: 2_000_000 })] }),
    ]);
    const subagents = analyze([cli]).sources[0].subagents;
    expect(subagents?.runs).toBe(3);
    expect(subagents?.totalTokens).toBe(3_050_000);
    expect(subagents?.byType.map(t => t.agentType)).toEqual(['research', 'explore']);
    expect(subagents?.byType[0]).toMatchObject({ runs: 2, totalTokens: 3_000_000, background: 2, cancelled: 0 });
    expect(subagents?.byType[1]).toMatchObject({ runs: 1, background: 0, cancelled: 1 });
  });

  it('reads Codex reasoning from session totals and never pools sources', () => {
    const codex = session('Codex', [req(), req()], {
      modelUsage: { 'gpt-5.3-codex': { inputTokens: 10_000, outputTokens: 4_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, reasoningTokens: 2_500 } },
    });
    const cli = session('GitHub Copilot CLI', [req({ subagentRuns: [run()] })]);
    const data = analyze([codex, cli]);
    expect(data.sources.map(s => s.source)).toEqual(['codex', 'copilot-cli']);
    expect(data.sources[0].reasoning).toEqual({
      basis: 'session-totals',
      main: { outputTokens: 4_000, reasoningTokens: 2_500, sharePct: 62.5 },
      subagent: null,
      byEffort: [],
    });
    expect(data.sources[0].compaction).toBeNull();
    expect(data.sources[1].reasoning).toBeNull();
  });

  it('reports what each harness logs and leaves sources without data out', () => {
    const data = analyze([
      session('Local Agent', [req(), req()]),
      session('Claude', [req()]),
      session('OpenCode', [req()]),
      session('Codex', [req()]),
    ]);
    expect(data.sources).toEqual([]);
    const byHarness = new Map(data.harnesses.map(h => [h.harness, h]));
    expect(byHarness.get('Local Agent')).toMatchObject({ source: null, requests: 2, reports: { reasoning: 'not-reported', truncation: 'not-reported' } });
    expect(byHarness.get('Claude')?.reports).toMatchObject({ reasoning: 'not-reported', truncation: 'reported' });
    expect(byHarness.get('OpenCode')?.reports.reasoning).toBe('not-comparable');
    expect(byHarness.get('Codex')?.reports.reasoning).toBe('reported');
    expect(data.coverage).toEqual({ requests: 5, requestsWithData: 0 });
    expect(data.tips).toEqual([]);
  });

  it('coaches on frequent automatic compaction, heavy sub-agent use and a high reasoning share', () => {
    const cli = session('GitHub Copilot CLI', [
      req({ compaction: compaction(), compactions: [compaction(), compaction(), compaction()], subagentRuns: Array.from({ length: 5 }, () => run()) }),
    ]);
    const codex = session('Codex', [req()], {
      modelUsage: { 'gpt-5.3-codex': { inputTokens: 1, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 700 } },
    });
    const tips = analyze([cli, codex]).tips;
    expect(tips).toHaveLength(3);
    expect(tips.some(t => t.startsWith('Reasoning is 70% of Codex output'))).toBe(true);
    expect(tips.some(t => t.includes('3 of 3 Copilot CLI compactions were automatic'))).toBe(true);
    expect(tips.some(t => t.includes('Copilot CLI sub-agents used 5.0M tokens in 5 runs'))).toBe(true);
  });
});

function row(overrides: Partial<ModelCallRow> = {}): ModelCallRow {
  return {
    stream: 'main', model: 'claude-opus-5.5', calls: 10, reasoningEffort: 'high', input: 2_000_000, cacheRead: 1_900_000, cacheWrite: 100_000,
    outputTokens: 20_000, reasoningTokens: 12_000, truncatedCalls: 0, filteredCalls: 0, ttftMs: [3_000, 3_200, 4_700], durationMs: [7_800, 9_000, 32_000],
    ...overrides,
  };
}

describe('analyzeTokenTypes from per-call rows', () => {
  it('splits reasoning by stream and effort, with ratios of sums', () => {
    const cli = session('GitHub Copilot App', [
      req({ promptCache: { rows: [row(), row({ stream: 'subagent', model: 'claude-haiku-4.5', reasoningEffort: 'low', outputTokens: 10_000, reasoningTokens: 900 })] } }),
      req({ promptCache: { rows: [row({ reasoningEffort: 'xhigh', outputTokens: 10_000, reasoningTokens: 6_200 }), row({ reasoningEffort: 'medium', outputTokens: 10_000, reasoningTokens: 3_100 })] } }),
    ]);
    const reasoning = analyze([cli]).sources[0].reasoning;
    expect(reasoning?.basis).toBe('calls');
    expect(reasoning?.main).toEqual({ outputTokens: 40_000, reasoningTokens: 21_300, sharePct: 53.3 });
    expect(reasoning?.subagent?.sharePct).toBe(9);
    expect(reasoning?.byEffort.map(e => [e.stream, e.effort, e.sharePct, e.calls])).toEqual([
      ['main', 'max', 62, 10], ['main', 'high', 60, 10], ['main', 'medium', 31, 10], ['subagent', 'low', 9, 10],
    ]);
  });

  it('counts truncated calls per source and leaves the content filter out where it is not logged', () => {
    const cli = session('GitHub Copilot CLI', [req({ promptCache: { rows: [row({ truncatedCalls: 2, filteredCalls: 1 }), row({ stream: 'compaction', truncatedCalls: 5 })] } })]);
    const claude = session('Claude', [req({ promptCache: { rows: [{ stream: 'main', model: 'claude-opus-4.6', calls: 40, input: 1, cacheRead: 0, cacheWrite: 0, truncatedCalls: 3 }] } })]);
    const opencode = session('OpenCode', [req({ promptCache: { rows: [{ stream: 'main', model: 'big-pickle', calls: 7, input: 1, cacheRead: 0, cacheWrite: 0, truncatedCalls: 0 }] } })]);
    const bySource = new Map(analyze([cli, claude, opencode]).sources.map(s => [s.source, s]));
    expect(bySource.get('copilot-cli')?.truncation).toEqual({ calls: 10, truncatedCalls: 2, filteredCalls: 1 });
    expect(bySource.get('claude')?.truncation).toEqual({ calls: 40, truncatedCalls: 3, filteredCalls: null });
    expect(bySource.get('claude')?.reasoning).toBeNull();
    expect(bySource.get('opencode')?.truncation).toEqual({ calls: 7, truncatedCalls: 0, filteredCalls: null });
    expect(bySource.get('opencode')?.latency).toBeNull();
  });

  it('reports latency percentiles per model over the stored samples, most calls first', () => {
    const cli = session('GitHub Copilot CLI', [req({ promptCache: { rows: [
      row(),
      row({ stream: 'subagent', calls: 2 }),
      row({ model: 'gpt-6.1-sol', calls: 30, ttftMs: [16_000, 20_000, 69_000, 12_000], durationMs: [22_900, 93_100] }),
    ] } })]);
    expect(analyze([cli]).sources[0].latency).toEqual([
      { model: 'gpt-6.1-sol', calls: 30, ttftP50Ms: 16_000, ttftP90Ms: 69_000, durationP50Ms: 22_900, durationP90Ms: 93_100 },
      { model: 'claude-opus-5.5', calls: 12, ttftP50Ms: 3_200, ttftP90Ms: 4_700, durationP50Ms: 9_000, durationP90Ms: 32_000 },
    ]);
  });

  it('puts compaction and sub-agent tokens in proportion over the turns that log per-call usage', () => {
    const cli = session('GitHub Copilot CLI', [
      req({ promptCache: { rows: [row({ input: 900_000, outputTokens: 30_000 })] }, compaction: compaction(), subagentRuns: [run({ totalTokens: 200_000 })] }),
      // An older build without per-call usage: counted in the totals, not in the shares.
      req({ compaction: compaction(), subagentRuns: [run({ totalTokens: 5_000_000 })] }),
    ]);
    const source = analyze([cli]).sources[0];
    expect(source.compaction?.shareOfMainInputPct).toBe(27.8);
    expect(source.subagents?.shareOfAllTokensPct).toBe(14.4);
    expect(source.subagents?.totalTokens).toBe(5_200_000);
  });

  it('counts the cache session\u2019s automatic trigger names as automatic', () => {
    const cli = session('GitHub Copilot CLI', [req({ compaction: compaction({ trigger: 'auto' }), compactions: [compaction({ trigger: 'auto' }), compaction({ trigger: 'slash_command' })] })]);
    expect(analyze([cli]).sources[0].compaction).toMatchObject({ count: 2, automatic: 1, manual: 1 });
  });

  it('tips on frequent truncation only when it is common enough to act on', () => {
    const many = session('GitHub Copilot CLI', [req({ promptCache: { rows: [row({ calls: 200, truncatedCalls: 6 })] } })]);
    expect(analyze([many]).tips.some(t => t.startsWith('6 of 200 Copilot CLI model calls (3%) stopped at the output-token limit'))).toBe(true);
    const rare = session('GitHub Copilot CLI', [req({ promptCache: { rows: [row({ calls: 12_000, truncatedCalls: 7 })] } })]);
    expect(analyze([rare]).tips.some(t => t.includes('output-token limit'))).toBe(false);
  });
});

describe('sessionTokenTypes', () => {
  it('summarizes one session for the drill-down strip', () => {
    const cli = session('GitHub Copilot App', [
      req({ promptCache: { rows: [row({ truncatedCalls: 1 }), row({ stream: 'subagent', reasoningEffort: 'low', ttftMs: [100] })] }, compaction: compaction(), subagentRuns: [run(), run({ agentType: 'explore' }), run({ agentType: 'explore' })] }),
    ]);
    expect(sessionTokenTypes(cli)).toEqual({
      reasoningPct: 60,
      effort: 'high',
      subagentRuns: 3,
      subagentTokens: 3_000_000,
      subagentTypes: [{ agentType: 'explore', runs: 2 }, { agentType: 'research', runs: 1 }],
      compactionCalls: 1,
      compactionTokens: 258_000,
      compactionTimeMs: 60_000,
      truncatedCalls: 1,
      calls: 20,
      ttftMedianMs: 3_200,
    });
  });

  it('is null for harnesses that log no token types, or sessions without any', () => {
    expect(sessionTokenTypes(session('Local Agent', [req()]))).toBeNull();
    expect(sessionTokenTypes(session('GitHub Copilot CLI', [req()]))).toBeNull();
  });
});
