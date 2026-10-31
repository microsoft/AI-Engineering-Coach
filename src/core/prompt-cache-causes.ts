/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Cache-break attribution for the Prompt Cache tab: cause rows, who can change each cause, where cache
 * misses came from, and the time since the cache was last refreshed against the logged cache lifetime. */

import type {
  CacheBreak,
  CacheBreakCause,
  CacheBreakConfidence,
  CacheCauseKey,
  CacheCauseSummary,
  CacheControl,
  CacheIdleBucket,
  CacheIdleSummary,
  CacheOriginSlice,
  RequestPromptCache,
} from './types';
import { emptyTotals, missesOf, pct, type TotalsAcc } from './prompt-cache-totals';

/** System-prompt segments that hold what you wrote: instruction files and memories. */
const YOUR_SEGMENTS = new Set(['custom_instructions', 'memory']);

const CONTROL: Record<CacheCauseKey, CacheControl> = {
  'ttl-user': 'you',
  'ttl-agent': 'partly',
  resume: 'you',
  'model-switch': 'you',
  'model-auto': 'harness',
  'reasoning-effort': 'you',
  'tools-changed': 'partly',
  'instructions-changed': 'you',
  'system-prompt': 'harness',
  compaction: 'harness',
  'mode-change': 'you',
  unattributed: 'unknown',
};

/** Buckets of the time since the cache was last refreshed, in multiples of the cache lifetime, upper bound
 *  inclusive. */
const IDLE_BUCKETS: { label: string; max: number }[] = [
  { label: '\u22642\u00d7', max: 2 },
  { label: '2\u20136\u00d7', max: 6 },
  { label: '6\u201324\u00d7', max: 24 },
  { label: '>24\u00d7', max: Number.POSITIVE_INFINITY },
];

/** The cause row a break belongs to. */
export function causeKey(brk: CacheBreak): CacheCauseKey {
  const primary = brk.causes[0];
  switch (primary) {
    case undefined: return 'unattributed';
    case 'ttl-expired': return brk.initiator === 'agent' ? 'ttl-agent' : 'ttl-user';
    case 'model-switch': return brk.autoModel ? 'model-auto' : 'model-switch';
    case 'system-prompt': return brk.segments?.some(segment => YOUR_SEGMENTS.has(segment)) ? 'instructions-changed' : 'system-prompt';
    default: return primary;
  }
}

export function causeControl(key: CacheCauseKey): CacheControl {
  return CONTROL[key];
}

interface CauseAcc {
  breaks: number;
  rebuiltTokens: number;
  rebuiltCost: number;
  confidence: Record<CacheBreakConfidence, number>;
  segments: Map<string, number>;
  alsoSeen: Map<CacheBreakCause, number>;
}

