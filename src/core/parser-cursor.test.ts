/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Cursor Agent JSONL parser — synthetic fixtures only. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { parseCursorSessions } from './parser-cursor';

/** os.tmpdir() on Windows often returns 8.3 short names (e.g. TAMASB~1)
 *  that don't match readdirSync output. Resolve to the long form so
 *  tests that encode and decode filesystem paths work reliably. */
function longTmpDir(): string {
  const tmp = os.tmpdir();
  if (process.platform !== 'win32' || !tmp.includes('~')) return tmp;
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-Item ${JSON.stringify(tmp)}).FullName"`,
      { encoding: 'utf-8' },
    ).trim();
  } catch {
    return tmp;
  }
}

function makeCursorUser(query: string, prefix = ''): object {
  const text = prefix
    ? `${prefix}\n<user_query>${query}</user_query>`
    : `<user_query>${query}</user_query>`;
  return {
    role: 'user',
    message: { content: [{ type: 'text', text }] },
  };
}

function makeCursorAssistant(content: object[]): object {
  return {
    role: 'assistant',
    message: { content },
  };
}

function makeTurnEnded(status: string, error?: string): object {
  return error !== undefined
    ? { type: 'turn_ended', status, error }
    : { type: 'turn_ended', status };
}

function writeCursorSession(
  projectsDir: string,
  encodedDir: string,
  sessionId: string,
  lines: object[],
): void {
  const sessionDir = path.join(projectsDir, encodedDir, 'agent-transcripts', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `${sessionId}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n'),
    'utf-8',
  );
}

function withCursorProjects(
  encodedDir: string,
  sessionId: string,
  lines: object[],
  run: (projectsDir: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-parser-test-'));
  const projectsDir = path.join(root, 'projects');
  writeCursorSession(projectsDir, encodedDir, sessionId, lines);
  try { run(projectsDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('parseCursorSessions', () => {
  it('parses one-turn success with Write + Read (tools/files, messageText, endState no-data)', () => {
    withCursorProjects('c-Users-me-proj', 'sess-1', [
      makeCursorUser('create a file'),
      makeCursorAssistant([
        { type: 'tool_use', name: 'Write', input: { path: 'src/foo.ts', contents: 'export const x = 1;' } },
        { type: 'tool_use', name: 'Read', input: { path: 'src/foo.ts' } },
        { type: 'text', text: 'Done.' },
      ]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const editLocIndex: EditLocIndex = new Map();
      const result = parseCursorSessions(projectsDir, editLocIndex);
      expect(result).toHaveLength(1);
      const session = result[0].sessions[0];
      expect(session.harness).toBe('Cursor');
      expect(session.requests).toHaveLength(1);

      const req = session.requests[0];
      expect(req.messageText).toBe('create a file');
      expect(req.toolsUsed).toEqual(['Write', 'Read']);
      expect(req.editedFiles).toEqual(['src/foo.ts']);
      expect(req.referencedFiles).toEqual(['src/foo.ts']);
      expect(req.endState).toBe('no-data');
      expect(req.promptTokens).toBeNull();
      expect(req.completionTokens).toBeNull();
      expect(req.cacheReadTokens).toBeNull();
      expect(req.cacheWriteTokens).toBeNull();
      expect(req.modelId).toBe('');
      expect(editLocIndex.get('sess-1:cursor:0')?.get('src/foo.ts')).toEqual({ added: 1, removed: 0 });
    });
  });

  it('groups multi-turn sessions on turn_ended boundaries', () => {
    withCursorProjects('c-Users-me-proj', 'sess-2', [
      makeCursorUser('first task'),
      makeCursorAssistant([{ type: 'text', text: 'First reply.' }]),
      makeTurnEnded('success'),
      makeCursorUser('second task'),
      makeCursorAssistant([{ type: 'text', text: 'Second reply.' }]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0].messageText).toBe('first task');
      expect(session.requests[0].responseText).toBe('First reply.');
      expect(session.requests[0].endState).toBe('no-data');
      expect(session.requests[1].messageText).toBe('second task');
      expect(session.requests[1].responseText).toBe('Second reply.');
      expect(session.requestCount).toBe(2);
    });
  });

  it('skips system_notification-only user lines', () => {
    withCursorProjects('c-Users-me-proj', 'sess-3', [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<system_notification>background sync</system_notification>' }],
        },
      },
      makeCursorUser('real prompt'),
      makeCursorAssistant([{ type: 'text', text: 'ok' }]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('real prompt');
    });
  });

  it('parses timestamp and user_query XML wrappers (messageText has no XML)', () => {
    withCursorProjects('c-Users-me-proj', 'sess-4', [
      makeCursorUser('hello world', '<timestamp>2025-06-15T10:00:00Z</timestamp>'),
      makeCursorAssistant([{ type: 'text', text: 'hi' }]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const session = parseCursorSessions(projectsDir)[0].sessions[0];
      expect(session.requests[0].messageText).toBe('hello world');
      expect(session.requests[0].messageText).not.toContain('<user_query>');
      expect(session.requests[0].messageText).not.toContain('<timestamp>');
      expect(session.requests[0].timestamp).toBe(new Date('2025-06-15T10:00:00Z').getTime());
      expect(session.creationDate).toBe(new Date('2025-06-15T10:00:00Z').getTime());
    });
  });

  it('merges subagent files into the parent session, sorted by timestamp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-subagent-test-'));
    const projectsDir = path.join(root, 'projects');
    const encodedDir = 'c-Users-me-proj';
    const parentId = 'parent-sess';

    writeCursorSession(projectsDir, encodedDir, parentId, [
      makeCursorUser('parent prompt', '<timestamp>2025-06-15T10:00:00Z</timestamp>'),
      makeCursorAssistant([{ type: 'text', text: 'parent reply' }]),
      makeTurnEnded('success'),
    ]);

    const subDir = path.join(projectsDir, encodedDir, 'agent-transcripts', parentId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeCursorUser('subagent task', '<timestamp>2025-06-15T10:00:30Z</timestamp>'),
        makeCursorAssistant([{ type: 'text', text: 'subagent reply' }]),
        makeTurnEnded('success'),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseCursorSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(parentId);
      expect(sessions[0].requests).toHaveLength(2);
      expect(sessions[0].requests[0].messageText).toBe('parent prompt');
      expect(sessions[0].requests[1].messageText).toBe('subagent task');
      expect(sessions[0].requestCount).toBe(2);
      expect(sessions[0].lastMessageDate).toBe(new Date('2025-06-15T10:00:30Z').getTime());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits orphan subagent (no parent session) as standalone Cursor session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-orphan-test-'));
    const projectsDir = path.join(root, 'projects');
    const encodedDir = 'c-Users-me-proj';
    const orphanId = 'orphan-sess';

    const subDir = path.join(projectsDir, encodedDir, 'agent-transcripts', orphanId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      [
        makeCursorUser('orphan task', '<timestamp>2025-06-15T10:00:00Z</timestamp>'),
        makeCursorAssistant([{ type: 'text', text: 'orphan reply' }]),
        makeTurnEnded('success'),
      ].map(l => JSON.stringify(l)).join('\n'),
      'utf-8',
    );

    try {
      const result = parseCursorSessions(projectsDir);
      expect(result).toHaveLength(1);
      const sessions = result[0].sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(orphanId);
      expect(sessions[0].harness).toBe('Cursor');
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toBe('orphan task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sets endState pending when turn_ended is missing', () => {
    withCursorProjects('c-Users-me-proj', 'sess-pending', [
      makeCursorUser('still running'),
      makeCursorAssistant([{ type: 'text', text: 'working…' }]),
    ], (projectsDir) => {
      const req = parseCursorSessions(projectsDir)[0].sessions[0].requests[0];
      expect(req.endState).toBe('pending');
    });
  });

  it('sets endState errored on failed turn_ended', () => {
    withCursorProjects('c-Users-me-proj', 'sess-error', [
      makeCursorUser('do something'),
      makeCursorAssistant([{ type: 'text', text: 'oops' }]),
      makeTurnEnded('error', 'tool failed'),
    ], (projectsDir) => {
      const req = parseCursorSessions(projectsDir)[0].sessions[0].requests[0];
      expect(req.endState).toBe('errored');
      expect(req.isCanceled).toBe(false);
    });
  });

  it('sets endState no-data on successful turn_ended', () => {
    withCursorProjects('c-Users-me-proj', 'sess-success', [
      makeCursorUser('done'),
      makeCursorAssistant([{ type: 'text', text: 'finished' }]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const req = parseCursorSessions(projectsDir)[0].sessions[0].requests[0];
      expect(req.endState).toBe('no-data');
    });
  });

  it('returns no sessions for empty or malformed files without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-malformed-test-'));
    const projectsDir = path.join(root, 'projects');
    const encodedDir = 'c-Users-me-proj';

    writeCursorSession(projectsDir, encodedDir, 'empty-sess', []);
    const malformedDir = path.join(projectsDir, encodedDir, 'agent-transcripts', 'bad-sess');
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, 'bad-sess.jsonl'), 'not-json\n{broken', 'utf-8');

    try {
      expect(() => parseCursorSessions(projectsDir)).not.toThrow();
      expect(parseCursorSessions(projectsDir)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('decodes Windows-style encoded project folders (c-Users-foo-bar)', { timeout: 30_000 }, () => {
    const tmpBase = fs.mkdtempSync(path.join(longTmpDir(), 'cursor-ws-'));
    const usersDir = path.join(tmpBase, 'Users');
    const fooDir = path.join(usersDir, 'foo');
    const barDir = path.join(fooDir, 'bar');
    fs.mkdirSync(barDir, { recursive: true });

    const encodedDirName = barDir
      .replace(/^([a-zA-Z])(?=:)/, d => d.toLowerCase())
      .replace(/[:\\/\s]/g, '-');

    const root = fs.mkdtempSync(path.join(longTmpDir(), 'cursor-proj-'));
    const projectsDir = path.join(root, 'projects');
    writeCursorSession(projectsDir, encodedDirName, 'sess-ws', [
      makeCursorUser('hello'),
      makeCursorAssistant([{ type: 'text', text: 'hi' }]),
      makeTurnEnded('success'),
    ]);

    try {
      const result = parseCursorSessions(projectsDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('bar');
      expect(result[0].workspaceId).toBe(`cursor-${encodedDirName}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('keeps tokens null and modelId empty', () => {
    withCursorProjects('c-Users-me-proj', 'sess-tokens', [
      makeCursorUser('count tokens?'),
      makeCursorAssistant([{ type: 'text', text: 'no token fields in Cursor logs' }]),
      makeTurnEnded('success'),
    ], (projectsDir) => {
      const req = parseCursorSessions(projectsDir)[0].sessions[0].requests[0];
      expect(req.promptTokens).toBeNull();
      expect(req.completionTokens).toBeNull();
      expect(req.cacheReadTokens).toBeNull();
      expect(req.cacheWriteTokens).toBeNull();
      expect(req.modelId).toBe('');
    });
  });
});
