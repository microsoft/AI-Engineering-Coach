/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Warm-up worker entry point. */

import { parentPort } from 'worker_threads';
import { Analyzer } from './analyzer';
import { isWarmUpWorkerRequest, type WarmUpWorkerResponse } from './warm-up-worker-protocol';

const port: {
  on(event: 'message', listener: (message: unknown) => void): void;
  postMessage(message: WarmUpWorkerResponse): void;
} | null = parentPort ?? (process.send ? {
  on: (_event: 'message', listener: (message: unknown) => void) => process.on('message', listener),
  postMessage: (message: WarmUpWorkerResponse) => process.send!(message),
} : null);

if (!port) throw new Error('warm-up-worker: must run as a worker thread or forked child');

port.on('message', (msg) => {
  try {
    if (!isWarmUpWorkerRequest(msg)) throw new Error('Invalid warm-up worker payload');
    const analyzer = new Analyzer(msg.sessions, msg.editLocIndex, msg.workspaces);
    const antiPatterns = analyzer.getAntiPatterns();
    const configHealth = analyzer.getConfigHealth();

    port.postMessage({ type: 'result', antiPatterns, configHealth });
  } catch (e) {
    port.postMessage({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
});
