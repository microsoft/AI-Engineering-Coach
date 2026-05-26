/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { findWindsurfDirs, parseWindsurfSessions } from './parser-windsurf';

/* ---- Helpers ---- */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-parser-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a minimal TrajectorySummaries protobuf buffer from scratch.
 *
 * TrajectorySummaries { repeated TrajectoryEntry entry = 1; }
 * TrajectoryEntry     { string trajectoryId = 1; TrajectorySummary summary = 2; }
 * TrajectorySummary   { string conversationId = 1; string title = 2; uint32 requestCount = 3;
 *                       repeated Turn turns = 7; workspace ws = 9; string modelId = 26; }
 * Turn                { string turnId = 1; TurnBody body = 2; }
 * TurnBody            { string userMessage = 26; string responseText = 42; string modelId = 34; }
 * Workspace           { string folderUri = 1; }
 */

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeField(fieldNum: number, wireType: number, payload: Buffer): Buffer {
  const tag = (fieldNum << 3) | wireType;
  return Buffer.concat([encodeVarint(tag), payload]);
}

function encodeString(fieldNum: number, s: string): Buffer {
  const strBuf = Buffer.from(s, 'utf8');
  return encodeField(fieldNum, 2, Buffer.concat([encodeVarint(strBuf.length), strBuf]));
}

function encodeMessage(fieldNum: number, msgBuf: Buffer): Buffer {
  return encodeField(fieldNum, 2, Buffer.concat([encodeVarint(msgBuf.length), msgBuf]));
}

function encodeVarintField(fieldNum: number, n: number): Buffer {
  return encodeField(fieldNum, 0, encodeVarint(n));
}

function buildTurnBody(userMsg: string, responseText: string, modelId: string): Buffer {
  return Buffer.concat([
    encodeString(26, userMsg),
    encodeString(42, responseText),
    encodeString(34, modelId),
  ]);
}

function buildTurn(turnId: string, userMsg: string, resp: string, model: string): Buffer {
  const body = buildTurnBody(userMsg, resp, model);
  return Buffer.concat([
    encodeString(1, turnId),
    encodeMessage(2, body),
  ]);
}

function buildWorkspace(folderUri: string): Buffer {
  return encodeString(1, folderUri);
}

function buildTrajectorySummary(opts: {
  conversationId: string;
  title: string;
  requestCount: number;
  workspaceUri: string;
  modelId: string;
  turns: Buffer[];
}): Buffer {
  const parts: Buffer[] = [
    encodeString(1, opts.conversationId),
    encodeString(2, opts.title),
    encodeVarintField(3, opts.requestCount),
  ];
  for (const turn of opts.turns) {
    parts.push(encodeMessage(7, turn));
  }
  parts.push(encodeMessage(9, buildWorkspace(opts.workspaceUri)));
  parts.push(encodeString(26, opts.modelId));
  return Buffer.concat(parts);
}

function buildTrajectoryEntry(trajectoryId: string, summary: Buffer): Buffer {
  return Buffer.concat([
    encodeString(1, trajectoryId),
    encodeMessage(2, summary),
  ]);
}

function buildTrajectorySummaries(entries: Buffer[]): Buffer {
  return Buffer.concat(entries.map(e => encodeMessage(1, e)));
}

function buildLevelDbValue(b64: string): Buffer {
  return Buffer.from(`{"type":"string","value":"${b64}"}`, 'utf8');
}

function writeFakeDb(dir: string, payload: Buffer): string {
  const ldbDir = path.join(dir, 'test.indexeddb.leveldb');
  fs.mkdirSync(ldbDir, { recursive: true });
  const b64 = payload.toString('base64');
  const ldbValue = buildLevelDbValue(b64);
  fs.writeFileSync(path.join(ldbDir, '000001.ldb'), ldbValue);
  return ldbDir;
}

/* ---- Tests ---- */

