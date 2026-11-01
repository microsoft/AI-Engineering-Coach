/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Lets one window of a VS Code profile install an update at a time. globalState has no
 * compare-and-set and reaches other windows late, but the windows share the extension's
 * globalStorage folder on disk, where creating a file is atomic. The window that creates the lock
 * file installs, and records what it installed before it lets the next window in. */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const LOCK_FILE = 'install.lock';
const RECORD_FILE = 'installed.json';
/** How long a window waits for another window's install before giving up. */
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;
/** A window doesn't start VS Code's installer once it has held the lock this long… */
const MAX_HOLD_MS = 20 * 60_000;
/** …so a lock this old can be taken over even while its window still runs. */
const ABANDONED_LOCK_MS = 30 * 60_000;

export interface InstallRecord {
  version: string;
  /** The installation, as `UpdateService` identifies it: local or remote host, and extensions folder. */
  location: string;
  at: number;
}

export interface InstallLockHost {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** False once the process holding a lock has exited. */
  isAlive?: (pid: number) => boolean;
}

export interface HeldLock {
  /** Throws `LockLostError` unless this window may still start the installer. */
  confirm(): Promise<void>;
}

export class LockLostError extends Error {
  override readonly name = 'LockLostError';
}

export type LockedResult<T> = { kind: 'done'; value: T } | { kind: 'busy' };

interface LockHolder {
  pid: number;
  at: number;
  token: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    // Missing, or being written by another window at this moment.
    return undefined;
  }
}

async function readRecord(dir: string): Promise<InstallRecord | undefined> {
  const { version, location, at } = await readJson(path.join(dir, RECORD_FILE)) ?? {};
  return typeof version === 'string' && typeof location === 'string' && typeof at === 'number' ? { version, location, at } : undefined;
}

/** Only the window holding the lock reads or writes the record, so a plain write is enough. */
export async function writeInstallRecord(dir: string, record: InstallRecord): Promise<void> {
  await fs.writeFile(path.join(dir, RECORD_FILE), JSON.stringify(record), { mode: 0o600 });
}

async function tryLock(lock: string, holder: LockHolder): Promise<boolean> {
  try {
    await fs.writeFile(lock, JSON.stringify(holder), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** The contents of a lock left by a window that closed, crashed, or stopped long ago. */
async function abandonedLock(lock: string, host: InstallLockHost): Promise<string | undefined> {
  const holder = await readJson(lock);
  const at = typeof holder?.at === 'number' ? holder.at : (await fs.stat(lock).catch(() => undefined))?.mtimeMs;
  if (at === undefined) return undefined;
  const pid = holder?.pid;
  const exited = typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid
    && !(host.isAlive ?? isProcessAlive)(pid);
  return exited || host.now() - at > ABANDONED_LOCK_MS ? JSON.stringify(holder ?? null) : undefined;
}

/**
 * Runs `task` while this window holds the lock, with the record of the last install. Waits for
 * another window's install for up to a minute, then reports that it is busy.
 */
export async function withInstallLock<T>(
  dir: string, host: InstallLockHost, task: (last: InstallRecord | undefined, lock: HeldLock) => Promise<T>,
): Promise<LockedResult<T>> {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, LOCK_FILE);
  const giveUpAt = host.now() + LOCK_WAIT_MS;
  for (;;) {
    const holder: LockHolder = { pid: process.pid, at: host.now(), token: randomUUID() };
    if (await tryLock(lock, holder)) {
      const held: HeldLock = {
        confirm: async () => {
          if (host.now() - holder.at >= MAX_HOLD_MS || (await readJson(lock))?.token !== holder.token) {
            throw new LockLostError('another window took over the update');
          }
        },
      };
      try {
        return { kind: 'done', value: await task(await readRecord(dir), held) };
      } finally {
        // Leave a lock that another window took over after judging this one abandoned.
        if ((await readJson(lock))?.token === holder.token) await fs.rm(lock, { force: true }).catch(() => undefined);
      }
    }
    const abandoned = await abandonedLock(lock, host);
    if (abandoned !== undefined) {
      // Only remove the lock that was judged abandoned, not one another window created since.
      if (JSON.stringify(await readJson(lock) ?? null) === abandoned) await fs.rm(lock, { force: true }).catch(() => undefined);
    } else if (host.now() >= giveUpAt) {
      return { kind: 'busy' };
    } else {
      await host.sleep(LOCK_POLL_MS);
    }
  }
}
