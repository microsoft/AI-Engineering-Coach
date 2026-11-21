/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the GitHub Copilot CLI events parser, focused on the streaming async path added for
 * issue #106 (parseCLIEventsFileAsync) and the resilient recordFailedFile catch. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { getParseWarningCounts, resetParseWarnings, setCuriosityDetector, stripSingleSession } from './parser-shared';
import { detectCuriosity } from './curiosity';
import { CuriosityAnalyzer } from './analyzer-curiosity';
import { runDetectors, runEmitters } from './detector-registry';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cli-'));
  tempDirs.push(dir);
  return dir;
}

/** Write an events.jsonl from a list of event objects and return its path. */
function writeEvents(events: Array<Record<string, unknown>>): string {
  const dir = makeTempDir();
  const fp = path.join(dir, 'events.jsonl');
  fs.writeFileSync(fp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return fp;
}

const SAMPLE_EVENTS: Array<Record<string, unknown>> = [
  { type: 'session.start', timestamp: '2025-06-15T10:00:00Z', data: { sessionId: 'sess-1', startTime: '2025-06-15T10:00:00Z', selectedModel: 'claude-sonnet-4' } },
  { type: 'user.message', timestamp: '2025-06-15T10:00:01Z', data: { content: 'add a function', agentMode: 'agent' } },
  { type: 'assistant.message', id: 'a1', timestamp: '2025-06-15T10:00:02Z', data: { content: 'Sure, editing now.', outputTokens: 12 } },
  { type: 'tool.execution_start', timestamp: '2025-06-15T10:00:03Z', data: { toolName: 'edit', arguments: { path: 'foo.ts', new_str: 'export const x = 1;' } } },
  { type: 'session.shutdown', timestamp: '2025-06-15T10:00:05Z', data: { modelMetrics: { 'claude-sonnet-4': { usage: { inputTokens: 100, outputTokens: 12 } } } } },
];

beforeEach(() => resetParseWarnings());

afterEach(() => {
  setCuriosityDetector(undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseCLIEventsFileAsync', () => {
  it.each([false, true])('recognizes MCP server metadata (Copilot App: %s)', async (remoteSteerable) => {
    const file = writeEvents([
      { type: 'session.start', data: { sessionId: 'mcp-session', ...(remoteSteerable ? { remoteSteerable: true } : {}) } },
      ...Array.from({ length: 30 }, (_, index) => [
        { type: 'user.message', timestamp: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(), data: { content: 'Find the issue' } },
        { type: 'assistant.message', data: { toolRequests: [{ toolName: 'github-search_code', arguments: {} }] } },
        { type: 'tool.execution_start', data: { toolName: 'github-search_code', mcpServerName: 'github' } },
        { type: 'tool.execution_start', data: { toolName: 'view' } },
        { type: 'tool.execution_start', data: { toolName: 'grep', mcpServerName: '' } },
      ]).flat(),
    ]);
    for (const parsed of [parseCLIEventsFile(file, 'ws', 'Workspace'), await parseCLIEventsFileAsync(file, 'ws', 'Workspace')]) {
      expect(parsed?.requests).toHaveLength(30);
      expect(parsed?.harness).toBe(remoteSteerable ? 'GitHub Copilot App' : 'GitHub Copilot CLI');
      expect(parsed?.requests[0].toolsUsed).toEqual(['mcp_github_github-search_code', 'view', 'grep']);
      const mcpName = parsed?.requests[0].toolsUsed[0] ?? '';
      expect(mcpName.slice(4).split('_')[0]).toBe('github');
      const sessions = parsed ? [parsed] : [];
      const emission = runEmitters(parsed?.requests ?? [], sessions, false).get('context-engineering-gaps');
      const withoutMcp = sessions.map(session => ({
        ...session, requests: session.requests.map(request => ({ ...request, toolsUsed: ['search', 'view', 'grep'] })),
      }));
      const missing = runEmitters(withoutMcp.flatMap(session => session.requests), withoutMcp, false).get('context-engineering-gaps');
      expect(emission).toBeDefined();
      expect(missing).toBeDefined();
      expect(emission?.count).toBe((missing?.count ?? 0) - 1);
    }
  });

  it('classifies PowerShell-only commands and parallel calls through both parser paths', async () => {
    setCuriosityDetector(detectCuriosity);
    const file = writeEvents([
      SAMPLE_EVENTS[0],
      { type: 'user.message', id: 'p1', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Run the tests.' } },
      { type: 'tool.execution_start', data: { toolName: 'powershell', arguments: { command: 'npm test' } } },
      { type: 'user.message', id: 'p2', timestamp: '2026-09-30T12:01:00Z', data: { content: 'Run the build.' } },
      { type: 'tool.execution_start', data: { toolName: 'multi_tool_use.parallel', arguments: { tool_uses: [
        { recipient_name: 'functions.powershell', parameters: { command: 'npm run build' } },
      ] } } },
    ]);
    for (const parsed of [parseCLIEventsFile(file, 'ws', 'Workspace'), await parseCLIEventsFileAsync(file, 'ws', 'Workspace')]) {
      expect(parsed?.requests.map(request => request.toolsUsed)).toEqual([['powershell'], ['functions.powershell']]);
      const data = new CuriosityAnalyzer(parsed ? [parsed] : [], new Map()).getCuriosity();
      expect(data.counts).toEqual({ direct: 0, web: 0, repository: 0, action: 2 });
      expect(data.coverage.reasons.unknownTool).toBe(0);
    }
  });

  it('captures web domains from explicit calls and parallel wrappers without leaking them into later turns', async () => {
    const file = writeEvents([
      SAMPLE_EVENTS[0],
      { type: 'user.message', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Why?' } },
      { type: 'tool.execution_start', data: { toolName: 'multi_tool_use.parallel', arguments: { tool_uses: [
        { recipient_name: 'functions.web_fetch', parameters: { url: 'https://docs.python.org/3/?private=1' } },
        { recipient_name: 'functions.web_search', parameters: { query: 'https://not-a-source.example' } },
      ] } } },
      { type: 'assistant.message', data: { phase: 'final', content: 'The answer.', toolRequests: [
        { toolName: 'web_fetch', arguments: { url: 'https://docs.python.org/3/reference' } },
      ] } },
      { type: 'user.message', timestamp: '2026-09-30T12:01:00Z', data: { content: 'How?' } },
      { type: 'assistant.message', data: { phase: 'final', content: 'Another answer.' } },
    ]);
    for (const parsed of [parseCLIEventsFile(file, 'ws', 'Workspace'), await parseCLIEventsFileAsync(file, 'ws', 'Workspace')]) {
      expect(parsed?.requests.map(request => request.webDomains)).toEqual([['docs.python.org'], []]);
    }
  });

  it('recognizes final_answer and successful task-completion summaries, but not failed completions', async () => {
    const parsed = await parseCLIEventsFileAsync(writeEvents([
      { type: 'user.message', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Why?' } },
      { type: 'assistant.message', data: { phase: 'final_answer', content: 'The reason.' } },
      { type: 'user.message', timestamp: '2026-09-30T12:01:00Z', data: { content: 'How?' } },
      { type: 'tool.execution_start', data: { toolName: 'task_complete', arguments: { summary: 'A final answer.' } } },
      { type: 'session.task_complete', data: { success: true, summary: 'A final answer.' } },
      { type: 'user.message', timestamp: '2026-09-30T12:02:00Z', data: { content: 'What?' } },
      { type: 'session.task_complete', data: { success: false, summary: 'Not delivered.' } },
    ]), 'ws', 'Workspace');
    expect(parsed?.requests).toMatchObject([
      { answerEvidence: 'final', responseText: 'The reason.' },
      { answerEvidence: 'final', responseText: 'A final answer.' },
      { answerEvidence: 'missing', responseText: '' },
    ]);
  });

  it('captures explicit investigation roles without guessing generic subagent work', async () => {
    const parsed = await parseCLIEventsFileAsync(writeEvents([
      { type: 'user.message', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Investigate the alternatives.' } },
      { type: 'tool.execution_start', data: { toolName: 'multi_tool_use.parallel', arguments: { tool_uses: [
        { recipient_name: 'functions.task', parameters: { agent_type: 'research' } },
        { recipient_name: 'functions.task', parameters: { agent_type: 'explore' } },
        { recipient_name: 'functions.task', parameters: { agent_type: 'general-purpose', prompt: 'Research this.' } },
      ] } } },
    ]), 'ws', 'Workspace');
    expect(parsed?.requests[0].investigationDelegations).toEqual(['research', 'explore']);
    expect(parsed?.requests[0].toolsUsed).toEqual(['functions.task']);
  });

  it('retains native event IDs, project root, final answers and namespaced tool file evidence', async () => {
    const parsed = await parseCLIEventsFileAsync(writeEvents([
      { type: 'session.start', data: { sessionId: 's', context: { cwd: '/repo' } } },
      { type: 'user.message', id: 'human-1', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Why?' } },
      { type: 'assistant.message', data: { phase: 'commentary', content: 'I will inspect it.' } },
      { type: 'tool.execution_start', data: { toolName: 'multi_tool_use.parallel', arguments: { tool_uses: [
        { recipient_name: 'functions.view', parameters: { path: '/repo/src/[id].tsx' } },
        { recipient_name: 'functions.rg', parameters: { paths: ['/repo/a.py', '/repo/b.py'] } },
      ] } } },
      { type: 'assistant.message', id: 'answer-1', data: { phase: 'final', content: 'A final answer.' } },
      { type: 'user.message', id: 'human-2', timestamp: '2026-09-30T12:01:00Z', data: { content: 'How?' } },
      { type: 'assistant.message', data: { phase: 'commentary', content: 'I will inspect it.' } },
      { type: 'tool.execution_start', data: { toolName: 'view', arguments: { path: '/repo/a.ts' } } },
    ]), 'ws', 'Workspace');
    expect(parsed?.workspaceRootPath).toBe('/repo');
    expect(parsed?.requests).toMatchObject([
      { requestId: 'answer-1', userEventId: 'human-1', answerEvidence: 'final',
        toolsUsed: ['functions.view', 'functions.rg'], referencedFiles: ['/repo/src/[id].tsx', '/repo/a.py', '/repo/b.py'] },
      { userEventId: 'human-2', answerEvidence: 'missing' },
    ]);
  });

  it('does not treat generated patch code or pre-tool legacy commentary as an answer', async () => {
    const parsed = await parseCLIEventsFileAsync(writeEvents([
      SAMPLE_EVENTS[0],
      { type: 'user.message', timestamp: '2026-09-30T12:00:00Z', data: { content: 'Why?' } },
      { type: 'assistant.message', data: { content: 'I will inspect the code.' } },
      { type: 'tool.execution_start', data: { toolName: 'apply_patch',
        arguments: '*** Update File: src/a.ts\n+const x = 1;\n' } },
    ]), 'ws', 'Workspace');
    expect(parsed?.requests[0]).toMatchObject({ answerEvidence: 'missing', editedFiles: ['src/a.ts'], toolsUsed: ['apply_patch'] });
  });

  it('keeps user messages but excludes agent traffic from curiosity', async () => {
    setCuriosityDetector(detectCuriosity);
    const events: Record<string, unknown>[] = [SAMPLE_EVENTS[0]];
    for (const data of [
      { content: 'Why?', parentAgentTaskId: 'parent' },
      { content: 'Why?', source: 'agent-42' },
      { content: 'Why?', source: 'system' },
      { content: 'Why?', transformedContent: '<relayed_message>\nfrom_session_id: abc\n</relayed_message>\nWhy?' },
      { content: 'from_date: today\nWhy?', transformedContent: '<now>today</now>\nfrom_date: today\nWhy?' },
    ]) {
      events.push({ type: 'user.message', timestamp: '2026-09-30T12:00:00Z', data });
      events.push({ type: 'assistant.message', timestamp: '2026-09-30T12:00:01Z', data: { content: 'A reason.' } });
    }
    const parsed = await parseCLIEventsFileAsync(writeEvents(events), 'ws', 'Workspace');
    expect(parsed?.requests.map(request => request.curiosity?.kind))
      .toEqual(['analyzed', 'excluded', 'excluded', 'excluded', 'analyzed']);
  });

  it('parses a well-formed events file into a CLI session', async () => {
    const fp = writeEvents(SAMPLE_EVENTS);
    const session = await parseCLIEventsFileAsync(fp, 'ws-1', 'My Workspace');

    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-1');
    expect(session!.harness).toBe('GitHub Copilot CLI');
    expect(session!.workspaceId).toBe('ws-1');
    expect(session!.workspaceName).toBe('My Workspace');
    expect(session!.endReason).toBe('shutdown');
    expect(session!.requests).toHaveLength(1);

    const req = session!.requests[0];
    expect(req.messageText).toBe('add a function');
    expect(req.editedFiles).toContain('foo.ts');
    expect(req.toolsUsed).toContain('edit');
  });

  it('reports byte progress ending at the total file size', async () => {
    const fp = writeEvents(SAMPLE_EVENTS);
    const total = fs.statSync(fp).size;
    const progress: Array<[number, number]> = [];

    await parseCLIEventsFileAsync(fp, 'ws-1', 'My Workspace', undefined, (read, t) => progress.push([read, t]));

    // Small files finish in one chunk, so onProgress fires once with the final totals.
    expect(progress.at(-1)).toEqual([total, total]);
  });

  it('returns null and records a failed file when the path cannot be read', async () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'does-not-exist.jsonl');

    const session = await parseCLIEventsFileAsync(missing, 'ws-1', 'My Workspace');

    expect(session).toBeNull();
    expect(getParseWarningCounts().skippedFiles).toBe(1);
  });

  it('returns null for a file with no recognizable events', async () => {
    const fp = writeEvents([{ type: 'unknown.event', data: {} }]);
    const session = await parseCLIEventsFileAsync(fp, 'ws-1', 'My Workspace');
    expect(session).toBeNull();
  });

  it('produces the same requests as the synchronous parser', async () => {
    const fp = writeEvents(SAMPLE_EVENTS);
    const sync = parseCLIEventsFile(fp, 'ws-1', 'My Workspace');
    const asyncResult = await parseCLIEventsFileAsync(fp, 'ws-1', 'My Workspace');

    expect(asyncResult).not.toBeNull();
    expect(sync).not.toBeNull();
    expect(asyncResult!.requests.map((r) => r.messageText)).toEqual(sync!.requests.map((r) => r.messageText));
    expect(asyncResult!.requests[0].editedFiles).toEqual(sync!.requests[0].editedFiles);
  });
});

describe('CLI edit delta extraction', () => {
  it('captures freeform apply_patch arguments used by current Copilot CLI and App sessions', () => {
    const fp = writeEvents([
      { type: 'session.start', data: { sessionId: 'sess-patch' } },
      { type: 'user.message', data: { content: 'patch it' } },
      {
        type: 'tool.execution_start',
        data: {
          toolName: 'apply_patch',
          arguments: [
            '*** Begin Patch',
            '*** Update File: src/app.ts',
            '@@',
            '-const oldValue = 1;',
            '+const newValue = 2;',
            '+const extra = 3;',
            '*** End Patch',
          ].join('\n'),
        },
      },
      { type: 'assistant.message', id: 'assistant-patch', data: { content: 'Done.' } },
    ]);
    const editLocIndex: EditLocIndex = new Map();

    const session = parseCLIEventsFile(fp, 'ws', 'Workspace', undefined, editLocIndex);

    expect(session?.requests[0].editedFiles).toEqual(['src/app.ts']);
    expect(editLocIndex.get('assistant-patch')?.get('src/app.ts')).toEqual({ added: 2, removed: 1 });
  });

  it('diffs edit old_str/new_str payloads instead of counting all replacement text', () => {
    const fp = writeEvents([
      { type: 'session.start', data: { sessionId: 'sess-edit' } },
      { type: 'user.message', data: { content: 'edit it' } },
      {
        type: 'tool.execution_start',
        data: {
          toolName: 'edit',
          arguments: { path: 'src/app.ts', old_str: 'a\nold', new_str: 'a\nnew\nextra' },
        },
      },
      { type: 'assistant.message', id: 'assistant-edit', data: { content: 'Done.' } },
    ]);
    const editLocIndex: EditLocIndex = new Map();

    parseCLIEventsFile(fp, 'ws', 'Workspace', undefined, editLocIndex);

    expect(editLocIndex.get('assistant-edit')?.get('src/app.ts')).toEqual({ added: 2, removed: 1 });
  });

  it('does not count failed edit tool attempts', () => {
    const fp = writeEvents([
      { type: 'session.start', data: { sessionId: 'sess-failed' } },
      { type: 'user.message', data: { content: 'edit it' } },
      {
        type: 'tool.execution_start',
        data: {
          toolCallId: 'call-failed',
          toolName: 'edit',
          arguments: { path: 'src/app.ts', old_str: 'old', new_str: 'new' },
        },
      },
      {
        type: 'tool.execution_complete',
        data: { toolCallId: 'call-failed', success: false, error: { message: 'not applied' } },
      },
      { type: 'assistant.message', id: 'assistant-failed', data: { content: 'The edit failed.' } },
    ]);
    const editLocIndex: EditLocIndex = new Map();

    const session = parseCLIEventsFile(fp, 'ws', 'Workspace', undefined, editLocIndex);

    expect(session?.requests[0].editedFiles).toEqual([]);
    expect(editLocIndex.size).toBe(0);
  });

  it('does not count correlated edit calls without a completion event', () => {
    const fp = writeEvents([
      { type: 'session.start', data: { sessionId: 'sess-incomplete' } },
      { type: 'user.message', data: { content: 'edit it' } },
      {
        type: 'tool.execution_start',
        data: {
          toolCallId: 'call-incomplete',
          toolName: 'edit',
          arguments: { path: 'src/app.ts', old_str: 'old', new_str: 'new' },
        },
      },
      { type: 'assistant.message', id: 'assistant-incomplete', data: { content: 'Editing...' } },
    ]);
    const editLocIndex: EditLocIndex = new Map();

    const session = parseCLIEventsFile(fp, 'ws', 'Workspace', undefined, editLocIndex);

    expect(session?.requests[0].editedFiles).toEqual([]);
    expect(editLocIndex.size).toBe(0);
  });
});

describe('plan mode from native CLI events', () => {
  // Each user.message records the mode it was sent in, and untagged messages are in the default mode.
  // session.mode_changed doesn't log every switch back, so it isn't applied to later messages.
  function planRule(events: Array<Record<string, unknown>>) {
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', timestamp: '2026-09-30T09:00:00Z', data: { sessionId: 'plan-sess', startTime: '2026-09-30T09:00:00Z' } },
      ...events,
    ]), 'ws', 'Workspace');
    if (!session) throw new Error('session did not parse');
    return runDetectors(session.requests, [session], false).find(pattern => pattern.id === 'no-plan-mode');
  }
  const messages = (count: number, data: Record<string, unknown> = {}) => Array.from({ length: count }, (_, index) => ({
    type: 'user.message', timestamp: `2026-09-30T10:${String(index).padStart(2, '0')}:00Z`, data: { content: `step ${index}`, ...data },
  }));

  it('flags agent-mode sessions that never plan', () => {
    expect(planRule(messages(40))?.occurrences).toBe(40);
  });

  it('stays quiet once a message is sent in plan mode', () => {
    expect(planRule([
      { type: 'session.mode_changed', timestamp: '2026-09-30T09:30:00Z', data: { newMode: 'plan' } },
      ...messages(1, { agentMode: 'plan' }),
      ...messages(40),
    ])).toBeUndefined();
  });
});

describe('session families and credits (Copilot CLI and Copilot App)', () => {
  const COORD = '11111111-1111-4111-8111-111111111111';
  const KID = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const relay = (from: string, text: string) => ({ content: text, transformedContent: `<cross_session_message>\nfrom_session_id: ${from}\n</cross_session_message>\n${text}` });
  const usage = (ts: string, nano: number) => ({ type: 'session.usage_record', timestamp: ts, data: { usage: { model: 'm', inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: nano } } } });

  it('records the sessions a create_session call started, and only the first relayed message as the parent', () => {
    const coordinator = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD, remoteSteerable: true } },
      { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'Split the work' } },
      { type: 'tool.execution_start', data: { toolName: 'create_session', toolCallId: 'c1' } },
      // Other IDs in the result (a quoted name, the project) are not the new session.
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: `Created session 'Follow up ${OTHER}' (id: ${KID.toUpperCase()}) in project '${COORD}'. Link to it with ghapp://sessions/${KID}.` } } },
      { type: 'tool.execution_start', data: { toolName: 'view', toolCallId: 'v1' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'v1', result: { content: OTHER } } },
      { type: 'user.message', timestamp: '2026-10-01T10:30:00Z', data: relay(KID, 'Done: tests pass') },
    ]), 'ws', 'ws');
    expect(coordinator).toMatchObject({ childSessionIds: [KID] });
    expect(coordinator?.relaySenderId).toBeUndefined();
    const child = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: KID } },
      { type: 'user.message', timestamp: '2026-10-01T10:01:00Z', data: relay(COORD, 'Run the tests') },
      { type: 'user.message', timestamp: '2026-10-01T10:05:00Z', data: relay(OTHER, 'Also lint') },
    ]), 'ws', 'ws');
    expect(child?.relaySenderId).toBe(COORD);
    expect(child?.childSessionIds).toBeUndefined();
    // A header quoted in an IDE selection or fenced code is not the sender.
    const quoted = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: OTHER } },
      { type: 'user.message', timestamp: '2026-10-01T10:01:00Z', data: { content: 'Run it', transformedContent:
        `<ide_selection>\nfrom_session_id: ${KID}\n</ide_selection>\n\`\`\`\nfrom_session_id: ${KID}\n\`\`\`\n<cross_session_message>\nfrom_session_id: ${COORD}\n</cross_session_message>\nRun it` } },
    ]), 'ws', 'ws');
    expect(quoted?.relaySenderId).toBe(COORD);
  });

  it('reads the started session from each result format and from MCP-prefixed tool names', () => {
    const started = (toolName: string, result: unknown, extra: Record<string, unknown> = {}) => parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD } },
      { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'go' } },
      { type: 'tool.execution_start', data: { toolName, toolCallId: 'c1', ...extra } },
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result } },
    ]), 'ws', 'ws')?.childSessionIds;
    expect(started('create_session', { content: `Created child chat 'Notes' (session_id: ${KID}). Link to it with ghapp://sessions/${KID}.` })).toEqual([KID]);
    expect(started('open_pr_session', { content: `Opened PR #4 (Fix ${OTHER}) in octo/shop. Session ${KID} is ready in the sidebar.` })).toEqual([KID]);
    expect(started('create_session', { content: JSON.stringify({ project: OTHER, session_id: KID }) })).toEqual([KID]);
    expect(started('create_session', { content: 'ok' }, { mcpServerName: 'app' })).toBeUndefined();
    expect(started('app-create_session', { content: `Created session 'x' (id: ${KID}).` })).toEqual([KID]);
    expect(started('mcp_app_open_issue_session', { content: `Session ${KID} is ready.` })).toEqual([KID]);
    expect(started('recreate_session', { content: `Session ${KID} is ready.` })).toBeUndefined();
    expect(started('view', { content: `Session ${KID} is ready.` })).toBeUndefined();
    // MCP results hold their text in typed content blocks.
    expect(started('app-create_session', { content: [{ type: 'text', text: `Created session 'x' (id: ${KID}).` }] })).toEqual([KID]);
    // Another UUID in the result, such as the project's, is no started session.
    expect(started('create_session', { content: `Project id: ${OTHER}. Done.` })).toBeUndefined();
    expect(started('create_session', { content: JSON.stringify({ project_id: OTHER }) })).toBeUndefined();
  });

  it('tells the Copilot CLI from the App by the client that started the session', () => {
    const file = writeEvents([
      { type: 'session.start', data: { sessionId: COORD, remoteSteerable: false } },
      { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'go' } },
    ]);
    expect(parseCLIEventsFile(file, 'ws', 'ws')?.harness).toBe('GitHub Copilot App');
    fs.writeFileSync(path.join(path.dirname(file), 'workspace.yaml'), 'client_name: github/cli\n');
    const cli = parseCLIEventsFile(file, 'ws', 'ws');
    expect([cli?.harness, cli?.requests[0].agentName]).toEqual(['GitHub Copilot CLI', 'GitHub Copilot CLI']);
  });

  it('records the questions and permission prompts you answered as waits, not policy decisions', () => {
    const at = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 1, 10, m, s)).toISOString();
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD } },
      { type: 'user.message', timestamp: at(0), data: { content: 'go' } },
      { type: 'tool.execution_start', timestamp: at(1), data: { toolName: 'ask_user', toolCallId: 'q1' } },
      { type: 'tool.execution_complete', timestamp: at(6), data: { toolCallId: 'q1', success: true, result: { content: 'User selected: yes' } } },
      // Interrupted: no answer from you.
      { type: 'tool.execution_start', timestamp: at(7), data: { toolName: 'ask_user', toolCallId: 'q2' } },
      { type: 'tool.execution_complete', timestamp: at(8), data: { toolCallId: 'q2', success: false, result: { content: 'Tool execution was interrupted' } } },
      // A child's question relayed to you and answered.
      { type: 'tool.execution_start', timestamp: at(9), data: { toolName: 'relay_session_input', toolCallId: 'r1' } },
      { type: 'tool.execution_complete', timestamp: at(12), data: { toolCallId: 'r1', success: true, result: { content: JSON.stringify({ outcome: 'answered_here', answer: 'b' }) } } },
      { type: 'permission.requested', timestamp: at(13), data: { requestId: 'p1' } },
      { type: 'permission.completed', timestamp: at(13, 1), data: { requestId: 'p1', decisionSource: 'host_policy', result: { kind: 'approved' } } },
      { type: 'permission.requested', timestamp: at(14), data: { requestId: 'p2' } },
      { type: 'permission.completed', timestamp: at(14, 2), data: { requestId: 'p2', result: { kind: 'approved' } } },
      { type: 'permission.requested', timestamp: at(15), data: { requestId: 'p3' } },
      { type: 'permission.completed', timestamp: at(17), data: { requestId: 'p3', decisionSource: 'human_response', result: { kind: 'approved' } } },
      // Evidence can follow the decision.
      { type: 'permission.requested', timestamp: at(18), data: { requestId: 'p4' } },
      { type: 'permission.completed', timestamp: at(19), data: { requestId: 'p4', result: { kind: 'approved' } } },
      { type: 'human_response.recorded', timestamp: at(19), data: { requestId: 'p4', actor: 'human_response' } },
      { type: 'assistant.message', timestamp: at(20), data: { content: 'done' } },
      // A permission answered after the turn's last message still counts, with its own times.
      { type: 'permission.requested', timestamp: at(21), data: { requestId: 'p5' } },
      { type: 'permission.completed', timestamp: at(24), data: { requestId: 'p5', result: { kind: 'denied-interactively-by-user' } } },
    ]), 'ws', 'ws');
    const ms = (iso: string) => Date.parse(iso);
    // Every request stops the agent; only an answer from you is `answered`. A policy decision isn't a request to you.
    expect(session?.requests[0].userWaits).toEqual([
      { start: ms(at(1)), end: ms(at(6)), kind: 'question', answered: true, text: { answer: 'yes' } },
      { start: ms(at(7)), end: ms(at(8)), kind: 'question', answered: false },
      { start: ms(at(9)), end: ms(at(12)), kind: 'relay', answered: true, text: { answer: 'b' } },
      { start: ms(at(14)), end: ms(at(14, 2)), kind: 'permission', answered: false, text: { answer: 'approved' } },
      { start: ms(at(15)), end: ms(at(17)), kind: 'permission', answered: true, text: { answer: 'approved' } },
      // The record of your answer dates it, apart from the result.
      { start: ms(at(18)), end: ms(at(19)), kind: 'permission', answered: true, answeredAt: ms(at(19)), text: { answer: 'approved' } },
      { start: ms(at(21)), end: ms(at(24)), kind: 'permission', answered: true, text: { answer: 'denied-interactively-by-user' } },
    ]);
  });

  it('keeps what a question, relay or permission prompt asked and what you answered, until the session is stripped', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD } },
      { type: 'user.message', timestamp: at(0), data: { content: 'go' } },
      { type: 'assistant.message', timestamp: at(1), data: { content: 'Two databases fit.' } },
      { type: 'tool.execution_start', timestamp: at(2), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Which DB?', choices: ['A', 'B'] } } },
      { type: 'tool.execution_complete', timestamp: at(5), data: { toolCallId: 'q1', success: true, result: { content: 'User selected: B' } } },
      { type: 'permission.requested', timestamp: at(6), data: { requestId: 'p1', permissionRequest: { kind: 'shell', fullCommandText: 'npm test', intention: 'Run the tests' } } },
      { type: 'permission.completed', timestamp: at(7), data: { requestId: 'p1', decisionSource: 'human_response', result: { kind: 'approved' } } },
      { type: 'tool.execution_start', timestamp: at(8), data: { toolName: 'relay_session_input', toolCallId: 'r1', arguments: { context: 'Child asks', project_session_id: 'p' } } },
      { type: 'tool.execution_complete', timestamp: at(9), data: { toolCallId: 'r1', success: true, result: { content: JSON.stringify({ question: 'Deploy now?', outcome: 'answered_here', answer: 'Not yet' }) } } },
      // The answer text can come only in the human_response record.
      { type: 'tool.execution_start', timestamp: at(10), data: { toolName: 'ask_user', toolCallId: 'q2', arguments: { question: 'Name?' } } },
      { type: 'tool.execution_complete', timestamp: at(11), data: { toolCallId: 'q2', success: true, result: { content: '' } } },
      { type: 'human_response.recorded', timestamp: at(11), data: { toolCallId: 'q2', response: { answer: 'Ada' } } },
      { type: 'permission.requested', timestamp: at(12), data: { requestId: 'p2', permissionRequest: { kind: 'mcp', serverName: 'github', toolTitle: 'Create issue' } } },
      { type: 'permission.completed', timestamp: at(13), data: { requestId: 'p2', decisionSource: 'human_response', result: { kind: 'denied-interactively-by-user' } } },
      { type: 'assistant.message', timestamp: at(14), data: { content: 'done' } },
    ]), 'ws', 'ws');
    expect(session?.requests[0].userWaits?.map(w => [w.kind, w.answered, w.text])).toEqual([
      ['question', true, { ask: 'Which DB?', choices: ['A', 'B'], before: 'Two databases fit.', answer: 'B' }],
      ['permission', true, { ask: 'npm test', tool: 'shell', intention: 'Run the tests', answer: 'approved' }],
      ['relay', true, { ask: 'Deploy now?', before: 'Two databases fit.', answer: 'Not yet' }],
      ['question', true, { ask: 'Name?', before: 'Two databases fit.', answer: 'Ada' }],
      ['permission', true, { ask: 'github: Create issue', tool: 'mcp', answer: 'denied-interactively-by-user' }],
    ]);
    // The analyzers hold sessions without it: the detail view reads it again from the log.
    stripSingleSession(session!);
    expect(session?.requests[0].userWaits?.some(w => w.text)).toBe(false);
  });

  it('gives a recorded answer only to the question it answered, not to a later one that reused its tool call ID', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD } },
      { type: 'user.message', timestamp: at(0), data: { content: 'go' } },
      { type: 'tool.execution_start', timestamp: at(2), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Ship it?' } } },
      { type: 'human_response.recorded', timestamp: at(3), data: { toolCallId: 'q1', response: { answer: 'yes' } } },
      { type: 'tool.execution_complete', timestamp: at(3), data: { toolCallId: 'q1', success: true, result: { content: '' } } },
      { type: 'tool.execution_start', timestamp: at(5), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Tag it?' } } },
      { type: 'tool.execution_complete', timestamp: at(6), data: { toolCallId: 'q1', success: false } },
      { type: 'tool.execution_start', timestamp: at(7), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Notify?' } } },
      { type: 'assistant.message', timestamp: at(8), data: { content: 'done' } },
    ]), 'ws', 'ws');
    expect(session?.requests[0].userWaits?.map(w => [w.text?.ask, w.text?.answer])).toEqual([['Ship it?', 'yes'], ['Tag it?', undefined], ['Notify?', undefined]]);
    // Nor its record that you answered (code from #381, hardened here): only the first was answered.
    expect(session?.requests[0].userWaits?.map(w => [w.answered, w.answeredAt])).toEqual([[true, Date.parse(at(3))], [false, undefined], [false, undefined]]);
  });

  it('gives a wait to the turn that asked, even when the answer comes during a later turn', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: COORD } },
      { type: 'user.message', timestamp: at(0), data: { content: 'one' } },
      { type: 'permission.requested', timestamp: at(1), data: { requestId: 'p1' } },
      { type: 'tool.execution_start', timestamp: at(2), data: { toolName: 'ask_user', toolCallId: 'q1' } },
      { type: 'assistant.message', timestamp: at(3), data: { content: 'waiting' } },
      { type: 'user.message', timestamp: at(10), data: { content: 'two' } },
      { type: 'permission.completed', timestamp: at(11), data: { requestId: 'p1', result: { kind: 'approved' } } },
      { type: 'tool.execution_complete', timestamp: at(12), data: { toolCallId: 'q1', success: true, result: { content: 'User responded: ok' } } },
      // The evidence that you decided p1 comes later still.
      { type: 'human_response.recorded', timestamp: at(13), data: { requestId: 'p1' } },
      { type: 'assistant.message', timestamp: at(14), data: { content: 'done' } },
    ]), 'ws', 'ws');
    const ms = (iso: string) => Date.parse(iso);
    // Overlapping requests stay separate: each is its own answer, and the model unions their time.
    expect(session?.requests.map(r => r.userWaits)).toEqual([
      [{ start: ms(at(1)), end: ms(at(11)), kind: 'permission', answered: true, answeredAt: ms(at(13)), text: { answer: 'approved' } },
        { start: ms(at(2)), end: ms(at(12)), kind: 'question', answered: true, text: { answer: 'ok' } }],
      undefined,
    ]);
  });

  it('adds each usage record’s AI credits and tokens to its turn, the first turn taking earlier records', () => {
    const session = parseCLIEventsFile(writeEvents([
      { type: 'session.start', data: { sessionId: 'credits' } },
      usage('2026-10-01T09:59:00Z', 500_000_000),
      { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'one' } },
      usage('2026-10-01T10:00:10Z', 1_000_000_000),
      { type: 'user.message', timestamp: '2026-10-01T10:10:00Z', data: { content: 'two' } },
      { type: 'user.message', timestamp: '2026-10-01T10:20:00Z', data: { content: 'three' } },
      usage('2026-10-01T10:20:10Z', 2_000_000_000),
    ]), 'ws', 'ws');
    expect(session?.requests.map(r => [r.aiCredits, r.loggedTokens])).toEqual([[1.5, 240], [undefined, undefined], [2, 120]]);
  });

  it('reads the session’s name, branch and repository from workspace.yaml beside events.jsonl', () => {
    const file = writeEvents([
      { type: 'session.start', data: { sessionId: 'named' } },
      { type: 'user.message', timestamp: '2026-10-01T10:00:00Z', data: { content: 'hi' } },
    ]);
    fs.writeFileSync(path.join(path.dirname(file), 'workspace.yaml'), 'name: Timeline revamp\nuser_named: true\nbranch: main\nrepository: octo/shop\n');
    expect(parseCLIEventsFile(file, 'ws', 'ws')).toMatchObject({ displayName: 'Timeline revamp', branch: 'main', repository: 'shop' });
  });
});