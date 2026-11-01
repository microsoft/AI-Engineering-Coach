/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Claude Code sub-agent transcripts (`<sessionId>/subagents/agent-*.jsonl`) count as sub-agent cache usage whichever
 * of their lines carry `isSidechain`, since not every build marks them all. Fixtures mirror the real directory layout
 * and line shapes, content replaced. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isClaudeSubagentFile, parseClaudeSessions } from './parser-claude';
import { PromptCacheAnalyzer } from './analyzer-prompt-cache';
import { loadSourceSession } from './session-images';
import type { SessionSource } from './cache';
import type { Session, SessionRequest } from './types';

const SESSION = '5c1f0e9a-parent';
const AGENT = 'a1b2c3d4';

interface Usage { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }

const PARENT: Usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000, output_tokens: 50 };
// The reviewer's case: a sub-agent response with 100 input tokens and 5,000 cache-write tokens.
const SUB_FIRST: Usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000, output_tokens: 30 };
const SUB_NEXT: Usage = { input_tokens: 2, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000, output_tokens: 64 };
const promptOf = (u: Usage): number => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
const SUB_INPUT = promptOf(SUB_FIRST) + promptOf(SUB_NEXT);

type LineKind = 'prompt' | 'reply' | 'repeated reply';

/** Which lines of the sub-agent's transcript carry `isSidechain` and `agentId`. */
const MARKINGS: Record<string, (kind: LineKind) => boolean> = {
  'every line': () => true,
  'no line': () => false,
  'only the replies': kind => kind !== 'prompt',
  'only the prompt': kind => kind === 'prompt',
  'every line but a repeated reply': kind => kind !== 'repeated reply',
};
const MARKING_NAMES = Object.keys(MARKINGS);

const LINE = { userType: 'external', cwd: '/Users/me/proj', sessionId: SESSION, version: '2.0.14', gitBranch: 'main' };

function marks(marked: boolean): Record<string, unknown> {
  return marked ? { isSidechain: true, agentId: AGENT } : {};
}

function prompt(uuid: string, ts: string, text: string, marked = false): object {
  return { parentUuid: null, ...LINE, ...marks(marked), type: 'user', message: { role: 'user', content: text }, uuid, timestamp: ts };
}

/** One content-block line of a response: Claude Code repeats the response's usage on each line. */
function reply(id: string, ts: string, usage: Usage, { stopReason = null, marked = false }: { stopReason?: string | null; marked?: boolean } = {}): object {
  return {
    parentUuid: `parent-${ts}`, ...LINE, ...marks(marked), type: 'assistant', requestId: `req-${id}`, uuid: `uuid-${ts}`, timestamp: ts,
    message: {
      model: 'claude-sonnet-4-5-20250929', id, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'secret answer' }],
      stop_reason: stopReason, stop_sequence: null, usage,
    },
  };
}

/** The sub-agent's transcript, marked as `marking` says, and its parent's unless `orphan`. */
function transcripts(marking: string, orphan = false): Record<string, object[]> {
  const marked = MARKINGS[marking];
  const files: Record<string, object[]> = {
    [`${SESSION}/subagents/agent-${AGENT}.jsonl`]: [
      prompt('sub-prompt', '2026-10-28T10:00:02Z', 'Explore the parser and report back', marked('prompt')),
      reply('msg_s1', '2026-10-28T10:00:03Z', SUB_FIRST, { stopReason: 'tool_use', marked: marked('reply') }),
      reply('msg_s2', '2026-10-28T10:00:04Z', SUB_NEXT, { marked: marked('reply') }),
      reply('msg_s2', '2026-10-28T10:00:05Z', SUB_NEXT, { stopReason: 'end_turn', marked: marked('repeated reply') }),
    ],
  };
  if (!orphan) {
    files[`${SESSION}.jsonl`] = [
      prompt('parent-prompt', '2026-10-28T10:00:00Z', 'Why does the parser drop sub-agent usage?'),
      reply('msg_p', '2026-10-28T10:00:01Z', PARENT, { stopReason: 'end_turn' }),
    ];
  }
  return files;
}

