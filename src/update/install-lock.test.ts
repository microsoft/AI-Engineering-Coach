/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockLostError, withInstallLock, writeInstallRecord, type InstallLockHost } from './install-lock';

const NOW = Date.UTC(2026, 9, 31, 12);
const MINUTE = 60_000;
const OTHER_PID = 4242;

let dir: string;

const lockFile = () => path.join(dir, 'install.lock');

/** A clock that moves only while the lock waits, and a holder process that is still running. */
function host(overrides: Partial<InstallLockHost> = {}) {
  let now = NOW;
  return {
    now: () => now,
    sleep: vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    }),
    isAlive: (_pid: number) => true,
    ...overrides,
  };
}

/** Another window's lock. */
async function lockedBy(holder: { pid: number; at: number; token: string }): Promise<void> {
  await fs.writeFile(lockFile(), JSON.stringify(holder));
}

async function lockToken(): Promise<unknown> {
  return (JSON.parse(await fs.readFile(lockFile(), 'utf8')) as { token?: unknown }).token;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-install-lock-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('withInstallLock', () => {
  it('runs the task while holding the lock and releases it afterwards, also when the task fails', async () => {
    const result = await withInstallLock(dir, host(), async last => {
      expect(last).toBeUndefined();
      expect(JSON.parse(await fs.readFile(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid, at: NOW });
      return 'done';
    });
    expect(result).toEqual({ kind: 'done', value: 'done' });
    expect(await fs.readdir(dir)).toEqual([]);
    await expect(withInstallLock(dir, host(), () => Promise.reject(new Error('install failed')))).rejects.toThrow('install failed');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('hands the record of the last install to the next holder', async () => {
    const record = { version: '0.6.0', location: 'local:/home/u/.vscode/extensions', at: NOW };
    await writeInstallRecord(dir, record);
    expect(await withInstallLock(dir, host(), last => Promise.resolve(last))).toEqual({ kind: 'done', value: record });
    expect(await fs.readdir(dir)).toEqual(['installed.json']);
  });

  it('ignores a record it cannot read', async () => {
    await fs.writeFile(path.join(dir, 'installed.json'), '{"version":6}');
    expect(await withInstallLock(dir, host(), last => Promise.resolve(last))).toEqual({ kind: 'done', value: undefined });
  });

  it('waits while another window installs, then takes its turn', async () => {
    await lockedBy({ pid: OTHER_PID, at: NOW, token: 'other' });
    const clock = host({ sleep: vi.fn(() => fs.rm(lockFile())) });
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, clock, task)).toEqual({ kind: 'done', value: 'done' });
    expect(clock.sleep).toHaveBeenCalledOnce();
    expect(task).toHaveBeenCalledOnce();
  });

  it('gives up after a minute while the other window is still installing', async () => {
    await lockedBy({ pid: OTHER_PID, at: NOW, token: 'other' });
    const clock = host();
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, clock, task)).toEqual({ kind: 'busy' });
    expect(task).not.toHaveBeenCalled();
    expect(clock.now() - NOW).toBe(MINUTE);
    expect(await lockToken()).toBe('other');
  });
});

describe('locks left behind', () => {
  it('takes over the lock of a window that closed or crashed while installing', async () => {
    await lockedBy({ pid: OTHER_PID, at: NOW, token: 'closed' });
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, host({ isAlive: pid => pid !== OTHER_PID }), task)).toEqual({ kind: 'done', value: 'done' });
    expect(task).toHaveBeenCalledOnce();
  });

  it('takes over a lock older than half an hour, even if its process id is in use again', async () => {
    await lockedBy({ pid: OTHER_PID, at: NOW - 31 * MINUTE, token: 'old' });
    expect(await withInstallLock(dir, host(), () => Promise.resolve('done'))).toEqual({ kind: 'done', value: 'done' });
  });

  it('leaves a lock that another window took over meanwhile', async () => {
    const result = await withInstallLock(dir, host(), async () => {
      await lockedBy({ pid: OTHER_PID, at: NOW, token: 'other' });
      return 'done';
    });
    expect(result).toEqual({ kind: 'done', value: 'done' });
    expect(await lockToken()).toBe('other');
  });
});

describe('confirming the lock before the installer starts', () => {
  it('succeeds while this window holds the lock', async () => {
    const result = await withInstallLock(dir, host(), async (_last, lock) => {
      await lock.confirm();
      return 'installed';
    });
    expect(result).toEqual({ kind: 'done', value: 'installed' });
  });

  it('fails once another window took the lock over', async () => {
    const attempt = withInstallLock(dir, host(), async (_last, lock) => {
      await lockedBy({ pid: OTHER_PID, at: NOW, token: 'other' });
      await lock.confirm();
    });
    await expect(attempt).rejects.toBeInstanceOf(LockLostError);
    expect(await lockToken()).toBe('other');
  });

  it('fails after 20 minutes, well before other windows may take the lock over', async () => {
    const clock = host();
    const attempt = withInstallLock(dir, clock, async (_last, lock) => {
      await clock.sleep(20 * MINUTE);
      await lock.confirm();
    });
    await expect(attempt).rejects.toBeInstanceOf(LockLostError);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
