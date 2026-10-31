/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Runs the real parsers and the Prompt Cache analyzer over your local logs and prints aggregates:
 * counts, percentages, token sums, model names and cause names. It never prints workspace names,
 * session ids, file paths or prompt text. Usage: npm run analyze:prompt-cache [-- --from YYYY-MM-DD] */

import { findLogsDirs, parseAllLogs } from '../src/core/parser';
import { AnalyzerBase } from '../src/core/analyzer-base';
import { analyzePromptCache } from '../src/core/analyzer-prompt-cache';
import { toDateStr } from '../src/core/helpers';

const fromArg = process.argv.indexOf('--from');
const fromDate = fromArg > 0 ? process.argv[fromArg + 1] : undefined;

const { sessions } = parseAllLogs(findLogsDirs());
const sessionOf = AnalyzerBase.buildRequestSessionMap(sessions);
const requests = sessions
  .flatMap(session => session.requests)
  .filter(request => request.timestamp != null && request.timestamp > 0 && (!fromDate || toDateStr(request.timestamp) >= fromDate));
const data = analyzePromptCache(requests, request => sessionOf.get(request));

const m = (n: number): string => `${(n / 1e6).toFixed(1)}M`;
const p = (n: number | null | undefined): string => (n == null ? 'n/a' : `${n.toFixed(1)}%`);

console.log(`Prompt cache over ${requests.length} requests in ${data.coverage.totalSessions} sessions${fromDate ? ` since ${fromDate}` : ''}`);
console.log(`coverage: ${data.coverage.requestsWithData}/${data.coverage.totalRequests} requests, ${data.coverage.sessionsWithData} sessions with cache data\n`);

for (const h of data.harnesses) {
  const t = h.all;
  console.log(`${h.harness} [${h.reporting}${h.attribution ? ', attributed' : ''}]: ${h.requestsWithData}/${h.totalRequests} requests`);
  if (!t) continue;
  console.log(`  calls ${t.calls} (main ${h.main?.calls ?? 0}, subagent ${h.subagents?.calls ?? 0}, compaction ${h.compaction?.calls ?? 0}); input ${m(t.input)}`);
  console.log(`  hit ${p(t.hitPct)} (main ${p(h.main?.hitPct)}, subagent ${p(h.subagents?.hitPct)}); written ${p(t.writePct)}; uncached ${p(t.uncachedPct)}`);
  if (h.cost) console.log(`  caching cut input cost by ${p(h.cost.savedPct)}; misses = ${p(h.cost.missCostPct)} of input cost (rates on ${p(h.cost.ratedPct)} of tokens)`);
  if (h.breaks != null) console.log(`  breaks ${h.breaks} = ${h.breaksPer100} per 100 main calls`);
}

const a = data.attribution;
if (a) {
  console.log(`\nAttribution (${a.label}): ${a.breaks} breaks over ${a.mainCalls} main calls = ${a.breaksPer100} per 100; ${a.omittedBreaks} not listed`);
  console.log(`  confidence: logged ${a.confidence.logged}, checkpoint ${a.confidence.checkpoint}, unattributed ${a.confidence.unattributed}`);
  console.log(`  rebuilt ${m(a.rebuiltTokens)} tokens; control: you ${p(a.controlPct.you)}, partly ${p(a.controlPct.partly)}, harness ${p(a.controlPct.harness)}, unknown ${p(a.controlPct.unknown)}`);
  for (const c of a.causes) {
    const segments = c.segments.length > 0 ? ` segments ${c.segments.map(s => `${s.name}:${s.breaks}`).join(', ')}` : '';
    console.log(`  ${c.key.padEnd(22)} ${String(c.breaks).padStart(4)} breaks  ${p(c.pctOfRebuilt).padStart(6)} of rebuilt  cost ${p(c.costPct)}  [${c.control}]${segments}`);
  }
  console.log(`  misses ${m(a.misses)}:`);
  for (const o of a.origins) console.log(`    ${o.origin.padEnd(12)} ${p(o.pct).padStart(6)} of misses, ${p(o.costPct)} of input cost`);
  const idle = a.idle;
  console.log(`  returns ${idle.returns}, after expiry ${idle.expiredReturns}; median time since the cache was refreshed, at expiry breaks: ${idle.medianIdleMinutes ?? 'n/a'} min`);
  console.log(`  expiry breaks by time since refresh: ${idle.buckets.map(b => `${b.label} you ${b.user}/agent ${b.agent}`).join('; ')}`);
  console.log(`  lifetimes: ${idle.ttlByModel.map(t => `${t.model} ${t.ttlSeconds}s (${t.calls} calls)`).join(', ')}`);
}

console.log('\nBy model:');
for (const model of data.models) {
  console.log(`  ${model.harness} ${model.model}: ${model.calls} calls, hit ${p(model.hitPct)}, written ${p(model.writePct)}, breaks/100 ${model.breaksPer100 ?? 'n/a'}, ttl ${model.ttlSeconds ?? 'n/a'}`);
}
console.log('\nWeekly hit ratio:');
for (const series of data.trend.series) {
  console.log(`  ${series.harness}: ${data.trend.labels.map((label, i) => `${label} ${p(series.hitPct[i])}`).join(', ')}`);
}
console.log(`\nTop sessions (rebuilt tokens): ${data.topSessions.map(s => s.rebuiltTokens == null ? m(s.misses) : m(s.rebuiltTokens)).join(', ')}`);
console.log(`\nTips:\n${data.tips.map(t => `  - ${t}`).join('\n')}`);
