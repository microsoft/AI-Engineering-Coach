/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { createSession, createRequest } from '../core/parser-shared';
import { detectCuriosity } from '../core/curiosity';
import type { ParseResult } from '../core/cache';
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
    expect(call('runRuleTests', { ruleId: 'no-plan-mode' })).toMatchObject({ passed: 15, total: 15 });
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