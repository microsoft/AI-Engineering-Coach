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
import { getParseWarningCounts, resetParseWarnings, setCuriosityDetector } from './parser-shared';
import { detectCuriosity } from './curiosity';
import { CuriosityAnalyzer } from './analyzer-curiosity';
import { runDetectors } from './detector-registry';

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
