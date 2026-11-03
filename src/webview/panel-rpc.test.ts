/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { createSession, createRequest } from '../core/parser-shared';
import { detectCuriosity } from '../core/curiosity';
import type { ParseResult } from '../core/cache';
import type { PromptCacheData, PromptCacheSessionsData, SessionTimelineData, TokenTypesData, WorkspaceContextSessionsData } from '../core/types';
import { loadSessionImages } from '../core/session-image-loader';
import { generateRuleMarkdown, getRpcHandler, validateDateFilter, type RuleFeedback } from './panel-rpc';

vi.mock('../core/session-image-loader', () => ({ loadSessionImages: vi.fn() }));

describe('panel-rpc', () => {
  it('maps legacy workspace params onto workspaceId', () => {
    expect(validateDateFilter({ workspace: 'ws-123', harness: 'Local Agent' })).toEqual({
      workspaceId: 'ws-123',
      harness: 'Local Agent',
    });
  });

  it('prefers explicit workspaceId when both fields are present', () => {
    expect(validateDateFilter({ workspace: 'legacy', workspaceId: 'real-id' })).toEqual({
      workspaceId: 'real-id',
    });
  });

  it('exposes handlers for the newer analyzer-backed methods', () => {
    expect(getRpcHandler('getInsights')).toBeTypeOf('function');
    expect(getRpcHandler('getWorkspaceContextSessions')).toBeTypeOf('function');
    expect(getRpcHandler('getPromptCache')).toBeTypeOf('function');
    expect(getRpcHandler('getPromptCacheSessions')).toBeTypeOf('function');
    expect(getRpcHandler('getSessionTimeline')).toBeTypeOf('function');
  });

  it('validates Prompt Cache params and serves session timelines from memory', () => {
    const promptCache = { rows: [{ stream: 'main' as const, model: 'claude-opus-5.5', calls: 3, input: 90_000, cacheRead: 80_000, cacheWrite: 10_000 }] };
    const session = createSession({
      sessionId: 'app', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App',
      requests: [createRequest({ timestamp: new Date(2026, 9, 1, 12).getTime(), messageText: 'Fix it', responseText: 'Done', promptCache })],
      promptCache: { breaks: [] },
    });
    const analyzer = new Analyzer([session], new Map());
    const parsed: ParseResult = { sessions: [session], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
    const call = (method: 'getPromptCache' | 'getPromptCacheSessions' | 'getSessionTimeline', params: unknown) => getRpcHandler(method)!(analyzer, parsed, params as never);

    expect((call('getPromptCache', { filter: { fromDate: '2026-10-01', toDate: '2026-10-01' } }) as PromptCacheData).harnesses[0].all?.hitPct).toBe(88.9);
    expect((call('getPromptCache', { filter: { fromDate: '2026-10-02' } }) as PromptCacheData).harnesses).toEqual([]);
    expect(call('getPromptCacheSessions', { filter: {} })).toEqual({ workspaceName: '', harness: null, sessions: [], total: 0 });
    expect((call('getPromptCacheSessions', { workspaceId: 'ws', harness: 'GitHub Copilot App' }) as PromptCacheSessionsData).sessions.map(s => s.sessionId)).toEqual(['app']);
    expect((call('getPromptCacheSessions', { workspaceId: 'ws', harness: 'Claude' }) as PromptCacheSessionsData).total).toBe(0);
    expect((call('getSessionTimeline', { sessionId: 'app' }) as SessionTimelineData).unit).toBe('requests');
    expect(call('getSessionTimeline', { sessionId: 42 })).toBeNull();
    expect(call('getSessionTimeline', { sessionId: 'missing' })).toBeNull();
  });

  it('serves Token Types for the requested range, with Copilot App row data and its sub-agents', () => {
    const promptCache = { rows: [{ stream: 'main' as const, model: 'claude-opus-5.5', calls: 4, reasoningEffort: 'high', input: 400_000, cacheRead: 380_000, cacheWrite: 20_000, outputTokens: 8_000, reasoningTokens: 4_800, truncatedCalls: 1, filteredCalls: 0, ttftMs: [3_000, 3_400], durationMs: [8_000, 9_000] }] };
    const subagentRuns = [{ agentType: 'research' as const, model: 'claude-sonnet-5', mode: 'background' as const, totalTokens: 100_000, toolCalls: 12, durationMs: 60_000, cancelled: false }];
    const session = createSession({
      sessionId: 'app', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App',
      requests: [createRequest({ timestamp: new Date(2026, 9, 1, 12).getTime(), messageText: 'Fix it', responseText: 'Done', promptCache, subagentRuns })],
    });
    const analyzer = new Analyzer([session], new Map());
    const parsed: ParseResult = { sessions: [session], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
    expect(getRpcHandler('getTokenTypes')).toBeTypeOf('function');
    const call = (params: unknown) => getRpcHandler('getTokenTypes')!(analyzer, parsed, params as never) as TokenTypesData;

    const [source] = call({ filter: { fromDate: '2026-10-01', toDate: '2026-10-01' } }).sources;
    expect(source).toMatchObject({ source: 'copilot-cli', label: 'Copilot App', requests: 1 });
    expect(source.reasoning?.main?.sharePct).toBe(60);
    expect(source.truncation).toEqual({ calls: 4, truncatedCalls: 1, filteredCalls: 0 });
    expect(source.subagents?.shareOfAllTokensPct).toBe(19.7);
    expect(call({ filter: { fromDate: '2026-10-02' } }).sources).toEqual([]);
  });

  it('matches workspace sessions by request overlap only when the caller asks for it', () => {
    // The session starts on September 30 and ends on October 1 (local time, like the date filter).
    const session = createSession({
      sessionId: 'spanning', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent',
      requests: [new Date(2026, 8, 30, 12), new Date(2026, 9, 1, 12)].map(day => createRequest({ timestamp: day.getTime(), messageText: 'Fix it', responseText: 'Done', promptTokens: 40_000 })),
    });
    const analyzer = new Analyzer([session], new Map());
    const parsed: ParseResult = { sessions: [session], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
    const handler = getRpcHandler('getWorkspaceContextSessions')!;
    const filter = { fromDate: '2026-09-01', toDate: '2026-09-30' };
    const ids = (params: Record<string, unknown>) => (handler(analyzer, parsed, params) as WorkspaceContextSessionsData).sessions.map(s => s.sessionId);
    expect(ids({ workspaceId: 'ws', filter })).toEqual([]);
    expect(ids({ workspaceId: 'ws', filter, rangeMatch: 'bogus' })).toEqual([]);
    expect(ids({ workspaceId: 'ws', filter, rangeMatch: 'requests' })).toEqual(['spanning']);
  });

  it('passes the Curiosity language filter through the runtime handler', () => {
    const sessions = ['ts', 'py'].map(extension => createSession({
      sessionId: extension, workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests: [createRequest({
        timestamp: Date.parse('2026-09-30T12:00:00Z'), messageText: 'Why?', responseText: 'An answer.',
        curiosity: detectCuriosity('Why?'), answerEvidence: 'final', referencedFiles: [`src/a.${extension}`],
      })],
    }));
    const analyzer = new Analyzer(sessions, new Map());
    const parseResult: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
    const handler = getRpcHandler('getCuriosity')!;
    expect(handler(analyzer, parseResult, { language: 'Python' })).toMatchObject({ counts: { direct: 1 } });
    expect(handler(analyzer, parseResult, { language: 3 })).toMatchObject({ error: 'Invalid session language filter' });
  });

  it('dispatches image requests with the indexed harness source and verifies request ownership', async () => {
    vi.mocked(loadSessionImages).mockReset().mockResolvedValue(['data:image/png;base64,image']);
    const session = createSession({
      sessionId: 'session', workspaceId: 'ws', workspaceName: 'Project', harness: 'Claude',
      requests: [createRequest({ requestId: 'request', userEventId: 'user-event', messageText: 'Screenshot', responseText: '' })],
    });
    const source = {
      kind: 'claude-jsonl' as const, filePath: 'session.jsonl', workspaceId: 'ws', workspaceName: 'Project', harness: 'Claude',
    };
    const parsed: ParseResult = {
      sessions: [session], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map([['session', source]]),
    };
    const handler = getRpcHandler('getSessionImages')!;
    const analyzer = new Analyzer(parsed.sessions, parsed.editLocIndex);
    expect(await handler(analyzer, parsed, { sessionId: 'session', requestId: 'request' }))
      .toEqual({ images: ['data:image/png;base64,image'] });
    expect(loadSessionImages).toHaveBeenCalledWith(source, 'session', 'request', { userEventId: 'user-event', requestIndex: 0 });
    expect(await handler(analyzer, parsed, { sessionId: 'session', requestId: 'unrelated' })).toEqual({ images: [] });
    expect(await handler(analyzer, parsed, { sessionId: 'missing', requestId: 'request' })).toEqual({ images: [] });
    expect(loadSessionImages).toHaveBeenCalledTimes(1);
  });
});

describe('rule evaluation RPCs', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const sessions = [['Claude', 3], ['Local Agent', 1]].map(([harness, count]) => createSession({
    sessionId: String(harness), workspaceId: 'ws', workspaceName: 'Project', harness: String(harness),
    requests: Array.from({ length: Number(count) }, (_, index) => createRequest({
      requestId: `${String(harness)}-${index}`, timestamp: at + index, messageText: 'Refactor the parser', responseText: '',
    })),
  }));
  const analyzer = new Analyzer(sessions, new Map());
  const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  const call = (method: string, params: Record<string, unknown>) => getRpcHandler(method)!(analyzer, parsed, params);
  const claudeRule = [
    '---', 'id: claude-requests', 'name: Claude requests', 'group: tool-mastery', 'severity: low', 'scope: requests', '---',
    '', '# Detection Logic', '```detect', 'scan: requests', 'match: harness == "Claude"', 'check: count >= 3', '```',
  ].join('\n');

  it('lets the Playground read harness on request rows', () => {
    expect(call('evaluateExpression', { expr: 'harness == "Claude"', scope: 'requests' })).toMatchObject({ matched: 3, total: 4 });
    expect(call('evaluateExpression', { expr: 'harness == "Claude"', scope: 'sessions' })).toMatchObject({ matched: 1, total: 2 });
  });

  it('lets Test Rule read harness on request rows', () => {
    expect(call('testRuleLive', { markdown: claudeRule })).toMatchObject({ ok: true, triggered: true, occurrences: 3, total: 4 });
  });

  it('keeps the Data Explorer reading harness from sessions', () => {
    expect(call('getDataExplorer', { field: 'harness' })).toMatchObject({ count: 2, uniqueCount: 2 });
    const { fields } = call('getDataExplorerFields', {}) as { fields: Array<{ name: string; fillRate: number; total: number }> };
    expect(fields.find(field => field.name === 'harness')).toMatchObject({ fillRate: 100, total: 2 });
  });

  it("runs a built-in rule's inline # Tests", () => {
    expect(call('runRuleTests', { ruleId: 'no-plan-mode' })).toMatchObject({ passed: 16, total: 16 });
    expect(call('runRuleTests', { ruleId: 'abandon-sessions' })).toMatchObject({ error: 'No test cases found in rule' });
  });
});

describe('rule evaluation RPCs across a date filter', () => {
  // One VS Code session: 15 requests in each of two weeks inside the range, and its last message after toDate,
  // so filterSessions drops the session while filterRequests keeps the 30 requests.
  const days = [15, 22, 30].map(day => new Date(2026, 8, day, 12).getTime());
  const requests = [...Array.from({ length: 30 }, (_, index) => days[index < 15 ? 0 : 1] + index), days[2]].map((timestamp, index) =>
    createRequest({ requestId: `r${index}`, timestamp, messageText: 'Refactor the parser', responseText: '' }));
  const sessions = [createSession({ sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'Local Agent', requests })];
  const analyzer = new Analyzer(sessions, new Map());
  const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  const call = (method: string, params: Record<string, unknown>) => getRpcHandler(method)!(analyzer, parsed, params);
  const filter = { toDate: '2026-09-25' };
  const vscodeRule = [
    '---', 'id: vscode-requests', 'name: VS Code requests', 'group: tool-mastery', 'severity: low', 'scope: requests', '---',
    '', '# Detection Logic', '```detect', 'scan: requests', 'match: harness == "Local Agent"', 'check: count >= 30', '```',
  ].join('\n');

  it('keeps the harness of requests whose session the filter drops', () => {
    expect(analyzer.filterSessions(filter)).toHaveLength(0);
    expect(call('evaluateExpression', { expr: 'harness == "Local Agent"', scope: 'requests', filter })).toMatchObject({ matched: 30, total: 30 });
    expect(call('testRuleLive', { markdown: vscodeRule, filter })).toMatchObject({ triggered: true, occurrences: 30 });
    expect(call('getRulePreview', { ruleId: 'no-custom-instructions', ...filter })).toMatchObject({ triggered: true, occurrences: 30, total: 30 });
    expect((call('getRuleCoverage', { filter }) as { rules: Array<{ id: string }> }).rules.map(rule => rule.id)).toContain('no-custom-instructions');

    const editor = call('getRuleEditor', filter) as {
      previews: Array<{ ruleId: string; triggered: boolean; total: number }>;
      dateHistograms: Record<string, { counts: number[] }>;
    };
    expect(editor.previews.find(preview => preview.ruleId === 'no-custom-instructions')).toMatchObject({ triggered: true, total: 30 });
    expect(editor.dateHistograms['no-custom-instructions'].counts).toEqual([15, 15]);
  });
});

const VALID_RULE = [
  '---',
  'id: long-sessions',
  'name: Long sessions',
  'group: session-hygiene',
  'severity: medium',
  'scope: sessions',
  '---',
  '',
  '# Description',
  'Sessions that run for too long.',
  '',
  '# When Triggered',
  '{{count}} long sessions.',
  '',
  '# Detection Logic',
  '```detect',
  'scan: sessions',
  'match: requestCount > 50',
  'check: count >= 1',
  '```',
  '',
  '# How to Improve',
  'Start a new chat for each task.',
].join('\n');

const asker = () => vi.fn<(feedback?: RuleFeedback) => Promise<string>>();

describe('generateRuleMarkdown', () => {
  it('returns the first valid rule without asking again', async () => {
    const ask = asker().mockResolvedValueOnce(VALID_RULE);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: VALID_RULE });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(undefined);
  });

  it('feeds validation issues back until the rule is valid', async () => {
    const ask = asker()
      .mockResolvedValueOnce('Here is a rule without frontmatter.')
      .mockResolvedValueOnce(VALID_RULE);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: VALID_RULE });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]?.reply).toBe('Here is a rule without frontmatter.');
    expect(ask.mock.calls[1][0]?.issues).toContain('Missing YAML frontmatter (must start with ---)');
  });

  it('accepts the reply after two invalid drafts as-is', async () => {
    const ask = asker()
      .mockResolvedValueOnce('draft one')
      .mockResolvedValueOnce('draft two')
      .mockResolvedValueOnce('final reply');

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: 'final reply' });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2][0]?.reply).toBe('draft two');
  });

  it('accepts a reply with CRLF line endings and returns it with LF', async () => {
    const ask = asker().mockResolvedValueOnce(VALID_RULE.replaceAll('\n', '\r\n'));

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: VALID_RULE });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each(['scope: both', 'scope: "both"'])('accepts %s', async scope => {
    const rule = VALID_RULE.replace('scope: sessions', scope);
    const ask = asker().mockResolvedValueOnce(rule);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: rule });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again when the scope only starts with an allowed one', async () => {
    const ask = asker()
      .mockResolvedValueOnce(VALID_RULE.replace('scope: sessions', 'scope: both requests and sessions'))
      .mockResolvedValueOnce(VALID_RULE);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: VALID_RULE });
    expect(ask.mock.calls[1][0]?.issues).toContain('Missing or invalid "scope:" (must be requests, sessions, or both)');
  });
});

