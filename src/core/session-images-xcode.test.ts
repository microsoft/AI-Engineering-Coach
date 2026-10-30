/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSource } from './cache';
import { parseXcodeDatabases, parseXcodeDatabasesAsync } from './parser-xcode';
import { extractSourceImages, loadSourceSession } from './session-images';

const { sqlite } = vi.hoisted(() => ({
  sqlite: vi.fn<(command: string, args: string[], options: unknown) => string>(),
}));

vi.mock('child_process', () => ({
  execFileSync: sqlite,
  execFile: (command: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(null, sqlite(command, args, options));
  },
}));

const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const image = `data:image/png;base64,${base64}`;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-xcode-images-'));
  const directory = path.join(root, 'machine', 'conversations');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'conversation.db'), '');
  const turns = [
    { rowID: 1, id: 'user-image', role: 'user', createdAt: 1, data: JSON.stringify({ content: '', contentImageReferences: [{ data: base64, source: 'pasted' }] }) },
    { rowID: 2, id: 'assistant-image', role: 'assistant', createdAt: 2, data: JSON.stringify({ content: 'Answer', contentImageReferences: [{ data: base64 }] }) },
    { rowID: 3, id: 'plain-user', role: 'user', createdAt: 3, data: JSON.stringify({ content: 'Text only' }) },
  ];
  sqlite.mockImplementation((_command, args) => {
    if (args.includes('--version')) return '3.0';
    const sql = args.at(-1)!;
    if (sql.includes('FROM Conversation')) {
      return JSON.stringify([{ id: 'xcode-session', title: 'Xcode', createdAt: 1, updatedAt: 3 }]);
    }
    if (sql.startsWith('SELECT data')) {
      return JSON.stringify(sql.includes("id = 'user-image'") && sql.includes("conversationID = 'xcode-session'")
        ? [{ data: turns[0].data }] : []);
    }
    if (args.includes('-separator')) {
      return turns.map(turn => [turn.rowID, turn.id, turn.role, turn.data, turn.createdAt].join('\x1f')).join('\n');
    }
    return JSON.stringify(turns);
  });
});

afterEach(() => {
  sqlite.mockReset();
  fs.rmSync(root, { recursive: true, force: true });
});

it('counts and loads Xcode image-only user turns in both parsing paths', async () => {
  const sources = new Map<string, SessionSource>();
  for (const sessions of [parseXcodeDatabases(root, undefined, sources), await parseXcodeDatabasesAsync(root, undefined, sources)]) {
    expect(sessions[0].requests.map(request => request.variableKinds.image ?? 0)).toEqual([1, 0]);
    expect(sources.get('xcode-session')?.kind).toBe('xcode-db');
  }
  const source = sources.get('xcode-session')!;
  expect(extractSourceImages(source, 'xcode-session', 'user-image')).toEqual([image]);
  expect(extractSourceImages(source, 'xcode-session', 'plain-user')).toEqual([]);
  expect(extractSourceImages(source, 'xcode-session', 'assistant-image')).toEqual([]);
  expect(extractSourceImages(source, 'another-conversation', 'user-image')).toEqual([]);
  expect(loadSourceSession(source, 'xcode-session')?.requests[0].variableKinds.image).toBe(1);
  for (const [, args] of sqlite.mock.calls.filter(([, args]) => !args.includes('--version'))) {
    expect(args[0]).toBe('-readonly');
  }
});

it('quotes Xcode request IDs rather than interpolating SQL syntax', () => {
  const source: SessionSource = {
    kind: 'xcode-db', filePath: path.join(root, 'machine', 'conversations', 'conversation.db'),
    workspaceId: 'ws', workspaceName: 'Xcode', harness: 'Xcode',
  };
  expect(extractSourceImages(source, 'xcode-session', "missing' OR 1=1 --")).toEqual([]);
  expect(sqlite.mock.calls.at(-1)?.[1].at(-1)).toContain("id = 'missing'' OR 1=1 --'");
});
