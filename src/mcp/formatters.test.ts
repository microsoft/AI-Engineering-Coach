/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { PromptCacheAnalyzer } from '../core/analyzer-prompt-cache';
import { TokenTypesAnalyzer } from '../core/analyzer-token-types';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import { toDateStr } from '../core/helpers';
import { createRequest, createSession } from '../core/parser-shared';
import { clearLayerRules, registerPersonalRuleSource } from '../core/rule-engine';
import type { ModelUsage, NonHumanKind, Session } from '../core/types';
import { TODAY, returnedAfterExpiryWithoutCacheData, returnedToday } from '../test/copilot-cache-sessions';
import { formatActivity, formatFlow, formatInsights, formatPatterns, formatPromptCache, formatSummary, formatTokenTypes, formatWellbeing } from './formatters';

// Keeps the broken rule out of the developer's runtime.log.
vi.mock('../core/runtime-debug', async importOriginal => ({ ...await importOriginal<typeof import('../core/runtime-debug')>(), runtimeDebug: vi.fn() }));

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

describe('formatPromptCache with Copilot CLI and Copilot App returns in one range', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  /** Today's summary of sessions parsed from synthetic logs by the real parser. */
  function todaysSummary(build: (dir: string) => Session[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-mcp-cache-'));
    dirs.push(dir);
    const today = toDateStr(TODAY);
    return formatPromptCache(new PromptCacheAnalyzer(build(dir), new Map()).getPromptCache({ fromDate: today, toDate: today }));
  }

  it.each<[string, string, boolean]>([
    ['Copilot CLI', 'Copilot App', false],
    ['Copilot App', 'Copilot CLI', true],
  ])('keeps the %s returns it measured, and reports the %s returns without cache data apart', (measured, apart, measuredIsApp) => {
    const alone = todaysSummary(dir => [returnedToday(dir, 'measured', measuredIsApp)]);
    const mixed = todaysSummary(dir => [returnedToday(dir, 'measured', measuredIsApp), returnedAfterExpiryWithoutCacheData(dir, 'apart', !measuredIsApp)]);
    expect(alone.cacheBreaks).toMatchObject({ harnesses: measured, returnsAfterExpiry: { expired: 0, of: 1, notMeasured: 0 } });
    expect(alone.returnsWithoutCacheData).toBeNull();
    // The other harness's expired return changes nothing attributed to the measured harness.
    expect(mixed.cacheBreaks).toEqual(alone.cacheBreaks);
    expect(mixed.returnsWithoutCacheData).toEqual({ harnesses: apart, returnsAfterExpiry: { expired: 1, of: 1, notMeasured: 0 } });
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

/* ---- Which turns the time-based measures count ---- */

const NOON = new Date(2026, 0, 14, 12).getTime();
const NEXT_NIGHT = new Date(2026, 0, 15, 2).getTime();

function session(turns: Array<[number, NonHumanKind?]>): Session {
  return createSession({
    sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App',
    requests: turns.map(([timestamp, nonHumanKind], index) => createRequest({
      requestId: `r${index}`, timestamp, messageText: 'Refactor the parser', responseText: '', nonHumanKind,
    })),
  });
}

describe('MCP formatters', () => {
  const analyzer = new Analyzer([session([[NOON], [NOON + 60_000, 'agent'], [NEXT_NIGHT, 'autopilot']])], new Map());
  const basis = { counts: 'prompts the user typed', typedPrompts: 1, automatedTurnsLeftOut: 2 };

  it('activity: recent days count typed prompts, and the volume counts every turn', () => {
    const activity = formatActivity(analyzer);
    expect(activity.summary.totalRequests).toBe(3);
    expect(activity.recentDays).toEqual([{ date: '2026-01-14', requests: 1, focusScore: 100 }]);
    expect(activity.recentDaysBasis).toEqual(basis);
  });

  it('flow: peak hours count typed prompts', () => {
    const flow = formatFlow(analyzer);
    expect(flow.basis).toEqual(basis);
    expect(flow.peakActivityHours).toEqual([{ hour: '12:00', totalRequests: 1 }]);
  });

  it('wellbeing and sustainable pace: say they count typed prompts', () => {
    const wellbeing = formatWellbeing(analyzer);
    expect(wellbeing).toMatchObject({ basis, workLifeBalance: { timeDistribution: { lateNight: 0, workHours: 1 } } });
    expect(formatInsights(analyzer).sustainablePace.counts).toBe('prompts the user typed');
  });

  it('wellbeing: has no data when the user typed no prompt in range', () => {
    const automatedOnly = new Analyzer([session([[NEXT_NIGHT, 'autopilot']])], new Map());
    expect(formatWellbeing(automatedOnly)).toMatchObject({ status: 'no-data' });
  });
});

/* ---- Rules that couldn't be evaluated ---- */

const BROKEN = [
  '---', 'id: broken-rule', 'name: Broken Rule', 'group: prompt-quality', 'severity: high', 'scope: requests', '---', '',
  '# Description', 'A test rule.', '', '# Detection Logic', '```detect', 'scan: requests', 'match: (', 'check: count > 0', '```', '',
].join('\n');

const requests = [createRequest({ requestId: 'r0', messageText: 'Explain why the parser drops the last token.', responseText: 'Done.', timestamp: Date.UTC(2026, 9, 1, 12) })];
const analyzer = new Analyzer([createSession({ sessionId: 's1', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })], new Map());
const filter = { harness: 'Local Agent' };

describe('MCP anti-pattern summaries', () => {
  afterEach(() => {
    clearLayerRules('personal');
    invalidateDetectorRegistry();
  });

  it('list a rule that could not be evaluated, with its group and error', () => {
    registerPersonalRuleSource('broken-rule', BROKEN, '/home/rules/broken-rule.md');
    for (const notEvaluated of [formatPatterns(analyzer, filter).antiPatterns.notEvaluated, formatSummary(analyzer, filter).antiPatterns.notEvaluated]) {
      expect(notEvaluated.map(({ rule, group }) => ({ rule, group }))).toEqual([{ rule: 'Broken Rule', group: 'prompt-quality' }]);
      expect(notEvaluated[0].error).toMatch(/^Parse error at position \d+/);
    }
  });

  it('list none when every rule ran', () => {
    expect(formatPatterns(analyzer, filter).antiPatterns.notEvaluated).toEqual([]);
    expect(formatSummary(analyzer, filter).antiPatterns.notEvaluated).toEqual([]);
  });
});
