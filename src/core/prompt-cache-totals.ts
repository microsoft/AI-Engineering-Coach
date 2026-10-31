/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Token-sum accumulators for the Prompt Cache tab. Ratios are always ratios of sums (token-weighted). */

import type { CacheCost, CacheTotals, ModelCallRow } from './types';

export interface TotalsAcc {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  missCost: number;
  ratedInput: number;
}

export function emptyTotals(): TotalsAcc {
  return { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, cost: 0, missCost: 0, ratedInput: 0 };
}

export function addUsage(acc: TotalsAcc, row: Pick<ModelCallRow, 'calls' | 'input' | 'cacheRead' | 'cacheWrite' | 'cost' | 'missCost' | 'ratedInput'>): void {
  acc.calls += row.calls;
  acc.input += row.input;
  acc.cacheRead += row.cacheRead;
  acc.cacheWrite += row.cacheWrite;
  acc.cost += row.cost ?? 0;
  acc.missCost += row.missCost ?? 0;
  acc.ratedInput += row.ratedInput ?? 0;
}

export function mergeTotals(target: TotalsAcc, source: TotalsAcc): void {
  addUsage(target, source);
}

/** Percent rounded to one decimal; `null` without a base. */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function missesOf(acc: TotalsAcc): number {
  return Math.max(0, acc.input - acc.cacheRead);
}

export function toTotals(acc: TotalsAcc): CacheTotals | null {
  if (acc.input <= 0) return null;
  const uncached = Math.max(0, acc.input - acc.cacheRead - acc.cacheWrite);
  return {
    calls: acc.calls,
    input: acc.input,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    uncached,
    hitPct: pct(acc.cacheRead, acc.input),
    writePct: pct(acc.cacheWrite, acc.input),
    uncachedPct: pct(uncached, acc.input),
  };
}

/** Cost effect over the calls that logged rates; `null` when none did. */
export function toCost(acc: TotalsAcc): CacheCost | null {
  if (acc.ratedInput <= 0 || acc.cost <= 0) return null;
  return {
    savedPct: Math.max(0, Math.round((1 - acc.cost / acc.ratedInput) * 1000) / 10),
    missCostPct: pct(acc.missCost, acc.cost) ?? 0,
    ratedPct: pct(acc.ratedInput, acc.input) ?? 0,
  };
}
