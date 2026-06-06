/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Kilo parser — verifies that SQLite-backed sessions are
 * parsed correctly, including token data, tool calls, and edge cases. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findKiloDirs, parseKiloSessions } from './parser-kilo';
import { DatabaseSync } from 'node:sqlite';

let _tmpDir: string | undefined;

function tmpDir(): string {
  if (!_tmpDir) throw new Error('tmpDir not set');
  return _tmpDir;
}

function createDb(): DatabaseSync {
  _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-parser-test-'));
  const dbPath = path.join(_tmpDir!, 'kilo.db');
  const db = new DatabaseSync(dbPath, { open: true });

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id),
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id),
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE workspace (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      directory TEXT,
      branch TEXT,
      extra TEXT,
      project_id TEXT NOT NULL,
      time_used INTEGER NOT NULL
    );
  `);
  return db;
}

function cleanup(): void {
  if (_tmpDir) {
    fs.rmSync(_tmpDir, { recursive: true, force: true });
    _tmpDir = undefined;
  }
}

describe('findKiloDirs', () => {
  it('returns empty when no database exists', () => {
    const dirs = findKiloDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });
});

describe('parseKiloSessions', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns empty for empty database', () => {
    const db = createDb();
    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(0);
  });

  it('returns empty when no messages exist', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess1', 'proj1', 'my-project', '/home/user/proj', 'My Project', '1', 1700000000000, 1700000000000);
    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(0);
  });

  it('parses a simple user+assistant pair with token data', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess1', 'proj1', 'my-project', '/home/user/proj', 'My Project', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('m1', 'sess1', 1700000000000, 1700000000000,
        JSON.stringify({
          id: 'm1', sessionID: 'sess1', role: 'user',
          time: { created: 1700000000000 },
          agent: 'code',
        }));

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('m2', 'sess1', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'm2', sessionID: 'sess1', role: 'assistant', parentID: 'm1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 500, write: 100 } },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    const reqs = sessions[0].requests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].modelId).toBe('anthropic/claude-sonnet-4');
    expect(reqs[0].promptTokens).toBe(1600); // 1000 + 500 + 100
    expect(reqs[0].completionTokens).toBe(200);
    expect(reqs[0].cacheReadTokens).toBe(500);
    expect(reqs[0].cacheWriteTokens).toBe(100);
    expect(reqs[0].agentName).toBe('code');
  });

  it('records zero-token assistants as data, not missing', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess2', 'proj1', 'proj', '/home/user/proj', 'Proj', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess2', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess2', role: 'user', time: { created: 1700000000000 } }));

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a1', 'sess2', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'a1', sessionID: 'sess2', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 0, output: 0 },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].requests[0].promptTokens).toBe(0);
    expect(sessions[0].requests[0].completionTokens).toBe(0);
  });

  it('marks request as missing when no assistant message exists', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess3', 'proj1', 'proj', '/home/user/proj', 'Proj', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess3', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess3', role: 'user', time: { created: 1700000000000 } }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].requests[0].promptTokens).toBeNull();
    expect(sessions[0].requests[0].completionTokens).toBeNull();
  });

  it('extracts tools used, edited files, and referenced files from tool parts', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess4', 'proj1', 'proj', '/home/user/proj', 'Proj', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess4', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess4', role: 'user', time: { created: 1700000000000 }, agent: 'code' }));

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a1', 'sess4', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'a1', sessionID: 'sess4', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000003000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 500, output: 50 },
        }));

    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('p1', 'a1', 'sess4', 1700000001500, 1700000001500,
        JSON.stringify({
          type: 'tool', tool: 'write', callID: 'call1',
          state: { status: 'completed', input: { filePath: '/home/user/proj/src/index.ts', content: 'console.log("hi");' }, output: '' },
        }));

    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('p2', 'a1', 'sess4', 1700000002000, 1700000002000,
        JSON.stringify({
          type: 'tool', tool: 'read', callID: 'call2',
          state: { status: 'completed', input: { filePath: '/home/user/proj/src/utils.ts' }, output: '...' },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    const req = sessions[0].requests[0];
    expect(req.toolsUsed).toEqual(['write', 'read']);
    expect(req.editedFiles).toEqual(['/home/user/proj/src/index.ts']);
    expect(req.referencedFiles).toEqual(['/home/user/proj/src/utils.ts']);
  });

  it('stores session directory as workspaceRootPath', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess5', 'proj1', 'proj', '/home/user/proj', 'Proj', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess5', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess5', role: 'user', time: { created: 1700000000000 } }));

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a1', 'sess5', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'a1', sessionID: 'sess5', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 100, output: 20 },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].workspaceRootPath).toBe('/home/user/proj');
  });

  it('uses workspace name from workspace table when available', () => {
    const db = createDb();
    db.prepare(`INSERT INTO workspace (id, type, name, directory, branch, project_id, time_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('ws1', 'local', 'My Awesome Project', '/home/user/proj', 'main', 'proj1', 1700000000000);

    db.prepare(`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess6', 'proj1', 'ws1', 'proj', '/home/user/proj', 'proj', '1', 1700000000000, 1700000000000);

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess6', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess6', role: 'user', time: { created: 1700000000000 } }));

    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a1', 'sess6', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'a1', sessionID: 'sess6', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 100, output: 20 },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].workspaceName).toBe('My Awesome Project');
  });

  it('handles multiple requests in a session', () => {
    const db = createDb();
    db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sess7', 'proj1', 'proj', '/home/user/proj', 'Proj', '1', 1700000000000, 1700000000000);

    // First user+assistant pair
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u1', 'sess7', 1700000000000, 1700000000000,
        JSON.stringify({ id: 'u1', sessionID: 'sess7', role: 'user', time: { created: 1700000000000 }, agent: 'code' }));
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a1', 'sess7', 1700000001000, 1700000001000,
        JSON.stringify({
          id: 'a1', sessionID: 'sess7', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4', providerID: 'anthropic',
          tokens: { input: 100, output: 20 },
        }));

    // Second user+assistant pair
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('u2', 'sess7', 1700000003000, 1700000003000,
        JSON.stringify({ id: 'u2', sessionID: 'sess7', role: 'user', time: { created: 1700000003000 }, agent: 'code' }));
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)`)
      .run('a2', 'sess7', 1700000004000, 1700000004000,
        JSON.stringify({
          id: 'a2', sessionID: 'sess7', role: 'assistant', parentID: 'u2',
          time: { created: 1700000004000, completed: 1700000005000 },
          modelID: 'gpt-4o', providerID: 'openai',
          tokens: { input: 200, output: 50 },
        }));

    db.close();
    const sessions = parseKiloSessions(tmpDir());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].requests).toHaveLength(2);
    expect(sessions[0].requests[0].modelId).toBe('anthropic/claude-sonnet-4');
    expect(sessions[0].requests[1].modelId).toBe('openai/gpt-4o');
  });
});
