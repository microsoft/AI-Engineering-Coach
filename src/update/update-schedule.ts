/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* When automatic update checks run. Pure: every window computes the same schedule from the
 * state that all windows of the profile share, so a check made by one window covers the rest.
 * Jitter spreads windows and machines apart; failures back off up to the daily interval. A
 * short lease, confirmed after a pause, lets one window check and announce while the rest wait. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const CHECK_INTERVAL_MS = 24 * HOUR;
const INTERVAL_JITTER_MS = 2 * HOUR;
const FIRST_CHECK_MIN_DELAY_MS = 2 * MINUTE;
const FIRST_CHECK_MAX_DELAY_MS = 10 * MINUTE;
/** Spreads windows that wake for the same shared due time. */
const WAKE_JITTER_MS = 5 * MINUTE;
/** A window that starts a check claims it for this long, so other windows skip it. */
const CLAIM_MS = 10 * MINUTE;
/** Automatic wake-ups never come sooner than this, so a check that can't make progress can't spin. */
const MIN_WAKE_DELAY_MS = MINUTE;
/** The window that checks and announces holds a lease this long; the others stay out. */
export const LEASE_MS = 2 * MINUTE;
/** Long enough for another window's simultaneous lease write to arrive through globalState. */
export const LEASE_SETTLE_MS = 3_000;
/** Spreads windows that lost the same lease. */
const LEASE_RETRY_JITTER_MS = MINUTE;
const RETRY_BASE_MS = HOUR;
const MAX_FAILURES = 16;
/** Timestamps further in the future than this are treated as clock skew and ignored. */
const MAX_FUTURE_SKEW_MS = CHECK_INTERVAL_MS + INTERVAL_JITTER_MS + HOUR;
/** Node's setTimeout limit; longer delays fire immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ScheduleState {
  /** When a window last asked GitHub. */
  lastCheckAt?: number;
  /** When the next automatic check is due; authoritative when set. */
  nextCheckAt?: number;
  /** Consecutive failed checks. */
  failures?: number;
  /** GitHub's anonymous rate limit is exhausted until then; manual checks wait too. */
  rateLimitedUntil?: number;
  /** The window that is running the automatic check and announcement. */
  lease?: Lease;
}

export interface Lease {
  owner: string;
  until: number;
}

function between(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min));
}

function plausible(value: number | undefined, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value <= now + MAX_FUTURE_SKEW_MS;
}

/** True when no window has a check scheduled later or made one recently enough to cover this one. */
export function isCheckDue(state: ScheduleState, now: number): boolean {
  if (plausible(state.nextCheckAt, now)) return now >= state.nextCheckAt;
  if (plausible(state.lastCheckAt, now) && state.lastCheckAt <= now) {
    return now - state.lastCheckAt >= CHECK_INTERVAL_MS - INTERVAL_JITTER_MS;
  }
  return true;
}

/** When this window should next wake up; a few minutes after activation at the earliest. */
export function nextCheckTime(state: ScheduleState, now: number, random: () => number, justActivated: boolean): number {
  const earliest = now + (justActivated ? between(random, FIRST_CHECK_MIN_DELAY_MS, FIRST_CHECK_MAX_DELAY_MS) : MIN_WAKE_DELAY_MS);
  if (plausible(state.nextCheckAt, now)) return Math.max(earliest, state.nextCheckAt + between(random, 0, WAKE_JITTER_MS));
  if (plausible(state.lastCheckAt, now) && state.lastCheckAt <= now && now - state.lastCheckAt < CHECK_INTERVAL_MS) {
    return Math.max(earliest, state.lastCheckAt + CHECK_INTERVAL_MS + between(random, -INTERVAL_JITTER_MS, INTERVAL_JITTER_MS));
  }
  return earliest;
}

/** Written before a check starts, so windows that wake meanwhile skip it. */
export function claimCheck(state: ScheduleState, now: number): ScheduleState {
  return { ...state, lastCheckAt: now, nextCheckAt: now + CLAIM_MS };
}

export function afterSuccess(now: number, random: () => number): ScheduleState {
  return {
    lastCheckAt: now,
    nextCheckAt: now + CHECK_INTERVAL_MS + between(random, -INTERVAL_JITTER_MS, INTERVAL_JITTER_MS),
    failures: 0,
    rateLimitedUntil: undefined,
  };
}

/** Network and server errors: retry after 1 h, 2 h, 4 h, … capped at the daily interval. */
export function afterFailure(state: ScheduleState, now: number, random: () => number): ScheduleState {
  const failures = Math.min((state.failures ?? 0) + 1, MAX_FAILURES);
  const backoff = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), CHECK_INTERVAL_MS);
  return { ...state, lastCheckAt: now, nextCheckAt: now + backoff + between(random, 0, WAKE_JITTER_MS), failures };
}

/** Waits for GitHub's reset time (at least a minute, at most a day). */
export function afterRateLimit(state: ScheduleState, now: number, retryAt: number, random: () => number): ScheduleState {
  const until = Math.min(Math.max(retryAt, now + MINUTE), now + CHECK_INTERVAL_MS);
  return { ...state, lastCheckAt: now, nextCheckAt: until + between(random, 0, WAKE_JITTER_MS), rateLimitedUntil: until };
}

/** The rate-limit reset still ahead, ignoring one left behind by a clock that moved back. */
export function activeRateLimit(state: ScheduleState, now: number): number | undefined {
  return plausible(state.rateLimitedUntil, now) && state.rateLimitedUntil > now ? state.rateLimitedUntil : undefined;
}

/** True while another window holds the lease; a lease from a clock that moved back has lapsed. */
export function leasedByOther(state: ScheduleState, owner: string, now: number): boolean {
  const lease = state.lease;
  return typeof lease === 'object' && lease !== null && typeof lease.owner === 'string' && lease.owner !== owner
    && typeof lease.until === 'number' && lease.until > now && lease.until - now <= LEASE_MS;
}

export function takeLease(owner: string, now: number): Lease {
  return { owner, until: now + LEASE_MS };
}

/** When a window that found or lost a lease tries again: after it lapses, spread apart. */
export function afterLease(lease: Lease | undefined, now: number, random: () => number): number {
  const until = lease && Number.isFinite(lease.until) && lease.until - now <= LEASE_MS ? Math.max(lease.until, now) : now + LEASE_MS;
  return until + between(random, 0, LEASE_RETRY_JITTER_MS);
}

/** Milliseconds to pass to setTimeout. */
export function timerDelay(at: number, now: number): number {
  return Math.min(Math.max(0, at - now), MAX_TIMER_MS);
}
