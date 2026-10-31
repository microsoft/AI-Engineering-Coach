/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context layers for the shared call-timeline chart (call-timeline-chart.ts), used by Context Management's
 * Copilot CLI and Copilot App drill-down: the context size, the reported limit with the verdict thresholds,
 * each turn's context at its end, compactions, truncated calls, and output with reasoning. Line datasets
 * get their own `stack`, because the chart stacks its bars. */

import type { CallTimeline, ContextVerdictThresholds, SessionTimelineData, TimelineCompaction } from '../core/types';
import { bucketOfCall, reasoningCallsOf } from '../core/call-timeline';
import type { CallTimelineLayer, CallTimelineMarker } from './call-timeline-chart';
import { COLORS, formatNum } from './shared';

const COMPACTION_COLOR = COLORS.purple;
const TRUNCATION_COLOR = COLORS.pink;

function line(label: string, data: (number | null)[], color: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0,
    pointHitRadius: 6, spanGaps: true, stack: `line:${label}`, order: -1, ...extra,
  };
}

/** The largest prompt in each bar: how full the context window got. */
export function contextPeakLayer(): CallTimelineLayer {
  return {
    id: 'context',
    label: 'Context',
    help: 'The largest prompt in each bar, including cached tokens: how full the context window got.',
    defaultOn: true,
    datasets: timeline => (timeline.buckets.some(b => b.peakPrompt != null)
      ? [line('Context (largest prompt)', timeline.buckets.map(b => b.peakPrompt ?? null), COLORS.blue, { fill: 'origin', backgroundColor: 'rgba(88,166,255,0.12)' })]
      : []),
  };
}

/** The limit the CLI reported for each bar's calls, and the utilization at which Context Management's verdicts change. */
export function contextLimitLayer(thresholds: ContextVerdictThresholds): CallTimelineLayer {
  return {
    id: 'limit',
    label: 'Limit and thresholds',
    help: `The context limit Copilot reported for the calls, and the utilization at which a session counts as degraded (${Math.round(thresholds.optimalUtilization)}%) or limited (${Math.round(thresholds.limitedUtilization)}%). Copilot compacts automatically at about 80% of the limit.`,
    defaultOn: true,
    datasets: timeline => {
      const limits = timeline.buckets.map(b => b.contextLimit ?? null);
      if (!limits.some(limit => limit != null)) return [];
      const at = (pct: number) => limits.map(limit => (limit == null ? null : Math.round((limit * pct) / 100)));
      return [
        line('Context limit (reported)', limits, COLORS.red, { stepped: true }),
        line(`Limited from ${Math.round(thresholds.limitedUtilization)}%`, at(thresholds.limitedUtilization), COLORS.orange, { borderDash: [6, 4], borderWidth: 1, stepped: true }),
        line(`Degraded from ${Math.round(thresholds.optimalUtilization)}%`, at(thresholds.optimalUtilization), COLORS.yellow, { borderDash: [2, 4], borderWidth: 1, stepped: true }),
      ];
    },
  };
}

/** Bar index of each turn's last main-agent call. */
export function turnEndBuckets(timeline: CallTimeline): Map<number, number> {
  const ends = new Map<number, number>();
  for (const [index, bucket] of timeline.buckets.entries()) {
    for (let r = bucket.firstRequest; r <= bucket.lastRequest; r++) ends.set(r, index);
  }
  return ends;
}

/** A point at each turn's end: the context Context Management scores (the turn's last prompt). */
export function turnEndLayer(data: SessionTimelineData): CallTimelineLayer {
  const turnEnds = data.context?.turnEnds ?? [];
  return {
    id: 'turns',
    label: 'Turn ends',
    help: 'The context when each of your turns ended: the prompt of its last main-agent call. Context Management scores utilization from these points.',
    defaultOn: true,
    datasets: timeline => {
      const values: (number | null)[] = timeline.buckets.map(() => null);
      for (const [request, index] of turnEndBuckets(timeline)) {
        const tokens = turnEnds[request];
        if (tokens != null) values[index] = tokens;
      }
      if (!values.some(v => v != null)) return [];
      return [line('Context at turn end', values, COLORS.cyan, { showLine: false, pointRadius: 3, pointHoverRadius: 5, pointStyle: 'circle' })];
    },
  };
}

