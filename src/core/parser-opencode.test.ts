/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the OpenCode parser — verifies that assistant messages with
 * `tokens: {input:0, output:0}` (tool-only / cached continuation steps)
 * are recorded as data (zero tokens), not flagged as missing. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { parseOpenCodeSessions } from './parser-opencode';

function withStorage(
  rawSession: object,
  messages: object[],
  run: (storageDir: string) => void,
  parts: (Record<string, unknown> & { id: string; messageID: string })[] = [],
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-test-'));
  const storageDir = path.join(root, 'storage');
  const sessId = (rawSession as { id: string }).id;
  fs.mkdirSync(path.join(storageDir, 'session', 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(storageDir, 'session', 'global', `${sessId}.json`),
    JSON.stringify(rawSession),
    'utf-8',
  );
  fs.mkdirSync(path.join(storageDir, 'message', sessId), { recursive: true });
  for (const msg of messages) {
    const m = msg as { id: string };
    fs.writeFileSync(
      path.join(storageDir, 'message', sessId, `${m.id}.json`),
      JSON.stringify(msg),
      'utf-8',
    );
  }
  for (const part of parts) {
    const partDir = path.join(storageDir, 'part', part.messageID);
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, `${part.id}.json`), JSON.stringify(part), 'utf-8');
  }
  try { run(storageDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('parseOpenCodeSessions', () => {
  it('parses current opencode.db session, message, and diff data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-test-'));
    const dbPath = path.join(root, 'opencode.db');
    const userData = JSON.stringify({
      role: 'user',
      summary: {
        title: 'update code',
        diffs: [{ file: 'src/app.ts', additions: 4, deletions: 2, status: 'modified' }],
      },
    });
    const assistantData = JSON.stringify({
      role: 'assistant',
      parentID: 'msg_user',
      modelID: 'claude-sonnet-4',
      tokens: { input: 100, output: 20 },
    });
    const sql = [
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);',
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
      'CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
      `INSERT INTO session VALUES ('ses_test', 'project', '/Users/me/proj', 'Project', 'project', 1700000000000, 1700000002000);`,
      `INSERT INTO message VALUES ('msg_user', 'ses_test', 1700000000000, 1700000000000, ${sqlString(userData)});`,
      `INSERT INTO message VALUES ('msg_assistant', 'ses_test', 1700000001000, 1700000002000, ${sqlString(assistantData)});`,
    ].join('\n');

    try {
      const database = new DatabaseSync(dbPath);
      database.exec(sql);
      database.close();
      const editLocIndex: EditLocIndex = new Map();
      const sessions = parseOpenCodeSessions(dbPath, editLocIndex);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].requests[0].messageText).toBe('update code');
      expect(sessions[0].requests[0].editedFiles).toEqual(['src/app.ts']);
      expect(editLocIndex.get('msg_user')?.get('src/app.ts')).toEqual({ added: 4, removed: 2 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses current per-turn summary diffs for exact added and removed LoC', () => {
    withStorage(
      { id: 'sess-diff', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        {
          id: 'u1',
          sessionID: 'sess-diff',
          role: 'user',
          time: { created: 1700000000000 },
          summary: {
            title: 'update files',
            diffs: [
              { file: 'src/app.ts', additions: 3, deletions: 2, status: 'modified' },
              { file: 'src/new.ts', additions: 5, deletions: 0, status: 'added' },
            ],
          },
        },
        {
          id: 'a1', sessionID: 'sess-diff', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const editLocIndex: EditLocIndex = new Map();
        const request = parseOpenCodeSessions(storageDir, editLocIndex)[0].requests[0];

        expect(request.editedFiles).toEqual(['src/app.ts', 'src/new.ts']);
        expect(editLocIndex.get('u1')?.get('src/app.ts')).toEqual({ added: 3, removed: 2 });
        expect(editLocIndex.get('u1')?.get('src/new.ts')).toEqual({ added: 5, removed: 0 });
      },
    );
  });

  it('excludes structured edits whose tool state reports failure', () => {
    withStorage(
      { id: 'sess-failed', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        {
          id: 'u1',
          sessionID: 'sess-failed',
          role: 'user',
          time: { created: 1700000000000 },
          summary: { title: 'edit file' },
        },
        {
          id: 'a1',
          sessionID: 'sess-failed',
          role: 'assistant',
          parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const editLocIndex: EditLocIndex = new Map();
        const request = parseOpenCodeSessions(storageDir, editLocIndex)[0].requests[0];

        expect(request.toolsUsed).toEqual(['edit']);
        expect(request.editedFiles).toEqual([]);
        expect(editLocIndex.size).toBe(0);
      },
      [{
        id: 'part-failed',
        sessionID: 'sess-failed',
        messageID: 'a1',
        type: 'tool',
        tool: 'edit',
        state: {
          status: 'error',
          input: { filePath: 'src/app.ts', old_string: 'old', new_string: 'new' },
        },
      }],
    );
  });

  it('uses a present empty summary diff as authoritative zero edits', () => {
    withStorage(
      { id: 'sess-reverted', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        {
          id: 'u1',
          sessionID: 'sess-reverted',
          role: 'user',
          time: { created: 1700000000000 },
          summary: { title: 'edit then revert', diffs: [] },
        },
        {
          id: 'a1',
          sessionID: 'sess-reverted',
          role: 'assistant',
          parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const editLocIndex: EditLocIndex = new Map();
        const request = parseOpenCodeSessions(storageDir, editLocIndex)[0].requests[0];

        expect(request.editedFiles).toEqual([]);
        expect(editLocIndex.get('u1')).toEqual(new Map());
      },
      [{
        id: 'part-completed',
        sessionID: 'sess-reverted',
        messageID: 'a1',
        type: 'tool',
        tool: 'edit',
        state: {
          status: 'completed',
          input: { filePath: 'src/app.ts', old_string: 'old', new_string: 'new' },
        },
      }],
    );
  });

  it('excludes edits whose tool state is still running', () => {
    withStorage(
      { id: 'sess-running', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        {
          id: 'u1',
          sessionID: 'sess-running',
          role: 'user',
          time: { created: 1700000000000 },
          summary: { title: 'edit file' },
        },
        {
          id: 'a1',
          sessionID: 'sess-running',
          role: 'assistant',
          parentID: 'u1',
          time: { created: 1700000001000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const editLocIndex: EditLocIndex = new Map();
        const request = parseOpenCodeSessions(storageDir, editLocIndex)[0].requests[0];

        expect(request.editedFiles).toEqual([]);
        expect(editLocIndex.size).toBe(0);
      },
      [{
        id: 'part-running',
        sessionID: 'sess-running',
        messageID: 'a1',
        type: 'tool',
        tool: 'edit',
        state: {
          status: 'running',
          input: { filePath: 'src/app.ts', old_string: 'old', new_string: 'new' },
        },
      }],
    );
  });

  it('keeps explicit web-tool hosts separate from search queries and later turns', () => {
    withStorage({ id: 'sources', directory: '/repo' }, [
      { id: 'u1', role: 'user', time: { created: 1700000000000 }, summary: { title: 'Why?' } },
      { id: 'a1', role: 'assistant', time: { created: 1700000001000 }, finish: 'stop' },
      { id: 'u2', role: 'user', time: { created: 1700000002000 }, summary: { title: 'How?' } },
      { id: 'a2', role: 'assistant', time: { created: 1700000003000 }, finish: 'stop' },
    ], storageDir => {
      expect(parseOpenCodeSessions(storageDir)[0].requests.map(request => request.webDomains))
        .toEqual([['docs.python.org'], []]);
    }, [
      { id: 'fetch', messageID: 'a1', type: 'tool', tool: 'webfetch', state: { input: { url: 'https://docs.python.org/3/' } } },
      { id: 'search', messageID: 'a1', type: 'tool', tool: 'websearch', state: { input: { query: 'https://not-a-source.example' } } },
      { id: 'answer', messageID: 'a2', type: 'text', text: 'An answer.' },
    ]);
  });

  it('collects late assistant tools and distinguishes final text from tool-only continuation', () => {
    withStorage({ id: 's', directory: '/repo' }, [
      { id: 'u1', role: 'user', time: { created: 1700000000000 }, summary: { title: 'Why?' } },
      { id: 'a1', role: 'assistant', time: { created: 1700000001000 }, tokens: { input: 5, output: 2 } },
      { id: 'a2', role: 'assistant', time: { created: 1700000002000 } },
      { id: 'a3', role: 'assistant', time: { created: 1700000003000 }, finish: 'stop' },
      { id: 'u2', role: 'user', time: { created: 1700000004000 }, summary: { title: 'How?' } },
      { id: 'a4', role: 'assistant', time: { created: 1700000005000 } },
    ], storageDir => {
      expect(parseOpenCodeSessions(storageDir)[0].requests).toMatchObject([
        { userEventId: 'u1', answerEvidence: 'final', toolsUsed: ['edit', 'task'], editedFiles: ['/repo/a.ts'], promptTokens: 5,
          investigationDelegations: ['research'] },
        { userEventId: 'u2', answerEvidence: 'missing', toolsUsed: ['read'], investigationDelegations: [] },
      ]);
    }, [
      { id: 'p1', messageID: 'a1', type: 'text', text: 'I will inspect it.' },
      { id: 'p2', messageID: 'a2', type: 'tool', tool: 'edit', state: { input: { filePath: '/repo/a.ts' } } },
      { id: 'p2b', messageID: 'a2', type: 'tool', tool: 'task', state: { input: { subagent_type: 'research' } } },
      { id: 'p3', messageID: 'a3', type: 'text', text: 'An answer.' },
      { id: 'p4', messageID: 'a4', type: 'tool', tool: 'read', state: { input: { filePath: '/repo/a.ts' } } },
    ]);
  });

  it('records {input:0,output:0} assistants as zero-token data, not missing', () => {
    withStorage(
      { id: 'sess1', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        { id: 'm1', sessionID: 'sess1', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        // First assistant: tool-only continuation step with zeroed tokens
        {
          id: 'm2', sessionID: 'sess1', role: 'assistant', parentID: 'm1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 0, output: 0 },
        },
        { id: 'm3', sessionID: 'sess1', role: 'user', time: { created: 1700000003000 }, summary: { title: 'go on' } },
        // Second assistant: real tokens
        {
          id: 'm4', sessionID: 'sess1', role: 'assistant', parentID: 'm3',
          time: { created: 1700000004000, completed: 1700000005000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 1000, output: 50 },
        },
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        const reqs = sessions[0].requests;
        expect(reqs).toHaveLength(2);
        // The zero-token assistant should produce 0 tokens, NOT null/missing
        expect(reqs[0].promptTokens).toBe(0);
        expect(reqs[0].completionTokens).toBe(0);
        // Second assistant has real numbers
        expect(reqs[1].promptTokens).toBe(1000);
        expect(reqs[1].completionTokens).toBe(50);
      },
    );
  });

  it('marks a request as missing when the assistant message is absent entirely', () => {
    withStorage(
      { id: 'sess2', directory: '/Users/me/proj' },
      [
        { id: 'u1', sessionID: 'sess2', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        // No assistant message at all
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].requests[0].promptTokens).toBeNull();
        expect(sessions[0].requests[0].completionTokens).toBeNull();
      },
    );
  });

  it('stores the OpenCode session directory as workspaceRootPath', () => {
    // rawSession.directory is the project root. Surfacing it as
    // workspaceRootPath lets config-health / SDLC workspace scans resolve the
    // repo for OpenCode sessions, the same way the Codex parser already does.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-dir-test-'));
    withStorage(
      { id: 'sess-dir', directory: dir, time: { created: 1700000000000 } },
      [
        { id: 'u1', sessionID: 'sess-dir', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        {
          id: 'a1', sessionID: 'sess-dir', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].workspaceRootPath).toBe(dir);
      },
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
