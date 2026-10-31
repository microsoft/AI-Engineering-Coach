/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Streaming builder for the neutral per-call timeline (see `types/call-timeline-types.ts`). Calls are added
 * in order; when the bucket cap is reached, adjacent buckets merge pairwise and the bucket size doubles, so
 * memory and stored size stay bounded for sessions with thousands of calls.
 *
 * To add a per-call field: add it to `CallTimelineSample` and `CallTimelineBucket`, map it in
 * `singleCallBucket`, combine it in `mergeBuckets` (sum, min or max), and add it to `CallTimelineSchema`.
 * The builder needs no change: every call is a one-call bucket folded in with `mergeBuckets`. */

import type { CallTimeline, CallTimelineBucket } from './types';

export const MAX_TIMELINE_BUCKETS = 120;

/** One call (or, for request-level timelines, one request) to add to the timeline. */
export interface CallTimelineSample {
  timestamp: number | null;
  /** Index of the request (turn) the call belongs to. */
  requestIndex: number;
  /** The call reported cache tokens; the cache fields below are ignored otherwise. */
  cacheReported: boolean;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  /* Context and token types; omitted for request-level timelines. */
  /** The call's prompt tokens, including cached tokens. */
  promptTokens?: number;
  contextLimit?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  truncated?: boolean;
}

/** Optional per-call fields of a one-call bucket; only the ones the call logged. */
function contextFields(sample: CallTimelineSample): Partial<CallTimelineBucket> {
  const out: Partial<CallTimelineBucket> = {};
  if (sample.promptTokens != null && sample.promptTokens > 0) out.peakPrompt = sample.promptTokens;
  if (sample.contextLimit != null && sample.contextLimit > 0) out.contextLimit = sample.contextLimit;
  if (sample.outputTokens != null) out.output = sample.outputTokens;
  if (sample.reasoningTokens != null) out.reasoning = sample.reasoningTokens;
  // Only truncations are marked, so buckets without one leave the field out (it would be on every bucket).
  if (sample.truncated) out.truncatedCalls = 1;
  return out;
}

type Combine = (a: number, b: number) => number;
type ContextKey = 'peakPrompt' | 'contextLimit' | 'output' | 'reasoning' | 'truncatedCalls';
const sum: Combine = (a, b) => a + b;
const MERGE_RULES: readonly [ContextKey, Combine][] = [
  ['peakPrompt', Math.max], ['contextLimit', Math.max], ['output', sum], ['reasoning', sum], ['truncatedCalls', sum],
];

/** Optional fields of two merged buckets: sums add, peaks and limits take the larger value. */
function mergeContextFields(a: CallTimelineBucket, b: CallTimelineBucket): Partial<CallTimelineBucket> {
  const out: Partial<CallTimelineBucket> = {};
  for (const [key, combine] of MERGE_RULES) {
    const x = a[key];
    const y = b[key];
    if (x != null || y != null) out[key] = x == null ? y : y == null ? x : combine(x, y);
  }
  return out;
}

/** The bucket of a single call: the one place that maps a call onto bucket fields. */
export function singleCallBucket(callIndex: number, sample: CallTimelineSample): CallTimelineBucket {
  const cache = sample.cacheReported;
  return {
    firstCall: callIndex,
    lastCall: callIndex,
    firstRequest: sample.requestIndex,
    lastRequest: sample.requestIndex,
    startTs: sample.timestamp,
    endTs: sample.timestamp,
    cacheCalls: cache ? 1 : 0,
    cacheRead: cache ? sample.cacheRead : 0,
    cacheWrite: cache ? sample.cacheWrite : 0,
    uncached: cache ? sample.uncached : 0,
    ...contextFields(sample),
  };
}

function minTs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  return b == null ? a : Math.min(a, b);
}

function maxTs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  return b == null ? a : Math.max(a, b);
}

/** Merge two adjacent buckets, `a` before `b`: the one place that combines bucket fields. */
export function mergeBuckets(a: CallTimelineBucket, b: CallTimelineBucket): CallTimelineBucket {
  return {
    firstCall: a.firstCall,
    lastCall: b.lastCall,
    firstRequest: Math.min(a.firstRequest, b.firstRequest),
    lastRequest: Math.max(a.lastRequest, b.lastRequest),
    startTs: minTs(a.startTs, b.startTs),
    endTs: maxTs(a.endTs, b.endTs),
    cacheCalls: a.cacheCalls + b.cacheCalls,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    uncached: a.uncached + b.uncached,
    ...mergeContextFields(a, b),
  };
}

export class CallTimelineBuilder {
  private buckets: CallTimelineBucket[] = [];
  private bucketSize = 1;
  private calls = 0;

  /** Add the next call and return its index. */
  add(sample: CallTimelineSample): number {
    const callIndex = this.calls++;
    let index = Math.floor(callIndex / this.bucketSize);
    if (index >= MAX_TIMELINE_BUCKETS) {
      this.halve();
      index = Math.floor(callIndex / this.bucketSize);
    }
    const call = singleCallBucket(callIndex, sample);
    this.buckets[index] = index < this.buckets.length ? mergeBuckets(this.buckets[index], call) : call;
    return callIndex;
  }

  private halve(): void {
    const merged: CallTimelineBucket[] = [];
    for (let i = 0; i < this.buckets.length; i += 2) {
      const next = this.buckets[i + 1];
      merged.push(next ? mergeBuckets(this.buckets[i], next) : this.buckets[i]);
    }
    this.buckets = merged;
    this.bucketSize *= 2;
  }

  build(): CallTimeline | undefined {
    if (this.calls === 0) return undefined;
    return { calls: this.calls, bucketSize: this.bucketSize, buckets: this.buckets.map(bucket => ({ ...bucket })) };
  }
}

/** The bucket that holds a call. */
export function bucketOfCall(timeline: CallTimeline, callIndex: number): number {
  return Math.min(timeline.buckets.length - 1, Math.max(0, Math.floor(callIndex / timeline.bucketSize)));
}