function topEntries<K>(map: Map<K, number>, limit: number): [K, number][] {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** Cause rows, most rebuilt tokens first. `totalRebuilt` and `totalCost` are the bases for the shares. */
export function summarizeCauses(breaks: CacheBreak[], totalRebuilt: number, totalCost: number): CacheCauseSummary[] {
  const byKey = new Map<CacheCauseKey, CauseAcc>();
  for (const brk of breaks) {
    const key = causeKey(brk);
    let acc = byKey.get(key);
    if (!acc) {
      acc = { breaks: 0, rebuiltTokens: 0, rebuiltCost: 0, confidence: { logged: 0, checkpoint: 0, unattributed: 0 }, segments: new Map(), alsoSeen: new Map() };
      byKey.set(key, acc);
    }
    acc.breaks++;
    acc.rebuiltTokens += brk.rebuiltTokens;
    acc.rebuiltCost += brk.rebuiltCost ?? 0;
    acc.confidence[brk.confidence]++;
    for (const segment of brk.segments ?? []) acc.segments.set(segment, (acc.segments.get(segment) ?? 0) + 1);
    for (const cause of brk.causes.slice(1)) acc.alsoSeen.set(cause, (acc.alsoSeen.get(cause) ?? 0) + 1);
  }
  return [...byKey]
    .map(([key, acc]) => ({
      key,
      control: causeControl(key),
      breaks: acc.breaks,
      rebuiltTokens: acc.rebuiltTokens,
      pctOfRebuilt: pct(acc.rebuiltTokens, totalRebuilt) ?? 0,
      costPct: totalCost > 0 && acc.rebuiltCost > 0 ? pct(acc.rebuiltCost, totalCost) : null,
      logged: acc.confidence.logged,
      checkpoint: acc.confidence.checkpoint,
      segments: topEntries(acc.segments, 6).map(([name, count]) => ({ name, breaks: count })),
      alsoSeen: topEntries(acc.alsoSeen, 4).map(([cause, count]) => ({ cause, breaks: count })),
    }))
    .sort((a, b) => b.rebuiltTokens - a.rebuiltTokens || b.breaks - a.breaks);
}

/** Percent of all rebuilt tokens by who can change the cause. `totalRebuilt` includes breaks that aren't listed
 *  (beyond a session's listing cap); their causes aren't known, so their tokens count as unknown. */
export function controlShares(causes: CacheCauseSummary[], totalRebuilt: number): Record<CacheControl, number> {
  const listed = causes.reduce((sum, cause) => sum + cause.rebuiltTokens, 0);
  const total = Math.max(totalRebuilt, listed);
  const out: Record<CacheControl, number> = { you: 0, partly: 0, harness: 0, unknown: total - listed };
  for (const cause of causes) out[cause.control] += cause.rebuiltTokens;
  for (const control of Object.keys(out) as CacheControl[]) out[control] = pct(out[control], total) ?? 0;
  return out;
}

/** Request-level sums the origins need, for the attribution harnesses. */
export interface OriginAcc {
  main: TotalsAcc;
  subagents: TotalsAcc;
  compaction: TotalsAcc;
  coldStart: number;
  coldStartCost: number;
  rebuilt: number;
  rebuiltCost: number;
  returns: number;
  expiredReturns: number;
}

export function emptyOrigins(): OriginAcc {
  return { main: emptyTotals(), subagents: emptyTotals(), compaction: emptyTotals(), coldStart: 0, coldStartCost: 0, rebuilt: 0, rebuiltCost: 0, returns: 0, expiredReturns: 0 };
}

export function addRequestExtras(acc: OriginAcc, cache: RequestPromptCache): void {
  acc.coldStart += cache.coldStart ?? 0;
  acc.coldStartCost += cache.coldStartCost ?? 0;
  acc.rebuilt += cache.rebuilt ?? 0;
  acc.rebuiltCost += cache.rebuiltCost ?? 0;
  acc.returns += cache.returns ?? 0;
  acc.expiredReturns += cache.expiredReturns ?? 0;
}

export function totalMisses(acc: OriginAcc): number {
  return missesOf(acc.main) + missesOf(acc.subagents) + missesOf(acc.compaction);
}

/** Where tokens not read from the cache came from. Shares of misses and, with logged rates, of input cost. */
export function buildOrigins(acc: OriginAcc, totalCost: number): CacheOriginSlice[] {
  const misses = totalMisses(acc);
  const rebuilt = Math.min(acc.rebuilt, missesOf(acc.main));
  const coldStart = Math.min(acc.coldStart, missesOf(acc.main) - rebuilt);
  const growthCost = Math.max(0, acc.main.missCost - acc.coldStartCost - acc.rebuiltCost);
  const slices: [CacheOriginSlice['origin'], number, number][] = [
    ['growth', Math.max(0, missesOf(acc.main) - coldStart - rebuilt), growthCost],
    ['rebuilt', rebuilt, acc.rebuiltCost],
    ['subagents', missesOf(acc.subagents), acc.subagents.missCost],
    ['compaction', missesOf(acc.compaction), acc.compaction.missCost],
    ['cold-start', coldStart, acc.coldStartCost],
  ];
  return slices
    .filter(([, tokens]) => tokens > 0)
    .map(([origin, tokens, cost]) => ({
      origin,
      tokens,
      pct: pct(tokens, misses) ?? 0,
      costPct: totalCost > 0 ? pct(cost, totalCost) : null,
    }));
}

function idleLabel(brk: CacheBreak): string | null {
  if (brk.idleSeconds == null || brk.ttlSeconds == null || brk.ttlSeconds <= 0) return null;
  const ratio = brk.idleSeconds / brk.ttlSeconds;
  return IDLE_BUCKETS.find(bucket => ratio <= bucket.max)?.label ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Time since the cache was last refreshed at cache-expiry breaks, and the cache lifetime logged per model. */
export function buildIdle(breaks: CacheBreak[], acc: OriginAcc, ttlCalls: Map<string, Map<number, number>>): CacheIdleSummary {
  const buckets: CacheIdleBucket[] = IDLE_BUCKETS.map(bucket => ({ label: bucket.label, user: 0, agent: 0 }));
  const idleMinutes: number[] = [];
  for (const brk of breaks) {
    if (brk.causes[0] !== 'ttl-expired') continue;
    if (brk.idleSeconds != null) idleMinutes.push(brk.idleSeconds / 60);
    const bucket = buckets.find(b => b.label === idleLabel(brk));
    if (bucket) bucket[brk.initiator === 'agent' ? 'agent' : 'user']++;
  }
  const ttlByModel = [...ttlCalls]
    .map(([model, counts]) => {
      const [ttlSeconds, calls] = topEntries(counts, 1)[0];
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      return { model, ttlSeconds, calls: total, dominant: calls };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8)
    .map(({ model, ttlSeconds, calls }) => ({ model, ttlSeconds, calls }));
  const med = median(idleMinutes);
  return {
    ttlByModel,
    returns: acc.returns,
    expiredReturns: acc.expiredReturns,
    buckets,
    medianIdleMinutes: med == null ? null : Math.round(med),
  };
}
