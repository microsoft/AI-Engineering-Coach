/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Dirent } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./parser-vscode', () => ({
  findVsCodeDirs: vi.fn(() => []),
  scanVsCodeDirs: vi.fn(() => ({ entries: [], totalDirs: 0 })),
  processWorkspaceEntry: vi.fn(),
  processWorkspaceEntryAsync: vi.fn(() => Promise.resolve('')),
  harnessFromPath: vi.fn(() => 'VS Code'),
}));

vi.mock('./parser-xcode', () => ({
  findXcodeDirs: vi.fn(() => []),
  parseXcodeDatabases: vi.fn(() => []),
  parseXcodeDatabasesAsync: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./parser-harnesses', () => ({
  collectExternalHarnessesSync: vi.fn(),
  collectExternalHarnessesAsync: vi.fn(() => Promise.resolve()),
  registerExternalHarnessSources: vi.fn(),
  EXTERNAL_HARNESS_SET: new Set(['Claude', 'Codex', 'OpenCode']),
}));

vi.mock('./cache', () => ({
  getMemoryCache: vi.fn(() => null),
  setMemoryCache: vi.fn(),
  computeDirMetasAsync: vi.fn(() => Promise.resolve({})),
  loadCacheData: vi.fn(() => Promise.resolve(null)),
  saveCacheData: vi.fn(() => Promise.resolve()),
  findStaleDirs: vi.fn(() => ({ stale: new Set(), removed: new Set() })),
  clearCache: vi.fn(),
  stripSessionsForMemory: vi.fn(),
}));

import type { ParseResult } from './parser';
import type { ParseContext } from './parser-shared';
import type { Session } from './types';
import { LOAD_PHASES, clearCache, findLogsDirs, parseAllLogs, parseAllLogsAsyncDetailed } from './parser';
import {
  clearCache as cacheClearCache,
  computeDirMetasAsync,
  findStaleDirs,
  getMemoryCache,
  loadCacheData,
  saveCacheData,
  setMemoryCache,
  stripSessionsForMemory,
} from './cache';
import {
  findVsCodeDirs,
  harnessFromPath,
  processWorkspaceEntry,
  processWorkspaceEntryAsync,
  scanVsCodeDirs,
} from './parser-vscode';
import {
  findXcodeDirs,
  parseXcodeDatabases,
  parseXcodeDatabasesAsync,
} from './parser-xcode';
import {
  collectExternalHarnessesAsync,
  collectExternalHarnessesSync,
} from './parser-harnesses';
import { createRequest } from './parser-shared';

const XCODE_DIR = path.join('/Users/test/.config/github-copilot/xcode');

function makeResult(): ParseResult {
  return {
    workspaces: new Map(),
    sessions: [],
    editLocIndex: new Map(),
    sessionSourceIndex: new Map(),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    workspaceName: 'Workspace 1',
    location: '/logs/workspace-1',
    harness: 'VS Code',
    creationDate: null,
    lastMessageDate: null,
    requestCount: 0,
    requests: [],
    ...overrides,
  };
}

function dirEntry(name: string): Dirent {
  return { name } as Dirent;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(findVsCodeDirs).mockReturnValue([]);
  vi.mocked(scanVsCodeDirs).mockReturnValue({ entries: [], totalDirs: 0 });
  vi.mocked(processWorkspaceEntry).mockImplementation(() => '');
  vi.mocked(processWorkspaceEntryAsync).mockResolvedValue('');
  vi.mocked(harnessFromPath).mockReturnValue('VS Code');

  vi.mocked(findXcodeDirs).mockReturnValue([]);
  vi.mocked(parseXcodeDatabases).mockReturnValue([]);
  vi.mocked(parseXcodeDatabasesAsync).mockResolvedValue([]);

  vi.mocked(collectExternalHarnessesSync).mockImplementation(() => {});
  vi.mocked(collectExternalHarnessesAsync).mockResolvedValue();

  vi.mocked(getMemoryCache).mockReturnValue(null);
  vi.mocked(setMemoryCache).mockImplementation(() => {});
  vi.mocked(computeDirMetasAsync).mockResolvedValue({});
  vi.mocked(loadCacheData).mockResolvedValue(null);
  vi.mocked(saveCacheData).mockResolvedValue();
  vi.mocked(findStaleDirs).mockReturnValue({ stale: new Set(), removed: new Set() });
  vi.mocked(stripSessionsForMemory).mockImplementation(() => {});
});

describe('LOAD_PHASES', () => {
  it('contains the expected phase labels in order', () => {
    expect(LOAD_PHASES).toEqual([
      'Discovering log directories',
      'Checking cache',
      'Parsing session logs',
      'Scanning external harnesses',
      'Preparing analytics',
      'Ready',
    ]);
  });
});

