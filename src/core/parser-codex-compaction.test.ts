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

function answer(ts: string): object {
  return { type: 'event_msg', timestamp: ts, payload: { type: 'assistant_message', content: 'done' } };
}

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
    expect(SessionSchema.safeParse(session).success).toBe(true);
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
