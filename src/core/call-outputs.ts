/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Output-side fields of one Copilot CLI or Copilot App model call (`session.usage_record`): output and
 * reasoning tokens, the reported context limit, why the call stopped, and its latency. Read in the same
 * pass as the other per-call fields (see cli-model-calls.ts) and summed per (stream, model) row. */

export type CliFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

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
  /** How long the call took (`duration`). */
  durationMs: number | null;
}

/** Summed output-side fields of a (stream, model) row. Latency samples are kept per call. */
export interface CallOutputTotals {
  outputTokens: number;
  /** `null` when no call reported reasoning tokens. */
  reasoningTokens: number | null;
  /** Calls that stopped at the output-token limit (`finishReason: length`). */
  truncatedCalls: number;
  filteredCalls: number;
  ttftMs: number[];
  durationMs: number[];
}

/** Most latency samples kept per row; longer series are thinned evenly. */
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
    durationMs: nonNegative(usage.duration),
  };
}

export function emptyCallOutputs(): CallOutputTotals {
  return { outputTokens: 0, reasoningTokens: null, truncatedCalls: 0, filteredCalls: 0, ttftMs: [], durationMs: [] };
}

export function addCallOutputs(totals: CallOutputTotals, call: CliCallOutputs): void {
  totals.outputTokens += call.outputTokens;
  if (call.reasoningTokens != null) totals.reasoningTokens = (totals.reasoningTokens ?? 0) + call.reasoningTokens;
  if (call.finishReason === 'length') totals.truncatedCalls++;
  if (call.contentFilter) totals.filteredCalls++;
  if (call.ttftMs != null) totals.ttftMs.push(Math.round(call.ttftMs));
  if (call.durationMs != null) totals.durationMs.push(Math.round(call.durationMs));
}

/** Keep at most `max` values, evenly spaced and including the first and last. */
export function thinSamples(values: number[], max = MAX_LATENCY_SAMPLES): number[] {
  if (values.length <= max) return values;
  if (max <= 1) return values.slice(0, Math.max(0, max));
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]);
}

/** Thin the latency samples before the row is stored. */
export function finishCallOutputs(totals: CallOutputTotals): CallOutputTotals {
  return { ...totals, ttftMs: thinSamples(totals.ttftMs), durationMs: thinSamples(totals.durationMs) };
}