/** A rule that ends with its detect block, as the generator prompt asks for. */
const RULE_ENDING_WITH_DETECT = [
  '---', 'id: long-sessions', 'name: Long sessions', 'group: session-hygiene', 'severity: medium', 'scope: sessions', '---', '',
  '# Description', 'Sessions that run for too long.', '',
  '# When Triggered', '{{count}} long sessions.', '',
  '# How to Improve', 'Start a new chat for each task.', '',
  '# Detection Logic', '```detect', 'scan: sessions', 'match: requestCount > 50', 'check: count >= 1', '```',
].join('\n');

describe('generateRuleMarkdown fences', () => {
  it('keeps the closing fence of a rule that ends with its detect block', async () => {
    const ask = asker().mockResolvedValueOnce(`${RULE_ENDING_WITH_DETECT}\n`);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: RULE_ENDING_WITH_DETECT });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an outer fence', '```markdown\n', '\n```\n'],
    ['an outer fence without a language', '```\n', '\n```'],
    ['prose and an outer fence', 'Here is the rule:\n\n```md\n', '\n```'],
    ['a closed example and an outer fence', 'For example:\n```\nscan: requests\n```\nThe rule:\n```markdown\n', '\n```'],
  ])('strips %s around the rule', async (_name, before, after) => {
    const ask = asker().mockResolvedValueOnce(`${before}${RULE_ENDING_WITH_DETECT}${after}`);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: RULE_ENDING_WITH_DETECT });
  });

  it('keeps the closing fence of a rule after a closed example in the prose', async () => {
    const ask = asker().mockResolvedValueOnce(`For example:\n\`\`\`\nscan: requests\n\`\`\`\n\n${RULE_ENDING_WITH_DETECT}`);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: RULE_ENDING_WITH_DETECT });
  });

  it('strips an outer fence around a rule without front matter', async () => {
    const body = RULE_ENDING_WITH_DETECT.slice(RULE_ENDING_WITH_DETECT.indexOf('# Description'));
    const ask = asker().mockResolvedValue(`\`\`\`markdown\n${body}\n\`\`\``);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: body });
  });
});

