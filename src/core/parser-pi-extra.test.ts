/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Extra edge-case coverage for the Pi Coding Agent parser. Templated on the
 * Codex (OpenAI terminal agent) extra-coverage suite — empty/invalid input,
 * header fallbacks, tree-entry handling, tool/skill extraction, model
 * switching, multi-round token accumulation, and multi-file scanning. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parsePiSessions } from './parser-pi';
import { MAX_FILE_SIZE } from './parser-shared';

type PiFixture = {
  /** Encoded project dir + filename, e.g. `--Users-me-proj--/sess.jsonl`. */
  relativePath: string;
  content: string | object[];
};

function encodeCwd(cwd: string): string {
  return '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--';
}

function stringifyLines(lines: object[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n');
}

function withPiRoot(run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parser-extra-'));
  const sessionsDir = path.join(root, '.pi', 'agent', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    run(sessionsDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writePiFixture(sessionsDir: string, relativePath: string, content: string | object[]): void {
  const filePath = path.join(sessionsDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === 'string' ? content : stringifyLines(content), 'utf-8');
}

function withPiFiles(files: PiFixture[], run: (sessionsDir: string) => void): void {
  withPiRoot((sessionsDir) => {
    for (const file of files) writePiFixture(sessionsDir, file.relativePath, file.content);
    run(sessionsDir);
  });
}

/** Convenience: one session file under `/Users/me/proj`. */
function withPiFile(lines: (string | object)[], run: (sessionsDir: string) => void): void {
  const content = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  withPiRoot((sessionsDir) => {
    writePiFixture(sessionsDir, `${encodeCwd('/Users/me/proj')}/sess_uuid.jsonl`, content);
    run(sessionsDir);
  });
}

const HEADER = {
  type: 'session', version: 3, id: 'sess-uuid-1234-5678',
  timestamp: '2026-06-02T07:20:57.002Z', cwd: '/Users/me/proj',
};

/** Parse a single expected session from a set of lines. */
function parseSingleSession(lines: (string | object)[]) {
  let session: ReturnType<typeof parsePiSessions>[number] | undefined;
  withPiFile(lines, (sessionsDir) => {
    const sessions = parsePiSessions(sessionsDir);
    expect(sessions).toHaveLength(1);
    session = sessions[0];
  });
  return session!;
}

describe('parsePiSessions extra coverage', () => {
  describe('empty and invalid input', () => {
    it('returns no sessions for an empty file', () => {
      withPiFile([''], (sessionsDir) => {
        expect(parsePiSessions(sessionsDir)).toEqual([]);
      });
    });

    it('returns no sessions for a header-only file with no message entries', () => {
      withPiFile([HEADER], (sessionsDir) => {
        expect(parsePiSessions(sessionsDir)).toEqual([]);
      });
    });

    it('returns no sessions for invalid JSON lines only', () => {
      withPiFile(['{not valid json}', 'still not json'], (sessionsDir) => {
        expect(parsePiSessions(sessionsDir)).toEqual([]);
      });
    });

    it('ignores invalid JSON lines when valid entries exist', () => {
      withPiFile([
        JSON.stringify(HEADER),
        '{broken',
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hello' } },
        'not json either',
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'world' }], usage: { input: 1, output: 1 } } },
      ], (sessionsDir) => {
        const sessions = parsePiSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].requests[0].messageText).toBe('hello');
        expect(sessions[0].requests[0].responseText).toBe('world');
      });
    });
  });

  describe('header handling', () => {
    it('falls back to the file name for sessionId when the header has no id', () => {
      const headerNoId = { type: 'session', version: 3, timestamp: '2026-06-02T07:20:57.002Z', cwd: '/Users/me/proj' };
      const session = parseSingleSession([
        headerNoId,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'yo' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.sessionId).toBe('sess_uuid');
    });

    it('treats the first line as an entry when it is not a session header', () => {
      // No header line at all: the file starts directly with message entries.
      const session = parseSingleSession([
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'no header here' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('no header here');
      // cwd is recovered from the encoded directory name.
      expect(session.workspaceRootPath).toBe('/Users/me/proj');
    });

    it('uses the header timestamp as the session creation date', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T08:00:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T08:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'yo' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.creationDate).toBe(new Date('2026-06-02T07:20:57.002Z').getTime());
    });
  });

  describe('message content shapes', () => {
    it('accepts a plain string as user content', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'plain string prompt' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests[0].messageText).toBe('plain string prompt');
    });

    it('joins multiple assistant text blocks with newlines and excludes thinking', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: {
            role: 'assistant', model: 'm', usage: { input: 1, output: 1 },
            content: [
              { type: 'thinking', thinking: 'internal reasoning' },
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        },
      ]);
      expect(session.requests[0].responseText).toBe('line one\nline two');
      expect(session.requests[0].responseText).not.toContain('internal reasoning');
    });

    it('ignores message entries without a recognizable role', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'x1', parentId: 'u1', timestamp: '2026-06-02T07:21:00.500Z', message: { content: 'no role here' } },
        { type: 'message', id: 'a1', parentId: 'x1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].responseText).toBe('ok');
    });
  });

  describe('tool call handling', () => {
    it('marks write-tool targets as edited and surfaces written content as a code block', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'write it' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: {
            role: 'assistant', model: 'm', usage: { input: 1, output: 1 },
            content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: { path: 'src/new.ts', content: 'export const x = 1;' } }],
          },
        },
      ]);
      expect(session.requests[0].toolsUsed).toEqual(['write']);
      expect(session.requests[0].editedFiles).toEqual(['src/new.ts']);
      expect(session.requests[0].aiCode.length).toBeGreaterThan(0);
      expect(session.requests[0].aiCode[0].language).toBe('typescript');
    });

    it('records a write tool with no path without crashing and edits nothing', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'go' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: { role: 'assistant', model: 'm', usage: { input: 1, output: 1 }, content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: {} }] },
        },
      ]);
      expect(session.requests[0].toolsUsed).toEqual(['write']);
      expect(session.requests[0].editedFiles).toEqual([]);
    });

    it('records read tools as referenced files, not edits', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'read it' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: { role: 'assistant', model: 'm', usage: { input: 1, output: 1 }, content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/app.ts' } }] },
        },
      ]);
      expect(session.requests[0].referencedFiles).toEqual(['src/app.ts']);
      expect(session.requests[0].editedFiles).toEqual([]);
    });

    it('deduplicates the same edited file referenced multiple times in a turn', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'edit twice' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: {
            role: 'assistant', model: 'm', usage: { input: 1, output: 1 },
            content: [
              { type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'src/app.ts', new_string: 'a' } },
              { type: 'toolCall', id: 't2', name: 'edit', arguments: { path: 'src/app.ts', new_string: 'b' } },
            ],
          },
        },
      ]);
      expect(session.requests[0].editedFiles).toEqual(['src/app.ts']);
    });
  });

  describe('skill extraction', () => {
    it('extracts a skill from a bashExecution command that references SKILL.md', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'use a skill' } },
        { type: 'message', id: 'b1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'bashExecution', command: 'cat /Users/me/.pi/skills/pdf-tools/SKILL.md', output: '...', exitCode: 0 } },
        { type: 'message', id: 'a1', parentId: 'b1', timestamp: '2026-06-02T07:21:02.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests[0].skillsUsed).toContain('pdf-tools');
      expect(session.requests[0].toolsUsed).toContain('bash');
    });

    it('extracts a skill from a bash toolCall command argument', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'use a skill' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: { role: 'assistant', model: 'm', usage: { input: 1, output: 1 }, content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'cat /Users/me/.pi/skills/data-viz/SKILL.md' } }] },
        },
      ]);
      expect(session.requests[0].skillsUsed).toContain('data-viz');
    });
  });

  describe('model switching and cancellation', () => {
    it('propagates a model_change entry to later turns', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'one' }], usage: { input: 1, output: 1 } } },
        { type: 'model_change', id: 'mc', parentId: 'a1', timestamp: '2026-06-02T07:21:02.000Z', provider: 'openai', modelId: 'gpt-5.5' },
        { type: 'message', id: 'u2', parentId: 'mc', timestamp: '2026-06-02T07:21:03.000Z', message: { role: 'user', content: 'second' } },
        // Assistant message omits `model` — should inherit the changed default.
        { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-06-02T07:21:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0].modelId).toBe('claude-opus-4-8');
      expect(session.requests[1].modelId).toBe('gpt-5.5');
    });

    it('marks a turn canceled when the assistant stopReason is aborted', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'go' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }], usage: { input: 1, output: 1 } } },
      ]);
      expect(session.requests[0].isCanceled).toBe(true);
    });
  });

  describe('token accumulation', () => {
    it('sums usage across multiple assistant rounds within a single turn', () => {
      // A user turn followed by two assistant messages (a tool round + a final
      // answer) — common in agentic loops. Token usage accumulates per turn.
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'do a task' } },
        {
          type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
          message: { role: 'assistant', model: 'm', stopReason: 'toolUse', usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5 }, content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }] },
        },
        { type: 'message', id: 't1r', parentId: 'a1', timestamp: '2026-06-02T07:21:02.000Z', message: { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false } },
        {
          type: 'message', id: 'a2', parentId: 't1r', timestamp: '2026-06-02T07:21:03.000Z',
          message: { role: 'assistant', model: 'm', stopReason: 'stop', usage: { input: 200, output: 20, cacheRead: 100, cacheWrite: 0 }, content: [{ type: 'text', text: 'all done' }] },
        },
      ]);
      expect(session.requests).toHaveLength(1);
      // promptTokens = (100+50+5) + (200+100+0) = 455
      expect(session.requests[0].promptTokens).toBe(455);
      expect(session.requests[0].completionTokens).toBe(30);
      expect(session.requests[0].cacheReadTokens).toBe(150);
      expect(session.requests[0].cacheWriteTokens).toBe(5);
    });

    it('leaves token fields null when no assistant usage is present', () => {
      const session = parseSingleSession([
        HEADER,
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'no usage' }] } },
      ]);
      expect(session.requests[0].promptTokens).toBeNull();
      expect(session.requests[0].completionTokens).toBeNull();
    });
  });

  describe('multiple session files', () => {
    it('parses sessions across multiple encoded project directories', () => {
      withPiFiles([
        {
          relativePath: `${encodeCwd('/Users/me/project-a')}/2026-06-02T07-00-00-000Z_aaa.jsonl`,
          content: [
            { type: 'session', version: 3, id: 'sess-a', timestamp: '2026-06-02T07:00:00.000Z', cwd: '/Users/me/project-a' },
            { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:00:01.000Z', message: { role: 'user', content: 'a' } },
            { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:00:02.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'one' }], usage: { input: 1, output: 1 } } },
          ],
        },
        {
          relativePath: `${encodeCwd('/Users/me/project-b')}/2026-06-02T08-00-00-000Z_bbb.jsonl`,
          content: [
            { type: 'session', version: 3, id: 'sess-b', timestamp: '2026-06-02T08:00:00.000Z', cwd: '/Users/me/project-b' },
            { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T08:00:01.000Z', message: { role: 'user', content: 'b' } },
            { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T08:00:02.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'two' }], usage: { input: 1, output: 1 } } },
          ],
        },
      ], (sessionsDir) => {
        const sessions = parsePiSessions(sessionsDir);
        expect(sessions).toHaveLength(2);
        expect(sessions.map(s => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
        expect(sessions.map(s => s.workspaceName).sort()).toEqual(['project-a', 'project-b']);
      });
    });

    it('ignores non-jsonl files while scanning project directories', () => {
      withPiFiles([
        {
          relativePath: `${encodeCwd('/Users/me/proj')}/2026-06-02T07-00-00-000Z_keep.jsonl`,
          content: [
            HEADER,
            { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'keep me' } },
            { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1 } } },
          ],
        },
        { relativePath: `${encodeCwd('/Users/me/proj')}/notes.txt`, content: 'just some notes, not a session' },
      ], (sessionsDir) => {
        const sessions = parsePiSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe('sess-uuid-1234-5678');
      });
    });
  });

  describe('oversized files', () => {
    it('skips a session file larger than the shared in-memory cap', () => {
      withPiRoot((sessionsDir) => {
        const filePath = path.join(sessionsDir, `${encodeCwd('/Users/me/proj')}/huge.jsonl`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const fd = fs.openSync(filePath, 'w');
        try {
          fs.writeSync(fd, JSON.stringify(HEADER) + '\n');
          const filler = JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'x'.repeat(1024) } }) + '\n';
          let written = 0;
          while (written <= MAX_FILE_SIZE) {
            fs.writeSync(fd, filler);
            written += filler.length;
          }
        } finally {
          fs.closeSync(fd);
        }
        // readFileSafe returns null for oversized files → no session produced.
        expect(parsePiSessions(sessionsDir)).toEqual([]);
      });
    });
  });
});
