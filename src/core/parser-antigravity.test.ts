/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the Antigravity parser — builds a synthetic conversation db with
 * hand-encoded protobuf step payloads matching the reverse-engineered layout. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseAntigravitySessions } from './parser-antigravity';

type NodeSqliteModule = typeof import('node:sqlite');

function loadNodeSqliteForTest(): NodeSqliteModule | null {
  interface SqliteCapable { getBuiltinModule?: (id: string) => unknown }
  return ((process as SqliteCapable).getBuiltinModule?.('node:sqlite') as NodeSqliteModule | undefined) ?? null;
}

/* --- minimal protobuf wire-format writer (mirrors the parser's reader) --- */

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

function intField(fieldNo: number, value: number): Buffer {
  return Buffer.concat([varint((fieldNo << 3) | 0), varint(value)]);
}

function bytesField(fieldNo: number, value: Buffer | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(payload.length), payload]);
}

function timestampMessage(seconds: number): Buffer {
  return intField(1, seconds);
}

/** field 5 metadata: {1: timestamp, 4?: tool call, 9?: usage} */
function metaMessage(seconds: number, extra: Buffer[] = []): Buffer {
  return Buffer.concat([bytesField(1, timestampMessage(seconds)), ...extra]);
}

function userStepPayload(seconds: number, text: string): Buffer {
  return Buffer.concat([
    intField(1, 14),
    bytesField(5, metaMessage(seconds)),
    bytesField(19, bytesField(2, text)),
  ]);
}

function generationStepPayload(seconds: number, text: string, inputTokens: number, outputTokens: number, tool?: { name: string; argsJson: string }): Buffer {
  const usage = Buffer.concat([intField(2, inputTokens), intField(3, outputTokens)]);
  const generationParts = [bytesField(1, text)];
  if (tool) {
    generationParts.push(bytesField(7, Buffer.concat([bytesField(2, tool.name), bytesField(3, tool.argsJson)])));
  }
  return Buffer.concat([
    intField(1, 15),
    bytesField(5, metaMessage(seconds, [bytesField(9, usage)])),
    bytesField(20, Buffer.concat(generationParts)),
  ]);
}

function withConversation(run: (conversationsDir: string) => void): void {
  const sqlite = loadNodeSqliteForTest();
  if (!sqlite) return; // node:sqlite unavailable on this runtime — nothing to test

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-parser-test-'));
  const conversationsDir = path.join(root, 'conversations');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(conversationsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  fs.writeFileSync(
    path.join(cacheDir, 'last_conversations.json'),
    JSON.stringify({ '/home/me/proj': 'conv-1' }),
    'utf-8',
  );

  const db = new sqlite.DatabaseSync(path.join(conversationsDir, 'conv-1.db'));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
  const insert = db.prepare('INSERT INTO steps VALUES (?,?,?)');
  insert.run(0, 14, userStepPayload(1_700_000_000, 'refactor this'));
  insert.run(1, 15, generationStepPayload(1_700_000_005, 'On it.', 1000, 50, {
    name: 'view_file',
    argsJson: JSON.stringify({ AbsolutePath: '/home/me/proj/a.ts' }),
  }));
  insert.run(2, 15, generationStepPayload(1_700_000_010, 'Done.', 1200, 80));
  db.close();

  try {
    run(conversationsDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parseAntigravitySessions', () => {
  it('parses conversations from protobuf step payloads', () => {
    withConversation(conversationsDir => {
      const sessions = parseAntigravitySessions(conversationsDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].harness).toBe('Antigravity');
      expect(sessions[0].workspaceName).toBe('proj');
      expect(sessions[0].workspaceRootPath).toBe('/home/me/proj');

      const requests = sessions[0].requests;
      expect(requests).toHaveLength(1);
      expect(requests[0].messageText).toBe('refactor this');
      expect(requests[0].responseText).toContain('On it.');
      expect(requests[0].responseText).toContain('Done.');
      expect(requests[0].toolsUsed).toEqual(['view_file']);
      expect(requests[0].referencedFiles).toEqual(['/home/me/proj/a.ts']);
      // Summed across the two generation steps
      expect(requests[0].promptTokens).toBe(2200);
      expect(requests[0].completionTokens).toBe(130);
      expect(requests[0].timestamp).toBe(1_700_000_000 * 1000);
      // 10s between the user step and the last generation step
      expect(requests[0].totalElapsed).toBe(10_000);
    });
  });

  it('skips databases without user messages', () => {
    const sqlite = loadNodeSqliteForTest();
    if (!sqlite) return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-empty-test-'));
    const conversationsDir = path.join(root, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const db = new sqlite.DatabaseSync(path.join(conversationsDir, 'conv-2.db'));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)');
    db.prepare('INSERT INTO steps VALUES (?,?,?)').run(0, 15, generationStepPayload(1_700_000_000, 'hello', 10, 5));
    db.close();

    try {
      expect(parseAntigravitySessions(conversationsDir)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
