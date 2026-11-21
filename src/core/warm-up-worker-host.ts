/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { EventEmitter } from 'events';
import type { ForkFn } from './parser-worker-host';
import type { WarmUpWorkerRequest, WarmUpWorkerResponse, WarmUpWorkerResult } from './warm-up-worker-protocol';

interface WarmUpEndpoint {
  events: EventEmitter;
  send(request: WarmUpWorkerRequest, onError: (error: Error) => void): void;
  terminate(): void;
}

async function loadEndpointFactory(forkWorker?: ForkFn): Promise<() => WarmUpEndpoint> {
  const workerPath = path.join(__dirname, 'warm-up-worker.js');
  if (forkWorker) return () => {
    const child = forkWorker(workerPath, [], { serialization: 'advanced', execArgv: [] });
    return {
      events: child,
      send: (request, onError) => { child.send(request, error => { if (error) onError(error); }); },
      terminate: () => { child.kill(); },
    };
  };
  const { Worker } = await import('worker_threads');
  return () => {
    const worker = new Worker(workerPath);
    return {
      events: worker,
      send: request => { worker.postMessage(request); },
      terminate: () => { void worker.terminate(); },
    };
  };
}

export async function runWarmUpWorker(request: WarmUpWorkerRequest, forkWorker?: ForkFn): Promise<WarmUpWorkerResult> {
  const createEndpoint = await loadEndpointFactory(forkWorker);
  const timeoutMs = forkWorker ? 120_000 : 30_000;
  return new Promise((resolve, reject) => {
    // Do not yield between spawning a worker and attaching its error listener.
    const endpoint = createEndpoint();
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(deferredSend);
      endpoint.terminate();
      complete();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const timeout = setTimeout(() => fail(new Error(`worker timeout (${timeoutMs / 1000}s)`)), timeoutMs);

    endpoint.events.on('message', (message: WarmUpWorkerResponse) => {
      if (message?.type === 'result') finish(() => resolve({
        antiPatterns: message.antiPatterns, configHealth: message.configHealth,
      }));
      else if (message?.type === 'error') fail(new Error(message.message));
      else fail(new Error('Invalid warm-up worker response'));
    });
    endpoint.events.on('error', fail);
    endpoint.events.on('exit', (code: number | null) => fail(new Error(`warm-up worker exited before a result (${code})`)));

    // Defer the structured clone so the loading screen can paint first.
    const deferredSend = setTimeout(() => {
      if (settled) return;
      try {
        endpoint.send(request, fail);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  });
}
