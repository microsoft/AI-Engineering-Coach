/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Codex `token_count` events: per-call context, the reported context window and reasoning tokens.
 * Synthetic fixtures follow the Codex rollout format (`info.total_token_usage`, `info.last_token_usage`,
 * `info.model_context_window`); no local Codex logs were available to copy shapes from. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseCodexSessions } from './parser-codex';
import { SessionSchema } from './schemas';

function withCodexFile(lines: object[], run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-types-'));
  const dayDir = path.join(root, 'sessions', '2026', '10', '30');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-2026-10-30-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(path.join(root, 'sessions')); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function usage(input: number, cached: number, output: number, reasoning: number): Record<string, number> {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}

function tokenCount(ts: string, total: Record<string, number>, last: Record<string, number> | null, window: number | null = 272_000): object {
  return {
    type: 'event_msg',
    timestamp: ts,
    payload: { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}), ...(window ? { model_context_window: window } : {}) } },
  };
}

const HEADER = [
  { type: 'session_meta', payload: { id: 'sess-codex-tt', cwd: '/Users/me/proj' } },
  { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'high' } },
];

describe('Codex token types', () => {
  it('records each turn\u2019s last and largest prompt, the reported window and reasoning tokens', () => {
    withCodexFile([
      ...HEADER,
      { type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'user_message', message: 'fix the bug' } },
      tokenCount('2026-10-30T10:00:05Z', usage(20_000, 0, 500, 300), usage(20_000, 0, 500, 300)),
      tokenCount('2026-10-30T10:00:10Z', usage(65_000, 18_000, 1_100, 600), usage(45_000, 18_000, 600, 300)),
      // A repeated event (same totals, e.g. after a rate-limit update) is not another model call.
      tokenCount('2026-10-30T10:00:11Z', usage(65_000, 18_000, 1_100, 600), usage(45_000, 18_000, 600, 300)),
      { type: 'event_msg', timestamp: '2026-10-30T10:01:00Z', payload: { type: 'assistant_message', content: 'fixed' } },
      { type: 'event_msg', timestamp: '2026-10-30T10:02:00Z', payload: { type: 'user_message', message: 'add a test' } },
      tokenCount('2026-10-30T10:02:05Z', usage(115_000, 60_000, 1_500, 700), usage(50_000, 42_000, 400, 100)),
      { type: 'event_msg', timestamp: '2026-10-30T10:02:30Z', payload: { type: 'assistant_message', content: 'added' } },
    ], (sessionsDir) => {
      const session = parseCodexSessions(sessionsDir)[0];
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0].contextUsage).toEqual({ lastPromptTokens: 45_000, peakPromptTokens: 45_000, contextLimit: 272_000 });
      expect(session.requests[1].contextUsage).toEqual({ lastPromptTokens: 50_000, peakPromptTokens: 50_000, contextLimit: 272_000 });
      // promptTokens keeps its meaning: the turn's cumulative input delta.
      expect(session.requests[0].promptTokens).toBe(65_000);
      expect(session.requests[1].promptTokens).toBe(50_000);
      expect(session.modelUsage?.['gpt-5.3-codex']).toMatchObject({ outputTokens: 1_500, reasoningTokens: 700 });
      expect(SessionSchema.safeParse(session).success).toBe(true);
    });
  });

  it('keeps the largest prompt of a turn when the context shrinks', () => {
    withCodexFile([
      ...HEADER,
      { type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'user_message', message: 'big task' } },
      tokenCount('2026-10-30T10:00:05Z', usage(200_000, 0, 100, 0), usage(200_000, 0, 100, 0)),
      tokenCount('2026-10-30T10:00:10Z', usage(230_000, 0, 200, 0), usage(30_000, 0, 100, 0)),
    ], (sessionsDir) => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].contextUsage).toEqual({ lastPromptTokens: 30_000, peakPromptTokens: 200_000, contextLimit: 272_000 });
    });
  });

  it('records nothing new for builds without last_token_usage, model_context_window or reasoning', () => {
    withCodexFile([
      ...HEADER,
      { type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'user_message', message: 'hi' } },
      { type: 'event_msg', timestamp: '2026-10-30T10:00:01Z', payload: { type: 'token_count', info: null } },
      { type: 'event_msg', timestamp: '2026-10-30T10:00:05Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 200 } } } },
    ], (sessionsDir) => {
      const session = parseCodexSessions(sessionsDir)[0];
      expect(session.requests[0].contextUsage).toBeUndefined();
      expect(session.requests[0].promptTokens).toBe(1000);
      expect(session.modelUsage?.['gpt-5.3-codex'].reasoningTokens).toBeUndefined();
    });
  });

  it('records the context without a window when model_context_window is missing', () => {
    withCodexFile([
      ...HEADER,
      { type: 'event_msg', timestamp: '2026-10-30T10:00:00Z', payload: { type: 'user_message', message: 'hi' } },
      tokenCount('2026-10-30T10:00:05Z', usage(9_000, 0, 50, 10), usage(9_000, 0, 50, 10), null),
    ], (sessionsDir) => {
      expect(parseCodexSessions(sessionsDir)[0].requests[0].contextUsage).toEqual({ lastPromptTokens: 9_000, peakPromptTokens: 9_000, contextLimit: null });
    });
  });
});
