/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, it, expect } from 'vitest';
import { EditLocIndex } from './edit-loc-diff';
import { accumulateXcodeFileEdits, findXcodeDirs, parseXcodeDatabases, parseXcodeDatabasesAsync } from './parser-xcode';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-xcode-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findXcodeDirs', () => {
  it('returns empty array when xcode dir does not exist', () => {
    const prevHome = process.env.HOME;
    const home = makeTempDir();
    process.env.HOME = home;
    try {
      const dirs = findXcodeDirs();
      expect(dirs).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('returns xcode base dir when it exists', () => {
    const prevHome = process.env.HOME;
    const home = makeTempDir();
    const xcodeDir = path.join(home, '.config', 'github-copilot', 'xcode');
    fs.mkdirSync(xcodeDir, { recursive: true });
    process.env.HOME = home;
    try {
      const dirs = findXcodeDirs();
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toBe(xcodeDir);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe('parseXcodeDatabases', () => {
  it.skipIf(process.platform === 'win32')('captures explicit web hosts from recorded assistant tool inputs', async () => {
    const xcodeBase = makeTempDir();
    const directory = path.join(xcodeBase, 'machine', 'conversations');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'sources.db');
    const user = JSON.stringify({ content: 'Why?', requestType: 'conversation' }).replaceAll("'", "''");
    const assistant = JSON.stringify({
      content: 'A recorded answer.', turnStatus: 'completed', editAgentRounds: [{ toolCalls: [
        { name: 'web_fetch', input: { url: 'https://docs.python.org/3/?private=1' } },
        { name: 'web_search', input: { query: 'https://not-a-source.example' } },
      ] }],
    }).replaceAll("'", "''");
    execFileSync('sqlite3', [file, `
      CREATE TABLE Conversation (id TEXT, title TEXT, createdAt INTEGER, updatedAt INTEGER);
      CREATE TABLE Turn (id TEXT, conversationID TEXT, role TEXT, data TEXT, createdAt INTEGER);
      INSERT INTO Conversation VALUES ('sources', 'Sources', 1700000000, 1700000001);
      INSERT INTO Turn VALUES ('user', 'sources', 'user', '${user}', 1700000000);
      INSERT INTO Turn VALUES ('answer', 'sources', 'assistant', '${assistant}', 1700000001);
    `], { cwd: os.tmpdir() });
    for (const sessions of [parseXcodeDatabases(xcodeBase), await parseXcodeDatabasesAsync(xcodeBase)]) {
      expect(sessions[0]?.requests[0].webDomains).toEqual(['docs.python.org']);
    }
  });

  it('returns empty array for non-existent directory', () => {
    const sessions = parseXcodeDatabases('/nonexistent/path');
    expect(sessions).toEqual([]);
  });

  describe('Xcode file edit deltas', () => {
    it('diffs persisted original/modified contents and excludes undone edits', () => {
      const editLocIndex: EditLocIndex = new Map();
      accumulateXcodeFileEdits([
        {
          fileURL: 'file:///Users/me/proj/App.swift',
          originalContent: 'a\nold',
          modifiedContent: 'a\nnew\nextra',
          status: 'kept',
        },
        {
          fileURL: 'file:///Users/me/proj/Undone.swift',
          originalContent: 'old',
          modifiedContent: 'new',
          status: 'undone',
        },
      ], 'turn-1', editLocIndex);

      expect(editLocIndex.get('turn-1')?.get('/Users/me/proj/App.swift'))
        .toEqual({ added: 2, removed: 1 });
      expect(editLocIndex.get('turn-1')?.has('/Users/me/proj/Undone.swift')).toBe(false);
    });

    it('records authoritative zero LoC when every edit was undone', () => {
      const editLocIndex: EditLocIndex = new Map();

      accumulateXcodeFileEdits([{
        fileURL: 'file:///Users/me/proj/Undone.swift',
        originalContent: 'old',
        modifiedContent: 'new',
        status: 'undone',
      }], 'turn-undone', editLocIndex);

      expect(editLocIndex.get('turn-undone')).toEqual(new Map());
    });

    it('leaves a turn without recognizable edits to code-block counting', () => {
      const editLocIndex: EditLocIndex = new Map();

      accumulateXcodeFileEdits([], 'turn-empty', editLocIndex);
      accumulateXcodeFileEdits(
        [{ fileURL: 'file:///Users/me/proj/NoContent.swift', status: 'kept' }],
        'turn-no-content',
        editLocIndex,
      );

      expect(editLocIndex.has('turn-empty')).toBe(false);
      expect(editLocIndex.has('turn-no-content')).toBe(false);
    });
  });

  it('returns empty array when no db files present', () => {
    const xcodeBase = makeTempDir();
    const machineDir = path.join(xcodeBase, 'machine-1', 'conversations');
    fs.mkdirSync(machineDir, { recursive: true });
    const sessions = parseXcodeDatabases(xcodeBase);
    expect(sessions).toEqual([]);
  });
});
