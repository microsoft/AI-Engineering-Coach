/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Copilot CLI compactions and sub-agent runs, parsed from events.jsonl. Fixtures mirror the shapes
 * of real events (current and older builds), with content, paths and ids replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import { parseCLIEventsFile, parseCLIEventsFileAsync } from './parser-vscode-cli';
import { SessionSchema } from './schemas';

const tempDirs: string[] = [];

function writeEvents(events: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cli-token-types-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const START = { type: 'session.start', timestamp: '2026-10-28T09:00:00Z', data: { sessionId: 'cli-tt', startTime: '2026-10-28T09:00:00Z', selectedModel: 'claude-opus-5.5', remoteSteerable: true } };

function user(id: string, minute: number): Record<string, unknown> {
  return { type: 'user.message', id, timestamp: `2026-10-28T09:${String(minute).padStart(2, '0')}:00Z`, data: { content: `secret prompt ${id}` } };
}

function assistant(id: string): Record<string, unknown> {
  return { type: 'assistant.message', id, data: { content: 'secret answer', outputTokens: 10 } };
}

function compactionComplete(before: number, after: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session.compaction_complete',
    data: {
      success: true, trigger: 'threshold', preCompactionTokens: before, postCompactionTokens: after, tokensRemoved: before - after,
      tokenLimit: 300_000, checkpointNumber: 1, checkpointPath: '/home/someone/.copilot/session-state/cli-tt/checkpoints/001.md',
      summaryContent: 'SECRET SUMMARY', requestId: 'req-secret',
      compactionTokensUsed: { inputTokens: 250_000, outputTokens: 7_000, cacheReadTokens: 200_000, cacheWriteTokens: 9_000, duration: 40_000, model: 'claude-opus-5.5' },
      ...extra,
    },
  };
}

function subagentStarted(toolCallId: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'subagent.started', data: { toolCallId, agentDescription: 'SECRET description', ...data } };
}

function subagentCompleted(toolCallId: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type: 'subagent.completed', data: { toolCallId, ...data } };
}

const EVENTS = [
  START,
  user('u1', 1),
  subagentStarted('call-bg', { agentType: 'research', agentName: 'research', executionMode: 'background', model: 'claude-sonnet-5' }),
  subagentStarted('call-sync', { agentType: 'explore', agentName: 'explore', executionMode: 'sync', model: 'claude-haiku-4.5' }),
  subagentCompleted('call-sync', { agentName: 'explore', model: 'claude-haiku-4.5', totalTokens: 60_000, totalToolCalls: 9, durationMs: 20_000 }),
  compactionComplete(245_000, 52_000),
  compactionComplete(250_000, 49_000, { checkpointNumber: 2 }),
  assistant('a1'),
  user('u2', 5),
  subagentStarted('call-custom', { agentType: 'custom', agentName: 'my-private-agent', executionMode: 'sync', model: 'gpt-6.1-sol' }),
  subagentCompleted('call-bg', { agentName: 'research', model: 'claude-sonnet-5', totalTokens: 1_500_000, totalToolCalls: 44, durationMs: 300_000 }),
  subagentCompleted('call-custom', { agentName: 'my-private-agent', totalTokens: 90_000, totalToolCalls: 3, durationMs: 9_000, cancelled: true }),
  subagentStarted('call-running', { agentType: 'task', agentName: 'task', executionMode: 'background' }),
  assistant('a2'),
  user('u3', 9),
  // An older build: legacy compaction fields only.
  { type: 'session.compaction_complete', data: { mode: 'simple', numRounds: 8, contextLengthBefore: 120_000, durationMs: 900, model: 'gpt-5.4', outcome: 'success' } },
  assistant('a3'),
];

describe('Copilot CLI compactions and sub-agent runs', () => {
  it('keeps every compaction of a turn with the fields current builds log', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    const [first, , third] = session?.requests ?? [];
    expect(first.compaction).toMatchObject({ contextLengthBefore: 245_000, contextLengthAfter: 52_000, tokenLimit: 300_000, trigger: 'threshold', checkpointNumber: 1 });
    expect(first.compactions?.map(c => c.contextLengthBefore)).toEqual([245_000, 250_000]);
    expect(first.compactions?.[1]).toMatchObject({ contextLengthAfter: 49_000, checkpointNumber: 2, tokensUsed: { input: 250_000, output: 7_000, cacheRead: 200_000, cacheWrite: 9_000 }, durationMs: 40_000, outcome: 'success' });
    expect(third.compaction).toMatchObject({ mode: 'simple', numRounds: 8, contextLengthBefore: 120_000, model: 'gpt-5.4' });
    expect(third.compactions).toBeUndefined();
  });

  it('attributes sub-agent runs to the turn that launched them', () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    const [first, second, third] = session?.requests ?? [];
    expect(first.subagentRuns).toEqual([
      { agentType: 'explore', model: 'claude-haiku-4.5', mode: 'sync', totalTokens: 60_000, toolCalls: 9, durationMs: 20_000, cancelled: false },
      { agentType: 'research', model: 'claude-sonnet-5', mode: 'background', totalTokens: 1_500_000, toolCalls: 44, durationMs: 300_000, cancelled: false },
    ]);
    expect(second.subagentRuns).toEqual([
      { agentType: 'custom', model: 'gpt-6.1-sol', mode: 'sync', totalTokens: 90_000, toolCalls: 3, durationMs: 9_000, cancelled: true },
    ]);
    expect(third.subagentRuns).toBeUndefined();
  });

  it('stores no summaries, paths, ids, descriptions or custom agent names, and passes the schema', async () => {
    const session = parseCLIEventsFile(writeEvents(EVENTS), 'ws', 'demo');
    expect(session && SessionSchema.safeParse(session).success).toBe(true);
    const json = JSON.stringify(session?.requests.map(r => ({ compaction: r.compaction, compactions: r.compactions, subagentRuns: r.subagentRuns })));
    for (const secret of ['SECRET', 'checkpoints', 'req-secret', 'my-private-agent', 'call-bg', 'call-custom']) expect(json).not.toContain(secret);

    const asyncSession = await parseCLIEventsFileAsync(writeEvents(EVENTS), 'ws', 'demo');
    expect(asyncSession?.requests.map(r => r.subagentRuns?.length ?? 0)).toEqual([2, 1, 0]);
  });
});