describe('parseWindsurfSessions', () => {
  it('parses a single session with one turn', () => {
    const turn = buildTurn(
      'turn-uuid-0001-0000-0000-000000000001',
      'How do I reverse a string in Python?',
      'You can use slicing: `s[::-1]`',
      'claude-sonnet-4-5',
    );
    const summary = buildTrajectorySummary({
      conversationId: 'conv-uuid-0001-0000-0000-000000000001',
      title: 'Python String Reverse',
      requestCount: 1,
      workspaceUri: 'file:///Users/test/projects/myapp',
      modelId: 'claude-sonnet-4-5',
      turns: [turn],
    });
    const entry = buildTrajectoryEntry('traj-uuid-0001-0000-0000-000000000001', summary);
    const blob = buildTrajectorySummaries([entry]);
    const ldbDir = writeFakeDb(tmpDir, blob);

    const sessions = parseWindsurfSessions(ldbDir);
    expect(sessions).toHaveLength(1);

    const s = sessions[0];
    expect(s.harness).toBe('Windsurf');
    expect(s.workspaceName).toBe('myapp');
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0].messageText).toBe('How do I reverse a string in Python?');
    expect(s.requests[0].responseText).toBe('You can use slicing: `s[::-1]`');
    expect(s.requests[0].modelId).toBe('claude-sonnet-4-5');
    expect(s.requests[0].agentName).toBe('Cascade');
  });

  it('deduplicates identical trajectoryIds across ldb files', () => {
    const turn = buildTurn(
      'turn-uuid-dup1-0000-0000-000000000001',
      'What is 2+2?',
      '4',
      'claude-haiku-4',
    );
    const summary = buildTrajectorySummary({
      conversationId: 'conv-uuid-dup1-0000-0000-000000000001',
      title: 'Math',
      requestCount: 1,
      workspaceUri: 'file:///Users/test/projects/math',
      modelId: 'claude-haiku-4',
      turns: [turn],
    });
    const entry = buildTrajectoryEntry('traj-uuid-dup1-0000-0000-000000000001', summary);
    const blob = buildTrajectorySummaries([entry]);

    const ldbDir = path.join(tmpDir, 'dedupe-test.indexeddb.leveldb');
    fs.mkdirSync(ldbDir, { recursive: true });
    const b64 = blob.toString('base64');
    const ldbValue = buildLevelDbValue(b64);
    // Write same data to two files
    fs.writeFileSync(path.join(ldbDir, '000001.ldb'), ldbValue);
    fs.writeFileSync(path.join(ldbDir, '000002.ldb'), ldbValue);

    const sessions = parseWindsurfSessions(ldbDir);
    expect(sessions).toHaveLength(1);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = path.join(tmpDir, 'empty.indexeddb.leveldb');
    fs.mkdirSync(emptyDir, { recursive: true });
    const sessions = parseWindsurfSessions(emptyDir);
    expect(sessions).toHaveLength(0);
  });

  it('skips turns with no user message or response', () => {
    const emptyTurn = buildTurn('turn-uuid-empty-000-0000-000000000001', '', '', 'claude-sonnet-4-5');
    const summary = buildTrajectorySummary({
      conversationId: 'conv-uuid-skip-0000-0000-000000000001',
      title: 'Empty turns',
      requestCount: 0,
      workspaceUri: 'file:///Users/test/projects/empty',
      modelId: 'claude-sonnet-4-5',
      turns: [emptyTurn],
    });
    const entry = buildTrajectoryEntry('traj-uuid-skip-0000-0000-000000000001', summary);
    const blob = buildTrajectorySummaries([entry]);
    const ldbDir = writeFakeDb(tmpDir, blob);

    const sessions = parseWindsurfSessions(ldbDir);
    // Session with only empty turns has no valid requests → skipped
    expect(sessions).toHaveLength(0);
  });
});

describe('findWindsurfDirs', () => {
  it('returns an array (may be empty on non-Windsurf systems)', () => {
    const dirs = findWindsurfDirs();
    expect(Array.isArray(dirs)).toBe(true);
  });
});
