/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
  activeRateLimit, afterFailure, afterLease, afterRateLimit, afterSuccess, CHECK_INTERVAL_MS, claimCheck, isCheckDue, LEASE_MS,
  leasedByOther, nextCheckTime, takeLease, timerDelay, type ScheduleState,
} from './update-schedule';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 31, 12);
const low = () => 0;
const high = () => 0.999_999;

describe('isCheckDue', () => {
  it('is due when nothing has been checked yet', () => {
    expect(isCheckDue({}, NOW)).toBe(true);
  });

  it('follows the shared due time', () => {
    expect(isCheckDue({ nextCheckAt: NOW + MINUTE, lastCheckAt: NOW - 30 * HOUR }, NOW)).toBe(false);
    expect(isCheckDue({ nextCheckAt: NOW - MINUTE, lastCheckAt: NOW - MINUTE }, NOW)).toBe(true);
  });

  it('skips when another window checked recently', () => {
    expect(isCheckDue({ lastCheckAt: NOW - HOUR }, NOW)).toBe(false);
    expect(isCheckDue({ lastCheckAt: NOW - 23 * HOUR }, NOW)).toBe(true);
  });

  it('ignores timestamps from a clock that ran ahead', () => {
    expect(isCheckDue({ nextCheckAt: NOW + 30 * 24 * HOUR }, NOW)).toBe(true);
    expect(isCheckDue({ lastCheckAt: NOW + HOUR }, NOW)).toBe(true);
  });
});

describe('nextCheckTime', () => {
  it('waits 2 to 10 minutes after activation', () => {
    expect(nextCheckTime({}, NOW, low, true)).toBe(NOW + 2 * MINUTE);
    const latest = nextCheckTime({}, NOW, high, true);
    expect(latest).toBeGreaterThan(NOW + 9 * MINUTE);
    expect(latest).toBeLessThan(NOW + 10 * MINUTE);
  });

  it('never wakes again within a minute, so a check that makes no progress cannot spin', () => {
    expect(nextCheckTime({}, NOW, low, false)).toBe(NOW + MINUTE);
    expect(nextCheckTime({ nextCheckAt: NOW - HOUR }, NOW, low, false)).toBe(NOW + MINUTE);
  });

  it('wakes a few minutes after the shared due time', () => {
    expect(nextCheckTime({ nextCheckAt: NOW + 5 * HOUR }, NOW, low, true)).toBe(NOW + 5 * HOUR);
    const spread = nextCheckTime({ nextCheckAt: NOW + 5 * HOUR }, NOW, high, false) - (NOW + 5 * HOUR);
    expect(spread).toBeGreaterThan(4 * MINUTE);
    expect(spread).toBeLessThan(5 * MINUTE);
  });

  it('never fires before the activation delay', () => {
    expect(nextCheckTime({ nextCheckAt: NOW - HOUR }, NOW, low, true)).toBe(NOW + 2 * MINUTE);
  });

  it('falls back to the last check plus about a day', () => {
    const at = nextCheckTime({ lastCheckAt: NOW - HOUR }, NOW, low, false);
    expect(at).toBe(NOW - HOUR + CHECK_INTERVAL_MS - 2 * HOUR);
  });
});

