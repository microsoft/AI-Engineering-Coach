/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CallTimelineBuilder, MAX_TIMELINE_BUCKETS, bucketOfCall, mergeBuckets, singleCallBucket, type CallTimelineSample } from './call-timeline';
import { CallTimelineSchema } from './schemas';

function sample(requestIndex: number, timestamp: number | null, cacheRead = 900, cacheReported = true): CallTimelineSample {
  return { timestamp, requestIndex, cacheReported, cacheRead, cacheWrite: 80, uncached: 20 };
}

describe('call timeline', () => {
  it('keeps one bucket per call up to the cap, then merges pairwise and doubles the bucket size', () => {
    const builder = new CallTimelineBuilder();
    for (let i = 0; i < MAX_TIMELINE_BUCKETS; i++) expect(builder.add(sample(i, 1_000 + i))).toBe(i);
    expect(builder.build()).toMatchObject({ calls: MAX_TIMELINE_BUCKETS, bucketSize: 1 });
    builder.add(sample(MAX_TIMELINE_BUCKETS, 5_000));
    const timeline = builder.build()!;
    expect(timeline).toMatchObject({ calls: MAX_TIMELINE_BUCKETS + 1, bucketSize: 2 });
    expect(timeline.buckets).toHaveLength(MAX_TIMELINE_BUCKETS / 2 + 1);
    expect(timeline.buckets[0]).toEqual({ firstCall: 0, lastCall: 1, firstRequest: 0, lastRequest: 1, startTs: 1_000, endTs: 1_001, cacheCalls: 2, cacheRead: 1_800, cacheWrite: 160, uncached: 40 });
    expect(timeline.buckets.at(-1)).toMatchObject({ firstCall: 120, lastCall: 120, firstRequest: 120, startTs: 5_000, cacheCalls: 1 });
    expect(timeline.buckets.reduce((sum, bucket) => sum + bucket.cacheRead, 0)).toBe(900 * (MAX_TIMELINE_BUCKETS + 1));
  });

  it('counts calls without cache data in the call range but not in the cache sums', () => {
    const builder = new CallTimelineBuilder();
    builder.add(sample(0, null, 900, false));
    expect(builder.build()!.buckets[0]).toEqual({ firstCall: 0, lastCall: 0, firstRequest: 0, lastRequest: 0, startTs: null, endTs: null, cacheCalls: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 });
    expect(new CallTimelineBuilder().build()).toBeUndefined();
  });

  it('merges adjacent buckets in one place: sums, request range and time span', () => {
    const a = singleCallBucket(4, sample(2, null, 100));
    const b = singleCallBucket(5, sample(1, 7_000, 300));
    expect(mergeBuckets(a, b)).toEqual({ firstCall: 4, lastCall: 5, firstRequest: 1, lastRequest: 2, startTs: 7_000, endTs: 7_000, cacheCalls: 2, cacheRead: 400, cacheWrite: 160, uncached: 40 });
  });

  it('finds the bucket of a call, clamped to the timeline', () => {
    const builder = new CallTimelineBuilder();
    for (let i = 0; i < MAX_TIMELINE_BUCKETS * 2 + 3; i++) builder.add(sample(0, i));
    const timeline = builder.build()!;
    expect(timeline.bucketSize).toBe(4);
    expect(bucketOfCall(timeline, 0)).toBe(0);
    expect(bucketOfCall(timeline, 9)).toBe(2);
    expect(bucketOfCall(timeline, 10_000)).toBe(timeline.buckets.length - 1);
    expect(bucketOfCall(timeline, -1)).toBe(0);
  });
});

describe('call timeline context fields', () => {
  it('keeps the context and token-type fields a call logged: peaks and limits take the larger value, the rest add up', () => {
    type ContextFields = Pick<CallTimelineSample, 'promptTokens' | 'contextLimit' | 'outputTokens' | 'reasoningTokens' | 'truncated'>;
    const context = (fields: ContextFields): CallTimelineSample => ({ ...sample(0, null), ...fields });
    const a = singleCallBucket(0, context({ promptTokens: 240_000, contextLimit: 968_000, outputTokens: 1_000, reasoningTokens: 600, truncated: false }));
    expect(a).toMatchObject({ peakPrompt: 240_000, contextLimit: 968_000, output: 1_000, reasoning: 600 });
    expect(a).not.toHaveProperty('truncatedCalls');
    const b = singleCallBucket(1, context({ promptTokens: 60_000, contextLimit: 272_000, outputTokens: 32_000, reasoningTokens: null, truncated: true }));
    expect(b).not.toHaveProperty('reasoning');
    expect(mergeBuckets(a, b)).toMatchObject({ peakPrompt: 240_000, contextLimit: 968_000, output: 33_000, reasoning: 600, truncatedCalls: 1 });

    // Request-level timelines and older builds log none of them: the fields stay absent.
    const plain = mergeBuckets(singleCallBucket(0, sample(0, null)), singleCallBucket(1, sample(0, null)));
    for (const key of ['peakPrompt', 'contextLimit', 'output', 'reasoning', 'truncatedCalls']) expect(plain).not.toHaveProperty(key);
    expect(mergeBuckets(plain, a)).toMatchObject({ peakPrompt: 240_000, output: 1_000 });

    const builder = new CallTimelineBuilder();
    for (let i = 0; i < MAX_TIMELINE_BUCKETS * 2; i++) {
      builder.add(context({ promptTokens: 1_000 + i, contextLimit: 200_000, outputTokens: 10, reasoningTokens: 4, truncated: i === 5 }));
    }
    const timeline = builder.build()!;
    expect(timeline.buckets[2]).toMatchObject({ peakPrompt: 1_005, contextLimit: 200_000, output: 20, reasoning: 8, truncatedCalls: 1 });
    expect(CallTimelineSchema.safeParse(timeline).success).toBe(true);
  });
});
