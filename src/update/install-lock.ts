/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Lets one window of a VS Code profile install an update at a time. globalState has no
 * compare-and-set and reaches other windows late, but the windows share the extension's
 * globalStorage folder on disk, where creating a file is atomic. Windows take numbered turns: a
 * window takes the next turn by creating the file after the newest one, once that turn has ended
 * or was abandoned. Exactly one of the windows that saw the same newest turn can create the next
 * one, and nobody deletes the last two turns, so a window acting on an outdated view can't break
 * into the current turn. The holder records what it installed before its turn ends. */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const TURN_FILE = /^install\.(\d+)\.lock$/;
const RECORD_FILE = 'installed.json';
/** How long a window waits for another window's install before giving up. */
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;
/** A window doesn't start VS Code's installer once its turn is this old… */
const MAX_HOLD_MS = 20 * 60_000;
/** …so a turn this old is abandoned even while its window still runs. */
const ABANDONED_TURN_MS = 30 * 60_000;

export interface InstallRecord {
  version: string;
  /** The installation, as `UpdateService` identifies it: local or remote host, and extensions folder. */
  location: string;
  at: number;
}

export interface InstallLockHost {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** False once the process holding a turn has exited. */
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

interface Holder {
  pid: number;
  at: number;
  token: string;
}

interface Turn {
  number: number;
  /** Undefined while its window is still writing the file. */
  holder: Record<string, unknown> | undefined;
  modifiedAt: number | undefined;
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

/** Only the window whose turn it is reads or writes the record, so a plain write is enough. */
export async function writeInstallRecord(dir: string, record: InstallRecord): Promise<void> {
  await fs.writeFile(path.join(dir, RECORD_FILE), JSON.stringify(record), { mode: 0o600 });
}

const turnFile = (dir: string, number: number) => path.join(dir, `install.${number}.lock`);

async function turnNumbers(dir: string): Promise<number[]> {
  return (await fs.readdir(dir)).flatMap(name => {
    const match = TURN_FILE.exec(name);
    return match ? [Number(match[1])] : [];
  });
}

async function newestTurn(dir: string): Promise<Turn | undefined> {
  const numbers = await turnNumbers(dir);
  if (numbers.length === 0) return undefined;
  const number = Math.max(...numbers);
  const file = turnFile(dir, number);
  return { number, holder: await readJson(file), modifiedAt: (await fs.stat(file).catch(() => undefined))?.mtimeMs };
}

/** True once the turn has ended, or its window has exited or stopped long ago. */
function isOver(turn: Turn, host: InstallLockHost): boolean {
  if (turn.holder?.released === true) return true;
  const at = typeof turn.holder?.at === 'number' ? turn.holder.at : turn.modifiedAt;
  if (at === undefined) return false;
  if (host.now() - at > ABANDONED_TURN_MS) return true;
  const pid = turn.holder?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid !== process.pid
    && !(host.isAlive ?? isProcessAlive)(pid);
}

async function tryTake(file: string, holder: Holder): Promise<boolean> {
  try {
    await fs.writeFile(file, JSON.stringify(holder), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Turns before the previous one can't matter any more. */
async function pruneTurns(dir: string, current: number): Promise<void> {
  for (const number of await turnNumbers(dir).catch(() => [])) {
    if (number < current - 1) await fs.rm(turnFile(dir, number), { force: true }).catch(() => undefined);
  }
}

interface TakenTurn {
  dir: string;
  number: number;
  holder: Holder;
  host: InstallLockHost;
}

async function runTurn<T>(
  { dir, number, holder, host }: TakenTurn, task: (last: InstallRecord | undefined, lock: HeldLock) => Promise<T>,
): Promise<LockedResult<T>> {
  await pruneTurns(dir, number);
  const isCurrent = async () => {
    const newest = await newestTurn(dir);
    return newest?.number === number && newest.holder?.token === holder.token;
  };
  const held: HeldLock = {
    confirm: async () => {
      if (host.now() - holder.at >= MAX_HOLD_MS || !(await isCurrent())) {
        throw new LockLostError('another window took over the update');
      }
    },
  };
  try {
    return { kind: 'done', value: await task(await readRecord(dir), held) };
  } finally {
    // End the turn, unless another window already took the next one after judging this one abandoned.
    if (await isCurrent().catch(() => false)) {
      await fs.writeFile(turnFile(dir, number), JSON.stringify({ ...holder, released: true }), { mode: 0o600 }).catch(() => undefined);
    }
  }
}

/**
 * Runs `task` in this window's turn, with the record of the last install. Waits for another
 * window's turn for up to a minute, then reports that it is busy.
 */
export async function withInstallLock<T>(
  dir: string, host: InstallLockHost, task: (last: InstallRecord | undefined, lock: HeldLock) => Promise<T>,
): Promise<LockedResult<T>> {
  await fs.mkdir(dir, { recursive: true });
  const giveUpAt = host.now() + LOCK_WAIT_MS;
  for (;;) {
    const newest = await newestTurn(dir);
    if (!newest || isOver(newest, host)) {
      const number = (newest?.number ?? 0) + 1;
      const holder: Holder = { pid: process.pid, at: host.now(), token: randomUUID() };
      // When several windows saw the same newest turn, the one that loses this race looks again.
      if (await tryTake(turnFile(dir, number), holder)) return runTurn({ dir, number, holder, host }, task);
    } else if (host.now() >= giveUpAt) {
      return { kind: 'busy' };
    } else {
      await host.sleep(LOCK_POLL_MS);
    }
  }
}
