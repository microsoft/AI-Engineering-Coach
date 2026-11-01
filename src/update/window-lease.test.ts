/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { LEASE_MS, LEASE_SETTLE_MS, type ScheduleState } from './update-schedule';
import { runUnderLease, type LeaseHost } from './window-lease';

const NOW = Date.UTC(2026, 9, 31, 12);

interface FakeWindow extends LeaseHost {
  state: ScheduleState;
  isClosed: boolean;
}

/** A window whose view of globalState is `state`; `duringPause` runs while it waits for other windows' writes. */
function fakeWindow(owner: string, state: ScheduleState, duringPause: (self: FakeWindow) => void = () => {}): FakeWindow {
  const self: FakeWindow = {
    owner,
    state,
    isClosed: false,
    read: () => self.state,
    write: lease => {
      self.state = { ...self.state, lease };
      return Promise.resolve();
    },
    sleep: vi.fn(() => {
      duringPause(self);
      return Promise.resolve();
    }),
    now: () => NOW,
    random: () => 0,
    closed: () => self.isClosed,
  };
  return self;
}

describe('runUnderLease', () => {
  it('runs the task once its own lease is still in place after the pause', async () => {
    const here = fakeWindow('a', {});
    const task = vi.fn(() => Promise.resolve());
    expect(await runUnderLease(here, task)).toBeUndefined();
    expect(task).toHaveBeenCalledOnce();
    expect(here.state.lease).toEqual({ owner: 'a', until: NOW + LEASE_MS });
    expect(here.sleep).toHaveBeenCalledWith(LEASE_SETTLE_MS);
  });

  it('stays out while another window holds the lease', async () => {
    const here = fakeWindow('b', { lease: { owner: 'a', until: NOW + 30_000 } });
    const task = vi.fn(() => Promise.resolve());
    expect(await runUnderLease(here, task)).toBe(NOW + 30_000);
    expect(task).not.toHaveBeenCalled();
    expect(here.sleep).not.toHaveBeenCalled();
    expect(here.state.lease?.owner).toBe('a');
  });

  it('backs off when another window\'s claim arrives during the pause', async () => {
    const here = fakeWindow('b', {}, self => { self.state = { lease: { owner: 'a', until: NOW + LEASE_MS } }; });
    const task = vi.fn(() => Promise.resolve());
    expect(await runUnderLease(here, task)).toBe(NOW + LEASE_MS);
    expect(task).not.toHaveBeenCalled();
  });

  it('does nothing once the window closes during the pause', async () => {
    const here = fakeWindow('a', {}, self => { self.isClosed = true; });
    const task = vi.fn(() => Promise.resolve());
    expect(await runUnderLease(here, task)).toBeUndefined();
    expect(task).not.toHaveBeenCalled();
  });
});