describe('findLogsDirs', () => {
  it('combines VS Code and Xcode directories', () => {
    vi.mocked(findVsCodeDirs).mockReturnValue(['/logs/vscode-a', '/logs/vscode-b']);
    vi.mocked(findXcodeDirs).mockReturnValue([XCODE_DIR]);

    expect(findLogsDirs()).toEqual(['/logs/vscode-a', '/logs/vscode-b', XCODE_DIR]);
  });
});

describe('parseAllLogs', () => {
  it('returns an empty result for empty logs dirs', () => {
    const result = parseAllLogs([]);

    expect(result).toEqual({
      workspaces: new Map(),
      sessions: [],
      editLocIndex: new Map(),
      sessionSourceIndex: new Map(),
    });
    expect(scanVsCodeDirs).toHaveBeenCalledWith([]);
  });

  it('processes each VS Code workspace entry', () => {
    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [
        { logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-1'), dirEntry('ws-2')] },
        { logsDir: '/logs/vscode-2', dirEntries: [dirEntry('ws-3')] },
      ],
      totalDirs: 3,
    });

    parseAllLogs(['/logs/vscode', '/logs/vscode-2']);

    expect(processWorkspaceEntry).toHaveBeenCalledTimes(3);
    expect(processWorkspaceEntry).toHaveBeenNthCalledWith(1, '/logs/vscode', 'ws-1', 'VS Code', expect.any(Object));
    expect(processWorkspaceEntry).toHaveBeenNthCalledWith(2, '/logs/vscode', 'ws-2', 'VS Code', expect.any(Object));
    expect(processWorkspaceEntry).toHaveBeenNthCalledWith(3, '/logs/vscode-2', 'ws-3', 'VS Code', expect.any(Object));
  });

  it('uses harnessFromPath for each VS Code logs dir', () => {
    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [{ logsDir: '/logs/custom', dirEntries: [dirEntry('ws-1')] }],
      totalDirs: 1,
    });
    vi.mocked(harnessFromPath).mockReturnValue('GitHub Copilot CLI');

    parseAllLogs(['/logs/custom']);

    expect(harnessFromPath).toHaveBeenCalledWith('/logs/custom');
    expect(processWorkspaceEntry).toHaveBeenCalledWith('/logs/custom', 'ws-1', 'GitHub Copilot CLI', expect.any(Object));
  });

  it('parses Xcode databases for Xcode directories', () => {
    vi.mocked(parseXcodeDatabases).mockReturnValue([
      makeSession({ sessionId: 'xcode-1', workspaceId: 'xc-ws', workspaceName: 'Xcode Workspace', harness: 'Xcode' }),
    ]);

    const result = parseAllLogs([XCODE_DIR]);

    expect(parseXcodeDatabases).toHaveBeenCalledWith(XCODE_DIR, result.editLocIndex);
    expect(result.sessions).toHaveLength(1);
    expect(result.workspaces.get('xc-ws')).toEqual({
      id: 'xc-ws',
      name: 'Xcode Workspace',
      path: XCODE_DIR,
    });
  });

  it('does not overwrite an existing workspace when Xcode adds sessions', () => {
    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('shared')] }],
      totalDirs: 1,
    });
    vi.mocked(processWorkspaceEntry).mockImplementation((_logsDir, wsId, _harness, ctx: ParseContext) => {
      ctx.workspaces.set(wsId, { id: wsId, name: 'VS Code Workspace', path: '/logs/vscode' });
      return '';
    });
    vi.mocked(parseXcodeDatabases).mockReturnValue([
      makeSession({ sessionId: 'xcode-1', workspaceId: 'shared', workspaceName: 'Xcode Workspace', harness: 'Xcode' }),
    ]);

    const result = parseAllLogs(['/logs/vscode', XCODE_DIR]);

    expect(result.workspaces.get('shared')).toEqual({
      id: 'shared',
      name: 'VS Code Workspace',
      path: '/logs/vscode',
    });
  });

  it('calls collectExternalHarnessesSync', () => {
    const result = parseAllLogs(['/logs/vscode']);

    expect(collectExternalHarnessesSync).toHaveBeenCalledWith(
      result.workspaces,
      result.sessions,
      result.editLocIndex,
    );
  });

  it('calls stripSessionsForMemory with parsed sessions', () => {
    vi.mocked(parseXcodeDatabases).mockReturnValue([
      makeSession({ sessionId: 'xcode-1', workspaceId: 'xc-ws', workspaceName: 'Xcode Workspace', harness: 'Xcode' }),
    ]);

    const result = parseAllLogs([XCODE_DIR]);

    expect(stripSessionsForMemory).toHaveBeenCalledWith(result.sessions);
  });
});

