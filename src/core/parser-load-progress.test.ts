/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Dirent } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, expect, it, vi } from 'vitest';

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
  EXTERNAL_HARNESS_SET: new Set(['Claude', 'Codex', 'OpenCode']),
}));

vi.mock('./cache', () => ({
  getMemoryCache: vi.fn(() => null),
  setMemoryCache: vi.fn(),
  computeDirMetasAsync: vi.fn(() => Promise.resolve({})),
  loadCacheData: vi.fn(() => Promise.resolve(null)),
  saveCacheData: vi.fn(() => Promise.resolve(true)),
  findStaleDirs: vi.fn(() => ({ stale: new Set(), removed: new Set() })),
  clearCache: vi.fn(),
  stripSessionsForMemory: vi.fn(),
}));

import type { ParseResult } from './parser';
import type { Session } from './types';
import { parseAllLogsAsyncDetailed } from './parser';
import { findStaleDirs, loadCacheData } from './cache';
import { processWorkspaceEntryAsync, scanVsCodeDirs } from './parser-vscode';

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
  vi.mocked(scanVsCodeDirs).mockReturnValue({ entries: [], totalDirs: 0 });
  vi.mocked(processWorkspaceEntryAsync).mockResolvedValue('');
  vi.mocked(loadCacheData).mockResolvedValue(null);
  vi.mocked(findStaleDirs).mockReturnValue({ stale: new Set(), removed: new Set() });
});

type ProgressUpdate = Parameters<NonNullable<Parameters<typeof parseAllLogsAsyncDetailed>[1]>>[0];

function expectForwardOnly(progress: ProgressUpdate[]): void {
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i].phase, `phase at update ${i}: ${progress[i].detail}`).toBeGreaterThanOrEqual(progress[i - 1].phase);
    expect(progress[i].pct, `pct at update ${i}: ${progress[i].detail}`).toBeGreaterThanOrEqual(progress[i - 1].pct);
  }
}

it('reports a cached load in phase order, with the CLI re-read as countable progress', async () => {
  const cliDir = path.join(os.homedir(), '.copilot', 'session-state');
  const cachedResult = makeResult();
  cachedResult.sessions.push(makeSession({ sessionId: 'cached-vscode' }));
  vi.mocked(loadCacheData).mockResolvedValue({ result: cachedResult, dirMetas: {} });
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: cliDir, dirEntries: [dirEntry('cli-a'), dirEntry('cli-b'), dirEntry('cli-c')] }],
    totalDirs: 3,
  });
  vi.mocked(processWorkspaceEntryAsync).mockImplementation((_logsDir, wsId, _harness, ctx) => {
    ctx.sessions.push(makeSession({
      sessionId: wsId,
      harness: 'GitHub Copilot CLI',
      workspaceRootPath: path.join(os.homedir(), 'work', `repo-${wsId}`),
    }));
    return Promise.resolve(`repo-${wsId}`);
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed([cliDir], update => { progress.push({ ...update }); });

  expectForwardOnly(progress);
  const items = progress.filter(update => update.item).map(update => update.item!);
  expect(items.map(item => `${item.kind} ${item.index}/${item.total} ${item.folder}`)).toEqual([
    'cli-session 1/3 repo-cli-a',
    'cli-session 2/3 repo-cli-b',
    'cli-session 3/3 repo-cli-c',
  ]);
  expect(items.every(item => item.path.startsWith('~') && item.status === 'parsed')).toBe(true);
  expect(progress.find(update => update.workspacePlan)?.workspacePlan).toHaveLength(3);
  expect(progress.at(-1)).toMatchObject({ phase: 3, detail: 'Found 4 sessions', sessions: 4 });
});

it('keeps an incremental load moving forward through changed workspaces and the CLI re-read', async () => {
  const cliDir = path.join(os.homedir(), '.copilot', 'session-state');
  const staleDir = path.join('/logs/vscode', 'ws-stale');
  const cachedResult = makeResult();
  vi.mocked(loadCacheData).mockResolvedValue({ result: cachedResult, dirMetas: {} });
  vi.mocked(findStaleDirs).mockReturnValue({ stale: new Set([staleDir]), removed: new Set() });
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: cliDir, dirEntries: [dirEntry('cli-a'), dirEntry('cli-b')] }],
    totalDirs: 2,
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed(['/logs/vscode', cliDir], update => { progress.push({ ...update }); });

  expectForwardOnly(progress);
  expect(progress.filter(update => update.workspacePlan)).toHaveLength(1);
  expect(progress.filter(update => update.item).map(update => `${update.item!.kind} ${update.item!.index}/${update.item!.total}`))
    .toEqual(['workspace 1/1', 'cli-session 1/2', 'cli-session 2/2']);
});