function compactionMarker(c: TimelineCompaction): CallTimelineMarker {
  const sizes = c.tokensAfter == null ? formatNum(c.tokensBefore) : `${formatNum(c.tokensBefore)}\u2192${formatNum(c.tokensAfter)}`;
  const share = c.tokenLimit ? ` (${Math.round((c.tokensBefore / c.tokenLimit) * 100)}% of the ${formatNum(c.tokenLimit)} limit)` : '';
  const who = c.trigger === 'automatic' ? 'Automatic compaction' : c.trigger === 'manual' ? 'Compaction you started' : 'Compaction';
  if (c.failed) return { label: 'Compaction failed', detail: `${who} failed at ${formatNum(c.tokensBefore)} tokens${share}.`, color: COLORS.red };
  return {
    label: `Compacted ${sizes}`,
    detail: `${who}: Copilot logged ${formatNum(c.tokensBefore)} tokens before${share}${c.tokensAfter == null ? '' : ` and ${formatNum(c.tokensAfter)} after`}.`,
    color: COMPACTION_COLOR,
  };
}

/** Compactions, at the first call after each one (where the smaller context shows). */
export function compactionLayer(data: SessionTimelineData): CallTimelineLayer {
  const compactions = data.context?.compactions ?? [];
  return {
    id: 'compactions',
    label: 'Compactions',
    help: 'When the context was summarized to make room, with its size before and after.',
    defaultOn: true,
    markers: timeline => {
      const markers = new Map<number, CallTimelineMarker[]>();
      for (const c of compactions) {
        const index = bucketOfCall(timeline, c.callIndex);
        markers.set(index, [...(markers.get(index) ?? []), compactionMarker(c)]);
      }
      return markers;
    },
  };
}

/** Bars with calls that stopped at the output-token limit. */
export function truncationLayer(): CallTimelineLayer {
  return {
    id: 'truncations',
    label: 'Truncated calls',
    help: 'Model calls that stopped at the output-token limit, so their answer was cut off.',
    defaultOn: true,
    markers: timeline => {
      const markers = new Map<number, CallTimelineMarker[]>();
      for (const [index, bucket] of timeline.buckets.entries()) {
        const n = bucket.truncatedCalls ?? 0;
        if (n > 0) markers.set(index, [{ label: 'Truncated', detail: `${n} call${n === 1 ? '' : 's'} stopped at the output-token limit.`, color: TRUNCATION_COLOR }]);
      }
      return markers;
    },
  };
}

/** Output and reasoning tokens per call, on the right-hand axis (they are far smaller than the context). Reasoning
 *  is averaged over the calls that logged it. */
export function outputLayer(): CallTimelineLayer {
  return {
    id: 'output',
    label: 'Output and reasoning',
    help: 'Average output tokens per model call, and the part that was reasoning, on the right-hand axis.',
    defaultOn: false,
    datasets: timeline => {
      if (!timeline.buckets.some(b => b.output != null)) return [];
      const perCall = (value: number | undefined, calls: number) => (value == null || calls <= 0 ? null : Math.round(value / calls));
      const calls = timeline.buckets.map(b => b.lastCall - b.firstCall + 1);
      return [
        line('Output per call', timeline.buckets.map((b, i) => perCall(b.output, calls[i])), COLORS.green, { yAxisID: 'y1' }),
        line('Reasoning per call', timeline.buckets.map(b => perCall(b.reasoning, reasoningCallsOf(b))), COLORS.green, { yAxisID: 'y1', borderDash: [4, 3] }),
      ];
    },
  };
}
