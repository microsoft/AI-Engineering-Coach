/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Neutral per-call timeline of a session's main-agent model calls (Copilot CLI and Copilot App).
 * Feature-agnostic: the prompt-cache view reads the cache fields today, and other views can add
 * per-call sums (output, reasoning, latency, …) to `CallTimelineBucket` without a second timeline.
 * Holds only call and request indexes, timestamps and token sums. */

/** Consecutive main-agent model calls of one session, summed. */
export interface CallTimelineBucket {
  /** 0-based index of the first and last main-agent call in the bucket. */
  firstCall: number;
  lastCall: number;
  /** Index of the first and last request (turn) the bucket's calls belong to. */
  firstRequest: number;
  lastRequest: number;
  /** Logged timestamps of the first and last call, i.e. when each finished (epoch ms); `null` when not
   *  logged. Copilot CLI and Copilot App log each call's duration (`CliModelCall.durationMs`). */
  startTs: number | null;
  endTs: number | null;
  /** Calls in the bucket that reported prompt-cache usage. */
  cacheCalls: number;
  /** Prompt tokens read from the cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache. */
  cacheWrite: number;
  /** Prompt tokens neither read from nor written to the cache. */
  uncached: number;
  /* Context and token types (Copilot CLI and Copilot App). Absent when no call in the bucket logged them. */
  /** Largest prompt of a call in the bucket, including cached tokens: the context size. */
  peakPrompt?: number;
  /** Largest context limit the bucket's calls reported (`maxPromptTokens`). */
  contextLimit?: number;
  /** Output tokens of the bucket's calls, including reasoning. */
  output?: number;
  /** Reasoning tokens of the bucket's calls (part of `output`). */
  reasoning?: number;
  /** Calls that stopped at the output-token limit; absent when none did. */
  truncatedCalls?: number;
}

/** A session's main-agent calls in order, grouped into at most `MAX_TIMELINE_BUCKETS` buckets
 *  of `bucketSize` calls each (the last bucket can hold fewer). */
export interface CallTimeline {
  /** Main-agent calls covered. */
  calls: number;
  bucketSize: number;
  buckets: CallTimelineBucket[];
}
