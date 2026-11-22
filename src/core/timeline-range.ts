/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Custom date ranges for the Timeline's Range view and its date picker: calendar dates (`YYYY-MM-DD`, local), their
 * [start, end) window, the month grid and the axis. Days are stepped on the calendar, never as 24 h, so a range over a
 * daylight-saving change has 23 or 25 hours on that day and is still exactly its days put end to end. Browser-safe. */

import { toDateStr } from './helpers';
import { addDays, dayStart, dayTicks, hourTicks, type Interval } from './timeline-model';

/** A range of whole local days, both included. */
export interface DateRange {
  from: string;
  to: string;
}

/** Longest range the lanes are drawn for: about a quarter. Longer picks are cut to it, and the page says so. */
export const MAX_RANGE_DAYS = 92;

/** A real calendar date written `YYYY-MM-DD` (not `2026-02-30`). */
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toDateStr(dayStart(value)) === value;
}

/** The date `days` calendar days from `date`. */
export function shiftDate(date: string, days: number): string {
  return toDateStr(addDays(dayStart(date), days));
}

/** The number of days in the range, both ends included. */
export function rangeDays(r: DateRange): number {
  // Whole days apart; a daylight-saving change moves the difference by an hour at most, which rounding absorbs.
  return Math.round((dayStart(r.to) - dayStart(r.from)) / 86_400_000) + 1;
}

/** The range's [start, end): from the first day's midnight to the midnight after its last day. */
export function rangeWindow(r: DateRange): Interval {
  return [dayStart(r.from), addDays(dayStart(r.to), 1)];
}

/** `a`–`b` in either order, kept within `lo`–`hi` and cut to `MAX_RANGE_DAYS` from its first day; null when none of
 *  it is within `lo`–`hi`. */
export function clampRange(a: string, b: string, lo: string, hi: string): { range: DateRange; capped: boolean } | null {
  const [first, last] = a <= b ? [a, b] : [b, a];
  const from = first < lo ? lo : first;
  const to = last > hi ? hi : last;
  if (from > to) return null;
  const end = shiftDate(from, MAX_RANGE_DAYS - 1);
  return end < to ? { range: { from, to: end }, capped: true } : { range: { from, to }, capped: false };
}

/** The range moved by its own length, earlier (-1) or later (1); at the edge of `lo`–`hi` it stops there, keeping its
 *  length where it fits. Null when it already ends at that edge. */
export function stepRange(r: DateRange, dir: -1 | 1, lo: string, hi: string): DateRange | null {
  if (dir > 0 ? r.to >= hi : r.from <= lo) return null;
  const n = rangeDays(r);
  let from = shiftDate(r.from, n * dir);
  let to = shiftDate(r.to, n * dir);
  if (to > hi) [from, to] = [shiftDate(hi, 1 - n), hi];
  if (from < lo) [from, to] = [lo, shiftDate(lo, n - 1)];
  return clampRange(from, to, lo, hi)?.range ?? null;
}

export type QuickRange = 'last7' | 'last30' | 'month';

export const QUICK_RANGES: [QuickRange, string][] = [['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['month', 'This month']];

/** A quick pick ending `today`: the last 7 or 30 days, or this month so far. */
export function quickRange(kind: QuickRange, today: string): DateRange {
  if (kind === 'month') return { from: today.slice(0, 8) + '01', to: today };
  return { from: shiftDate(today, kind === 'last7' ? -6 : -29), to: today };
}

/** `YYYY-MM` of a date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month `n` months from `month` (`YYYY-MM`). */
export function shiftMonth(month: string, n: number): string {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1);
  return toDateStr(d.getTime()).slice(0, 7);
}

/** The 42 days (six Monday-to-Sunday weeks) a month's calendar shows, from the Monday on or before its first day. */
export function monthCells(month: string): string[] {
  const first = new Date(month + '-01T00:00:00');
  const start = shiftDate(month + '-01', -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => shiftDate(start, i));
}

/** The same calendar day `n` months later, kept within that month (31 Jan + 1 month is 28 or 29 Feb). */
export function shiftDateByMonths(date: string, n: number): string {
  const month = shiftMonth(monthOf(date), n);
  const last = shiftDate(shiftMonth(month, 1) + '-01', -1);
  const day = `${month}-${date.slice(8)}`;
  return isDate(day) && day <= last ? day : last;
}

/** Axis ticks for a range of two days or more: every 6 hours over up to 3 days (each day's start named by its day), each day
 *  up to 2 weeks, every other day up to a month, then each Monday. Few enough to draw in every lane. */
export function rangeTicks(start: number, end: number): [number, string][] {
  const days = dayTicks(start, end);
  const dayName = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const dateName = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (days.length <= 3) {
    // Each day is named at its start: midnight, or 1:00 where the clock springs forward at midnight.
    const starts = new Set(days);
    const hours = hourTicks(start, end, 6).filter(t => !starts.has(t) && new Date(t).getHours() !== 0);
    return [...days.map((t): [number, string] => [t, dayName(t)]), ...hours.map((t): [number, string] => [t, `${new Date(t).getHours()}:00`])]
      .sort((a, b) => a[0] - b[0]);
  }
  if (days.length <= 14) return days.map((t): [number, string] => [t, dayName(t)]);
  if (days.length <= 31) return days.filter((_, i) => i % 2 === 0).map((t): [number, string] => [t, dateName(t)]);
  return days.filter(t => new Date(t).getDay() === 1).map((t): [number, string] => [t, dateName(t)]);
}
