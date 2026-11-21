/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* A Codex fork's own token usage: its cumulative snapshots start with the source's, so its responses' own usage records
 * decide it, whatever snapshots it holds or copied. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseCodexSessions } from './parser-codex';

function withCodexFile(lines: object[], run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fork-usage-test-'));
  const dayDir = path.join(root, 'sessions', '2025', '06', '15');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-2025-06-15-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(path.join(root, 'sessions')); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('Codex fork usage', () => {  it('counts a fork’s own responses by their thread and response IDs, whatever snapshots it holds (B8)', () => {
    const own = { type: 'token_usage_record', timestamp: '2025-06-15T09:00:09Z', payload: { thread_id: 'fork', response_id: 'r-own', usage: { input_tokens: 13_580, output_tokens: 34, total_tokens: 13_614 } } };
    const total = (ts: string, t: [number, number], last: [number, number]) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: t[0], output_tokens: t[1], total_tokens: t[0] + t[1] },
      last_token_usage: { input_tokens: last[0], output_tokens: last[1], total_tokens: last[0] + last[1] },
    } } });
    const parse = (lines: object[]) => {
      let out: (number | null)[] = [];
      withCodexFile([
        { type: 'session_meta', payload: { id: 'fork', forked_from_id: 'src', cwd: '/Users/me/proj' } },
        { type: 'event_msg', timestamp: '2025-06-15T09:00:00Z', payload: { type: 'user_message', message: 'Go on.' } },
        ...lines,
        { type: 'event_msg', timestamp: '2025-06-15T09:00:20Z', payload: { type: 'agent_message', message: 'Done.' } },
      ], (sessionsDir) => {
        const [request] = parseCodexSessions(sessionsDir)[0].requests;
        out = [request.promptTokens, request.completionTokens];
      });
      return out;
    };
    // No cumulative snapshot at all: the response's own record still counts.
    expect(parse([own])).toEqual([13_580, 34]);
    // A snapshot copied from the source (its own last call), then the fork's response and its snapshot: counted once.
    expect(parse([total('2025-06-15T09:00:05Z', [145_729, 723], [13_580, 34]), own, total('2025-06-15T09:00:10Z', [159_309, 757], [13_580, 34])]))
      .toEqual([13_580, 34]);
    // The source's response records, copied with the history, aren't the fork's.
    expect(parse([{ ...own, payload: { ...own.payload, thread_id: 'src', response_id: 'r-src' } }, own, own])).toEqual([13_580, 34]);
  });
});
