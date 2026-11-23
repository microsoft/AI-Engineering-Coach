/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Codex compactions. Codex logs no sizes for a compaction, and often several records for one: a `compacted` line,
 * a `compaction` response item, a `context_compacted` event or a `ContextCompaction` item. The fixtures are
 * synthetic, in the shape of Codex rollout files. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseCodexSessions } from './parser-codex';
import { requestCompactions } from './context-window';
import { compactionKind } from './cli-compaction';
import { SessionSchema } from './schemas';
import type { Session } from './types';

function parseLines(lines: object[]): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compaction-test-'));
  const dayDir = path.join(root, 'sessions', '2026', '11', '01');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-2026-11-01-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try {
    return parseCodexSessions(path.join(root, 'sessions'))[0];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let total = 0;
function tokenCount(ts: string, lastInput: number, window = 258_000): object {
  total += lastInput + 10;
  return {
    type: 'event_msg', timestamp: ts,
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: total, output_tokens: 10, total_tokens: total },
      last_token_usage: { input_tokens: lastInput, output_tokens: 10 },
      model_context_window: window,
    } },
  };
}

function prompt(ts: string, message: string): object {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message } };
}

function taskStarted(ts: string): object {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'task_started', model_context_window: 258_000 } };
}

function answer(ts: string): object {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'assistant_message', content: 'done' } };
}

function toolCall(ts: string): object {
  return { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: `call-${ts}` } };
}

function taskComplete(ts: string): object {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', last_agent_message: null } };
}

/** A compaction as Codex logs it: a `compacted` line and a `ContextCompaction` item. */
function compacted(ts: string): object[] {
  return [
    { type: 'compacted', timestamp: ts, payload: { message: '' } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: `item-${ts}` } } },
  ];
}

/** A first prompted task, so the compactions after it have a model call to be sized from. */
const FIRST_TASK = [
  taskStarted('2026-11-01T10:00:00Z'),
  prompt('2026-11-01T10:00:00Z', 'first task'),
  tokenCount('2026-11-01T10:00:05Z', 30_000),
  answer('2026-11-01T10:00:20Z'),
];

