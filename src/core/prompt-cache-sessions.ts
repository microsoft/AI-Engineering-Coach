/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Session-level prompt-cache views: a session's row in the Prompt Cache tab and its timeline payload
 * (`getSessionTimeline`). Both cover the whole session. */

import type {
  CacheBreakDetail,
  CacheCauseKey,
  CacheReporting,
  CacheSessionSummary,
  CacheStream,
  CallTimeline,
  Session,
  SessionCacheLayer,
  SessionTimelineData,
} from './types';
import { CallTimelineBuilder } from './call-timeline';
import { causeControl, causeKey } from './prompt-cache-causes';
import { addUsage, emptyTotals, missesOf, mergeTotals, pct, toTotals, type TotalsAcc } from './prompt-cache-totals';
import { toDateStr } from './helpers';

const ATTRIBUTION_HARNESSES = new Set(['GitHub Copilot CLI', 'GitHub Copilot App']);
const SPARKLINE_POINTS = 24;

/** Harnesses whose cache breaks are detected and attributed. */
export function attributesBreaks(harness: string): boolean {
  return ATTRIBUTION_HARNESSES.has(harness);
}

/** Codex reports cache usage only as session totals (`modelUsage`, input already excludes cached tokens). */
export function reportsSessionTotals(harness: string): boolean {
  return harness === 'Codex' || harness.startsWith('Codex');
}

/** How a harness reports cache usage when its logs carry it. */
export function expectedReporting(harness: string): CacheReporting {
  if (attributesBreaks(harness) || harness === 'OpenCode' || harness === 'Claude' || harness.startsWith('Claude')) return 'per-call';
  return reportsSessionTotals(harness) ? 'per-session' : 'none';
}

/** Codex session totals as a main-stream accumulator; `null` when the session has none. */
export function sessionTotals(session: Session): TotalsAcc | null {
  if (!reportsSessionTotals(session.harness) || !session.modelUsage) return null;
  const acc = emptyTotals();
  for (const usage of Object.values(session.modelUsage)) {
    addUsage(acc, {
      calls: 0,
      input: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    });
  }
  return acc.input > 0 ? acc : null;
}

interface SessionStreams {
  streams: Record<CacheStream, TotalsAcc>;
  rebuilt: number;
  hasData: boolean;
}

function sessionStreams(session: Session): SessionStreams {
  const streams: Record<CacheStream, TotalsAcc> = { main: emptyTotals(), subagent: emptyTotals(), compaction: emptyTotals() };
  let rebuilt = 0;
  let hasData = false;
  for (const request of session.requests) {
    const cache = request.promptCache;
    if (!cache) continue;
    hasData = true;
    for (const row of cache.rows) addUsage(streams[row.stream], row);
    rebuilt += cache.rebuilt ?? 0;
  }
  const totals = sessionTotals(session);
  if (totals) {
    mergeTotals(streams.main, totals);
    hasData = true;
  }
  return { streams, rebuilt, hasData };
}

function breakDetails(session: Session): CacheBreakDetail[] {
  return (session.promptCache?.breaks ?? []).map(brk => {
    const key = causeKey(brk);
    return { ...brk, key, control: causeControl(key) };
  });
}

function topCause(breaks: CacheBreakDetail[]): CacheCauseKey | null {
  const byKey = new Map<CacheCauseKey, number>();
  for (const brk of breaks) byKey.set(brk.key, (byKey.get(brk.key) ?? 0) + brk.rebuiltTokens);
  let best: CacheCauseKey | null = null;
  let max = -1;
  for (const [key, tokens] of byKey) {
    if (tokens > max) {
      best = key;
      max = tokens;
    }
  }
  return best;
}

/** Per-request timeline of the main-agent rows, for harnesses without a call timeline. */
function requestTimeline(session: Session): CallTimeline | null {
  if (!session.requests.some(request => request.promptCache)) return null;
  const builder = new CallTimelineBuilder();
  for (const [requestIndex, request] of session.requests.entries()) {
    const main = emptyTotals();
    for (const row of request.promptCache?.rows ?? []) if (row.stream === 'main') addUsage(main, row);
    builder.add({
      timestamp: request.timestamp,
      requestIndex,
      cacheReported: main.input > 0,
      cacheRead: main.cacheRead,
      cacheWrite: main.cacheWrite,
      uncached: Math.max(0, main.input - main.cacheRead - main.cacheWrite),
    });
  }
  return builder.build() ?? null;
}

/** Tokens not read from the cache per timeline bucket, summed into at most `SPARKLINE_POINTS` slices. */
function sparkline(timeline: CallTimeline | null): number[] {
  if (!timeline || timeline.buckets.length === 0) return [];
  const perSlice = Math.ceil(timeline.buckets.length / SPARKLINE_POINTS);
  const out: number[] = [];
  for (let i = 0; i < timeline.buckets.length; i += perSlice) {
    out.push(timeline.buckets.slice(i, i + perSlice).reduce((sum, bucket) => sum + bucket.cacheWrite + bucket.uncached, 0));
  }
  return out;
}

function sessionDate(session: Session): string {
  const ts = session.lastMessageDate || session.creationDate;
  return ts ? toDateStr(ts) : '';
}

/** A session's row in the tab; `null` when the session reports no cache usage. */
export function summarizeSession(session: Session): CacheSessionSummary | null {
  const { streams, rebuilt, hasData } = sessionStreams(session);
  if (!hasData) return null;
  const all = emptyTotals();
  for (const acc of Object.values(streams)) mergeTotals(all, acc);
  const attributed = attributesBreaks(session.harness) && session.promptCache != null;
  const breaks = breakDetails(session);
  return {
    sessionId: session.sessionId,
    date: sessionDate(session),
    workspaceName: session.workspaceName,
    harness: session.harness,
    calls: all.calls,
    hitPct: pct(all.cacheRead, all.input),
    breaks: attributed ? breaks.length + (session.promptCache?.omittedBreaks ?? 0) : null,
    rebuiltTokens: attributed ? rebuilt : null,
    misses: missesOf(all),
    topCause: attributed ? topCause(breaks) : null,
    sparkline: sparkline(session.callTimeline ?? requestTimeline(session)),
  };
}

function cacheLayer(session: Session): SessionCacheLayer | null {
  const { streams, hasData } = sessionStreams(session);
  if (!hasData) return null;
  return {
    reporting: reportsSessionTotals(session.harness) ? 'per-session' : 'per-call',
    main: toTotals(streams.main),
    subagents: toTotals(streams.subagent),
    compaction: toTotals(streams.compaction),
    breaks: breakDetails(session),
    omittedBreaks: session.promptCache?.omittedBreaks ?? 0,
  };
}

/** The `getSessionTimeline` payload; `null` when the session has neither a timeline nor cache data. */
export function buildSessionTimeline(session: Session): SessionTimelineData | null {
  const cache = cacheLayer(session);
  if (session.callTimeline) {
    return { sessionId: session.sessionId, harness: session.harness, unit: 'calls', timeline: session.callTimeline, cache };
  }
  const timeline = requestTimeline(session);
  if (!timeline && !cache) return null;
  return { sessionId: session.sessionId, harness: session.harness, unit: 'requests', timeline, cache };
}
