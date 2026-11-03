/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Text report of the Prompt Cache analysis for `npm run analyze:prompt-cache` (scripts/explore-prompt-cache.ts).
 * It holds only aggregates: counts, percentages, token sums, model names, cause names and system-prompt
 * segment names. It never holds workspace names, session ids, file paths or prompt text. */

import type { CacheAttribution, CacheReturnsWithoutData, PromptCacheData, Session } from './types';
import { AnalyzerBase } from './analyzer-base';
import { analyzePromptCache } from './analyzer-prompt-cache';
import { exportedOriginName } from './prompt-cache-causes';
import { toDateStr } from './helpers';

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;

/** Runs `fn` with console output held back, and counts the messages it held back. */
function withConsoleHeldBack<T>(fn: () => T): { result: T; heldBack: number } {
  const saved = CONSOLE_METHODS.map(method => Object.getOwnPropertyDescriptor(console, method));
  let heldBack = 0;
  const hold = (): void => { heldBack++; };
  for (const method of CONSOLE_METHODS) console[method] = hold;
  try {
    const result = fn();
    return { result, heldBack };
  } finally {
    for (const [i, method] of CONSOLE_METHODS.entries()) {
      const descriptor = saved[i];
      if (descriptor) Object.defineProperty(console, method, descriptor);
      else Reflect.deleteProperty(console, method);
    }
  }
}

const m = (n: number): string => `${(n / 1e6).toFixed(1)}M`;
const p = (n: number | null | undefined): string => (n == null ? 'n/a' : `${n.toFixed(1)}%`);

function harnessLines(data: PromptCacheData): string[] {
  const lines: string[] = [];
  for (const h of data.harnesses) {
    const t = h.all;
    lines.push(`${h.harness} [${h.reporting}${h.attribution ? ', attributed' : ''}]: ${h.requestsWithData}/${h.totalRequests} requests`);
    if (!t) continue;
    // Session totals (Codex) carry no count of model calls.
    lines.push(h.reporting === 'per-session'
      ? `  session totals; input ${m(t.input)}`
      : `  calls ${t.calls} (main ${h.main?.calls ?? 0}, subagent ${h.subagents?.calls ?? 0}, compaction ${h.compaction?.calls ?? 0}); input ${m(t.input)}`);
    lines.push(`  hit ${p(t.hitPct)} (main ${p(h.main?.hitPct)}, subagent ${p(h.subagents?.hitPct)}); written ${p(t.writePct)}; uncached ${p(t.uncachedPct)}`);
    if (h.cost) {
      const saved = h.cost.savedPct >= 0 ? `caching cut input cost by ${p(h.cost.savedPct)}` : `caching cost more than it saved: input cost ${p(-h.cost.savedPct)} above no caching`;
      lines.push(`  ${saved}; misses = ${p(h.cost.missCostPct)} of input cost (rates on ${p(h.cost.ratedPct)} of tokens)`);
    }
    if (h.breaks != null) lines.push(`  breaks ${h.breaks} = ${h.breaksPer100} per 100 main calls`);
  }
  return lines;
}