const HEADER = [
  { type: 'session_meta', payload: { id: 'sess-codex-compact', cwd: '/Users/me/proj' } },
  { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
];

describe('Codex compaction', () => {
  it('records one compaction per compaction, with the last prompt and window before it', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      prompt('2026-11-01T10:00:00Z', 'big task'),
      tokenCount('2026-11-01T10:00:05Z', 240_000),
      { type: 'compacted', timestamp: '2026-11-01T10:00:06Z', payload: { message: '' } },
      tokenCount('2026-11-01T10:00:06Z', 0),
      { type: 'event_msg', timestamp: '2026-11-01T10:00:06Z', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: 'item-1' } } },
      { type: 'event_msg', timestamp: '2026-11-01T10:00:06Z', payload: { type: 'context_compacted' } },
      tokenCount('2026-11-01T10:00:10Z', 20_000),
      answer('2026-11-01T10:00:20Z'),
      prompt('2026-11-01T10:01:00Z', 'next task'),
      tokenCount('2026-11-01T10:01:05Z', 25_000),
      { type: 'response_item', timestamp: '2026-11-01T10:01:06Z', payload: { type: 'compaction', encrypted_content: 'opaque' } },
      tokenCount('2026-11-01T10:01:10Z', 9_000),
      answer('2026-11-01T10:01:20Z'),
    ]);
    expect(session.requests).toHaveLength(2);
    expect(requestCompactions(session.requests[0])).toEqual([
      expect.objectContaining({ contextLengthBefore: 240_000, tokenLimit: 258_000, outcome: 'success' }),
    ]);
    expect(requestCompactions(session.requests[1])).toEqual([
      expect.objectContaining({ contextLengthBefore: 25_000, tokenLimit: 258_000 }),
    ]);
    // No task events (older Codex): who started the compaction is unknown.
    expect(requestCompactions(session.requests[0])[0].trigger).toBeUndefined();
    expect(SessionSchema.safeParse(session).success).toBe(true);
  });

  it('marks a compaction inside a prompted task automatic', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      taskStarted('2026-11-01T10:00:00Z'),
      prompt('2026-11-01T10:00:00Z', 'big task'),
      tokenCount('2026-11-01T10:00:05Z', 240_000),
      { type: 'compacted', timestamp: '2026-11-01T10:00:06Z', payload: { message: '' } },
      { type: 'event_msg', timestamp: '2026-11-01T10:00:06Z', payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: 'item-1' } } },
      tokenCount('2026-11-01T10:00:10Z', 20_000),
      answer('2026-11-01T10:00:20Z'),
    ]);
    const compactions = requestCompactions(session.requests[0]);
    expect(compactions).toHaveLength(1);
    expect(compactions[0].trigger).toBe('auto');
    expect(compactionKind(compactions[0].trigger)).toBe('automatic');
  });

  it('marks a compaction in a task with no prompt and no other work manual, on the turn before it', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      taskStarted('2026-11-01T10:00:00Z'),
      prompt('2026-11-01T10:00:00Z', 'first task'),
      tokenCount('2026-11-01T10:00:05Z', 30_000),
      answer('2026-11-01T10:00:20Z'),
      { type: 'event_msg', timestamp: '2026-11-01T10:00:21Z', payload: { type: 'task_complete', last_agent_message: 'done' } },
      taskStarted('2026-11-01T10:01:00Z'),
      ...compacted('2026-11-01T10:01:02Z'),
      taskComplete('2026-11-01T10:01:03Z'),
      taskStarted('2026-11-01T10:02:00Z'),
      prompt('2026-11-01T10:02:00Z', 'next task'),
      tokenCount('2026-11-01T10:02:05Z', 4_000),
      answer('2026-11-01T10:02:20Z'),
    ]);
    expect(session.requests).toHaveLength(2);
    const compactions = requestCompactions(session.requests[0]);
    expect(compactions).toEqual([expect.objectContaining({ contextLengthBefore: 30_000, trigger: 'manual' })]);
    expect(compactionKind(compactions[0].trigger)).toBe('manual');
    expect(session.requests[1].compaction).toBeNull();
  });

  it('marks a compaction after model work in a task with no prompt automatic', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      ...FIRST_TASK,
      taskStarted('2026-11-01T10:01:00Z'),
      toolCall('2026-11-01T10:01:01Z'),
      tokenCount('2026-11-01T10:01:02Z', 40_000),
      ...compacted('2026-11-01T10:01:03Z'),
      taskComplete('2026-11-01T10:01:04Z'),
    ]);
    expect(requestCompactions(session.requests[0])).toEqual([expect.objectContaining({ contextLengthBefore: 40_000, trigger: 'auto' })]);
  });

  it('marks a compaction before the task\'s prompt automatic', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      ...FIRST_TASK,
      taskStarted('2026-11-01T10:01:00Z'),
      ...compacted('2026-11-01T10:01:01Z'),
      prompt('2026-11-01T10:01:02Z', 'next task'),
      tokenCount('2026-11-01T10:01:05Z', 5_000),
      answer('2026-11-01T10:01:10Z'),
    ]);
    expect(session.requests).toHaveLength(2);
    expect(requestCompactions(session.requests[0])).toEqual([expect.objectContaining({ trigger: 'auto' })]);
    expect(session.requests[1].compaction).toBeNull();
  });

  it('marks a compaction followed by model work in a task with no prompt automatic', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      ...FIRST_TASK,
      taskStarted('2026-11-01T10:01:00Z'),
      ...compacted('2026-11-01T10:01:01Z'),
      toolCall('2026-11-01T10:01:02Z'),
      tokenCount('2026-11-01T10:01:03Z', 6_000),
      taskComplete('2026-11-01T10:01:04Z'),
    ]);
    expect(requestCompactions(session.requests[0])).toEqual([expect.objectContaining({ trigger: 'auto' })]);
  });

  it('keeps a manual compaction manual when the next task has work', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      ...FIRST_TASK,
      taskStarted('2026-11-01T10:01:00Z'),
      ...compacted('2026-11-01T10:01:01Z'),
      taskStarted('2026-11-01T10:02:00Z'),
      toolCall('2026-11-01T10:02:01Z'),
      prompt('2026-11-01T10:02:02Z', 'next task'),
      tokenCount('2026-11-01T10:02:05Z', 5_000),
    ]);
    expect(requestCompactions(session.requests[0])).toEqual([expect.objectContaining({ trigger: 'manual' })]);
  });

  it('ignores a compaction a forked thread inherited before its first model call', () => {
    total = 0;
    const session = parseLines([
      ...HEADER,
      { type: 'response_item', timestamp: '2026-11-01T10:00:00Z', payload: { type: 'compaction', encrypted_content: 'opaque' } },
      prompt('2026-11-01T10:00:01Z', 'review this'),
      tokenCount('2026-11-01T10:00:05Z', 30_000),
      answer('2026-11-01T10:00:20Z'),
    ]);
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].compaction).toBeNull();
  });
});
