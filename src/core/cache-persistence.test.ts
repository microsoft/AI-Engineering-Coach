/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Regression tests for parse-cache persistence. The parent of the parse worker terminates it as
 * soon as `done` arrives, so the cache write must already be on disk by then. Runs the real
 * bundled parse worker as a child process (through the production host) and as a worker thread,
 * and covers the in-thread fallback write and the crash-safe file replacement. */

import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, flushCacheWrites, loadCacheData, saveCacheData, type DirMetas, type ParseResult } from './cache';
import { getCacheDir } from './cache-paths';
import { removeStaleTempFiles, writeCacheFilesSync } from './cache-write';
import { createRequest, createSession } from './parser-shared';
import { parseAllLogsViaWorker } from './parser-worker-host';

let bundleDir: string;
let home: string;
let previousHome: { HOME?: string; USERPROFILE?: string };

beforeAll(async () => {
  // Bundle both workers side by side, as in dist/, so the parse worker finds cache-write-worker.js.
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-cache-bundle-'));
  await build({
    entryPoints: {
      'parse-worker': path.resolve('src', 'core', 'parse-worker.ts'),
      'cache-write-worker': path.resolve('src', 'core', 'cache-write-worker.ts'),
    },
    outdir: bundleDir, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
});

beforeEach(() => {
  previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aec-cache-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // clearCache() and loadCacheData() log a debug line for every missing or unreadable file.
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  process.env.HOME = previousHome.HOME;
  process.env.USERPROFILE = previousHome.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

/** One VS Code workspace with one chat session. */
function writeFixtureLogs(): string {
  const logsDir = path.join(home, 'workspaceStorage');
  const chatDir = path.join(logsDir, 'ws-persist', 'chatSessions');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'ws-persist', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(home).href }));
  const timestamp = Date.UTC(2026, 9, 1, 12);
  fs.writeFileSync(path.join(chatDir, 'session-persist.json'), JSON.stringify({
    sessionId: 'session-persist', creationDate: timestamp, lastMessageDate: timestamp + 60_000,
    requests: [{
      requestId: 'request-persist', timestamp, modelId: 'gpt-4o',
      message: { text: 'Add a regression test' }, response: [{ value: 'Added.' }],
    }],
  }));
  return logsDir;
}

function parseResultWith(sessionId: string): ParseResult {
  const session = createSession({
    sessionId, workspaceId: 'ws', workspaceName: 'workspace', harness: 'Local Agent',
    requests: [createRequest({ requestId: `${sessionId}-r1`, messageText: 'hello', responseText: '' })],
  });
  return {
    workspaces: new Map([['ws', { id: 'ws', name: 'workspace', path: '/ws' }]]),
    sessions: [session],
    editLocIndex: new Map(),
    sessionSourceIndex: new Map(),
  };
}

function cacheFiles(): string[] {
  return fs.readdirSync(getCacheDir()).filter(name => name !== 'runtime.log').sort();
}

function runtimeLog(): string {
  return fs.readFileSync(path.join(getCacheDir(), 'runtime.log'), 'utf-8');
}

async function loadedSessionIds(): Promise<string[] | undefined> {
  return (await loadCacheData())?.result.sessions.map(session => session.sessionId);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}

describe('cache persistence when the parse worker is terminated right after done', () => {
  it('child process: the host kills the child on done and the cache is already on disk', async () => {
    const logsDir = writeFixtureLogs();
    let child: ChildProcess | undefined;
    const result = await parseAllLogsViaWorker([logsDir], undefined, {
      fork: (_file, args, options) => {
        child = fork(path.join(bundleDir, 'parse-worker.js'), args, { ...options, env: childEnv() });
        return child;
      },
    });
    if (!child) throw new Error('parse worker was not forked');
    await exited(child);

    expect(result.sessions.map(session => session.sessionId)).toEqual(['session-persist']);
    expect(child.killed).toBe(true);
    expect(cacheFiles()).toEqual(['meta.json', 'parsed.json']);
    expect(await loadedSessionIds()).toEqual(['session-persist']);
    expect(runtimeLog()).toMatch(/\[cache\] write-complete \|[^\n]*via=worker/);
    expect(runtimeLog()).toMatch(/\[parse-worker\] cache-write-wait \|[^\n]*settled=true/);
  });

  it('worker thread: the parent terminates the worker on done and the cache is already on disk', async () => {
    const logsDir = writeFixtureLogs();
    const worker = new Worker(path.join(bundleDir, 'parse-worker.js'), { env: childEnv(), execArgv: [] });
    try {
      const outcome = new Promise<{ type: string; message?: string }>((resolve, reject) => {
        worker.on('message', (message: { type: string; message?: string }) => {
          if (message.type === 'done' || message.type === 'error') resolve(message);
        });
        worker.once('error', reject);
      });
      worker.postMessage({ logsDirs: [logsDir] });
      expect(await outcome).toMatchObject({ type: 'done' });
    } finally {
      await worker.terminate();
    }

    expect(cacheFiles()).toEqual(['meta.json', 'parsed.json']);
    expect(await loadedSessionIds()).toEqual(['session-persist']);
    expect(runtimeLog()).toMatch(/\[cache\] write-complete \|[^\n]*via=worker/);
  });
});

describe('in-thread fallback and the flush bound', () => {
  it('fallback: writes in-thread when the write worker is unavailable', async () => {
    // Unbundled sources have no cache-write-worker.js next to cache.ts: the same fallback runs
    // when worker_threads cannot start a worker.
    expect(fs.existsSync(path.resolve('src', 'core', 'cache-write-worker.js'))).toBe(false);
    const metas: DirMetas = { '/ws': { chatCount: 1, chatMaxMtime: 1, editCount: 0, editMaxMtime: 0 } };

    const write = saveCacheData(parseResultWith('session-fallback'), metas);
    // As in the parse worker: the save is not awaited, but flushed before the thread can end.
    expect(await flushCacheWrites()).toBe(true);

    await expect(write).resolves.toBe(true);
    expect(cacheFiles()).toEqual(['meta.json', 'parsed.json']);
    const loaded = await loadCacheData();
    expect(loaded?.result.sessions.map(session => session.sessionId)).toEqual(['session-fallback']);
    expect(loaded?.dirMetas).toEqual(metas);
    expect(runtimeLog()).toMatch(/\[cache\] write-complete \|[^\n]*via=in-thread/);
  });

  it('flushCacheWrites stops waiting for a stalled write after its timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseWrite!: () => void;
    const stalled = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(() => stalled);
    const write = saveCacheData(parseResultWith('session-stalled'), {});

    expect(await flushCacheWrites(50)).toBe(false);

    releaseWrite();
    // The temp file was never created, so committing it fails and nothing is published.
    await expect(write).resolves.toBe(false);
    expect(await flushCacheWrites(50)).toBe(true);
    expect(cacheFiles()).toEqual([]);
  });
});