function withProject(files: Record<string, object[]>, run: (projectsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-marking-'));
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

function parse(projectsDir: string, sources?: Map<string, SessionSource>): Session[] {
  return parseClaudeSessions(projectsDir, undefined, sources).flatMap(result => result.sessions);
}

/** The parent's request and the sub-agent's, merged into the parent session in time order. */
function requestsOf(marking: string, run: (parent: SessionRequest, sub: SessionRequest) => void): void {
  withProject(transcripts(marking), projectsDir => {
    const [session] = parse(projectsDir);
    expect(session.requests).toHaveLength(2);
    const [parent, sub] = session.requests;
    run(parent, sub);
  });
}

describe('isClaudeSubagentFile', () => {
  it('recognizes a transcript in a session\u2019s subagents folder only', () => {
    expect(isClaudeSubagentFile(path.join('projects', '-Users-me-proj', SESSION, 'subagents', `agent-${AGENT}.jsonl`))).toBe(true);
    expect(isClaudeSubagentFile(path.join('projects', '-Users-me-proj', `${SESSION}.jsonl`))).toBe(false);
  });
});

describe('Claude Code sub-agent transcripts\u2019 prompt-cache rows', () => {
  it.each(MARKING_NAMES)('are on the sub-agent stream, with no cold start of their own (%s marked)', marking => {
    requestsOf(marking, (parent, sub) => {
      expect(parent.promptCache).toMatchObject({ rows: [{ stream: 'main', calls: 1, input: promptOf(PARENT) }], coldStart: promptOf(PARENT) });
      expect(sub.promptCache?.rows.map(row => [row.stream, row.calls, row.input, row.cacheRead, row.cacheWrite])).toEqual([['subagent', 2, SUB_INPUT, 5_000, 6_000]]);
      expect(sub.promptCache).not.toHaveProperty('coldStart');
    });
  });

  it.each(MARKING_NAMES)('count in the sub-agents\u2019 totals on the Prompt Cache tab, never the main agent\u2019s (%s marked)', marking => {
    withProject(transcripts(marking), projectsDir => {
      const claude = new PromptCacheAnalyzer(parse(projectsDir), new Map()).getPromptCache({}).harnesses.find(h => h.harness === 'Claude');
      expect(claude?.main).toMatchObject({ calls: 1, input: promptOf(PARENT), cacheRead: 0, cacheWrite: 40_000 });
      expect(claude?.subagents).toMatchObject({ calls: 2, input: SUB_INPUT, cacheRead: 5_000, cacheWrite: 6_000 });
    });
  });
});

describe('Claude Code sub-agent transcripts without a parent transcript', () => {
  it.each(MARKING_NAMES)('are sub-agent cache usage too (%s marked)', marking => {
    withProject(transcripts(marking, true), projectsDir => {
      const [orphan] = parse(projectsDir);
      expect(orphan).toMatchObject({ sessionId: SESSION, launcherKind: 'programmatic' });
      expect(orphan.requests[0].promptCache?.rows.map(row => [row.stream, row.calls, row.input])).toEqual([['subagent', 2, SUB_INPUT]]);
      expect(orphan.requests[0].promptCache).not.toHaveProperty('coldStart');
    });
  });
});

describe('Claude Code sub-agent transcripts reloaded for the session detail', () => {
  const figures = (request: SessionRequest) => ({ id: request.requestId, cache: request.promptCache });

  it.each(MARKING_NAMES)('keep the prompt-cache figures of the dashboard parse (%s marked)', marking => {
    for (const orphan of [false, true]) {
      withProject(transcripts(marking, orphan), projectsDir => {
        const sources = new Map<string, SessionSource>();
        const [session] = parse(projectsDir, sources);
        const source = sources.get(SESSION);
        if (!source) throw new Error('no source');
        const reloaded = loadSourceSession(source, SESSION);
        expect(reloaded?.requests.map(figures)).toEqual(session.requests.map(figures));
        expect(reloaded?.requests.at(-1)?.promptCache?.rows.map(row => row.stream)).toEqual(['subagent']);
      });
    }
  });
});
