/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { ParseResult, SessionSource } from '../core/cache';
import { getRpcHandler, validateDateFilter } from './panel-rpc';

function callGetSessionImages(
  sessionSourceIndex: Map<string, SessionSource>,
  sessionId: string,
  requestId: string,
): string[] {
  const handler = getRpcHandler('getSessionImages');
  if (!handler) throw new Error('getSessionImages handler missing');
  const parseResult = { sessionSourceIndex } as unknown as ParseResult;
  const result = handler(
    undefined as unknown as never,
    parseResult,
    { sessionId, requestId },
  ) as { images: string[] };
  return result.images;
}

describe('panel-rpc', () => {
  it('maps legacy workspace params onto workspaceId', () => {
    expect(validateDateFilter({ workspace: 'ws-123', harness: 'Local Agent' })).toEqual({
      workspaceId: 'ws-123',
      harness: 'Local Agent',
    });
  });

  it('prefers explicit workspaceId when both fields are present', () => {
    expect(validateDateFilter({ workspace: 'legacy', workspaceId: 'real-id' })).toEqual({
      workspaceId: 'real-id',
    });
  });

  it('exposes handlers for the newer analyzer-backed methods', () => {
    expect(getRpcHandler('getInsights')).toBeTypeOf('function');
    expect(getRpcHandler('getWorkspaceContextSessions')).toBeTypeOf('function');
  });

  describe('getSessionImages', () => {
    it('resolves a subagent image from the subagent file via the composite key, not the parent file', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-images-'));
      try {
        const parentFile = path.join(root, 'parent.jsonl');
        const subFile = path.join(root, 'agent-1.jsonl');
        // Parent file has an image for the parent request 'p-1' only.
        fs.writeFileSync(parentFile, JSON.stringify({
          type: 'user', uuid: 'p-1',
          message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PPPPPPPP' } }] },
        }) + '\n');
        // Subagent file has the image for the rolled-up request 'sub-img'.
        fs.writeFileSync(subFile, JSON.stringify({
          type: 'user', uuid: 'sub-img',
          message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'SSSSSSSS' } }] },
        }) + '\n');

        const index = new Map<string, SessionSource>([
          ['parent-sess', { kind: 'claude-session-file', filePath: parentFile, workspaceId: 'w', workspaceName: 'p', harness: 'Claude' }],
          ['parent-sess::sub-img', { kind: 'claude-session-file', filePath: subFile, workspaceId: 'w', workspaceName: 'p', harness: 'Claude' }],
        ]);

        // Subagent moment: sessionId is the parent, requestId is the subagent's.
        expect(callGetSessionImages(index, 'parent-sess', 'sub-img')).toEqual(['data:image/gif;base64,SSSSSSSS']);
        // Ordinary parent moment: no composite key, falls back to the session file.
        expect(callGetSessionImages(index, 'parent-sess', 'p-1')).toEqual(['data:image/png;base64,PPPPPPPP']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});