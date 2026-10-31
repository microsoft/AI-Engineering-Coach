/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Cache write worker — commits cache data to disk off the main thread and reports the outcome. */

import { parentPort, workerData } from 'worker_threads';
import { isCacheWritePayload, writeCacheFilesSync, type CacheWriteWorkerResult } from './cache-write';

let result: CacheWriteWorkerResult;
try {
  if (!isCacheWritePayload(workerData)) {
    throw new Error('Invalid worker payload');
  }
  result = { ok: true, bytes: writeCacheFilesSync(workerData) };
} catch (e) {
  result = { ok: false, error: e instanceof Error ? e.message : String(e) };
}
parentPort?.postMessage(result);
