/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  stripSessionsForMemory,
  computeDirMetas,
  computeDirMetasAsync,
  findStaleDirs,
  getMemoryCache,
  setMemoryCache,
  loadSidebarStats,
  saveSidebarStats,
  loadTeamModeAuthState,
  saveTeamModeAuthState,
  clearCache,
  DirMetas,
  ParseResult,
} from './cache';
import { Session } from './types';
import { createRequest, createSession } from './parser-shared';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-engineer-coach-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(): Session {
  return createSession({
    sessionId: 's1',
    workspaceId: 'ws1',
    workspaceName: 'workspace',
    harness: 'Local Agent',
    requests: [createRequest({
      requestId: 'r1',
      messageText: 'a'.repeat(800),
      responseText: 'b'.repeat(1200),
      toolConfirmations: [{ toolId: 'terminal', confirmationType: 1, isTerminal: true, commandLine: 'npm test' }],
      todoSnapshot: [{ id: 1, title: 'ship fix', status: 'in-progress' }],
    })],
  });
}

describe('stripSessionsForMemory', () => {
  it('truncates request text and clears detail-only fields', () => {
    const sessions = [makeSession()];

    stripSessionsForMemory(sessions);

    const request = sessions[0].requests[0];
    expect(request.messageText.length).toBe(500);
    expect(request.responseText).toBe('');
    expect(request.toolConfirmations).toHaveLength(1);
    expect(request.toolConfirmations[0].commandLine).toBe('npm test');
    expect(request.todoSnapshot).toBeNull();
  });

  it('preserves analytics metadata needed after stripping', () => {
    const sessions = [makeSession()];
    const request = sessions[0].requests[0];
    const originalMessageLength = request.messageLength;
    const originalResponseLength = request.responseLength;
    const originalWorkType = request.workType;

    stripSessionsForMemory(sessions);

    expect(request.messageLength).toBe(originalMessageLength);
    expect(request.responseLength).toBe(originalResponseLength);
    expect(request.workType).toBe(originalWorkType);
    expect(request.aiCode).toEqual([]);
    expect(request.userCode).toEqual([]);
  });

  it('does not truncate short messages', () => {
    const session = createSession({
      sessionId: 's2',
      workspaceId: 'ws2',
      workspaceName: 'workspace',
      harness: 'Local Agent',
      requests: [createRequest({ requestId: 'r2', messageText: 'short msg', responseText: 'short resp' })],
    });
    stripSessionsForMemory([session]);
    expect(session.requests[0].messageText).toBe('short msg');
    expect(session.requests[0].responseText).toBe('');
  });
});

describe('computeDirMetas', () => {
  it('computes fingerprints for workspace dirs with chatSessions', () => {
    const logsDir = makeTempDir();
    const wsDir = path.join(logsDir, 'workspace1');
    const chatDir = path.join(wsDir, 'chatSessions');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'session1.json'), '{}');
    fs.writeFileSync(path.join(chatDir, 'session2.jsonl'), '{}');
    fs.writeFileSync(path.join(chatDir, 'readme.txt'), 'ignore');

    const metas = computeDirMetas([logsDir]);
    expect(metas[wsDir]).toBeDefined();
    expect(metas[wsDir].chatCount).toBe(2); // only .json/.jsonl
  });

  it('counts chatEditingSessions dirs', () => {
    const logsDir = makeTempDir();
    const wsDir = path.join(logsDir, 'workspace1');
    const editDir = path.join(wsDir, 'chatEditingSessions');
    fs.mkdirSync(path.join(editDir, 'edit1'), { recursive: true });
    fs.mkdirSync(path.join(editDir, 'edit2'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'chatSessions'), { recursive: true });

    const metas = computeDirMetas([logsDir]);
    expect(metas[wsDir].editCount).toBe(2);
  });

  it('skips Xcode and CLI directories', () => {
    const logsDir = makeTempDir();
    const xcodeDir = path.join(logsDir, '.config', 'github-copilot', 'xcode');
    fs.mkdirSync(path.join(xcodeDir, 'workspace1', 'chatSessions'), { recursive: true });

    const metas = computeDirMetas([xcodeDir]);
    expect(Object.keys(metas)).toHaveLength(0);
  });

  it('handles non-existent logsDirs gracefully', () => {
    const metas = computeDirMetas(['/non/existent/path']);
    expect(Object.keys(metas)).toHaveLength(0);
  });
});

