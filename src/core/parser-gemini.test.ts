/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseGeminiSessions } from './parser-gemini';

function makeUser(id: string, text: string, ts = '2026-06-01T10:00:00.000Z'): object {
  return {
    id,
    timestamp: ts,
    type: 'user',
    content: text,
  };
}

function makeGemini(id: string, text: string, ts = '2026-06-01T10:00:05.000Z', tokens?: unknown, toolCalls?: unknown[]): object {
  return {
    id,
    timestamp: ts,
    type: 'gemini',
    content: text,
    model: 'gemini-3-flash-preview',
    tokens: tokens ?? { input: 100, output: 20, cached: 50 },
    toolCalls: toolCalls ?? [],
  };
}

function withGeminiDir(lines: object[], run: (baseDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-parser-test-'));
  const tmpDir = path.join(root, 'tmp');
  const projDir = path.join(tmpDir, 'test-project');
  const chatsDir = path.join(projDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const file = path.join(chatsDir, 'session-1.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
  try {
    run(tmpDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parseGeminiSessions', () => {
  it('parses a simple conversation', () => {
    withGeminiDir([
      { sessionId: 'sess-123', startTime: '2026-06-01T10:00:00.000Z' },
      makeUser('m1', 'hello'),
      makeGemini('m2', 'hi there'),
    ], (baseDir) => {
      const result = parseGeminiSessions(baseDir);
      expect(result).toHaveLength(1);
      expect(result[0].workspaceName).toBe('test-project');
      const session = result[0].sessions[0];
      expect(session.sessionId).toBe('sess-123');
      expect(session.harness).toBe('Gemini CLI');
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('hello');
      expect(session.requests[0].responseText).toBe('hi there');
      expect(session.requests[0].promptTokens).toBe(150); // input + cached
      expect(session.requests[0].completionTokens).toBe(20);
    });
  });

  it('handles tool calls and extracts edited files', () => {
    withGeminiDir([
      makeUser('m1', 'write index.ts'),
      makeGemini('m2', 'Done', '2026-06-01T10:00:05.000Z', null, [
        { name: 'write_file', args: { file_path: 'src/index.ts', content: 'console.log("hi")' } }
      ]),
    ], (baseDir) => {
      const result = parseGeminiSessions(baseDir);
      const session = result[0].sessions[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].toolsUsed).toContain('write_file');
      expect(session.requests[0].editedFiles).toContain('src/index.ts');
      // Verify code was extracted into response text
      expect(session.requests[0].responseText).toContain('console.log("hi")');
    });
  });

  it('skips system context setup messages', () => {
    withGeminiDir([
      makeUser('m1', '<session_context>\nThis is a system setup message\n</session_context>'),
      makeGemini('m2', 'OK'),
      makeUser('m3', 'real prompt'),
      makeGemini('m4', 'real response'),
    ], (baseDir) => {
      const result = parseGeminiSessions(baseDir);
      const session = result[0].sessions[0];
      // Should only have ONE request (the real one)
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('real prompt');
    });
  });

  it('extracts referenced files from read tools', () => {
    withGeminiDir([
      makeUser('m1', 'check the readme'),
      makeGemini('m2', 'I saw it', '2026-06-01T10:00:05.000Z', null, [
        { name: 'read_file', args: { file_path: 'README.md' } }
      ]),
    ], (baseDir) => {
      const result = parseGeminiSessions(baseDir);
      const session = result[0].sessions[0];
      expect(session.requests[0].referencedFiles).toContain('README.md');
    });
  });

  it('extracts skills from activate_skill tool', () => {
    withGeminiDir([
      makeUser('m1', 'use tdd'),
      makeGemini('m2', 'Activating skill', '2026-06-01T10:00:05.000Z', null, [
        { name: 'activate_skill', args: { name: 'test-driven-development' } }
      ]),
    ], (baseDir) => {
      const result = parseGeminiSessions(baseDir);
      const session = result[0].sessions[0];
      expect(session.requests[0].skillsUsed).toContain('test-driven-development');
    });
  });
});