describe('crash-safe cache commits', () => {
  it('keeps the previous cache loadable when a write dies before committing', async () => {
    await saveCacheData(parseResultWith('session-old'), {});
    // A write killed mid-file leaves only its partial temp file behind.
    fs.writeFileSync(path.join(getCacheDir(), `parsed.json.${process.pid}-0-0123abcd.tmp`), '{"workspaces":[["ws",');

    expect(await loadedSessionIds()).toEqual(['session-old']);
  });

  it('never commits the meta file when committing the data file fails', async () => {
    await saveCacheData(parseResultWith('session-old'), {});
    const dir = getCacheDir();
    const metaBefore = fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8');

    expect(() => writeCacheFilesSync({
      cacheFile: path.join(dir, 'missing-dir', 'parsed.json'),
      metaFile: path.join(dir, 'meta.json'),
      json: '{}',
      metaJson: '{"version":0}',
    })).toThrow();

    expect(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')).toBe(metaBefore);
    expect(cacheFiles()).toEqual(['meta.json', 'parsed.json']);
    expect(await loadedSessionIds()).toEqual(['session-old']);
  });

  it('pairs new data with the previous fingerprints if it stops between the two commits', async () => {
    const oldMetas: DirMetas = { '/ws': { chatCount: 1, chatMaxMtime: 1, editCount: 0, editMaxMtime: 0 } };
    await saveCacheData(parseResultWith('session-old'), oldMetas);
    const dir = getCacheDir();
    const newData = fs.readFileSync(path.join(dir, 'parsed.json'), 'utf-8').replaceAll('session-old', 'session-new');

    expect(() => writeCacheFilesSync({
      cacheFile: path.join(dir, 'parsed.json'),
      metaFile: path.join(dir, 'missing-dir', 'meta.json'),
      json: newData,
      metaJson: '{}',
    })).toThrow();

    // The previous fingerprints mark every workspace that changed since as stale, so it is re-parsed.
    const loaded = await loadCacheData();
    expect(loaded?.result.sessions.map(session => session.sessionId)).toEqual(['session-new']);
    expect(loaded?.dirMetas).toEqual(oldMetas);
  });
});

describe('recovering from damaged or abandoned cache files', () => {
  it('treats a torn data file as a cache miss', async () => {
    await saveCacheData(parseResultWith('session-old'), {});
    const file = path.join(getCacheDir(), 'parsed.json');
    const json = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, json.slice(0, Math.floor(json.length / 2)));

    expect(await loadCacheData()).toBeNull();
  });

  it('sweeps temp files left by killed writes, but not ones a live write may still own', () => {
    const dir = getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'parsed.json.123-4-deadbeef.tmp');
    const live = path.join(dir, 'meta.json.123-4-cafebabe.tmp');
    const unrelated = path.join(dir, 'notes.tmp');
    for (const file of [stale, live, unrelated]) fs.writeFileSync(file, 'x');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(stale, hourAgo, hourAgo);
    fs.utimesSync(unrelated, hourAgo, hourAgo);

    removeStaleTempFiles(dir);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