function attributionLines(a: CacheAttribution): string[] {
  const lines = [
    '',
    `Attribution (${a.label}): ${a.breaks} breaks over ${a.mainCalls} main calls = ${a.breaksPer100} per 100; ${a.omittedBreaks} not listed`,
    `  confidence: logged ${a.confidence.logged}, checkpoint ${a.confidence.checkpoint}, unattributed ${a.confidence.unattributed}`,
    `  rebuilt ${m(a.rebuiltTokens)} tokens; control: you ${p(a.controlPct.you)}, partly ${p(a.controlPct.partly)}, harness ${p(a.controlPct.harness)}, unknown ${p(a.controlPct.unknown)}`,
  ];
  for (const c of a.causes) {
    const segments = c.segments.length > 0 ? ` segments ${c.segments.map(s => `${s.name}:${s.breaks}`).join(', ')}` : '';
    lines.push(`  ${c.key.padEnd(22)} ${String(c.breaks).padStart(4)} breaks  ${p(c.pctOfRebuilt).padStart(6)} of rebuilt  cost ${p(c.costPct)}  [${c.control}]${segments}`);
  }
  lines.push(`  misses ${m(a.misses)}:`);
  for (const o of a.origins) lines.push(`    ${exportedOriginName(o.origin).padEnd(28)} ${p(o.pct).padStart(6)} of misses, ${p(o.costPct)} of input cost`);
  const idle = a.idle;
  lines.push(
    `  returns ${idle.returns} with a logged expiry, after expiry ${idle.expiredReturns}; ${idle.unmeasuredReturns} more without a logged expiry`,
    `  median time since the cache was refreshed, at expiry breaks: ${idle.medianIdleMinutes ?? 'n/a'} min`,
    `  expiry breaks by time since refresh: ${idle.buckets.map(b => `${b.label} you ${b.user}/agent ${b.agent}`).join('; ')}`,
    `  lifetimes: ${idle.ttlByModel.map(t => `${t.model} ${t.ttlSeconds}s (${t.calls} calls)`).join(', ')}`,
  );
  return lines;
}

function returnsOnlyLines(r: CacheReturnsWithoutData): string[] {
  return [
    '',
    `Returns without cache data (${r.label}): ${r.returns} with a logged expiry, after expiry ${r.expiredReturns}; ${r.unmeasuredReturns} more without a logged expiry`,
  ];
}

function breakdownLines(data: PromptCacheData): string[] {
  return [
    '',
    'By model:',
    ...data.models.map(model => `  ${model.harness} ${model.model}: ${model.calls} calls, hit ${p(model.hitPct)}, written ${p(model.writePct)}, breaks/100 ${model.breaksPer100 ?? 'n/a'}, ttl ${model.ttlSeconds ?? 'n/a'}`),
    '',
    'Weekly hit ratio:',
    ...data.trend.series.map(series => `  ${series.harness}: ${data.trend.labels.map((label, i) => `${label} ${p(series.hitPct[i])}`).join(', ')}`),
    '',
    `Top sessions (rebuilt tokens): ${data.topSessions.map(s => (s.rebuiltTokens == null ? m(s.misses) : m(s.rebuiltTokens))).join(', ')}`,
    '',
    'Tips:',
    ...data.tips.map(tip => `  - ${tip}`),
  ];
}

/** Parses the sessions with `parse`, analyzes the requests sent since `fromDate`, and returns the report's lines.
 *  Parser diagnostics can name sessions and files, so they're held back meanwhile and only counted. */
export function promptCacheReport(parse: () => Session[], fromDate?: string): string[] {
  const { result, heldBack } = withConsoleHeldBack(() => {
    const sessions = parse();
    const sessionOf = AnalyzerBase.buildRequestSessionMap(sessions);
    const requests = sessions
      .flatMap(session => session.requests)
      .filter(request => request.timestamp != null && request.timestamp > 0 && (!fromDate || toDateStr(request.timestamp) >= fromDate));
    return { requests: requests.length, data: analyzePromptCache(requests, request => sessionOf.get(request)) };
  });
  const { data } = result;
  return [
    `Prompt cache over ${result.requests} requests in ${data.coverage.totalSessions} sessions${fromDate ? ` since ${fromDate}` : ''}`,
    `coverage: ${data.coverage.requestsWithData}/${data.coverage.totalRequests} requests, ${data.coverage.sessionsWithData} sessions with cache data`,
    ...(heldBack > 0 ? [`${heldBack} parser ${heldBack === 1 ? 'diagnostic' : 'diagnostics'} not shown, because they can name sessions and files`] : []),
    '',
    ...harnessLines(data),
    ...(data.attribution ? attributionLines(data.attribution) : []),
    ...(data.returnsWithoutCacheData ? returnsOnlyLines(data.returnsWithoutCacheData) : []),
    ...breakdownLines(data),
  ];
}
