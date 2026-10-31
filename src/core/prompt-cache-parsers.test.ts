/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Per-request prompt-cache usage for Claude Code and OpenCode. Claude Code writes one line per content
 * block and repeats the response's usage on each, so usage counts once per response id. OpenCode writes
 * one assistant message per model call. Fixtures mirror those shapes with content redacted. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSessions } from './parser-claude';
import { parseOpenCodeSessions } from './parser-opencode';

function withClaudeFile(lines: object[], run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cache-test-'));
  const projectsDir = path.join(root, 'projects');
  const projDir = path.join(projectsDir, '-Users-me-proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'sess-1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function claudeUser(text: string, ts: string): object {
  return { type: 'user', timestamp: ts, sessionId: 'sess-1', cwd: '/Users/me/proj', message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** One content-block line of an API response; Claude Code repeats `usage` on every line of a response. */
function claudeBlock(id: string, ts: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): object {
  return {
    type: 'assistant',
    timestamp: ts,
    sessionId: 'sess-1',
    ...extra,
    message: { id, role: 'assistant', model: 'claude-opus-4-6-20251001', content: [{ type: 'text', text: 'secret answer' }], usage },
  };
}

describe('Claude Code prompt-cache usage', () => {
  const FIRST = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 };
  const SECOND = { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 80 };

  it('counts each API response once although its usage repeats on every content-block line', () => {
    withClaudeFile([
      claudeUser('fix the bug', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_1', '2026-10-28T10:00:02Z', FIRST),
      claudeBlock('msg_1', '2026-10-28T10:00:02Z', FIRST),
      claudeBlock('msg_1', '2026-10-28T10:00:03Z', FIRST),
      claudeBlock('msg_2', '2026-10-28T10:00:05Z', SECOND),
      claudeBlock('msg_2', '2026-10-28T10:00:06Z', SECOND),
      claudeUser('next', '2026-10-28T10:05:00Z'),
      claudeBlock('msg_3', '2026-10-28T10:05:02Z', { input_tokens: 3, cache_read_input_tokens: 42_000, cache_creation_input_tokens: 1_000, output_tokens: 10 }),
    ], (projectsDir) => {
      const [session] = parseClaudeSessions(projectsDir)[0].sessions;
      const [first, second] = session.requests;
      expect(first.promptCache).toEqual({
        rows: [{ stream: 'main', model: 'claude-opus-4.6', calls: 2, input: 82_015, cacheRead: 40_000, cacheWrite: 42_000 }],
        coldStart: 40_010,
      });
      expect(second.promptCache).toEqual({
        rows: [{ stream: 'main', model: 'claude-opus-4.6', calls: 1, input: 43_003, cacheRead: 42_000, cacheWrite: 1_000 }],
      });
      // Existing per-request token fields keep their current behavior.
      expect(first.promptTokens).toBe(3 * 40_010 + 2 * 42_005);
    });
  });

  it('puts sidechain (sub-agent) responses on the sub-agent stream without a cold start', () => {
    withClaudeFile([
      claudeUser('explore', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_s', '2026-10-28T10:00:02Z', FIRST, { isSidechain: true }),
      claudeBlock('msg_m', '2026-10-28T10:00:04Z', SECOND),
    ], (projectsDir) => {
      const cache = parseClaudeSessions(projectsDir)[0].sessions[0].requests[0].promptCache;
      expect(cache?.rows.map(row => [row.stream, row.calls])).toEqual([['main', 1], ['subagent', 1]]);
      expect(cache?.coldStart).toBe(2_005);
    });
  });

  it('skips responses without usable usage', () => {
    withClaudeFile([
      claudeUser('hi', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_x', '2026-10-28T10:00:02Z', { input_tokens: 0, output_tokens: 0 }),
    ], (projectsDir) => {
      expect(parseClaudeSessions(projectsDir)[0].sessions[0].requests[0]).not.toHaveProperty('promptCache');
    });
  });
});

describe('Claude Code cache token fields', () => {
  it('keeps reported zero cache tokens as 0, and null when no usage was reported', () => {
    withClaudeFile([
      claudeUser('prompt caching is off', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_off', '2026-10-28T10:00:02Z', { input_tokens: 40_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 }),
      claudeUser('no reply yet', '2026-10-28T10:05:00Z'),
    ], (projectsDir) => {
      const [off, unanswered] = parseClaudeSessions(projectsDir)[0].sessions[0].requests;
      expect(off).toMatchObject({ promptTokens: 40_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
      expect(unanswered).toMatchObject({ promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    });
  });

  it('keeps cache fields null and records no cache usage when a response reports no cache tokens', () => {
    withClaudeFile([
      claudeUser('no usage block', '2026-10-28T10:00:00Z'),
      { type: 'assistant', timestamp: '2026-10-28T10:00:02Z', sessionId: 'sess-1', message: { id: 'msg_bare', role: 'assistant', model: 'claude-opus-4-6-20251001', content: [{ type: 'text', text: 'secret answer' }] } },
      claudeUser('usage without cache fields', '2026-10-28T10:05:00Z'),
      claudeBlock('msg_old', '2026-10-28T10:05:02Z', { input_tokens: 30_000, output_tokens: 40 }),
    ], (projectsDir) => {
      const [bare, old] = parseClaudeSessions(projectsDir)[0].sessions[0].requests;
      expect(bare).toMatchObject({ cacheReadTokens: null, cacheWriteTokens: null });
      expect(old).toMatchObject({ promptTokens: 30_000, cacheReadTokens: null, cacheWriteTokens: null });
      expect(bare).not.toHaveProperty('promptCache');
      expect(old).not.toHaveProperty('promptCache');
    });
  });

  it('counts a response once its usage arrives, even after a content block without usable usage', () => {
    withClaudeFile([
      claudeUser('fix the bug', '2026-10-28T10:00:00Z'),
      claudeBlock('msg_1', '2026-10-28T10:00:02Z', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
      claudeBlock('msg_1', '2026-10-28T10:00:03Z', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 }),
      claudeBlock('msg_1', '2026-10-28T10:00:04Z', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 }),
    ], (projectsDir) => {
      const cache = parseClaudeSessions(projectsDir)[0].sessions[0].requests[0].promptCache;
      expect(cache?.rows).toEqual([expect.objectContaining({ stream: 'main', calls: 1, input: 40_010, cacheRead: 0, cacheWrite: 40_000 })]);
    });
  });
});

function withOpenCodeStorage(messages: object[], run: (storageDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cache-test-'));
  const storageDir = path.join(root, 'storage');
  fs.mkdirSync(path.join(storageDir, 'session', 'global'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'session', 'global', 'sess-oc.json'), JSON.stringify({ id: 'sess-oc', directory: '/Users/me/proj', time: { created: 1700000000000 } }), 'utf-8');
  fs.mkdirSync(path.join(storageDir, 'message', 'sess-oc'), { recursive: true });
  for (const message of messages) {
    fs.writeFileSync(path.join(storageDir, 'message', 'sess-oc', `${(message as { id: string }).id}.json`), JSON.stringify(message), 'utf-8');
  }
  try { run(storageDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('OpenCode prompt-cache usage', () => {
  it('sums every model call of a request, not only the first assistant message', () => {
    withOpenCodeStorage([
      { id: 'u1', sessionID: 'sess-oc', role: 'user', time: { created: 1700000000000 }, summary: { title: 'task' } },
      { id: 'a1', sessionID: 'sess-oc', role: 'assistant', parentID: 'u1', modelID: 'big-pickle', time: { created: 1700000001000 }, tokens: { input: 4_874, output: 20, cache: { read: 0, write: 0 } } },
      { id: 'a2', sessionID: 'sess-oc', role: 'assistant', parentID: 'u1', modelID: 'big-pickle', time: { created: 1700000002000 }, tokens: { input: 200, output: 20, cache: { read: 9_664, write: 0 } } },
    ], (storageDir) => {
      const request = parseOpenCodeSessions(storageDir)[0].requests[0];
      expect(request.promptCache).toEqual({
        rows: [{ stream: 'main', model: 'big-pickle', calls: 2, input: 14_738, cacheRead: 9_664, cacheWrite: 0 }],
        coldStart: 4_874,
      });
      // The existing request fields still describe the first assistant message only, which reported zero
      // cache tokens: 0, not null.
      expect(request.promptTokens).toBe(4_874);
      expect(request).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    });
  });

  it('keeps the cache fields null when no token usage was reported', () => {
    withOpenCodeStorage([
      { id: 'u1', sessionID: 'sess-oc', role: 'user', time: { created: 1700000000000 }, summary: { title: 'task' } },
      { id: 'a1', sessionID: 'sess-oc', role: 'assistant', parentID: 'u1', modelID: 'big-pickle', time: { created: 1700000001000 } },
    ], (storageDir) => {
      const request = parseOpenCodeSessions(storageDir)[0].requests[0];
      expect(request).toMatchObject({ promptTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
      expect(request).not.toHaveProperty('promptCache');
    });
  });

  it('keeps the cache fields null when token usage carries no cache entry', () => {
    withOpenCodeStorage([
      { id: 'u1', sessionID: 'sess-oc', role: 'user', time: { created: 1700000000000 }, summary: { title: 'task' } },
      { id: 'a1', sessionID: 'sess-oc', role: 'assistant', parentID: 'u1', modelID: 'big-pickle', time: { created: 1700000001000 }, tokens: { input: 5_000, output: 20 } },
    ], (storageDir) => {
      const request = parseOpenCodeSessions(storageDir)[0].requests[0];
      expect(request).toMatchObject({ promptTokens: 5_000, cacheReadTokens: null, cacheWriteTokens: null });
      expect(request).not.toHaveProperty('promptCache');
    });
  });
});
