/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* When automatic update checks run. Pure: every window computes the same schedule from the
 * state that all windows of the profile share, so a check made by one window covers the rest.
 * Jitter spreads windows and machines apart; failures back off up to the daily interval. */

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
  const earliest = justActivated ? now + between(random, FIRST_CHECK_MIN_DELAY_MS, FIRST_CHECK_MAX_DELAY_MS) : now;
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

/** Milliseconds to pass to setTimeout. */
export function timerDelay(at: number, now: number): number {
  return Math.min(Math.max(0, at - now), MAX_TIMER_MS);
}
