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