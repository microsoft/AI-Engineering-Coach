/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Row-based token types: reasoning share by effort, truncated calls and model-call latency, summed over the
 * per-request rows (`CallRow`, filled by call-outputs.ts): the rows of calls that reported their cache usage and
 * the rows of calls that didn't, so token types never depend on cache data. Ratios are ratios of sums over the
 * calls that logged each value; latency percentiles are over the stored per-call samples, each weighted by the
 * calls it stands for. Compaction-summary rows are left out: compaction has its own figures
 * (`CompactionEvent.tokensUsed`). */

import type {
  CallRow,
  EffortReasoning,
  LatencyByModel,
  ReasoningByEffort,
  ReasoningShare,
  SessionRequest,
  TokenTypesReasoning,
  TokenTypesTruncation,
} from './types';
import { effortKey } from './call-outputs';

type Effort = ReasoningByEffort['effort'];
type CallStream = ReasoningByEffort['stream'];

const EFFORT_ORDER: readonly Effort[] = ['max', 'high', 'medium', 'low', 'unknown'];
/** Most models listed in the latency table. */
const MAX_LATENCY_MODELS = 12;

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function reasoningShare(outputTokens: number, reasoningTokens: number): ReasoningShare {
  return { outputTokens, reasoningTokens, sharePct: pct(Math.min(reasoningTokens, outputTokens), outputTokens) };
}

/** Every row of a request's calls, whether or not they reported their cache usage, compaction summaries included. */
export function requestCallRows(request: SessionRequest): CallRow[] {
  return [...request.promptCache?.rows ?? [], ...request.callRowsWithoutCacheData ?? []];
}

/** Rows of the requests' main-agent and sub-agent calls. */
export function callRows(requests: Iterable<SessionRequest>): CallRow[] {
  const rows: CallRow[] = [];
  for (const request of requests) {
    for (const row of requestCallRows(request)) if (row.stream !== 'compaction') rows.push(row);
  }
  return rows;
}

/** The request logged per-call output for its main agent (Copilot CLI and Copilot App builds with
 *  `session.usage_record`). */
export function hasPerCallOutputs(request: SessionRequest): boolean {
  return requestCallRows(request).some(row => row.stream === 'main' && row.outputTokens != null);
}

export function effortOf(row: CallRow): Effort {
  return effortKey(row.reasoningEffort);
}

/** A row's reasoning by effort, over the calls that logged both output and reasoning tokens. */
export function reasoningParts(row: CallRow): EffortReasoning[] {
  if (row.outputTokens == null || row.reasoningTokens == null) return [];
  return row.reasoningByEffort
    ?? [{ effort: effortOf(row), calls: row.calls, outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens }];
}

/** Reasoning share of output for the main agent and sub-agents, and by reasoning effort. Only calls that logged
 *  reasoning tokens count, in both parts of the share. `null` without any such call. */
export function rowReasoning(rows: CallRow[]): TokenTypesReasoning | null {
  const streams = new Map<CallStream, { output: number; reasoning: number }>();
  const byEffort = new Map<string, ReasoningByEffort>();
  for (const row of rows) {
    if (row.stream === 'compaction') continue;
    const stream = row.stream;
    for (const part of reasoningParts(row)) {
      const totals = streams.get(stream) ?? { output: 0, reasoning: 0 };
      totals.output += part.outputTokens;
      totals.reasoning += part.reasoningTokens;
      streams.set(stream, totals);
      const key = `${stream}:${part.effort}`;
      const entry = byEffort.get(key) ?? { effort: part.effort, stream, calls: 0, outputTokens: 0, reasoningTokens: 0, sharePct: null };
      entry.calls += part.calls;
      entry.outputTokens += part.outputTokens;
      entry.reasoningTokens += part.reasoningTokens;
      byEffort.set(key, entry);
    }
  }
  if (streams.size === 0) return null;
  const shareOf = (stream: CallStream): ReasoningShare | null => {
    const totals = streams.get(stream);
    return totals && totals.output > 0 ? reasoningShare(totals.output, totals.reasoning) : null;
  };
  return {
    basis: 'calls',
    main: shareOf('main'),
    subagent: shareOf('subagent'),
    byEffort: [...byEffort.values()]
      .filter(entry => entry.outputTokens > 0)
      .map(entry => ({ ...entry, sharePct: reasoningShare(entry.outputTokens, entry.reasoningTokens).sharePct }))
      .sort((a, b) => (a.stream === b.stream ? 0 : a.stream === 'main' ? -1 : 1) || EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort)),
  };
}

