/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Truncated model calls for Claude Code (`stop_reason: max_tokens`, counted once per response id) and
 * OpenCode (`finish: length`, every call of a request). A call that logs no stop reason stays out of the
 * truncation rate. Fixtures mirror real shapes with content redacted. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSessions } from './parser-claude';
import { parseOpenCodeSessions } from './parser-opencode';
import { rowTruncation } from './token-types-rows';

function withClaudeFile(lines: object[], run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-truncation-test-'));
  const projectsDir = path.join(root, 'projects');
  const projDir = path.join(projectsDir, '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'sess-1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function claudeUser(text: string, ts: string): object {
  return { type: 'user', timestamp: ts, sessionId: 'sess-1', cwd: '/Users/me/proj', message: { role: 'user', content: [{ type: 'text', text }] } };
}

const USAGE = { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 64_000 };

/** One content-block line; Claude Code repeats `usage` on every line and logs the stop reason on some of them. */
function claudeBlock(id: string, ts: string, stopReason: string | null, extra: Record<string, unknown> = {}): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    ...extra,
    message: { id, role: 'assistant', model: 'claude-opus-4-6-20251001', content: [{ type: 'text', text: 'secret answer' }], stop_reason: stopReason, usage: USAGE },
  };
}

describe('Claude Code truncated calls', () => {
  it('counts a response once when any of its lines stopped at max_tokens', () => {
    withClaudeFile([
      claudeUser('write a long file', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_1', '2026-10-28T10:00:02Z', null),
      claudeBlock('msg_1', '2026-10-28T10:00:03Z', 'max_tokens'),
      claudeBlock('msg_1', '2026-10-28T10:00:03Z', 'max_tokens'),
      claudeBlock('msg_2', '2026-10-28T10:00:05Z', 'max_tokens'),
      claudeBlock('msg_3', '2026-10-28T10:00:07Z', 'end_turn'),
      claudeBlock('msg_s', '2026-10-28T10:00:08Z', 'max_tokens', { isSidechain: true }),
    ], (projectsDir) => {
      const rows = parseClaudeSessions(projectsDir)[0].sessions[0].requests[0].promptCache?.rows ?? [];
      expect(rows.map(row => [row.stream, row.calls, row.truncatedCalls])).toEqual([['main', 3, 2], ['subagent', 1, 1]]);
      // Claude Code logs no per-call reasoning, content-filter stops or latency.
      for (const key of ['outputTokens', 'reasoningTokens', 'filteredCalls', 'ttftMs', 'durationMs']) expect(rows[0]).not.toHaveProperty(key);
    });
  });

  it('counts a response toward the truncation rate only once one of its lines logs a stop reason', () => {
    withClaudeFile([
      claudeUser('write a long file', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_1', '2026-10-28T10:00:02Z', null),
      claudeBlock('msg_1', '2026-10-28T10:00:03Z', 'end_turn'),
      claudeBlock('msg_2', '2026-10-28T10:00:04Z', null),
      claudeBlock('msg_2', '2026-10-28T10:00:05Z', null),
      claudeBlock('msg_3', '2026-10-28T10:00:06Z', 'max_tokens'),
    ], (projectsDir) => {
      const rows = parseClaudeSessions(projectsDir)[0].sessions[0].requests[0].promptCache?.rows ?? [];
      expect(rows[0]).toMatchObject({ calls: 3, truncatedCalls: 1, stopCalls: 2 });
      expect(rowTruncation(rows)).toEqual({ calls: 2, truncatedCalls: 1, filteredCalls: null });
    });
  });
});

function withOpenCodeStorage(messages: object[], run: (storageDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-truncation-test-'));
  const storageDir = path.join(root, 'storage');
  fs.mkdirSync(path.join(storageDir, 'session', 'global'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'session', 'global', 'sess-oc.json'), JSON.stringify({ id: 'sess-oc', directory: '/Users/me/proj', time: { created: 1700000000000 } }), 'utf-8');
  fs.mkdirSync(path.join(storageDir, 'message', 'sess-oc'), { recursive: true });
  for (const message of messages) {
    fs.writeFileSync(path.join(storageDir, 'message', 'sess-oc', `${(message as { id: string }).id}.json`), JSON.stringify(message), 'utf-8');
  }
  try { run(storageDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('OpenCode truncated calls', () => {
  const assistant = (id: string, created: number, finish?: string): object => ({
    id, sessionID: 'sess-oc', role: 'assistant', parentID: 'u1', modelID: 'big-pickle', ...(finish ? { finish } : {}),
    time: { created }, tokens: { input: 1_000, output: 4_000, reasoning: 900, cache: { read: 5_000, write: 0 } },
  });
  const user = { id: 'u1', sessionID: 'sess-oc', role: 'user', time: { created: 1700000000000 }, summary: { title: 'task' } };

  it('counts every call of a request that finished at the length limit', () => {
    withOpenCodeStorage([
      user,
      assistant('a1', 1700000001000, 'tool-calls'),
      assistant('a2', 1700000002000, 'length'),
      assistant('a3', 1700000003000, 'stop'),
    ], (storageDir) => {
      const [row] = parseOpenCodeSessions(storageDir)[0].requests[0].promptCache?.rows ?? [];
      expect(row).toMatchObject({ calls: 3, truncatedCalls: 1 });
      expect(row).not.toHaveProperty('stopCalls');
      // OpenCode's reasoning count depends on the provider, so it isn't stored for comparison.
      expect(row).not.toHaveProperty('reasoningTokens');
    });
  });

  it('leaves a call without a finish reason out of the truncation rate', () => {
    withOpenCodeStorage([user, assistant('a1', 1700000001000, 'length'), assistant('a2', 1700000002000)], (storageDir) => {
      const rows = parseOpenCodeSessions(storageDir)[0].requests[0].promptCache?.rows ?? [];
      expect(rows[0]).toMatchObject({ calls: 2, truncatedCalls: 1, stopCalls: 1 });
      expect(rowTruncation(rows)).toEqual({ calls: 1, truncatedCalls: 1, filteredCalls: null });
    });
  });
});
