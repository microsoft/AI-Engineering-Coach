/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Pi Coding Agent parser — verifies that the JSONL session
 * tree (SessionHeader + message/model_change/etc. entries) is folded into
 * the internal session/request format, that cwd/timestamp/role/model and
 * message content are preserved, and that unsupported entry types are
 * ignored safely. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { findPiDirs, parsePiSessions } from './parser-pi';

/** Write a minimal Pi session tree under a project subdirectory whose name
 *  encodes `cwd` the way Pi does (`/` -> `-`, wrapped in `--`). */
function withPiSession(
  cwd: string,
  header: object,
  entries: object[],
  run: (sessionsDir: string, filePath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parser-test-'));
  const sessionsDir = path.join(root, '.pi', 'agent', 'sessions');
  const encoded = '--' + cwd.replace(/^\//, '').replaceAll('/', '-') + '--';
  const projDir = path.join(sessionsDir, encoded);
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, '2026-06-02T07-20-57-002Z_019e8734-fbaa-702d-81e3-3e22fec1f7eb.jsonl');
  const lines = [header, ...entries].map(l => JSON.stringify(l)).join('\n');
  fs.writeFileSync(file, lines, 'utf-8');
  try { run(sessionsDir, file); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const HEADER = {
  type: 'session',
  version: 3,
  id: '019e8734-fbaa-702d-81e3-3e22fec1f7eb',
  timestamp: '2026-06-02T07:20:57.002Z',
  cwd: '/Users/me/proj',
};

describe('parsePiSessions', () => {
  it('parses a basic user/assistant turn and preserves cwd, model, content', () => {
    withPiSession('/Users/me/proj', HEADER, [
      { type: 'model_change', id: 'm0', parentId: null, timestamp: '2026-06-02T07:20:57.100Z', provider: 'anthropic', modelId: 'claude-opus-4-8' },
      {
        type: 'message', id: 'a1', parentId: 'm0', timestamp: '2026-06-02T07:21:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Where are my logs stored?' }] },
      },
      {
        type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-06-02T07:21:05.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Under ~/.pi/agent/sessions.' }],
          provider: 'anthropic', model: 'claude-opus-4-8', stopReason: 'stop',
          usage: { input: 10, output: 20, cacheRead: 100, cacheWrite: 50, totalTokens: 180 },
        },
      },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      expect(sessions).toHaveLength(1);
      const s = sessions[0];
      expect(s.harness).toBe('Pi Coding Agent');
      expect(s.workspaceRootPath).toBe('/Users/me/proj');
      expect(s.workspaceName).toBe('proj');
      expect(s.requests).toHaveLength(1);

      const req = s.requests[0];
      expect(req.messageText).toBe('Where are my logs stored?');
      expect(req.responseText).toContain('Under ~/.pi/agent/sessions.');
      // thinking blocks are not folded into the response text
      expect(req.responseText).not.toContain('hmm');
      expect(req.modelId).toBe('claude-opus-4-8');
      expect(req.timestamp).toBe(new Date('2026-06-02T07:21:00.000Z').getTime());
      // promptTokens = uncached input + cacheRead + cacheWrite = 10 + 100 + 50
      expect(req.promptTokens).toBe(160);
      expect(req.completionTokens).toBe(20);
      expect(req.cacheReadTokens).toBe(100);
      expect(req.cacheWriteTokens).toBe(50);
    });
  });

  it('captures tool calls: edits, references, and bash commands', () => {
    withPiSession('/Users/me/proj', HEADER, [
      {
        type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z',
        message: { role: 'user', content: 'Add a file' },
      },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:05.000Z',
        message: {
          role: 'assistant', model: 'claude-opus-4-8', stopReason: 'toolUse',
          content: [
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/Users/me/proj/a.ts' } },
            { type: 'toolCall', id: 't2', name: 'write', arguments: { path: '/Users/me/proj/b.ts', content: 'export const x = 1;' } },
            { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'ls' } },
          ],
        },
      },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      expect(sessions).toHaveLength(1);
      const req = sessions[0].requests[0];
      expect(req.toolsUsed).toEqual(['read', 'write', 'bash']);
      expect(req.editedFiles).toEqual(['/Users/me/proj/b.ts']);
      expect(req.referencedFiles).toEqual(['/Users/me/proj/a.ts']);
      // Written file content is surfaced so AI-code detection works
      expect(req.aiCode.length).toBeGreaterThan(0);
    });
  });

  it('splits multiple user messages into separate turns', () => {
    withPiSession('/Users/me/proj', HEADER, [
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'first' } },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'one' }], usage: { input: 1, output: 1 } },
      },
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-06-02T07:21:02.000Z', message: { role: 'user', content: 'second' } },
      {
        type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-06-02T07:21:03.000Z',
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'two' }], usage: { input: 1, output: 1 } },
      },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      expect(sessions[0].requests).toHaveLength(2);
      expect(sessions[0].requests[0].messageText).toBe('first');
      expect(sessions[0].requests[1].messageText).toBe('second');
    });
  });

  it('ignores unsupported entry types safely', () => {
    withPiSession('/Users/me/proj', HEADER, [
      { type: 'thinking_level_change', id: 't', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', thinkingLevel: 'high' },
      { type: 'message', id: 'u1', parentId: 't', timestamp: '2026-06-02T07:21:01.000Z', message: { role: 'user', content: 'hi' } },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:02.000Z',
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hey' }], usage: { input: 1, output: 1 } },
      },
      { type: 'compaction', id: 'c', parentId: 'a1', timestamp: '2026-06-02T07:21:03.000Z', summary: 'earlier...', tokensBefore: 5000 },
      { type: 'label', id: 'l', parentId: 'c', timestamp: '2026-06-02T07:21:04.000Z', targetId: 'u1', label: 'checkpoint' },
      { type: 'session_info', id: 'si', parentId: 'l', timestamp: '2026-06-02T07:21:05.000Z', name: 'My session' },
      { type: 'custom', id: 'cu', parentId: 'si', timestamp: '2026-06-02T07:21:06.000Z', customType: 'ext', data: { n: 1 } },
      { type: 'some_future_type', id: 'ft', parentId: 'cu', timestamp: '2026-06-02T07:21:07.000Z' },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toBe('hi');
      expect(sessions[0].requests[0].responseText).toBe('hey');
    });
  });

  it('falls back to the encoded directory name for cwd when the header has none', () => {
    const headerNoCwd = { type: 'session', version: 3, id: 'abc', timestamp: '2026-06-02T07:20:57.002Z' };
    withPiSession('/Users/me/proj', headerNoCwd, [
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hey' }], usage: { input: 1, output: 1 } },
      },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].workspaceRootPath).toBe('/Users/me/proj');
      expect(sessions[0].workspaceName).toBe('proj');
    });
  });

  it('exposes aggregate token usage as Session.modelUsage', () => {
    withPiSession('/Users/me/proj', HEADER, [
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-06-02T07:21:00.000Z', message: { role: 'user', content: 'hi' } },
      {
        type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-06-02T07:21:01.000Z',
        message: {
          role: 'assistant', model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'hey' }],
          usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10 },
        },
      },
    ], (sessionsDir) => {
      const sessions = parsePiSessions(sessionsDir);
      const usage = sessions[0].modelUsage!['claude-opus-4-8'];
      expect(usage).toBeDefined();
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.cacheReadTokens).toBe(200);
      expect(usage.cacheWriteTokens).toBe(10);
    });
  });
});

describe('findPiDirs', () => {
  function setEnv(key: 'HOME' | 'USERPROFILE', value: string | undefined): void {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  it('discovers ~/.pi/agent/sessions when present', () => {
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      expect(findPiDirs()).toHaveLength(0);
      fs.mkdirSync(path.join(home, '.pi', 'agent', 'sessions'), { recursive: true });
      const dirs = findPiDirs();
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toBe(path.join(home, '.pi', 'agent', 'sessions'));
    } finally {
      setEnv('HOME', prevHome);
      setEnv('USERPROFILE', prevUserProfile);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