/** Truncated calls, over the calls that logged why they stopped, and content-filtered calls, over the calls that
 *  logged the filter. The two are counted independently: a call can log one without the other. `null` when no
 *  row logged either. */
export function rowTruncation(rows: CallRow[]): TokenTypesTruncation | null {
  let calls = 0, truncated = 0, filtered = 0, stopLogged = false, filterLogged = false;
  for (const row of rows) {
    if (row.truncatedCalls != null) {
      stopLogged = true;
      calls += row.stopCalls ?? row.calls;
      truncated += row.truncatedCalls;
    }
    if (row.filteredCalls != null) {
      filterLogged = true;
      filtered += row.filteredCalls;
    }
  }
  if (!stopLogged && !filterLogged) return null;
  return {
    calls: stopLogged ? calls : null,
    truncatedCalls: stopLogged ? truncated : null,
    filteredCalls: filterLogged ? filtered : null,
  };
}

/** A latency sample and the calls it stands for: more than one when its row's samples were thinned. */
interface WeightedSample {
  value: number;
  weight: number;
}

/** A row's latency samples, each weighted by the calls it stands for (`ttftCalls` or `durationCalls` over the samples
 *  kept), so thinning doesn't change a row's weight among rows. A row without the count weighs each sample once. */
export function latencySamples(values: number[] | undefined, calls: number | undefined): WeightedSample[] {
  if (!values?.length) return [];
  const weight = Math.max(calls ?? 0, values.length) / values.length;
  return values.map(value => ({ value, weight }));
}

/** Nearest-rank percentile of weighted samples: the smallest value whose cumulative weight reaches p% of the total.
 *  With every weight 1, it is the nearest-rank percentile of the values. `null` without samples. */
export function weightedPercentile(samples: readonly WeightedSample[], p: number): number | null {
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (sorted.length === 0 || total <= 0) return null;
  const target = (p / 100) * total;
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.weight;
    if (cumulative >= target) return sample.value;
  }
  return sorted[sorted.length - 1].value;
}

/** First-token time and call duration by model, most calls first. `null` when no row logged latency. */
export function rowLatency(rows: CallRow[]): LatencyByModel[] | null {
  const models = new Map<string, { calls: number; ttft: WeightedSample[]; duration: WeightedSample[] }>();
  for (const row of rows) {
    if (!row.ttftMs?.length && !row.durationMs?.length) continue;
    const entry = models.get(row.model) ?? { calls: 0, ttft: [], duration: [] };
    entry.calls += row.calls;
    entry.ttft.push(...latencySamples(row.ttftMs, row.ttftCalls));
    entry.duration.push(...latencySamples(row.durationMs, row.durationCalls));
    models.set(row.model, entry);
  }
  if (models.size === 0) return null;
  return [...models]
    .map(([model, entry]) => ({
      model,
      calls: entry.calls,
      ttftP50Ms: weightedPercentile(entry.ttft, 50),
      ttftP90Ms: weightedPercentile(entry.ttft, 90),
      durationP50Ms: weightedPercentile(entry.duration, 50),
      durationP90Ms: weightedPercentile(entry.duration, 90),
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
    .slice(0, MAX_LATENCY_MODELS);
}

/** Main-agent input and output tokens of rows that logged per-call output. */
export function mainTokens(rows: CallRow[]): { input: number; output: number } {
  let input = 0, output = 0;
  for (const row of rows) {
    if (row.stream !== 'main' || row.outputTokens == null) continue;
    input += row.input;
    output += row.outputTokens;
  }
  return { input, output };
}
