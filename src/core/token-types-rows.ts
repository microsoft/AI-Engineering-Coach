/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Row-based token types: reasoning share by effort, truncated calls and model-call latency, summed over the
 * shared per-request rows (`ModelCallRow`, filled by call-outputs.ts). Ratios are ratios of sums over the
 * calls that logged each value; latency percentiles are over the stored per-call samples. Compaction-summary
 * rows are left out: compaction has its own figures (`CompactionEvent.tokensUsed`). */

import type {
  EffortReasoning,
  LatencyByModel,
  ModelCallRow,
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

/** Rows of the requests' main-agent and sub-agent calls. */
export function callRows(requests: Iterable<SessionRequest>): ModelCallRow[] {
  const rows: ModelCallRow[] = [];
  for (const request of requests) {
    for (const row of request.promptCache?.rows ?? []) if (row.stream !== 'compaction') rows.push(row);
  }
  return rows;
}

/** The request logged per-call output for its main agent (Copilot CLI and Copilot App builds with
 *  `session.usage_record`). */
export function hasPerCallOutputs(request: SessionRequest): boolean {
  return request.promptCache?.rows.some(row => row.stream === 'main' && row.outputTokens != null) ?? false;
}

export function effortOf(row: ModelCallRow): Effort {
  return effortKey(row.reasoningEffort);
}

/** A row's reasoning by effort, over the calls that logged both output and reasoning tokens. */
export function reasoningParts(row: ModelCallRow): EffortReasoning[] {
  if (row.outputTokens == null || row.reasoningTokens == null) return [];
  return row.reasoningByEffort
    ?? [{ effort: effortOf(row), calls: row.calls, outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens }];
}

/** Reasoning share of output for the main agent and sub-agents, and by reasoning effort. Only calls that logged
 *  reasoning tokens count, in both parts of the share. `null` without any such call. */
export function rowReasoning(rows: ModelCallRow[]): TokenTypesReasoning | null {
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

/** Truncated (and, where logged, content-filtered) calls, over the calls that logged why they stopped. `null`
 *  when no row logged it. */
export function rowTruncation(rows: ModelCallRow[]): TokenTypesTruncation | null {
  let calls = 0, truncated = 0, filtered = 0, filterLogged = false;
  for (const row of rows) {
    if (row.truncatedCalls == null) continue;
    calls += row.stopCalls ?? row.calls;
    truncated += row.truncatedCalls;
    if (row.filteredCalls != null) {
      filterLogged = true;
      filtered += row.filteredCalls;
    }
  }
  if (calls === 0) return null;
  return { calls, truncatedCalls: truncated, filteredCalls: filterLogged ? filtered : null };
}

/** Nearest-rank percentile of ascending values. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function ascending(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** First-token time and call duration by model, most calls first. `null` when no row logged latency. */
export function rowLatency(rows: ModelCallRow[]): LatencyByModel[] | null {
  const models = new Map<string, { calls: number; ttft: number[]; duration: number[] }>();
  for (const row of rows) {
    if (!row.ttftMs?.length && !row.durationMs?.length) continue;
    const entry = models.get(row.model) ?? { calls: 0, ttft: [], duration: [] };
    entry.calls += row.calls;
    entry.ttft.push(...(row.ttftMs ?? []));
    entry.duration.push(...(row.durationMs ?? []));
    models.set(row.model, entry);
  }
  if (models.size === 0) return null;
  return [...models]
    .map(([model, entry]) => {
      const ttft = ascending(entry.ttft);
      const duration = ascending(entry.duration);
      return {
        model,
        calls: entry.calls,
        ttftP50Ms: percentile(ttft, 50),
        ttftP90Ms: percentile(ttft, 90),
        durationP50Ms: percentile(duration, 50),
        durationP90Ms: percentile(duration, 90),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
    .slice(0, MAX_LATENCY_MODELS);
}

/** Main-agent input and output tokens of rows that logged per-call output. */
export function mainTokens(rows: ModelCallRow[]): { input: number; output: number } {
  let input = 0, output = 0;
  for (const row of rows) {
    if (row.stream !== 'main' || row.outputTokens == null) continue;
    input += row.input;
    output += row.outputTokens;
  }
  return { input, output };
}