it('never puts the home folder in progress sent during a cold parse', async () => {
  const home = os.homedir();
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-1')] }],
    totalDirs: 1,
  });
  vi.mocked(processWorkspaceEntryAsync).mockImplementation((...args: Parameters<typeof processWorkspaceEntryAsync>) => {
    const [, wsId, , ctx, onWorkspaceProgress] = args;
    const root = path.join(home, 'source', 'my-api');
    onWorkspaceProgress?.({ wsName: root, detail: 'chat 1/1', completed: 1, total: 1 });
    ctx.sessions.push(makeSession({ sessionId: wsId, workspaceRootPath: root }));
    return Promise.resolve(root);
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed(['/logs/vscode'], update => { progress.push({ ...update }); });

  const shown = progress.flatMap(update => [update.detail ?? '', update.item?.path ?? '', update.item?.folder ?? '']);
  expect(shown.filter(text => text.toLowerCase().includes(home.toLowerCase()))).toEqual([]);
  const done = progress.filter(update => update.item?.status && update.item.status !== 'reading').map(update => update.item!);
  expect(done).toEqual([expect.objectContaining({
    kind: 'workspace', index: 1, total: 1, folder: 'my-api', path: path.join('~', 'source', 'my-api'), sessions: 1, status: 'parsed',
  })]);
  expect(progress.find(update => update.item?.status === 'reading')?.detail).toBe(`workspace 1/1: ${path.join('~', 'source', 'my-api')} — chat 1/1`);
});

it('uses the source index for the folder of VS Code chat sessions, so same-named folders stay distinct', async () => {
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-a'), dirEntry('ws-b')] }],
    totalDirs: 2,
  });
  vi.mocked(processWorkspaceEntryAsync).mockImplementation((...args: Parameters<typeof processWorkspaceEntryAsync>) => {
    const [, wsId, , ctx] = args;
    // Chat sessions keep their root in the source index, not on the session, and the parser
    // resolves only the folder name.
    ctx.sessions.push(makeSession({ sessionId: wsId }));
    ctx.sessionSourceIndex.set(wsId, {
      kind: 'vscode-session-file', filePath: `/logs/vscode/${wsId}/chat.json`, workspaceId: wsId, workspaceName: 'api', harness: 'VS Code',
      workspaceRootPath: path.join(os.homedir(), wsId === 'ws-a' ? 'team-a' : 'team-b', 'api'),
    });
    return Promise.resolve('api');
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed(['/logs/vscode'], update => { progress.push({ ...update }); });

  const done = progress.filter(update => update.item && update.item.status !== 'reading').map(update => update.item!.path);
  expect(done).toEqual([path.join('~', 'team-a', 'api'), path.join('~', 'team-b', 'api')]);
});

it('reports reading progress inside a large CLI session on a cached load', async () => {
  const cliDir = path.join(os.homedir(), '.copilot', 'session-state');
  vi.mocked(loadCacheData).mockResolvedValue({ result: makeResult(), dirMetas: {} });
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: cliDir, dirEntries: [dirEntry('cli-a'), dirEntry('cli-b')] }],
    totalDirs: 2,
  });
  vi.mocked(processWorkspaceEntryAsync).mockImplementation((...args: Parameters<typeof processWorkspaceEntryAsync>) => {
    const [, wsId, , ctx, onWorkspaceProgress] = args;
    onWorkspaceProgress?.({ wsName: `repo-${wsId}`, detail: 'events.jsonl 50%', completed: 1, total: 2 });
    ctx.sessions.push(makeSession({ sessionId: wsId, harness: 'GitHub Copilot CLI' }));
    return Promise.resolve(`repo-${wsId}`);
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed([cliDir], update => { progress.push({ ...update }); });

  const reading = progress.filter(update => update.item?.status === 'reading');
  expect(reading.map(update => `${update.item!.kind} ${update.item!.index}/${update.item!.total} ${update.detail}`)).toEqual([
    'cli-session 1/2 session 1/2: repo-cli-a — events.jsonl 50%',
    'cli-session 2/2 session 2/2: repo-cli-b — events.jsonl 50%',
  ]);
  // Half way through the first of two sessions is a quarter of the way through phase 2 (10–75%).
  expect(reading[0].pct).toBe(26);
  for (let i = 1; i < progress.length; i++) expect(progress[i].pct).toBeGreaterThanOrEqual(progress[i - 1].pct);
});

it('shows a workspace opened in the home folder as "~" while reading and when it has no sessions', async () => {
  vi.mocked(scanVsCodeDirs).mockReturnValue({
    entries: [{ logsDir: '/logs/vscode', dirEntries: [dirEntry('ws-home')] }],
    totalDirs: 1,
  });
  vi.mocked(processWorkspaceEntryAsync).mockImplementation((...args: Parameters<typeof processWorkspaceEntryAsync>) => {
    const [, wsId, , ctx, onWorkspaceProgress] = args;
    // The parser resolves only the folder name, which for the home folder is the user name.
    const name = path.basename(os.homedir());
    ctx.workspaceRoots?.set(wsId, os.homedir());
    onWorkspaceProgress?.({ wsName: name, rootPath: os.homedir(), detail: 'chat 1/1', completed: 1, total: 1 });
    return Promise.resolve(name);
  });
  const progress: ProgressUpdate[] = [];

  await parseAllLogsAsyncDetailed(['/logs/vscode'], update => { progress.push({ ...update }); });

  const items = progress.filter(update => update.item).map(update => `${update.item!.status} ${update.item!.folder} ${update.item!.path}`);
  expect(items).toEqual(['reading ~ ~', 'parsed ~ ~']);
});
