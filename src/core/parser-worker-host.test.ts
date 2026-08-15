/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the out-of-process parse worker host (issue #106). Drives parseAllLogsViaWorker
 * against an in-memory fake child process so the chunked-IPC assembly, ack backpressure, error
 * handling, and OOM retry can be unit-tested without spawning a real worker. */

import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import { parseAllLogsViaWorker, isRetryableWorkerError } from './parser-worker-host';
import { createSession, createRequest } from './parser-shared';
import { runtimeDebug } from './runtime-debug';
import type { WorkerChunkPayload, WorkerDonePayload } from './parse-chunking';

vi.mock('./runtime-debug', () => ({ runtimeDebug: vi.fn() }));
const runtimeDebugMock = vi.mocked(runtimeDebug);

/** Minimal stand-in for the forked child process: an EventEmitter with spied send/kill. */
class FakeChild extends EventEmitter {
  send = vi.fn();
  kill = vi.fn();
}

type ForkLike = (...args: unknown[]) => FakeChild;

/** A fork impl that records every child it hands out (one per attempt). */
function queuedFork(): { fork: ForkLike; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const fork: ForkLike = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { fork, children };
}

function doneMessage(overrides: Partial<{ skippedFiles: number; skippedLines: number }> = {}) {
  const payload: WorkerDonePayload & {
    dirMetas: Record<string, never>;
    parseWarningCounts?: { skippedFiles: number; skippedLines: number };
  } = {
    workspaces: [],
    orphanEditLoc: [],
    orphanSources: [],
    dirMetas: {},
    parseWarningCounts: { skippedFiles: overrides.skippedFiles ?? 0, skippedLines: overrides.skippedLines ?? 0 },
  };
  return { type: 'done' as const, payload };
}

function chunkMessage(seq: number, sessionId: string) {
  const payload: WorkerChunkPayload = {
    sessions: [createSession({
      sessionId,
      workspaceId: 'ws1',
      workspaceName: 'workspace',
      harness: 'Local Agent',
      requests: [createRequest({ requestId: `${sessionId}-r1`, messageText: 'hi', responseText: 'there' })],
    })],
    editLocEntries: [],
    sourceEntries: [],
  };
  return { type: 'chunk' as const, seq, payload };
}

describe('isRetryableWorkerError', () => {
  it.each([
    'JavaScript heap out of memory',
    'Reached heap memory limit',
    'Child process killed by SIGABRT',
    'Child process killed by SIGKILL',
    'Child process exited with code 134',
  ])('treats %j as retryable', (message) => {
    expect(isRetryableWorkerError(message)).toBe(true);
  });

  it.each([
    'failed to start parse worker child process',
    'parse worker timeout (10m)',
    'Unexpected token in JSON',
  ])('treats %j as non-retryable', (message) => {
    expect(isRetryableWorkerError(message)).toBe(false);
  });
});

describe('parseAllLogsViaWorker IPC orchestration', () => {
  it('forwards progress messages to onProgress', async () => {
    const { fork, children } = queuedFork();
    const onProgress = vi.fn();
    const promise = parseAllLogsViaWorker(['dir'], onProgress, { fork: fork as never });

    children[0].emit('message', { type: 'progress', progress: { phase: 2, pct: 30, detail: '1/3: ws' } });
    children[0].emit('message', doneMessage());
    await promise;

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 2, pct: 30 }));
  });

  it('acks each chunk and assembles the streamed sessions', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });
    const child = children[0];

    child.emit('message', chunkMessage(0, 's1'));
    child.emit('message', chunkMessage(1, 's2'));
    child.emit('message', doneMessage());
    const result = await promise;

    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    // Each chunk is acked back to the worker so it can release its in-flight window.
    expect(child.send).toHaveBeenCalledWith({ type: 'ack', seq: 0 });
    expect(child.send).toHaveBeenCalledWith({ type: 'ack', seq: 1 });
  });

  it('resolves with the worker-reported skipped counts on done', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });

    children[0].emit('message', doneMessage({ skippedFiles: 4, skippedLines: 17 }));
    const result = await promise;

    expect(result.parseWarnings).toEqual({ skippedFiles: 4, skippedLines: 17 });
  });

  it('rejects when the worker posts an error message', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });

    children[0].emit('message', { type: 'error', message: 'Unexpected token in JSON' });

    await expect(promise).rejects.toThrow('Unexpected token in JSON');
  });

  it('rejects without retrying when the child emits a non-retryable error event', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });

    children[0].emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');
    expect(children).toHaveLength(1);
  });

  it('rejects when both attempts exit before sending done', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });

    // A bare exit is retryable ("exited with code N"), so attempt 1 triggers a second fork; when
    // that also exits the failure finally propagates.
    children[0].emit('exit', 1, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].emit('exit', 1, null);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it('retries once at a higher heap ceiling after a retryable crash', async () => {
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });

    // Attempt 1 dies with a retryable exit, so the host forks a second worker.
    children[0].emit('exit', 134, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));

    children[1].emit('message', doneMessage({ skippedFiles: 1, skippedLines: 0 }));
    const result = await promise;

    expect(result.parseWarnings?.skippedFiles).toBe(1);
  });

  it('emits a per-phase sync-timing summary on done', async () => {
    runtimeDebugMock.mockClear();
    const { fork, children } = queuedFork();
    const promise = parseAllLogsViaWorker(['dir'], undefined, { fork: fork as never });
    const child = children[0];

    child.emit('message', { type: 'progress', progress: { phase: 1, pct: 5, detail: 'fingerprints' } });
    child.emit('message', { type: 'progress', progress: { phase: 2, pct: 40, detail: 'cold parse' } });
    child.emit('message', doneMessage());
    await promise;

    const timingCall = runtimeDebugMock.mock.calls.find(
      (call) => call[0] === 'parser' && call[1] === 'worker-phase-timing',
    );
    expect(timingCall).toBeDefined();
    const detail = typeof timingCall?.[2] === 'string' ? timingCall[2] : '';
    expect(detail).toMatch(/totalMs=\d+/);
    expect(detail).toMatch(/p1=\d+ms/);
    expect(detail).toMatch(/p2=\d+ms/);
  });
});
