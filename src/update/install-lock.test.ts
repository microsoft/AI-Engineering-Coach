/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockLostError, withInstallLock, writeInstallRecord, type InstallLockHost } from './install-lock';

const fsHooks = vi.hoisted(() => ({
  /** Holds back the next removal of a lock file until this settles. */
  lockRemoval: undefined as Promise<void> | undefined,
}));

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const held = fsHooks.lockRemoval;
      if (held && String(args[0]).endsWith('.lock')) {
        fsHooks.lockRemoval = undefined;
        await held;
      }
      return actual.rm(...args);
    },
  };
});

const NOW = Date.UTC(2026, 9, 31, 12);
const MINUTE = 60_000;
const OTHER_PID = 4242;

let dir: string;

const turnFile = (number: number) => path.join(dir, `install.${number}.lock`);

/** A clock that moves only while the lock waits, and holders whose processes still run. */
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

/** Another window's turn. */
async function takenBy(number: number, holder: { pid: number; at: number; token: string; released?: boolean }): Promise<void> {
  await fs.writeFile(turnFile(number), JSON.stringify(holder));
}

async function turn(number: number): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(turnFile(number), 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aec-install-lock-'));
  fsHooks.lockRemoval = undefined;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('taking turns', () => {
  it('runs the task in a new turn and ends the turn afterwards, also when the task fails', async () => {
    const result = await withInstallLock(dir, host(), async last => {
      expect(last).toBeUndefined();
      expect(await turn(1)).toMatchObject({ pid: process.pid, at: NOW });
      return 'done';
    });
    expect(result).toEqual({ kind: 'done', value: 'done' });
    expect(await turn(1)).toMatchObject({ released: true });
    await expect(withInstallLock(dir, host(), () => Promise.reject(new Error('install failed')))).rejects.toThrow('install failed');
    expect(await turn(2)).toMatchObject({ released: true });
  });

  it('hands the record of the last install to the next turn', async () => {
    const record = { version: '0.6.0', location: 'local:/home/u/.vscode/extensions', at: NOW };
    await writeInstallRecord(dir, record);
    expect(await withInstallLock(dir, host(), last => Promise.resolve(last))).toEqual({ kind: 'done', value: record });
  });

  it('ignores a record it cannot read', async () => {
    await fs.writeFile(path.join(dir, 'installed.json'), '{"version":6}');
    expect(await withInstallLock(dir, host(), last => Promise.resolve(last))).toEqual({ kind: 'done', value: undefined });
  });

  it('waits while another window installs, then takes the next turn', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW, token: 'other' });
    const clock = host({ sleep: vi.fn(() => takenBy(1, { pid: OTHER_PID, at: NOW, token: 'other', released: true })) });
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, clock, task)).toEqual({ kind: 'done', value: 'done' });
    expect(clock.sleep).toHaveBeenCalledOnce();
    expect(await turn(2)).toMatchObject({ pid: process.pid, released: true });
  });

  it('gives up after a minute while the other window is still installing', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW, token: 'other' });
    const clock = host();
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, clock, task)).toEqual({ kind: 'busy' });
    expect(task).not.toHaveBeenCalled();
    expect(clock.now() - NOW).toBe(MINUTE);
    expect(await fs.readdir(dir)).toEqual(['install.1.lock']);
  });

  it('keeps only the last two turns', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW, token: 'first', released: true });
    await takenBy(2, { pid: OTHER_PID, at: NOW, token: 'second', released: true });
    await withInstallLock(dir, host(), () => Promise.resolve('done'));
    expect((await fs.readdir(dir)).sort()).toEqual(['install.2.lock', 'install.3.lock']);
  });
});

describe('turns left behind', () => {
  it('takes the next turn after a window that closed or crashed while installing', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW, token: 'closed' });
    const task = vi.fn(() => Promise.resolve('done'));
    expect(await withInstallLock(dir, host({ isAlive: pid => pid !== OTHER_PID }), task)).toEqual({ kind: 'done', value: 'done' });
    expect(await turn(2)).toMatchObject({ pid: process.pid });
  });

  it('takes the next turn after half an hour, even if the process id is in use again', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW - 31 * MINUTE, token: 'old' });
    expect(await withInstallLock(dir, host(), () => Promise.resolve('done'))).toEqual({ kind: 'done', value: 'done' });
  });

  it('lets only one of two windows that recover the same abandoned turn install', async () => {
    await takenBy(1, { pid: OTHER_PID, at: NOW, token: 'crashed' });
    // The first lock file a window removes stays in place until a task has started.
    let taskStarted = () => {};
    fsHooks.lockRemoval = new Promise<void>(resolve => { taskStarted = resolve; });
    let running = 0;
    let mostAtOnce = 0;
    const install = async () => {
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      taskStarted();
      await new Promise(resolve => setTimeout(resolve, 50));
      running--;
      return 'installed';
    };
    const window = () => host({
      isAlive: pid => pid !== OTHER_PID,
      sleep: () => new Promise<void>(resolve => setTimeout(resolve, 5)),
    });
    const results = await Promise.all([withInstallLock(dir, window(), install), withInstallLock(dir, window(), install)]);
    expect(results).toEqual([{ kind: 'done', value: 'installed' }, { kind: 'done', value: 'installed' }]);
    expect(mostAtOnce).toBe(1);
  });

  it('leaves the turn that another window took after judging this one abandoned', async () => {
    const result = await withInstallLock(dir, host(), async () => {
      await takenBy(2, { pid: OTHER_PID, at: NOW, token: 'other' });
      return 'done';
    });
    expect(result).toEqual({ kind: 'done', value: 'done' });
    expect(await turn(1)).not.toHaveProperty('released');
    expect(await turn(2)).toMatchObject({ token: 'other' });
  });
});

describe('confirming the turn before the installer starts', () => {
  it('succeeds while it is this window\'s turn', async () => {
    const result = await withInstallLock(dir, host(), async (_last, lock) => {
      await lock.confirm();
      return 'installed';
    });
    expect(result).toEqual({ kind: 'done', value: 'installed' });
  });

  it('fails once another window has taken the next turn', async () => {
    const attempt = withInstallLock(dir, host(), async (_last, lock) => {
      await takenBy(2, { pid: OTHER_PID, at: NOW, token: 'other' });
      await lock.confirm();
    });
    await expect(attempt).rejects.toBeInstanceOf(LockLostError);
  });

  it('fails after 20 minutes, well before other windows may take the next turn', async () => {
    const clock = host();
    const attempt = withInstallLock(dir, clock, async (_last, lock) => {
      await clock.sleep(20 * MINUTE);
      await lock.confirm();
    });
    await expect(attempt).rejects.toBeInstanceOf(LockLostError);
    expect(await turn(1)).toMatchObject({ released: true });
  });
});