describe('computeDirMetasAsync', () => {
  it('produces same results as sync version', async () => {
    const logsDir = makeTempDir();
    const wsDir = path.join(logsDir, 'workspace1');
    const chatDir = path.join(wsDir, 'chatSessions');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(chatDir, 'session1.json'), '{}');

    const syncMetas = computeDirMetas([logsDir]);
    const asyncMetas = await computeDirMetasAsync([logsDir]);
    expect(asyncMetas[wsDir].chatCount).toBe(syncMetas[wsDir].chatCount);
  });
});

describe('findStaleDirs', () => {
  it('detects stale dirs when metas differ', () => {
    const current: DirMetas = {
      '/ws1': { chatCount: 3, chatMaxMtime: 200, editCount: 1, editMaxMtime: 100 },
      '/ws2': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 },
    };
    const cached: DirMetas = {
      '/ws1': { chatCount: 2, chatMaxMtime: 150, editCount: 1, editMaxMtime: 100 },
      '/ws2': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 },
    };

    const { stale, removed } = findStaleDirs(current, cached);
    expect(stale.has('/ws1')).toBe(true);
    expect(stale.has('/ws2')).toBe(false);
    expect(removed.size).toBe(0);
  });

  it('detects removed dirs', () => {
    const current: DirMetas = { '/ws1': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 } };
    const cached: DirMetas = {
      '/ws1': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 },
      '/ws2': { chatCount: 2, chatMaxMtime: 200, editCount: 0, editMaxMtime: 0 },
    };

    const { stale, removed } = findStaleDirs(current, cached);
    expect(stale.size).toBe(0);
    expect(removed.has('/ws2')).toBe(true);
  });

  it('marks new dirs as stale', () => {
    const current: DirMetas = {
      '/ws1': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 },
      '/ws-new': { chatCount: 5, chatMaxMtime: 300, editCount: 0, editMaxMtime: 0 },
    };
    const cached: DirMetas = {
      '/ws1': { chatCount: 1, chatMaxMtime: 100, editCount: 0, editMaxMtime: 0 },
    };

    const { stale } = findStaleDirs(current, cached);
    expect(stale.has('/ws-new')).toBe(true);
  });
});

describe('memory cache', () => {
  it('getMemoryCache returns null initially after clearCache', () => {
    clearCache();
    expect(getMemoryCache()).toBeNull();
  });

  it('setMemoryCache stores data retrievable by getMemoryCache', () => {
    clearCache();
    const result: ParseResult = {
      workspaces: new Map([['ws1', { id: 'ws1', name: 'test', path: '/tmp' }]]),
      sessions: [],
      editLocIndex: new Map(),
      sessionSourceIndex: new Map(),
    };
    const dirMetas: DirMetas = {};
    setMemoryCache(result, dirMetas);
    const cached = getMemoryCache();
    expect(cached).not.toBeNull();
    expect(cached!.result.workspaces.get('ws1')?.name).toBe('test');
    clearCache();
  });
});

describe('sidebar stats', () => {
  it('saveSidebarStats and loadSidebarStats round-trip', () => {
    const stats = { harnesses: ['Local Agent', 'Xcode'], savedAt: Date.now() };
    saveSidebarStats(stats);
    const loaded = loadSidebarStats();
    expect(loaded).not.toBeNull();
    expect(loaded!.harnesses).toContain('Local Agent');
    expect(loaded!.savedAt).toBe(stats.savedAt);
  });
});

describe('team mode auth state', () => {
  it('saveTeamModeAuthState and loadTeamModeAuthState round-trip', () => {
    const state = {
      serverUrl: 'https://team.example',
      serverId: 'server-123',
      developerId: 'dev-123',
      accessToken: 'token-abc',
      role: 'member' as const,
      savedAt: Date.now(),
    };

    saveTeamModeAuthState(state);
    const loaded = loadTeamModeAuthState();

    expect(loaded).not.toBeNull();
    expect(loaded!.serverUrl).toBe(state.serverUrl);
    expect(loaded!.serverId).toBe(state.serverId);
    expect(loaded!.developerId).toBe(state.developerId);
    expect(loaded!.accessToken).toBe(state.accessToken);
    expect(loaded!.role).toBe(state.role);
    expect(loaded!.savedAt).toBe(state.savedAt);
  });
});
