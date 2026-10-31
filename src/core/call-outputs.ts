/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Output-side fields of a model call: output and reasoning tokens, the reported context limit, why the call
 * stopped, and its latency. Copilot CLI and Copilot App read them from `session.usage_record` in the same
 * pass as the other per-call fields (see cli-model-calls.ts); Claude Code and OpenCode supply the subset
 * they log. They are summed onto the shared per-request rows (`ModelCallRow`) by `RequestCacheBuilder`. */

import type { ModelCallRow } from './types';

export type CliFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

/** Output-side fields of one Copilot CLI or Copilot App call. Its duration is `CliModelCall.durationMs`. */
export interface CliCallOutputs {
  outputTokens: number;
  /** Reasoning tokens, part of `outputTokens`; `null` when not reported. */
  reasoningTokens: number | null;
  /** Context limit reported for the call (`maxPromptTokens`). */
  maxPromptTokens: number | null;
  finishReason: CliFinishReason | null;
  /** The content filter stopped or changed the answer. */
  contentFilter: boolean;
  /** Time until the model sent its first token (`timeToFirstTokenMs`). */
  ttftMs: number | null;
}

/** What one call adds to its row. `null` means the harness doesn't log the value. */
export interface CallOutputSample {
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Stopped at the output-token limit. */
  truncated: boolean | null;
  /** Stopped or changed by the content filter. */
  filtered: boolean | null;
  ttftMs: number | null;
  durationMs: number | null;
}

/** Most latency samples kept per row and request; longer series are thinned evenly. */
export const MAX_LATENCY_SAMPLES = 128;

const FINISH_REASONS = new Set<string>(['stop', 'tool_calls', 'length', 'content_filter']);

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read the output-side fields from a `session.usage_record` `usage` object. */
export function readCallOutputs(usage: Record<string, unknown>): CliCallOutputs {
  const output = nonNegative(usage.outputTokens) ?? 0;
  const reasoning = nonNegative(usage.reasoningTokens);
  const limit = nonNegative(usage.maxPromptTokens);
  const finish = usage.finishReason;
  return {
    outputTokens: output,
    // A handful of calls log more reasoning than output; reasoning is part of output, so cap it.
    reasoningTokens: reasoning == null ? null : Math.min(reasoning, output),
    maxPromptTokens: limit != null && limit > 0 ? limit : null,
    finishReason: typeof finish === 'string' && finish ? (FINISH_REASONS.has(finish) ? finish as CliFinishReason : 'other') : null,
    contentFilter: usage.contentFilterTriggered === true || finish === 'content_filter',
    ttftMs: nonNegative(usage.timeToFirstTokenMs),
  };
}

/** A Copilot CLI or Copilot App call's contribution to its row. */
export function cliOutputSample(call: CliCallOutputs & { durationMs: number | null }): CallOutputSample {
  return {
    outputTokens: call.outputTokens,
    reasoningTokens: call.reasoningTokens,
    truncated: call.finishReason === 'length',
    filtered: call.contentFilter,
    ttftMs: call.ttftMs,
    durationMs: call.durationMs,
  };
}

/** A call of a harness that logs only why it stopped (Claude Code, OpenCode). */
export function stopReasonSample(truncated: boolean): CallOutputSample {
  return { outputTokens: null, reasoningTokens: null, truncated, filtered: null, ttftMs: null, durationMs: null };
}

/** Add one call's output-side fields to its row. A field stays absent until a call logs it. */
export function addRowOutputs(row: ModelCallRow, sample: CallOutputSample): void {
  if (sample.outputTokens != null) row.outputTokens = (row.outputTokens ?? 0) + sample.outputTokens;
  if (sample.reasoningTokens != null) row.reasoningTokens = (row.reasoningTokens ?? 0) + sample.reasoningTokens;
  if (sample.truncated != null) row.truncatedCalls = (row.truncatedCalls ?? 0) + (sample.truncated ? 1 : 0);
  if (sample.filtered != null) row.filteredCalls = (row.filteredCalls ?? 0) + (sample.filtered ? 1 : 0);
  if (sample.ttftMs != null) (row.ttftMs ??= []).push(Math.round(sample.ttftMs));
  if (sample.durationMs != null) (row.durationMs ??= []).push(Math.round(sample.durationMs));
}

/** Keep at most `max` values, evenly spaced and including the first and last. */
export function thinSamples(values: number[], max = MAX_LATENCY_SAMPLES): number[] {
  if (values.length <= max) return values;
  if (max <= 1) return values.slice(0, Math.max(0, max));
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]);
}

/** Thin a row's latency samples before it is stored. */
export function finishRowOutputs(row: ModelCallRow): void {
  if (row.ttftMs) row.ttftMs = thinSamples(row.ttftMs);
  if (row.durationMs) row.durationMs = thinSamples(row.durationMs);
}