describe('state after a check', () => {
  it('claims the check so other windows skip it', () => {
    const claimed = claimCheck({ failures: 2 }, NOW);
    expect(claimed).toEqual({ failures: 2, lastCheckAt: NOW, nextCheckAt: NOW + 10 * MINUTE });
    expect(isCheckDue(claimed, NOW + 5 * MINUTE)).toBe(false);
  });

  it('schedules the next check 22 to 26 hours after a success', () => {
    const early = afterSuccess(NOW, low);
    expect(early).toEqual({ lastCheckAt: NOW, nextCheckAt: NOW + 22 * HOUR, failures: 0, rateLimitedUntil: undefined });
    expect(afterSuccess(NOW, high).nextCheckAt).toBeLessThan(NOW + 26 * HOUR);
  });

  it('backs off 1 h, 2 h, 4 h, … and caps at a day', () => {
    let state: ScheduleState = {};
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      state = afterFailure(state, NOW, low);
      delays.push((state.nextCheckAt ?? 0) - NOW);
    }
    expect(delays.map(ms => ms / HOUR)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(state.failures).toBe(7);
    expect(afterSuccess(NOW, low).failures).toBe(0);
  });

  it('retries a failed check even though it updated lastCheckAt', () => {
    const failed = afterFailure({}, NOW, low);
    expect(isCheckDue(failed, NOW + 30 * MINUTE)).toBe(false);
    expect(isCheckDue(failed, NOW + HOUR)).toBe(true);
  });

  it('waits for the rate-limit reset, within a minute and a day', () => {
    expect(afterRateLimit({}, NOW, NOW + 20 * MINUTE, low)).toMatchObject({
      lastCheckAt: NOW, nextCheckAt: NOW + 20 * MINUTE, rateLimitedUntil: NOW + 20 * MINUTE,
    });
    expect(afterRateLimit({}, NOW, NOW - HOUR, low).rateLimitedUntil).toBe(NOW + MINUTE);
    expect(afterRateLimit({}, NOW, NOW + 5 * CHECK_INTERVAL_MS, low).rateLimitedUntil).toBe(NOW + CHECK_INTERVAL_MS);
  });

  it('honors a rate limit only while it is ahead and plausible', () => {
    expect(activeRateLimit({ rateLimitedUntil: NOW + 20 * MINUTE }, NOW)).toBe(NOW + 20 * MINUTE);
    expect(activeRateLimit({ rateLimitedUntil: NOW - MINUTE }, NOW)).toBeUndefined();
    // Left behind by a clock that moved back: waiting for it would stall checks for days.
    expect(activeRateLimit({ rateLimitedUntil: NOW + 5 * CHECK_INTERVAL_MS }, NOW)).toBeUndefined();
    expect(activeRateLimit({}, NOW)).toBeUndefined();
  });
});

describe('lease', () => {
  it('keeps other windows out until it lapses', () => {
    const state: ScheduleState = { lease: takeLease('a', NOW) };
    expect(state.lease).toEqual({ owner: 'a', until: NOW + LEASE_MS });
    expect(leasedByOther(state, 'b', NOW + MINUTE)).toBe(true);
    expect(leasedByOther(state, 'a', NOW + MINUTE)).toBe(false);
    expect(leasedByOther(state, 'b', NOW + LEASE_MS)).toBe(false);
    expect(leasedByOther({}, 'b', NOW)).toBe(false);
  });

  it('ignores leases that are malformed or from a clock that moved back', () => {
    expect(leasedByOther({ lease: { owner: 'a', until: NOW + 5 * LEASE_MS } }, 'b', NOW)).toBe(false);
    expect(leasedByOther({ lease: 'a' } as unknown as ScheduleState, 'b', NOW)).toBe(false);
    expect(leasedByOther({ lease: { owner: 7, until: NOW + MINUTE } } as unknown as ScheduleState, 'b', NOW)).toBe(false);
  });

  it('retries after the lease lapses, spread by up to a minute', () => {
    const lease = takeLease('a', NOW);
    expect(afterLease(lease, NOW, low)).toBe(NOW + LEASE_MS);
    expect(afterLease(lease, NOW, high)).toBeGreaterThan(NOW + LEASE_MS + 59_000);
    expect(afterLease(lease, NOW, high)).toBeLessThan(NOW + LEASE_MS + MINUTE);
    expect(afterLease({ owner: 'a', until: NOW + 5 * LEASE_MS }, NOW, low)).toBe(NOW + LEASE_MS);
    expect(afterLease(undefined, NOW, low)).toBe(NOW + LEASE_MS);
  });
});

describe('timerDelay', () => {
  it('clamps to what setTimeout accepts', () => {
    expect(timerDelay(NOW - 1, NOW)).toBe(0);
    expect(timerDelay(NOW + 5, NOW)).toBe(5);
    expect(timerDelay(NOW + 2 ** 40, NOW)).toBe(2 ** 31 - 1);
  });
});
