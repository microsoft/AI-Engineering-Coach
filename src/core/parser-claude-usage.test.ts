/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude Code token totals and per-turn context. Claude Code writes one transcript line per content block
 * (thinking, text, each tool use) and repeats the response's `usage` on every line
 * (https://github.com/anthropics/claude-code/issues/87303), so each response counts once. A turn's context is the
 * prompt of its last model call on its own chain. Fixtures mirror real transcript shapes with content replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSessions } from './parser-claude';
import { Analyzer } from './analyzer';
import { requestContextTokens } from './context-window';
import type { SessionRequest } from './types';

const SESSION = 'sess-usage';

interface Usage { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens: number }
interface BlockOptions { kind?: 'thinking' | 'text' | 'tool_use'; extra?: Record<string, unknown> }

function withProject(files: Record<string, object[]>, run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-test-'));
  const projDir = path.join(root, 'projects', '-Users-me-proj');
  try {
    for (const [name, lines] of Object.entries(files)) {
      const file = path.join(projDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
    }
    run(path.join(root, 'projects'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function requestsOf(projectsDir: string): SessionRequest[] {
  return parseClaudeSessions(projectsDir)[0].sessions[0].requests;
}

function user(text: string, ts: string, extra: Record<string, unknown> = {}): object {
  return { type: 'user', timestamp: ts, sessionId: SESSION, cwd: '/Users/me/proj', ...extra, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** One content-block line of a response; `id` undefined omits `message.id`. */
function block(id: string | undefined, ts: string, usage: Usage, { kind = 'text', extra = {} }: BlockOptions = {}): object {
  const content = kind === 'tool_use' ? [{ type: 'tool_use', id: `tool-${ts}`, name: 'Read', input: { file_path: '/secret/file.ts' } }]
    : [{ type: kind, text: 'secret' }];
  return {
    type: 'assistant', timestamp: ts, sessionId: SESSION, ...extra,
    message: { ...(id ? { id } : {}), role: 'assistant', model: 'claude-sonnet-4-6', content, usage },
  };
}

const A: Usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 };
const B: Usage = { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 80 };
const C: Usage = { input_tokens: 2, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 3_000, output_tokens: 20 };
const SIDECHAIN: BlockOptions = { extra: { isSidechain: true } };
const promptOf = (u: Usage): number => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

describe('Claude Code request token fields', () => {
  it('count each API response once, although its usage repeats on every content-block line', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('fix the bug', '2026-10-28T10:00:00Z'),
        block('msg_a', '2026-10-28T10:00:01Z', A, { kind: 'thinking' }),
        block('msg_a', '2026-10-28T10:00:02Z', A),
        block('msg_a', '2026-10-28T10:00:03Z', A, { kind: 'tool_use' }),
        block('msg_b', '2026-10-28T10:00:05Z', B),
        block('msg_b', '2026-10-28T10:00:06Z', B, { kind: 'tool_use' }),
      ],
    }, projectsDir => {
      expect(requestsOf(projectsDir)[0]).toMatchObject({
        promptTokens: promptOf(A) + promptOf(B),
        completionTokens: 50 + 80,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 42_000,
      });
    });
  });

  it('keep the largest value of each field when the lines of one response differ', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('stream', '2026-10-28T10:00:00Z'),
        block('msg_a', '2026-10-28T10:00:01Z', { input_tokens: 0, output_tokens: 0 }, { kind: 'thinking' }),
        block('msg_a', '2026-10-28T10:00:02Z', { ...A, output_tokens: 12 }),
        block('msg_a', '2026-10-28T10:00:03Z', A, { kind: 'tool_use' }),
      ],
    }, projectsDir => {
      expect(requestsOf(projectsDir)[0]).toMatchObject({ promptTokens: promptOf(A), completionTokens: 50, cacheWriteTokens: 40_000 });
    });
  });

  it('count lines without a response id separately', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('old transcript', '2026-10-28T10:00:00Z'),
        block(undefined, '2026-10-28T10:00:01Z', A),
        block(undefined, '2026-10-28T10:00:02Z', A),
      ],
    }, projectsDir => {
      expect(requestsOf(projectsDir)[0]).toMatchObject({ promptTokens: 2 * promptOf(A), completionTokens: 100 });
    });
  });
});

