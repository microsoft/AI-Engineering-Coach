/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Crash-safe parse-cache writes, shared by cache-write-worker.ts and the in-thread fallback in
 * cache.ts.
 *
 * Each file is written to a unique temp file next to it and then renamed over the target, so a
 * write interrupted at any point (the parse process is killed, the disk fills up) leaves either
 * the previous file or the complete new one, never a truncated one. The data file is committed
 * before the meta file that vouches for it: stopping between the two pairs the new data with the
 * previous fingerprints, which only marks the changed workspaces stale so they are re-parsed.
 * No fsync: this is a cache, and a file torn by a power loss fails JSON.parse on load, which
 * falls back to a re-parse. */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { threadId } from 'worker_threads';

export interface CacheWritePayload {
  cacheFile: string;
  metaFile: string;
  json: string;
  metaJson: string;
}

/** Posted by cache-write-worker.js when it has finished. */
export type CacheWriteWorkerResult = { ok: true; bytes: number } | { ok: false; error: string };

export function isCacheWritePayload(value: unknown): value is CacheWritePayload {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.cacheFile === 'string' &&
    typeof data.metaFile === 'string' &&
    typeof data.json === 'string' &&
    typeof data.metaJson === 'string';
}

export function isCacheWriteWorkerResult(value: unknown): value is CacheWriteWorkerResult {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return data.ok === true ? typeof data.bytes === 'number' : data.ok === false && typeof data.error === 'string';
}

/** Owner-only: cached transcripts can contain secrets users pasted into chats. `wx` never opens
 *  an existing path, so two writers can never share a temp file. */
const TEMP_WRITE_OPTIONS = { encoding: 'utf-8', mode: 0o600, flag: 'wx' } as const;

const TEMP_FILE_PATTERN = /\.\d+-\d+-[0-9a-f]{8}\.tmp$/;

/** A live write commits within seconds; an older temp file was left by a killed write. */
const STALE_TEMP_FILE_MS = 15 * 60_000;

/** On Windows, renaming onto a file that another process has open (a second window loading the
 *  cache, an antivirus scan) fails transiently with EPERM, EACCES or EBUSY. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function tempPathFor(target: string): string {
  return `${target}.${process.pid}-${threadId}-${randomBytes(4).toString('hex')}.tmp`;
}

function renameRetryDelay(error: unknown, attempt: number): number | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RETRYABLE_RENAME_CODES.has(code) ? RENAME_RETRY_DELAYS_MS[attempt] : undefined;
}

function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const delay = renameRetryDelay(error, attempt);
      if (delay === undefined) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const delay = renameRetryDelay(error, attempt);
      if (delay === undefined) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/** Atomically replace `target` with `data`; returns the bytes written. */
function replaceFileSync(target: string, data: string): number {
  const temp = tempPathFor(target);
  try {
    fs.writeFileSync(temp, data, TEMP_WRITE_OPTIONS);
    const { size } = fs.statSync(temp);
    renameSyncWithRetry(temp, target);
    return size;
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* never created */ }
    throw error;
  }
}

async function replaceFile(target: string, data: string): Promise<number> {
  const temp = tempPathFor(target);
  try {
    await fs.promises.writeFile(temp, data, TEMP_WRITE_OPTIONS);
    const { size } = await fs.promises.stat(temp);
    await renameWithRetry(temp, target);
    return size;
  } catch (error) {
    await fs.promises.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Commit the data file, then its meta file. Returns the data file's size in bytes. */
export function writeCacheFilesSync(payload: CacheWritePayload): number {
  const bytes = replaceFileSync(payload.cacheFile, payload.json);
  replaceFileSync(payload.metaFile, payload.metaJson);
  return bytes;
}

/** Async counterpart of writeCacheFilesSync, used when the write worker is unavailable. */
export async function writeCacheFiles(payload: CacheWritePayload): Promise<number> {
  const bytes = await replaceFile(payload.cacheFile, payload.json);
  await replaceFile(payload.metaFile, payload.metaJson);
  return bytes;
}

/** Delete temp files that killed writes left in `dir` (best effort). */
export function removeStaleTempFiles(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_FILE_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_TEMP_FILE_MS) fs.unlinkSync(file);
    } catch {
      // Committed or removed by another writer in the meantime.
    }
  }
}
