/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @vitest-environment jsdom
 *
 * Regression test for the webview progress-message forwarder (issue #106). The loading-screen
 * telemetry strip silently showed nothing because `initMessageListener` rebuilt the progress
 * object field-by-field and dropped `telemetry`. This locks in that every progress field — most
 * importantly `telemetry` — is forwarded to the onProgress callback.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { WorkerTelemetry } from './shared';

const postMessage = vi.fn();

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage,
    getState: () => null,
    setState: () => { /* noop */ },
  });
});

function dispatch(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

describe('initMessageListener progress forwarding', () => {
  it('forwards telemetry alongside the rest of the progress payload', async () => {
    const { initMessageListener } = await import('./shared');
    const onProgress = vi.fn();
    const onDataReady = vi.fn();
    initMessageListener(onProgress, onDataReady);

    const telemetry: WorkerTelemetry = {
      rssMB: 700,
      heapUsedMB: 320,
      heapLimitMB: 4096,
      fileBufMB: 90,
      cpuPct: 55,
    };

    dispatch({
      type: 'progress',
      phase: 2,
      detail: 'Parsing session logs',
      pct: 15,
      sessions: 42,
      linesOfCode: 100,
      toolCalls: 7,
      imagesAnalyzed: 3,
      filesEdited: 11,
      requests: 21,
      telemetry,
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
    const arg = onProgress.mock.calls[0][0] as { telemetry?: WorkerTelemetry; phase: number; pct: number; sessions?: number };
    expect(arg.telemetry).toEqual(telemetry);
    // Sanity: existing fields still forwarded.
    expect(arg.phase).toBe(2);
    expect(arg.pct).toBe(15);
    expect(arg.sessions).toBe(42);
  });

  it('leaves telemetry undefined when the message omits it', async () => {
    const { initMessageListener } = await import('./shared');
    const onProgress = vi.fn();
    initMessageListener(onProgress, () => { /* noop */ });

    dispatch({ type: 'progress', phase: 1, pct: 5 });

    expect(onProgress).toHaveBeenCalled();
    const arg = onProgress.mock.calls.at(-1)![0] as { telemetry?: WorkerTelemetry };
    expect(arg.telemetry).toBeUndefined();
  });
});

describe('initMessageListener dataReady forwarding', () => {
  it('announces readiness after installing the message listener', async () => {
    const { initMessageListener } = await import('./shared');
    const onDataReady = vi.fn();
    await Promise.resolve();
    postMessage.mockClear();
    postMessage.mockImplementationOnce(() => dispatch({ type: 'dataReady', currentWorkspace: 'cached-app' }));
    initMessageListener(() => {}, onDataReady);
    expect(postMessage).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(onDataReady).toHaveBeenCalledWith('cached-app', { skippedFiles: 0, skippedLines: 0 });
  });

  it('forwards authoritative skipped counts from the dataReady payload', async () => {
    const { initMessageListener } = await import('./shared');
    const onDataReady = vi.fn();
    initMessageListener(() => { /* noop */ }, onDataReady);

    dispatch({ type: 'dataReady', currentWorkspace: 'my-app', skippedFiles: 3, skippedLines: 42 });

    expect(onDataReady).toHaveBeenCalledWith('my-app', { skippedFiles: 3, skippedLines: 42 });
  });

  it('defaults skipped counts to zero when the payload omits them', async () => {
    const { initMessageListener } = await import('./shared');
    const onDataReady = vi.fn();
    initMessageListener(() => { /* noop */ }, onDataReady);

    dispatch({ type: 'dataReady', currentWorkspace: 'my-app' });

    expect(onDataReady).toHaveBeenCalledWith('my-app', { skippedFiles: 0, skippedLines: 0 });
  });
});