describe('Claude Code request token fields and prompt-cache rows', () => {
  it('agree for the same request, sub-agent calls included', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('explore then fix', '2026-10-28T10:00:00Z'),
        block('msg_a', '2026-10-28T10:00:01Z', A),
        block('msg_a', '2026-10-28T10:00:02Z', A, { kind: 'tool_use' }),
        block('msg_s', '2026-10-28T10:00:03Z', C, SIDECHAIN),
        block('msg_s', '2026-10-28T10:00:04Z', C, { kind: 'tool_use', extra: { isSidechain: true } }),
        block('msg_b', '2026-10-28T10:00:05Z', B),
      ],
    }, projectsDir => {
      const [request] = requestsOf(projectsDir);
      const rows = request.promptCache?.rows ?? [];
      expect(rows.map(row => row.stream).sort()).toEqual(['main', 'subagent']);
      expect(request.promptTokens).toBe(rows.reduce((sum, row) => sum + row.input, 0));
      expect(request.cacheReadTokens).toBe(rows.reduce((sum, row) => sum + row.cacheRead, 0));
      expect(request.cacheWriteTokens).toBe(rows.reduce((sum, row) => sum + row.cacheWrite, 0));
    });
  });
});

describe('Claude Code turn context', () => {
  it('records the last and largest prompt of the main-agent calls, without a reported limit', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('long task', '2026-10-28T10:00:00Z'),
        block('msg_a', '2026-10-28T10:00:01Z', A),
        block('msg_b', '2026-10-28T10:00:02Z', B),
        block('msg_b', '2026-10-28T10:00:03Z', B, { kind: 'tool_use' }),
        block('msg_c', '2026-10-28T10:00:04Z', C),
      ],
    }, projectsDir => {
      const [request] = requestsOf(projectsDir);
      expect(request.contextUsage).toEqual({ lastPromptTokens: promptOf(C), peakPromptTokens: promptOf(B), contextLimit: null, calls: 3 });
      expect(requestContextTokens(request)).toBe(promptOf(C));
    });
  });

  it('leaves sub-agent calls out of the main context but counts their tokens', () => {
    withProject({
      [`${SESSION}.jsonl`]: [
        user('delegate', '2026-10-28T10:00:00Z'),
        block('msg_s', '2026-10-28T10:00:01Z', B, SIDECHAIN),
        block('msg_m', '2026-10-28T10:00:02Z', A),
      ],
    }, projectsDir => {
      const [request] = requestsOf(projectsDir);
      expect(request.promptTokens).toBe(promptOf(A) + promptOf(B));
      expect(request.contextUsage).toMatchObject({ lastPromptTokens: promptOf(A), peakPromptTokens: promptOf(A), calls: 1 });
    });
  });
});

describe('Claude Code sub-agent and Context Management context', () => {
  it('measures a sub-agent transcript against its own calls', () => {
    const sidechain = { isSidechain: true, agentId: 'agent-1' };
    withProject({
      [`${SESSION}.jsonl`]: [
        user('parent prompt', '2026-10-28T10:00:00Z'),
        block('msg_p', '2026-10-28T10:00:01Z', A),
      ],
      [`${SESSION}/subagents/agent-1.jsonl`]: [
        user('sub-agent task', '2026-10-28T10:00:10Z', sidechain),
        block('msg_s1', '2026-10-28T10:00:11Z', C, { extra: sidechain }),
        block('msg_s2', '2026-10-28T10:00:12Z', B, { extra: sidechain }),
      ],
    }, projectsDir => {
      const [parent, sub] = requestsOf(projectsDir);
      expect(parent.contextUsage).toMatchObject({ lastPromptTokens: promptOf(A), calls: 1 });
      expect(sub.contextUsage).toMatchObject({ lastPromptTokens: promptOf(B), peakPromptTokens: promptOf(B), calls: 2 });
      expect(sub.promptTokens).toBe(promptOf(B) + promptOf(C));
    });
  });

  it('feeds Context Management the last call of each turn, not the turn total', () => {
    const lines: object[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const minute = String(turn).padStart(2, '0');
      lines.push(user(`step ${turn}`, `2026-10-28T10:${minute}:00Z`));
      for (let call = 0; call < 3; call++) {
        const usage = { input_tokens: 10, cache_read_input_tokens: 30_000 + turn * 1_000, cache_creation_input_tokens: 500, output_tokens: 40 };
        const ts = `2026-10-28T10:${minute}:${String(call + 1).padStart(2, '0')}Z`;
        lines.push(block(`msg_${turn}_${call}`, ts, usage), block(`msg_${turn}_${call}`, ts, usage, { kind: 'tool_use' }));
      }
    }
    withProject({ [`${SESSION}.jsonl`]: lines }, projectsDir => {
      const sessions = parseClaudeSessions(projectsDir)[0].sessions;
      const [workspace] = new Analyzer(sessions).getContextManagement().workspaces;
      expect(workspace.maxPromptTokens).toBe(10 + 35_000 + 500);
      expect(sessions[0].requests[5].promptTokens).toBe(3 * (10 + 35_000 + 500));
    });
  });
});
