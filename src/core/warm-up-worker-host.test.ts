/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, type SendHandle } from 'child_process';
import type { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWarmUpWorker } from './warm-up-worker-host';
import { isWarmUpWorkerRequest } from './warm-up-worker-protocol';

interface ThreadStub extends EventEmitter {
  path: string;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
const { threads } = vi.hoisted(() => {
  const threads: ThreadStub[] = [];
  return { threads };
});
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(() => Promise.resolve(0));
    constructor(readonly path: string) { super(); threads.push(this); }
  } };
});

const payload = { sessions: [], editLocIndex: new Map(), workspaces: new Map() };
const response = { type: 'result', antiPatterns: null, configHealth: null };

describe('warm-up worker transport', () => {
  beforeEach(() => { vi.useFakeTimers(); threads.length = 0; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function child() {
    const worker = new ChildProcess();
    const send = vi.fn(() => true);
    worker.send = send;
    const terminate = vi.spyOn(worker, 'kill').mockReturnValue(true);
    return { worker, terminate, send };
  }

  it('defers IPC transfer, preserves Maps and settles once even if exit follows the result', async () => {
    const { worker, terminate, send } = child();
    const fork = vi.fn(() => worker);
    const result = runWarmUpWorker(payload, fork);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(fork).toHaveBeenCalledWith(expect.stringContaining('warm-up-worker.js'), [], {
      serialization: 'advanced', execArgv: [],
    });
    expect(send).toHaveBeenCalledWith(payload, expect.any(Function));
    worker.emit('message', response);
    worker.emit('exit', 0);
    worker.emit('message', { type: 'error', message: 'late message' });
    await expect(result).resolves.toEqual({ antiPatterns: null, configHealth: null });
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same lifecycle for worker threads', async () => {
    const result = runWarmUpWorker(payload);
    await vi.advanceTimersByTimeAsync(0);
    const worker = threads[0];
    expect(worker.path).toContain('warm-up-worker.js');
    expect(worker.postMessage).toHaveBeenCalledWith(payload);
    worker.emit('message', response);
    await expect(result).resolves.toEqual({ antiPatterns: null, configHealth: null });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['error', new Error('worker failed'), 'worker failed'],
    ['exit', 0, 'exited before a result (0)'],
    ['message', { type: 'error', message: 'analysis failed' }, 'analysis failed'],
    ['message', { type: 'unexpected' }, 'Invalid warm-up worker response'],
  ])('rejects %s and clears both timers', async (event, value, message) => {
    const { worker, terminate } = child();
    const rejected = expect(runWarmUpWorker(payload, () => worker)).rejects.toThrow(message);
    await vi.advanceTimersByTimeAsync(0);
    worker.emit(event, value);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a fork spawn failure', async () => {
    await expect(runWarmUpWorker(payload, () => { throw new Error('spawn failed'); })).rejects.toThrow('spawn failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures an immediate asynchronous spawn error before sending data', async () => {
    const { worker, terminate, send } = child();
    await expect(runWarmUpWorker(payload, () => {
      process.nextTick(() => worker.emit('error', new Error('spawn unavailable')));
      return worker;
    })).rejects.toThrow('spawn unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an asynchronous IPC send error', async () => {
    const { worker, terminate } = child();
    worker.send = vi.fn((_message: unknown, handleOrCallback?: SendHandle | ((error: Error | null) => void)) => {
      if (typeof handleOrCallback === 'function') handleOrCallback(new Error('IPC closed'));
      return false;
    });
    const rejected = expect(runWarmUpWorker(payload, () => worker)).rejects.toThrow('IPC closed');
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([['fork', 120_000], ['thread', 30_000]] as const)('retains the %s timeout', async (kind, timeout) => {
    const { worker, terminate } = child();
    const result = runWarmUpWorker(payload, kind === 'fork' ? () => worker : undefined);
    const rejected = expect(result).rejects.toThrow(`worker timeout (${timeout / 1000}s)`);
    await vi.advanceTimersByTimeAsync(timeout - 1);
    const stop = kind === 'fork' ? terminate : threads[0].terminate;
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks the shared request shape and Map serialization', () => {
    expect(isWarmUpWorkerRequest(payload)).toBe(true);
    expect(isWarmUpWorkerRequest({ sessions: [], workspaces: undefined })).toBe(true);
    for (const invalid of [null, [], {}, { sessions: {} }, { sessions: [], workspaces: {} },
      { sessions: [], editLocIndex: {} }]) {
      expect(isWarmUpWorkerRequest(invalid)).toBe(false);
    }
  });
});
