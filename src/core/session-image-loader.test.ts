/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionImageLoader } from './session-image-loader';
import type { SessionSourceRequest } from './session-images';
import type { SessionSource } from './cache';

class FakeWorker extends EventEmitter {
  requests: SessionSourceRequest[] = [];
  terminate = vi.fn(() => Promise.resolve(0));
  unref(): void {}
  postMessage(request: SessionSourceRequest): void {
    this.requests.push(request);
  }
}

const source: SessionSource = {
  kind: 'cli-events', filePath: 'events.jsonl', workspaceId: 'ws', workspaceName: 'Workspace', harness: 'Copilot',
};
const loaders: SessionImageLoader[] = [];

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('image worker lifecycle', () => {
  it('serializes image jobs and reuses one worker across requests', async () => {
    const worker = new FakeWorker();
    const create = vi.fn(() => worker);
    const loader = new SessionImageLoader(create);
    loaders.push(loader);
    const first = loader.load(source, 'session', 'first');
    const second = loader.load(source, 'session', 'second');
    await Promise.resolve();
    expect(worker.requests).toMatchObject([{ type: 'session-images', requestId: 'first' }]);
    worker.emit('message', { type: 'session-images', images: ['data:image/png;base64,first'] });
    expect(await first).toEqual(['data:image/png;base64,first']);
    await Promise.resolve();
    expect(worker.requests).toMatchObject([{ requestId: 'first' }, { requestId: 'second' }]);
    worker.emit('message', { type: 'session-images', images: [] });
    expect(await second).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('surfaces worker failures and allows the next request to restart the worker', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workers: FakeWorker[] = [];
    const loader = new SessionImageLoader(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    loaders.push(loader);
    const first = loader.load(source, 'session', 'first');
    const rejected = expect(first).rejects.toThrow('read failed');
    await Promise.resolve();
    workers[0].emit('message', { type: 'error', message: 'read failed' });
    await rejected;
    const next = loader.load(source, 'session', 'next');
    await Promise.resolve();
    workers[1].emit('message', { type: 'session-images', images: [] });
    expect(await next).toEqual([]);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates idle workers and timed-out jobs', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new FakeWorker();
    const loader = new SessionImageLoader(() => worker);
    loaders.push(loader);
    const result = loader.load(source, 'session', 'first');
    await Promise.resolve();
    worker.emit('message', { type: 'session-images', images: [] });
    await result;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const pending = loader.load(source, 'session', 'next');
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(2);
  });

  it('queues session details off-thread and validates detail replies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new FakeWorker();
    const loader = new SessionImageLoader(() => worker);
    loaders.push(loader);
    const detail = loader.loadSession(source, 'session');
    await Promise.resolve();
    expect(worker.requests).toEqual([{ type: 'session-detail', source, sessionId: 'session' }]);
    worker.emit('message', { type: 'session-detail', session: null });
    expect(await detail).toBeNull();
    const invalid = loader.loadSession(source, 'session');
    const rejected = expect(invalid).rejects.toThrow();
    await Promise.resolve();
    worker.emit('message', { type: 'session-detail', session: { sessionId: 'session' } });
    await rejected;
  });

  it('takes from the worker only the fields a lane shows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = new FakeWorker();
    const loader = new SessionImageLoader(() => worker);
    loaders.push(loader);
    const request = { type: 'timeline-text' as const, source, sessionId: 'session', scope: { from: 0, to: 10, turns: [] }, labels: { names: [] } };
    const text = loader.loadTimelineText(request);
    await Promise.resolve();
    worker.emit('message', { type: 'timeline-text', text: { sessionId: 'session', turns: [{ t: 1, k: 'you', prompt: 'Go' }], waits: [] } });
    expect(await text).toEqual({ sessionId: 'session', turns: [{ t: 1, k: 'you', prompt: 'Go' }], waits: [] });
    // A reply carrying anything more of the session (here its raw response) is refused.
    const more = loader.loadTimelineText(request);
    const rejected = expect(more).rejects.toThrow();
    await Promise.resolve();
    worker.emit('message', { type: 'timeline-text', text: { sessionId: 'session', turns: [{ t: 1, k: 'you', responseText: 'raw' }], waits: [] } });
    await rejected;
  });

  it('extracts images and session details through the real bundled parse-worker protocol', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-image-worker-'));
    try {
      const workerPath = path.join(directory, 'parse-worker.cjs');
      await build({
        entryPoints: [path.resolve('src', 'core', 'parse-worker.ts')],
        outfile: workerPath, bundle: true, platform: 'node', format: 'cjs',
      });
      const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
      const events = path.join(directory, 'events.jsonl');
      fs.writeFileSync(events, [
        { type: 'session.start', data: { sessionId: 'session' } },
        { type: 'user.message', id: 'user', data: { content: 'Screenshot', variables: [{ kind: 'image', data: [...Buffer.from(base64, 'base64')] }] } },
        { type: 'assistant.message', id: 'answer', data: { content: 'Done' } },
      ].map(event => JSON.stringify(event)).join('\n'));
      const worker = new Worker(workerPath, { execArgv: [] });
      const loader = new SessionImageLoader(() => worker);
      loaders.push(loader);
      expect(await loader.load({ ...source, filePath: events }, 'session', 'answer')).toEqual([`data:image/png;base64,${base64}`]);
      const invalid = new Promise<unknown>(resolve => worker.once('message', resolve));
      worker.postMessage({ type: 'session-detail', source: null, sessionId: 'session' });
      expect(await invalid).toEqual({ type: 'error', message: 'Invalid session source request' });
      expect(await loader.load({ ...source, filePath: events }, 'session', 'unknown')).toEqual([]);
      expect(await loader.loadSession({ ...source, filePath: events }, 'session')).toMatchObject({
        sessionId: 'session',
        requests: [{ requestId: 'answer', messageText: 'Screenshot', responseText: 'Done' }],
      });
      fs.appendFileSync(events, `\n${JSON.stringify({ type: 'assistant.message', id: 'later-answer', data: { content: 'More work' } })}`);
      expect(await loader.load({ ...source, filePath: events }, 'session', 'answer', { userEventId: 'user', requestIndex: 0 }))
        .toEqual([`data:image/png;base64,${base64}`]);
      loader.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds one lane’s text in the bundled parse worker: its scope only, scrubbed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-text-worker-'));
    try {
      const workerPath = path.join(directory, 'parse-worker.cjs');
      await build({
        entryPoints: [path.resolve('src', 'core', 'parse-worker.ts')],
        outfile: workerPath, bundle: true, platform: 'node', format: 'cjs',
      });
      const at = (day: number, m: number) => new Date(2026, 4, day, 10, m).toISOString();
      const secret = 'ghp_' + 'Abc123'.repeat(6);
      const events = path.join(directory, 'events.jsonl');
      fs.writeFileSync(events, [
        { type: 'session.start', data: { sessionId: 'session' } },
        { type: 'user.message', timestamp: at(1, 0), id: 'u1', data: { content: 'Yesterday’s prompt' } },
        { type: 'tool.execution_start', timestamp: at(1, 1), data: { toolName: 'ask_user', toolCallId: 'q1', arguments: { question: 'Yesterday’s question?' } } },
        { type: 'tool.execution_complete', timestamp: at(1, 2), data: { toolCallId: 'q1', success: true, result: { content: 'User selected: no' } } },
        { type: 'user.message', timestamp: at(2, 0), id: 'u2', data: { content: `Deploy with ${secret}` } },
        { type: 'tool.execution_start', timestamp: at(2, 1), data: { toolName: 'ask_user', toolCallId: 'q2', arguments: { question: 'Today’s question?' } } },
        { type: 'tool.execution_complete', timestamp: at(2, 2), data: { toolCallId: 'q2', success: true, result: { content: 'User selected: yes' } } },
        { type: 'user.message', timestamp: at(2, 30), id: 'u3', data: { content: 'Not listed by the lane' } },
      ].map(event => JSON.stringify(event)).join('\n'));
      const worker = new Worker(workerPath, { execArgv: [] });
      const loader = new SessionImageLoader(() => worker);
      loaders.push(loader);
      const day = new Date(2026, 4, 2).getTime();
      const text = await loader.loadTimelineText({
        type: 'timeline-text', source: { ...source, filePath: events }, sessionId: 'session',
        scope: { from: day, to: day + 86_400_000, turns: [{ t: Date.parse(at(2, 0)), id: 'u2' }] }, labels: { names: [] },
      });
      expect(text?.turns.map(t => t.prompt)).toEqual(['Deploy with [secret]']);
      expect(text?.waits.map(w => w.ask)).toEqual(['Today’s question?']);
      expect(JSON.stringify(text)).not.toContain('Yesterday');
      // A malformed scope is refused, not read.
      const invalid = new Promise<unknown>(resolve => worker.once('message', resolve));
      worker.postMessage({ type: 'timeline-text', source: { ...source, filePath: events }, sessionId: 'session', scope: { from: 'x' }, labels: { names: [] } });
      expect(await invalid).toEqual({ type: 'error', message: 'Invalid session source request' });
      loader.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