describe('parseAllLogsAsyncDetailed', () => {
  it('returns cached data on memory-cache hit', async () => {
    const cachedResult = makeResult();
    cachedResult.sessions.push(makeSession());
    const currentMetas = { '/logs/ws-1': { chatCount: 1, chatMaxMtime: 1, editCount: 0, editMaxMtime: 0 } };

    vi.mocked(computeDirMetasAsync).mockResolvedValue(currentMetas);
    vi.mocked(getMemoryCache).mockReturnValue({ result: cachedResult, dirMetas: { '/logs/ws-1': { chatCount: 1, chatMaxMtime: 1, editCount: 0, editMaxMtime: 0 } } });

    const parsed = await parseAllLogsAsyncDetailed(['/logs']);

    expect(parsed).toEqual({ result: cachedResult, dirMetas: currentMetas });
  });

  it('skips disk cache and full parsing on memory-cache hit', async () => {
    vi.mocked(getMemoryCache).mockReturnValue({ result: makeResult(), dirMetas: {} });

    await parseAllLogsAsyncDetailed(['/logs']);

    expect(loadCacheData).not.toHaveBeenCalled();
    expect(scanVsCodeDirs).toHaveBeenCalledWith([]);
    expect(processWorkspaceEntryAsync).not.toHaveBeenCalled();
    expect(setMemoryCache).not.toHaveBeenCalled();
  });

  it('refreshes external harnesses on memory-cache hit after removing old external sessions', async () => {
    const cachedResult = makeResult();
    cachedResult.sessions.push(
      makeSession({ sessionId: 'kept', harness: 'VS Code' }),
      makeSession({ sessionId: 'claude', harness: 'Claude' }),
      makeSession({ sessionId: 'claude-ghcp', harness: 'Claude' }),
      makeSession({ sessionId: 'codex', harness: 'Codex' }),
    );

    vi.mocked(getMemoryCache).mockReturnValue({ result: cachedResult, dirMetas: {} });

    const parsed = await parseAllLogsAsyncDetailed(['/logs']);

    expect(parsed.result.sessions.map(session => session.sessionId)).toEqual(['kept']);
    expect(collectExternalHarnessesAsync).toHaveBeenCalledWith(
      cachedResult.workspaces,
      cachedResult.sessions,
      cachedResult.editLocIndex,
      expect.any(Object),
    );
  });

  it('replaces empty OpenCode maps while preserving correlated empty Claude host maps', async () => {
    const cachedResult = makeResult();
    const openCodeRequest = createRequest({
      requestId: 'opencode-empty',
      messageText: '',
      responseText: '',
    });
    const claudeRequest = createRequest({
      requestId: 'claude-host-empty',
      messageText: '',
      responseText: '',
    });
    cachedResult.sessions.push(
      makeSession({
        sessionId: 'opencode',
        harness: 'OpenCode',
        requests: [openCodeRequest],
        requestCount: 1,
      }),
      makeSession({
        sessionId: 'claude',
        harness: 'Claude',
        requests: [claudeRequest],
        requestCount: 1,
      }),
    );
    cachedResult.editLocIndex.set('opencode-empty', new Map());
    cachedResult.editLocIndex.set('claude-host-empty', new Map());
    vi.mocked(getMemoryCache).mockReturnValue({ result: cachedResult, dirMetas: {} });

    const parsed = await parseAllLogsAsyncDetailed(['/logs']);

    expect(parsed.result.editLocIndex.has('opencode-empty')).toBe(false);
    expect(parsed.result.editLocIndex.get('claude-host-empty')).toEqual(new Map());
  });

  it('refreshes Copilot CLI/App and Xcode sessions on memory-cache hits', async () => {
    const cliDir = path.join('/Users/test', '.copilot', 'session-state');
    const cachedResult = makeResult();
    const oldCliRequest = createRequest({
      requestId: 'old-cli-request',
      messageText: '',
      responseText: '',
    });
    cachedResult.sessions.push(
      makeSession({
        sessionId: 'old-cli',
        harness: 'GitHub Copilot CLI',
        requests: [oldCliRequest],
        requestCount: 1,
      }),
      makeSession({ sessionId: 'old-xcode', harness: 'Xcode' }),
    );
    cachedResult.editLocIndex.set(
      'old-cli-request',
      new Map([['src/app.ts', { added: 10, removed: 0 }]]),
    );
    vi.mocked(getMemoryCache).mockReturnValue({ result: cachedResult, dirMetas: {} });
    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [{ logsDir: cliDir, dirEntries: [dirEntry('fresh-cli')] }],
      totalDirs: 1,
    });
    vi.mocked(parseXcodeDatabasesAsync).mockResolvedValue([
      makeSession({ sessionId: 'fresh-xcode', harness: 'Xcode' }),
    ]);

    const parsed = await parseAllLogsAsyncDetailed([cliDir, XCODE_DIR]);

    expect(parsed.result.sessions.map(session => session.sessionId)).toEqual(['fresh-xcode']);
    expect(parsed.result.editLocIndex.has('old-cli-request')).toBe(false);
    expect(processWorkspaceEntryAsync).toHaveBeenCalledWith(
      cliDir,
      'fresh-cli',
      'VS Code',
      expect.any(Object),
    );
    expect(parseXcodeDatabasesAsync).toHaveBeenCalledWith(XCODE_DIR, parsed.result.editLocIndex);
  });

  it('reports progress during a cold parse', async () => {
    const progress: Array<{ phase: number; detail?: string; workspacePlan?: string[]; workspaceDone?: string }> = [];

    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-1')] }],
      totalDirs: 1,
    });
    vi.mocked(processWorkspaceEntryAsync).mockImplementation((_logsDir, wsId, _harness, _ctx, onWorkspaceProgress) => {
      onWorkspaceProgress?.({ wsName: `Workspace ${wsId}`, detail: 'reading sessions', completed: 1, total: 1 });
      return Promise.resolve(`Workspace ${wsId}`);
    });

    await parseAllLogsAsyncDetailed(['/logs/vscode'], (update) => {
      progress.push(update);
    });

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some(update => update.detail === 'Computing directory fingerprints')).toBe(true);
    expect(progress.some(update => update.detail === 'Loading disk cache')).toBe(true);
    expect(progress.some(update => update.detail === 'Cold parse')).toBe(true);
    expect(progress.some(update => update.phase === 2 && Array.isArray(update.workspacePlan))).toBe(true);
    expect(progress.some(update => update.phase === 2 && typeof update.workspaceDone === 'string')).toBe(true);
  });

  it('processes each VS Code workspace asynchronously during cold parse', async () => {
    vi.mocked(scanVsCodeDirs).mockReturnValue({
      entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-1'), dirEntry('ws-2')] }],
      totalDirs: 2,
    });

    await parseAllLogsAsyncDetailed(['/logs/vscode']);

    expect(processWorkspaceEntryAsync).toHaveBeenCalledTimes(2);
    expect(processWorkspaceEntryAsync).toHaveBeenNthCalledWith(1, '/logs/vscode', 'ws-1', 'VS Code', expect.any(Object), expect.any(Function));
    expect(processWorkspaceEntryAsync).toHaveBeenNthCalledWith(2, '/logs/vscode', 'ws-2', 'VS Code', expect.any(Object), expect.any(Function));
  });

  it('parses Xcode databases asynchronously during cold parse', async () => {
    vi.mocked(parseXcodeDatabasesAsync).mockResolvedValue([
      makeSession({ sessionId: 'xcode-1', workspaceId: 'xc-ws', workspaceName: 'Xcode Workspace', harness: 'Xcode' }),
    ]);

    const parsed = await parseAllLogsAsyncDetailed([XCODE_DIR]);

    expect(parseXcodeDatabasesAsync).toHaveBeenCalledWith(XCODE_DIR, parsed.result.editLocIndex);
    expect(parsed.result.workspaces.get('xc-ws')).toEqual({
      id: 'xc-ws',
      name: 'Xcode Workspace',
      path: XCODE_DIR,
    });
  });

  it('calls collectExternalHarnessesAsync during cold parse', async () => {
    const parsed = await parseAllLogsAsyncDetailed(['/logs/vscode']);

    expect(collectExternalHarnessesAsync).toHaveBeenCalledWith(
      parsed.result.workspaces,
      parsed.result.sessions,
      parsed.result.editLocIndex,
      expect.any(Object),
    );
  });

  it('strips sessions and saves caches after cold parse', async () => {
    const currentMetas = { '/logs/ws-1': { chatCount: 2, chatMaxMtime: 10, editCount: 1, editMaxMtime: 5 } };
    vi.mocked(computeDirMetasAsync).mockResolvedValue(currentMetas);

    const parsed = await parseAllLogsAsyncDetailed(['/logs/vscode']);

    expect(stripSessionsForMemory).toHaveBeenCalledWith(parsed.result.sessions);
    expect(setMemoryCache).toHaveBeenCalledWith(parsed.result, currentMetas);
    expect(saveCacheData).toHaveBeenCalledWith(parsed.result, currentMetas);
  });

  it('reports loaded-from-memory progress on memory-cache hit', async () => {
    const progress: string[] = [];
    const cachedResult = makeResult();
    cachedResult.sessions.push(makeSession());

    vi.mocked(getMemoryCache).mockReturnValue({ result: cachedResult, dirMetas: {} });

    await parseAllLogsAsyncDetailed(['/logs'], (update) => {
      progress.push(update.detail ?? '');
    });

    expect(progress).toContain('Loaded from memory');
  });
});

describe('clearCache', () => {
  it('re-exports clearCache from cache', () => {
    clearCache();

    expect(cacheClearCache).toHaveBeenCalledTimes(1);
  });
});
