/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude Code compactions: a `system` line with subtype `compact_boundary` and `compactMetadata`. The
 * fixtures are synthetic, in the shape Claude Code writes. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSessions } from './parser-claude';
import { requestCompactions } from './context-window';
import { SessionSchema } from './schemas';
import type { Session } from './types';

const SESSION = 'sess-compact';

function parseLines(lines: object[]): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compaction-test-'));
  const projDir = path.join(root, 'projects', '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${SESSION}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try {
    return parseClaudeSessions(path.join(root, 'projects'))[0].sessions[0];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function user(text: string, ts: string, extra: Record<string, unknown> = {}): object {
  return { type: 'user', timestamp: ts, sessionId: SESSION, cwd: '/Users/me/proj', ...extra, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistant(id: string, ts: string, input: number): object {
  return {
    type: 'assistant', timestamp: ts, sessionId: SESSION,
    message: { id, role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: input, output_tokens: 10 } },
  };
}

function boundary(ts: string, metadata: Record<string, unknown>): object {
  return { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: ts, sessionId: SESSION, compactMetadata: metadata };
}

describe('Claude Code compaction', () => {
  it('records a compact_boundary on the request it was logged in, with its sizes and trigger', () => {
    const session = parseLines([
      user('first task', '2026-11-01T10:00:00Z'),
      assistant('m1', '2026-11-01T10:00:05Z', 300_000),
      boundary('2026-11-01T10:00:06Z', { trigger: 'auto', preTokens: 300_000, postTokens: 12_000, durationMs: 40 }),
      user('This session is being continued from a previous conversation.', '2026-11-01T10:00:07Z', { isCompactSummary: true }),
      assistant('m2', '2026-11-01T10:00:09Z', 12_000),
      user('next task', '2026-11-01T10:01:00Z'),
      assistant('m3', '2026-11-01T10:01:05Z', 15_000),
    ]);
    expect(session.requests).toHaveLength(3);
    expect(session.requests[0].compaction).toMatchObject({
      contextLengthBefore: 300_000, contextLengthAfter: 12_000, trigger: 'auto', durationMs: 40, outcome: 'success',
    });
    expect(session.requests[0].compactions).toBeUndefined();
    expect(session.requests[1].compaction).toBeNull();
    expect(session.requests[2].compaction).toBeNull();
    expect(SessionSchema.safeParse(session).success).toBe(true);
  });

  it('keeps every compaction of a turn, and gives one logged before the first prompt to the first request', () => {
    const session = parseLines([
      boundary('2026-11-01T09:59:00Z', { trigger: 'manual', preTokens: 90_000 }),
      user('long task', '2026-11-01T10:00:00Z'),
      assistant('m1', '2026-11-01T10:00:05Z', 200_000),
      boundary('2026-11-01T10:00:06Z', { trigger: 'auto', preTokens: 200_000, postTokens: 9_000 }),
      assistant('m2', '2026-11-01T10:00:09Z', 9_000),
    ]);
    const all = requestCompactions(session.requests[0]);
    expect(all.map(c => [c.trigger, c.contextLengthBefore, c.contextLengthAfter])).toEqual([
      ['manual', 90_000, undefined],
      ['auto', 200_000, 9_000],
    ]);
  });
});
