/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode request token fields and per-turn context. OpenCode writes one assistant message per model call
 * (one step), and `tokens.input` excludes the cached tokens. The token fields sum every call of the turn; the
 * context is the last and largest call's prompt. Token shapes mirror a real two-call turn. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseOpenCodeSessions } from './parser-opencode';
import { requestContextTokens } from './context-window';
import type { SessionRequest } from './types';

const SESSION = { id: 'ses_usage', directory: '/Users/me/proj', title: 'Project', time: { created: 1_700_000_000_000 } };
const USER = { id: 'msg_user', sessionID: SESSION.id, role: 'user', time: { created: 1_700_000_000_000 }, summary: { title: 'task' } };
const FIRST_CALL = {
  id: 'msg_a1', sessionID: SESSION.id, role: 'assistant', parentID: 'msg_user', modelID: 'big-pickle', finish: 'tool-calls',
  time: { created: 1_700_000_001_000, completed: 1_700_000_004_000 },
  tokens: { total: 9_730, input: 9_674, output: 56, reasoning: 0, cache: { write: 0, read: 0 } },
};
const SECOND_CALL = {
  id: 'msg_a2', sessionID: SESSION.id, role: 'assistant', parentID: 'msg_user', modelID: 'big-pickle', finish: 'stop',
  time: { created: 1_700_000_005_000, completed: 1_700_000_012_000 },
  tokens: { total: 15_372, input: 4_864, output: 844, reasoning: 0, cache: { write: 0, read: 9_664 } },
};
const TURN_PROMPT = 9_674 + (4_864 + 9_664);

function withJsonStorage(messages: object[], run: (request: SessionRequest) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-usage-json-'));
  const storageDir = path.join(root, 'storage');
  try {
    fs.mkdirSync(path.join(storageDir, 'session', 'global'), { recursive: true });
    fs.writeFileSync(path.join(storageDir, 'session', 'global', `${SESSION.id}.json`), JSON.stringify(SESSION), 'utf-8');
    fs.mkdirSync(path.join(storageDir, 'message', SESSION.id), { recursive: true });
    for (const message of messages) {
      fs.writeFileSync(path.join(storageDir, 'message', SESSION.id, `${(message as { id: string }).id}.json`), JSON.stringify(message), 'utf-8');
    }
    run(parseOpenCodeSessions(storageDir)[0].requests[0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withDatabase(messages: Array<{ id: string; time: { created: number } }>, run: (request: SessionRequest) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-usage-db-'));
  const dbPath = path.join(root, 'opencode.db');
  try {
    const database = new DatabaseSync(dbPath);
    database.exec([
      'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);',
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
      'CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
    ].join('\n'));
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run(SESSION.id, 'project', SESSION.directory, SESSION.title, 'project', SESSION.time.created, SESSION.time.created);
    const insert = database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    for (const message of messages) {
      const { id, ...data } = message as Record<string, unknown> & { id: string; time: { created: number } };
      insert.run(id, SESSION.id, message.time.created, message.time.created, JSON.stringify(data));
    }
    database.close();
    run(parseOpenCodeSessions(dbPath)[0].requests[0]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('OpenCode request token fields', () => {
  for (const [source, withSource] of [['JSON storage', withJsonStorage], ['opencode.db', withDatabase]] as const) {
    it(`sum every model call of the turn (${source})`, () => {
      withSource([USER, FIRST_CALL, SECOND_CALL], request => {
        expect(request).toMatchObject({ promptTokens: TURN_PROMPT, completionTokens: 56 + 844, cacheReadTokens: 9_664, cacheWriteTokens: 0 });
        const rows = request.promptCache?.rows ?? [];
        expect(request.promptTokens).toBe(rows.reduce((sum, row) => sum + row.input, 0));
        expect(request.cacheReadTokens).toBe(rows.reduce((sum, row) => sum + row.cacheRead, 0));
      });
    });

    it(`record the turn's context from its last and largest call (${source})`, () => {
      withSource([USER, FIRST_CALL, SECOND_CALL], request => {
        expect(request.contextUsage).toEqual({ lastPromptTokens: 14_528, peakPromptTokens: 14_528, contextLimit: null, calls: 2 });
        expect(requestContextTokens(request)).toBe(14_528);
      });
    });
  }

  it('count a later call when the first one logged no tokens', () => {
    const { tokens: _unused, ...withoutTokens } = FIRST_CALL;
    withJsonStorage([USER, withoutTokens, SECOND_CALL], request => {
      expect(request).toMatchObject({ promptTokens: 4_864 + 9_664, completionTokens: 844, cacheReadTokens: 9_664 });
      expect(request.contextUsage).toMatchObject({ lastPromptTokens: 14_528, calls: 1 });
    });
  });

  it('keep the context of a turn whose last call is smaller than its largest', () => {
    const third = { ...SECOND_CALL, id: 'msg_a3', time: { created: 1_700_000_013_000 }, tokens: { input: 1_000, output: 10, cache: { read: 2_000, write: 0 } } };
    withJsonStorage([USER, FIRST_CALL, SECOND_CALL, third], request => {
      expect(request.contextUsage).toEqual({ lastPromptTokens: 3_000, peakPromptTokens: 14_528, contextLimit: null, calls: 3 });
    });
  });
});
