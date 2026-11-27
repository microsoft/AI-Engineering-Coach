/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The Timeline lane-text RPC: a Range view's lane can list many more turns than a day or a week, and its scope must
 * still reach the reader; past the shared limit nothing is read. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Analyzer } from '../core/analyzer';
import { loadTimelineTextFromDisk, type ParseResult } from '../core/cache';
import { createRequest, createSession } from '../core/parser-shared';
import { MAX_TEXT_SCOPE_TURNS } from '../core/timeline-model';
import { getRpcHandler } from './panel-rpc';

vi.mock('../core/cache', async importOriginal => ({
  ...await importOriginal<typeof import('../core/cache')>(),
  loadTimelineTextFromDisk: vi.fn((sessionId: string) => Promise.resolve({ sessionId, turns: [], waits: [] })),
}));

const T0 = new Date(2026, 4, 1, 9).getTime();
const session = createSession({
  sessionId: 'cli', workspaceId: 'ws', workspaceName: 'Project', harness: 'GitHub Copilot CLI',
  requests: [createRequest({ timestamp: T0, messageText: 'Fix it', responseText: 'Done' })],
});
const analyzer = new Analyzer([session], new Map());
const parsed: ParseResult = { sessions: [session], workspaces: new Map(), editLocIndex: new Map(), sessionSourceIndex: new Map() };
const read = (turns: number) => getRpcHandler('getTimelineSessionText')!(analyzer, parsed, {
  sessionId: 'cli', scope: { from: T0, to: T0 + 92 * 86_400_000, turns: Array.from({ length: turns }, (_, i) => ({ t: T0 + i * 60_000 })) },
});

describe('getTimelineSessionText', () => {
  beforeEach(() => vi.mocked(loadTimelineTextFromDisk).mockClear());

  it('reads a long range lane’s scope', async () => {
    await read(6_000);
    expect(loadTimelineTextFromDisk).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadTimelineTextFromDisk).mock.calls[0][1].turns).toHaveLength(6_000);
  });

  it('reads nothing past the shared limit', async () => {
    expect(await read(MAX_TEXT_SCOPE_TURNS + 1)).toBeNull();
    expect(loadTimelineTextFromDisk).not.toHaveBeenCalled();
  });
});
