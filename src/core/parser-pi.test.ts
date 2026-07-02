/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Pi parser — verifies JSONL sessions parse into requests with
 * summed token usage across the assistant steps of a turn. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parsePiSessions } from './parser-pi';

function withPiSession(entries: object[], run: (sessionsDir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-parser-test-'));
  const projectDir = path.join(root, '--home-me-proj--');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '2026-01-01T00-00-00-000Z_abc.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n'),
    'utf-8',
  );
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parsePiSessions', () => {
  it('parses a session and sums usage across the assistant steps of a turn', () => {
    withPiSession(
      [
        { type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/me/proj' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'do it' }], timestamp: 1767225600000 } },
        {
          type: 'message',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4',
            usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5 },
            content: [
              { type: 'text', text: 'working' },
              { type: 'toolCall', name: 'edit', arguments: { path: '/home/me/proj/a.ts' } },
            ],
            timestamp: 1767225601000,
          },
        },
        { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: 1767225602000 } },
        {
          type: 'message',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4',
            usage: { input: 200, output: 20 },
            content: [{ type: 'text', text: 'done' }, { type: 'toolCall', name: 'read', arguments: { path: '/home/me/proj/b.ts' } }],
            timestamp: 1767225603000,
          },
        },
      ],
      sessionsDir => {
        const sessions = parsePiSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].harness).toBe('Pi');
        expect(sessions[0].workspaceName).toBe('proj');
        expect(sessions[0].workspaceRootPath).toBe('/home/me/proj');

        const requests = sessions[0].requests;
        expect(requests).toHaveLength(1);
        expect(requests[0].messageText).toBe('do it');
        expect(requests[0].responseText).toContain('working');
        expect(requests[0].responseText).toContain('done');
        expect(requests[0].modelId).toBe('claude-sonnet-4');
        // 100 + 50 + 5 (turn 1, incl. cache) + 200 (turn 2)
        expect(requests[0].promptTokens).toBe(355);
        expect(requests[0].completionTokens).toBe(30);
        expect(requests[0].cacheReadTokens).toBe(50);
        expect(requests[0].cacheWriteTokens).toBe(5);
        expect(requests[0].toolsUsed).toEqual(['edit', 'read']);
        expect(requests[0].editedFiles).toEqual(['/home/me/proj/a.ts']);
        expect(requests[0].referencedFiles).toEqual(['/home/me/proj/b.ts']);
      },
    );
  });

  it('skips sessions without any user request', () => {
    withPiSession(
      [
        { type: 'session', id: 'sess-2', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/me/proj' },
        { type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet-4' },
      ],
      sessionsDir => {
        expect(parsePiSessions(sessionsDir)).toHaveLength(0);
      },
    );
  });

  it('keeps requests without usage data as null tokens', () => {
    withPiSession(
      [
        { type: 'session', id: 'sess-3', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/me/proj' },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1767225600000 } },
      ],
      sessionsDir => {
        const sessions = parsePiSessions(sessionsDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].requests[0].promptTokens).toBeNull();
        expect(sessions[0].requests[0].completionTokens).toBeNull();
      },
    );
  });
});