describe('generateRuleMarkdown failures', () => {
  it('keeps the latest draft when a follow-up request runs out of time', async () => {
    const outOfTime = new Error('GitHub Copilot did not respond in time. Try again.');
    const ask = asker()
      .mockResolvedValueOnce('draft one')
      .mockRejectedValueOnce(outOfTime);

    await expect(generateRuleMarkdown(ask)).resolves.toEqual({ markdown: 'draft one', retryError: outOfTime });
  });

  it('fails when the first request fails', async () => {
    const unavailable = new Error("GitHub Copilot isn't available.");
    const ask = asker().mockRejectedValueOnce(unavailable);

    await expect(generateRuleMarkdown(ask)).rejects.toBe(unavailable);
  });
});

describe('humanTurn on request rows', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const sessions = [createSession({
    sessionId: 's', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot App',
    requests: (['typed', 'typed', 'agent', 'typed', 'autopilot'] as const).map((kind, index) => createRequest({
      requestId: `r${index}`, timestamp: at + index, messageText: 'Refactor the parser', responseText: '',
      nonHumanKind: kind === 'typed' ? undefined : kind,
    })),
  })];
  const analyzer = new Analyzer(sessions, new Map());
  const parsed: ParseResult = { sessions, workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
  const call = (method: string, params: Record<string, unknown>) => getRpcHandler(method)!(analyzer, parsed, params);
  const automatedRule = [
    '---', 'id: automated-turns', 'name: Automated turns', 'group: session-hygiene', 'severity: low', 'scope: requests', '---',
    '', '# Detection Logic', '```detect', 'scan: requests', 'match: humanTurn == false', 'check: count >= 2', '```',
  ].join('\n');

  it('lets the Playground and Test Rule read it', () => {
    expect(call('evaluateExpression', { expr: 'humanTurn == true', scope: 'requests' })).toMatchObject({ matched: 3, total: 5 });
    expect(call('testRuleLive', { markdown: automatedRule })).toMatchObject({ ok: true, triggered: true, occurrences: 2, total: 5 });
  });

  it('shows it in the Data Explorer', () => {
    expect(call('getDataExplorer', { field: 'humanTurn' })).toMatchObject({ count: 5, trueCount: 3, falseCount: 2, trueRate: 60 });
    const { fields } = call('getDataExplorerFields', {}) as { fields: Array<{ name: string; type: string; fillRate: number; total: number }> };
    expect(fields.find(field => field.name === 'humanTurn')).toMatchObject({ type: 'boolean', fillRate: 100, total: 5 });
  });

  it("runs the updated rules' inline # Tests", () => {
    expect(call('runRuleTests', { ruleId: 'late-night-coding' })).toMatchObject({ passed: 7, total: 7 });
    expect(call('runRuleTests', { ruleId: 'weekend-overwork' })).toMatchObject({ passed: 5, total: 5 });
  });
});