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
import { describe, it, expect, vi } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { findOpenCodeDirs, loadOpenCodeSession, parseOpenCodeSessions } from './parser-opencode';
import type { SessionSource } from './cache';

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

function withV2Database(run: (database: DatabaseSync, dbPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v2-test-'));
  const dbPath = path.join(root, 'opencode.db');
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, path TEXT, title TEXT, slug TEXT,
        agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('ses_v2', 'project', '/repo/project', NULL, 'Project', 'project',
        'build', '{"id":"gpt-5","providerID":"openai"}', 1700000000000, 1700000010000);
    `);
    run(database, dbPath);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function insertV2Message(database: DatabaseSync, id: string, type: string, seq: number, data: object | string,
  sessionId = 'ses_v2', created = 1700000000000 + seq * 1000): void {
  database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sessionId, type, seq, created, created, typeof data === 'string' ? data : JSON.stringify(data));
}

describe('OpenCode V2 databases', () => {
  it('reads inline prompts, assistant content, models, tokens, tools, and source details', () => {
    withV2Database((database, dbPath) => {
      insertV2Message(database, 'user', 'user', 1, { text: 'Update the app', files: [] });
      insertV2Message(database, 'assistant', 'assistant', 2, {
        agent: 'plan', model: { id: 'gpt-5', providerID: 'openai', variant: 'high' },
        time: { created: 1700000002000, completed: 1700000004000 },
        tokens: { input: 100, output: 20, cache: { read: 30, write: 5 } }, finish: 'stop',
        content: [
          { type: 'reasoning', text: 'Private reasoning is not response text.' },
          { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: 'src/app.ts' } } },
          { type: 'tool', name: 'edit', state: { status: 'completed', input: { filePath: 'src/app.ts', oldString: 'old', newString: 'new\nline' } } },
          { type: 'tool', name: 'patch', state: { status: 'completed', input: { patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** End Patch' } } },
          { type: 'tool', name: 'subagent', state: { status: 'completed', input: { agent: 'explore' } } },
          { type: 'text', text: 'Updated the app.' },
        ],
      });
      const editLocIndex: EditLocIndex = new Map();
      const sources = new Map<string, SessionSource>();
      const originalDatabase = fs.readFileSync(dbPath);
      const sessions = parseOpenCodeSessions(dbPath, editLocIndex, sources);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ sessionId: 'ses_v2', harness: 'OpenCode', workspaceName: 'project', workspaceRootPath: '/repo/project' });
      expect(sessions[0].requests[0]).toMatchObject({
        requestId: 'user', messageText: 'Update the app',
        modelId: 'gpt-5', agentName: 'plan', agentMode: 'plan', reasoningEffort: 'high', answerEvidence: 'final',
        promptTokens: 135, completionTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5,
        totalElapsed: 3000, toolsUsed: ['read', 'edit', 'patch', 'subagent'],
        referencedFiles: ['src/app.ts'], editedFiles: ['src/app.ts', 'src/new.ts'], investigationDelegations: ['explore'],
      });
      expect(sessions[0].requests[0].responseText).toContain('Updated the app.');
      expect(sessions[0].requests[0].responseText).not.toContain('Private reasoning');
      expect(editLocIndex.get('user')?.get('src/app.ts')).toEqual({ added: 2, removed: 1 });
      expect(editLocIndex.get('user')?.get('src/new.ts')).toEqual({ added: 1, removed: 0 });
      expect(sources.get('ses_v2')).toMatchObject({ kind: 'opencode-db', filePath: dbPath });
      expect(loadOpenCodeSession(dbPath, 'ses_v2')).toEqual(sessions[0]);
      expect(fs.readFileSync(dbPath)).toEqual(originalDatabase);
    });
  });

  it('uses sequence order, ignores control events, and captures the full agentic turn', () => {
    withV2Database((database, dbPath) => {
      insertV2Message(database, 'z-user', 'user', 1, { text: 'Explain it' }, 'ses_v2', 1700000001000);
      insertV2Message(database, 'b-step', 'assistant', 2, {
        model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 10, output: 3 },
        content: [{ type: 'tool', name: 'read', state: { input: { filePath: 'app.ts' } } }], finish: 'tool-calls',
      }, 'ses_v2', 1700000001000);
      insertV2Message(database, 'system', 'system', 3, { text: 'Not a user prompt' });
      insertV2Message(database, 'compact', 'compaction', 4, { summary: 'Not an assistant response', tokens: { input: 900, output: 900 } });
      insertV2Message(database, 'a-final', 'assistant', 5, {
        model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 100, output: 7, cache: { read: 50, write: 0 } },
        time: { created: 1700000005000, completed: 1700000006000 },
        content: [{ type: 'text', text: 'The answer.' }], finish: 'stop',
      });
      insertV2Message(database, 'next-user', 'user', 6, { text: 'Next question' });
      const session = parseOpenCodeSessions(dbPath)[0];
      expect(session.requests).toHaveLength(2);
      expect(session.requests[0]).toMatchObject({ messageText: 'Explain it', responseText: 'The answer.',
        promptTokens: 150, completionTokens: 10, cacheReadTokens: 50, totalElapsed: 5000, answerEvidence: 'final' });
      expect(session.requests[1]).toMatchObject({ messageText: 'Next question', promptTokens: null, completionTokens: null, answerEvidence: 'missing' });
      expect(session.lastMessageDate).toBe(1700000006000);
    });
  });

  it('keeps explicit zero tokens and skips malformed messages and unsuccessful edits', () => {
    withV2Database((database, dbPath) => {
      insertV2Message(database, 'bad-json', 'user', 1, '{');
      insertV2Message(database, 'bad-shape', 'assistant', 2, 'null');
      insertV2Message(database, 'user', 'user', 3, { text: 'Try editing' });
      insertV2Message(database, 'assistant', 'assistant', 4, { tokens: { input: 0, output: 0 }, content: [
        { type: 'tool', name: 'edit', state: { status: 'error', input: { filePath: 'failed.ts', oldString: 'old', newString: 'new' } } },
        { type: 'tool', name: 'patch', state: { status: 'running', input: { patchText: '*** Begin Patch\n*** Add File: running.ts\n+new\n*** End Patch' } } },
      ] });
      const editLocIndex: EditLocIndex = new Map();
      const sessions = parseOpenCodeSessions(dbPath, editLocIndex);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].requests).toHaveLength(1);
      expect(sessions[0].requests[0]).toMatchObject({ promptTokens: 0, completionTokens: 0, editedFiles: [] });
      expect(editLocIndex.size).toBe(0);
    });
  });

  it('uses recorded tool diffs rather than estimating repeated replacements and patches', () => {
    withV2Database((database, dbPath) => {
      insertV2Message(database, 'user', 'user', 1, { text: 'Replace repeated text' });
      insertV2Message(database, 'assistant', 'assistant', 2, { content: [
        { type: 'tool', name: 'edit', state: {
          status: 'completed', input: { filePath: 'app.ts', oldString: 'old', newString: 'new', replaceAll: true },
          metadata: { filediff: { file: 'app.ts', additions: 3, deletions: 3 } },
        } },
        { type: 'tool', name: 'patch', state: {
          status: 'completed', input: { patchText: '*** Begin Patch\n*** Update File: app.ts\n-old\n+new\n*** End Patch' },
          metadata: { files: [{ file: 'app.ts', additions: 2, deletions: 2 }] },
        } },
        { type: 'tool', name: 'edit', state: {
          status: 'error', input: { filePath: 'failed.ts' }, metadata: { filediff: { file: 'failed.ts', additions: 9, deletions: 9 } },
        } },
      ] });
      const edits: EditLocIndex = new Map();
      expect(parseOpenCodeSessions(dbPath, edits)[0].requests[0].editedFiles).toEqual(['app.ts']);
      expect(edits.get('user')?.get('app.ts')).toEqual({ added: 5, removed: 5 });
    });
  });

  it('prefers V2 copies of migrated sessions while retaining V1-only sessions', () => {
    withV2Database((database, dbPath) => {
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        INSERT INTO session VALUES ('ses_v2', 'project', '/repo/project', 'Project', 'project', 1, 2);
        INSERT INTO session VALUES ('ses_v1', 'project', '/repo/legacy', 'Legacy', 'legacy', 1, 2);
        INSERT INTO message VALUES ('user', 'ses_v2', 1, 2, '{"role":"user","summary":{"title":"Old copy"}}');
        INSERT INTO message VALUES ('legacy-user', 'ses_v1', 1, 2, '{"role":"user","summary":{"title":"V1 only"}}');
      `);
      insertV2Message(database, 'user', 'user', 1, { text: 'Current copy' });
      const sessions = parseOpenCodeSessions(dbPath);
      expect(sessions).toHaveLength(2);
      expect(sessions.find(session => session.sessionId === 'ses_v2')?.requests[0].messageText).toBe('Current copy');
      expect(sessions.find(session => session.sessionId === 'ses_v1')?.requests[0].messageText).toBe('V1 only');
      expect(loadOpenCodeSession(dbPath, 'ses_v2')?.requests[0].messageText).toBe('Current copy');
      expect(loadOpenCodeSession(dbPath, 'ses_v1')?.requests[0].messageText).toBe('V1 only');
      database.exec("DELETE FROM session_message WHERE session_id = 'ses_v2'");
      expect(parseOpenCodeSessions(dbPath).map(session => session.sessionId)).toEqual(['ses_v1']);
      expect(loadOpenCodeSession(dbPath, 'ses_v2')).toBeNull();
    });
  });

  it('discovers V2 channel databases in configured data roots', () => {
    withV2Database((database, dbPath) => {
      insertV2Message(database, 'user', 'user', 1, { text: 'Nightly session' });
      const root = path.dirname(dbPath);
      const base = path.join(root, 'opencode');
      fs.mkdirSync(base);
      const nightly = path.join(base, 'opencode-nightly.db');
      fs.copyFileSync(dbPath, nightly);
      vi.stubEnv('HOME', root);
      vi.stubEnv('USERPROFILE', root);
      vi.stubEnv('XDG_DATA_HOME', root);
      vi.stubEnv('LOCALAPPDATA', path.join(root, 'local-appdata'));
      try {
        expect(findOpenCodeDirs()).toEqual([nightly]);
        expect(parseOpenCodeSessions(nightly)[0].requests[0].messageText).toBe('Nightly session');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('uses the V2 path when the session directory is empty', () => {
    withV2Database((database, dbPath) => {
      database.exec("UPDATE session_v2 SET directory = '', path = '/repo/alternate'");
      insertV2Message(database, 'user', 'user', 1, { text: 'Path session' });
      expect(parseOpenCodeSessions(dbPath)[0]).toMatchObject({ workspaceRootPath: '/repo/alternate', workspaceName: 'alternate' });
    });
  });

  it('skips V1 query when V2 has the requested session', () => {
    withV2Database((database, dbPath) => {
      // Create V1 tables with the same session ID — V1 should be skipped entirely.
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        INSERT INTO session VALUES ('ses_v2', 'v1project', '/repo/v1', 'V1 Copy', 'v1', 1, 2);
        INSERT INTO message VALUES ('v1-user', 'ses_v2', 1, 2, '{"role":"user","summary":{"title":"V1 stale"}}');
      `);
      insertV2Message(database, 'user', 'user', 1, { text: 'V2 current' });
      const loaded = loadOpenCodeSession(dbPath, 'ses_v2');
      expect(loaded?.requests[0].messageText).toBe('V2 current');
    });
  });

  it('handles V2 messages with null content, null files, and non-user/assistant roles', () => {
    withV2Database((database, dbPath) => {
      // User with null files — should still produce a text part.
      insertV2Message(database, 'user', 'user', 1, { text: 'Hello', files: null as unknown as [] });
      // Assistant with null content — should produce no parts, no response text.
      insertV2Message(database, 'assistant', 'assistant', 2, { content: null as unknown as [] });
      // Non-user/assistant roles — should be ignored.
      insertV2Message(database, 'system', 'system', 3, { text: 'System message' });
      insertV2Message(database, 'tool', 'tool_result', 4, { text: 'Tool output' });
      const session = parseOpenCodeSessions(dbPath)[0];
      expect(session.requests).toHaveLength(1);
      expect(session.requests[0].messageText).toBe('Hello');
      expect(session.requests[0].responseText).toBe('');
    });
  });

  it('filters to a single session when loadOpenCodeSession is called with a sessionId', () => {
    withV2Database((database, dbPath) => {
      // Ensure ses_v2 has messages so it parses as a valid session.
      insertV2Message(database, 'user', 'user', 1, { text: 'Update the app' });
      insertV2Message(database, 'assistant', 'assistant', 2, {
        model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 10, output: 5 },
        content: [{ type: 'text', text: 'Updated.' }], finish: 'stop',
      });
      // Insert a second session to verify filtering.
      database.exec(`
        INSERT INTO session_v2 VALUES ('ses_other', 'project', '/repo/other', NULL, 'Other', 'other',
          'build', '{"id":"gpt-5","providerID":"openai"}', 1700000020000, 1700000030000);
      `);
      insertV2Message(database, 'other-user', 'user', 1, { text: 'Other session prompt' }, 'ses_other');
      insertV2Message(database, 'other-assistant', 'assistant', 2, {
        model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 10, output: 5 },
        content: [{ type: 'text', text: 'Other answer.' }], finish: 'stop',
      }, 'ses_other');
      const allSessions = parseOpenCodeSessions(dbPath);
      expect(allSessions).toHaveLength(2);
      // loadOpenCodeSession with a specific ID should return only that session.
      const filtered = loadOpenCodeSession(dbPath, 'ses_v2');
      expect(filtered).not.toBeNull();
      expect(filtered!.sessionId).toBe('ses_v2');
      expect(filtered!.requests[0].messageText).toBe('Update the app');
      const other = loadOpenCodeSession(dbPath, 'ses_other');
      expect(other).not.toBeNull();
      expect(other!.sessionId).toBe('ses_other');
      expect(other!.requests[0].messageText).toBe('Other session prompt');
    });
  });

  it('returns empty / null when the V2 database has zero sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-empty-v2-'));
    const dbPath = path.join(root, 'opencode.db');
    const database = new DatabaseSync(dbPath);
    try {
      database.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, path TEXT, title TEXT, slug TEXT,
          agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
          time_created INTEGER, time_updated INTEGER, data TEXT);
      `);
      expect(parseOpenCodeSessions(dbPath)).toEqual([]);
      expect(loadOpenCodeSession(dbPath, 'nonexistent')).toBeNull();
    } finally {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findOpenCodeDirs', () => {
  it('returns an empty array when HOME has no V2 databases or legacy storage', () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-empty-home-'));
    vi.stubEnv('HOME', emptyHome);
    vi.stubEnv('USERPROFILE', emptyHome);
    vi.stubEnv('XDG_DATA_HOME', emptyHome);
    vi.stubEnv('LOCALAPPDATA', emptyHome);
    try {
      expect(findOpenCodeDirs()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe('OpenCode V1-only database', () => {
  it('parses V1 tables when no V2 tables exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-v1-only-test-'));
    const dbPath = path.join(root, 'opencode.db');
    const userData = JSON.stringify({ role: 'user', summary: { title: 'V1 only session' } });
    const assistantData = JSON.stringify({ role: 'assistant', modelID: 'gpt-4', tokens: { input: 50, output: 10 } });
    try {
      const database = new DatabaseSync(dbPath);
      database.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        INSERT INTO session VALUES ('v1only', 'proj', '/repo/v1', 'V1 Only', 'v1only', 1700000000000, 1700000002000);
        INSERT INTO message VALUES ('u1', 'v1only', 1700000000000, 1700000000000, ${sqlString(userData)});
        INSERT INTO message VALUES ('a1', 'v1only', 1700000001000, 1700000001000, ${sqlString(assistantData)});
      `);
      database.close();
      const sessions = parseOpenCodeSessions(dbPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('v1only');
      expect(sessions[0].requests[0].messageText).toBe('V1 only session');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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
