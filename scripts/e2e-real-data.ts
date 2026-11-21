/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end integration test that runs against real local Copilot chat logs.
 * Exercises: findLogsDirs → parseAllLogs → every Analyzer method.
 *
 * Run: npx tsx scripts/e2e-real-data.ts
 */

import { findLogsDirs, parseAllLogs } from '../src/core/parser';
import { Analyzer } from '../src/core/analyzer';
import { buildFamilies, buildLanes, buildViewFamilies, prepareTimeline, timelineKpis, timelineWindow } from '../src/core/timeline-model';

let failures = 0;
let passes = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// ---- 1. Log discovery ----
section('Log Discovery');
const dirs = findLogsDirs();
assert(dirs.length > 0, 'findLogsDirs returns at least one directory', `got ${dirs.length}`);
for (const d of dirs) {
  console.log(`    dir: ${d}`);
}

// ---- 2. Parsing ----
section('Parsing');
console.log('  Parsing all logs (this may take a moment)...');
const t0 = Date.now();
const result = parseAllLogs(dirs);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`  Parsed in ${elapsed}s`);

const sessionCount = result.sessions.length;
const wsCount = result.workspaces.size;
const totalReqs = result.sessions.reduce((s, sess) => s + sess.requestCount, 0);
const editLocKeys = result.editLocIndex.size;

assert(sessionCount > 0, `Sessions parsed: ${sessionCount}`);
assert(wsCount > 0, `Workspaces found: ${wsCount}`);
assert(totalReqs > 0, `Total requests: ${totalReqs}`);
console.log(`  Edit LoC index entries: ${editLocKeys}`);

// Spot-check a session
const sampleSession = result.sessions.find(s => s.requests.length > 0);
if (sampleSession) {
  assert(!!sampleSession.sessionId, 'Sample session has sessionId');
  assert(!!sampleSession.workspaceName, `Sample session workspace: ${sampleSession.workspaceName}`);
  assert(sampleSession.requests.length > 0, `Sample session has ${sampleSession.requests.length} requests`);
  const r0 = sampleSession.requests[0];
  assert(r0.timestamp !== null && r0.timestamp > 0, `First request has valid timestamp: ${r0.timestamp}`);
  assert(typeof r0.messageText === 'string', 'First request has messageText');
  assert(typeof r0.responseText === 'string', 'First request has responseText');
  assert(Array.isArray(r0.aiCode), 'First request has aiCode array');
  assert(Array.isArray(r0.toolsUsed), 'First request has toolsUsed array');
}

// Check some sessions have JSONL-sourced data (they'd have creationDate)
const withCreation = result.sessions.filter(s => s.creationDate !== null && s.creationDate > 0);
console.log(`  Sessions with creationDate: ${withCreation.length} / ${sessionCount}`);

// Check code blocks were extracted
const sessionsWithAiCode = result.sessions.filter(s => s.requests.some(r => r.aiCode.length > 0));
console.log(`  Sessions with AI code blocks: ${sessionsWithAiCode.length}`);
assert(sessionsWithAiCode.length > 0, 'At least some sessions have AI code blocks');

// ---- 3. Analyzer ----
section('Analyzer Construction');
const analyzer = new Analyzer(result.sessions, result.editLocIndex);
assert(!!analyzer, 'Analyzer created successfully');

// ---- 3a. getWorkspaces ----
section('getWorkspaces');
const workspaces = analyzer.getWorkspaces();
assert(workspaces.length > 0, `Workspaces: ${workspaces.length}`);
assert(typeof workspaces[0].id === 'string', 'Workspace has id');
assert(typeof workspaces[0].name === 'string', `First workspace: ${workspaces[0].name}`);

// ---- 3b. getDailyActivity ----
section('getDailyActivity');
const daily = analyzer.getDailyActivity();
assert(daily.labels.length > 0, `Daily labels: ${daily.labels.length} days`);
assert(daily.values.length === daily.labels.length, 'Values length matches labels');
assert(daily.loc.length === daily.labels.length, 'LoC length matches labels');
const totalDailyReqs = daily.values.reduce((a, b) => a + b, 0);
assert(totalDailyReqs > 0, `Total daily requests: ${totalDailyReqs}`);
// Verify date format YYYY-MM-DD
assert(/^\d{4}-\d{2}-\d{2}$/.test(daily.labels[0]), `Date format OK: ${daily.labels[0]}`);

// With workspace filter
const wsId = workspaces[0].id;
const dailyFiltered = analyzer.getDailyActivity({ workspace: wsId });
console.log(`  Filtered (${workspaces[0].name}): ${dailyFiltered.labels.length} days`);

// ---- 3c. getWorkspaceBreakdown ----
section('getWorkspaceBreakdown');
const wsBreak = analyzer.getWorkspaceBreakdown();
assert(wsBreak.labels.length > 0, `Workspace breakdown: ${wsBreak.labels.length} workspaces`);
assert(wsBreak.values.length === wsBreak.labels.length, 'Values matches labels');
assert(wsBreak.values[0] >= wsBreak.values[wsBreak.values.length - 1], 'Sorted descending');

// ---- 3d. getHourlyDistribution ----
section('getHourlyDistribution');
const hourly = analyzer.getHourlyDistribution();
assert(hourly.hours.length === 24, `Hours array length: ${hourly.hours.length}`);
const totalHourly = hourly.hours.reduce((a, b) => a + b, 0);
assert(totalHourly > 0, `Total hourly requests: ${totalHourly}`);
assert(Object.keys(hourly.byType).length > 0, `Work types in byType: ${Object.keys(hourly.byType).length}`);

// ---- 3e. getHeatmap ----
section('getHeatmap');
const heatmap = analyzer.getHeatmap();
assert(heatmap.heatmap.length === 7, `Heatmap has 7 rows (days)`);
assert(heatmap.heatmap[0].length === 24, `Each row has 24 columns (hours)`);
const heatmapTotal = heatmap.heatmap.flat().reduce((a, b) => a + b, 0);
assert(heatmapTotal > 0, `Heatmap total: ${heatmapTotal}`);
assert(Object.keys(heatmap.byType).length > 0, 'Heatmap byType populated');

// ---- 3f. getCodeProduction ----
section('getCodeProduction');
const prod = analyzer.getCodeProduction();
assert(typeof prod.summary.totalLoc === 'number', `Total LoC: ${prod.summary.totalLoc}`);
assert(typeof prod.summary.totalAiLoc === 'number', `AI LoC: ${prod.summary.totalAiLoc}`);
assert(typeof prod.summary.aiRatio === 'number', `AI Ratio: ${(prod.summary.aiRatio * 100).toFixed(1)}%`);
assert(typeof prod.summary.locCost2010 === 'number', `2010s value: $${prod.summary.locCost2010.toFixed(0)}`);
assert(prod.byLanguage.labels.length > 0, `Languages: ${prod.byLanguage.labels.join(', ')}`);
assert(prod.dailyTimeline.labels.length > 0, `Daily timeline: ${prod.dailyTimeline.labels.length} days`);
assert(prod.byWorkspace.labels.length > 0, `By workspace: ${prod.byWorkspace.labels.length}`);

// ---- 3g. getConsumption ----
section('getConsumption');
const cons = analyzer.getConsumption();
assert(cons.totalRequests > 0, `Total requests: ${cons.totalRequests}`);
assert(cons.avgPerDay > 0, `Avg/day: ${cons.avgPerDay.toFixed(1)}`);
assert(Object.keys(cons.modelTotals).length > 0, `Models: ${Object.keys(cons.modelTotals).join(', ')}`);
assert(cons.daily.labels.length > 0, `Daily series: ${cons.daily.labels.length} points`);
assert(cons.weekly.labels.length > 0, `Weekly series: ${cons.weekly.labels.length} points`);
assert(cons.monthly.labels.length > 0, `Monthly series: ${cons.monthly.labels.length} points`);
// Verify model multipliers filled in
for (const model of Object.keys(cons.modelTotals)) {
  assert(cons.defaultMultipliers[model] !== undefined, `Multiplier for ${model}: ${cons.defaultMultipliers[model]}`);
}

// ---- 3h. getBurndown ----
section('getBurndown');
for (const sku of ['pro', 'pro-plus', 'business', 'enterprise'] as const) {
  const bd = analyzer.getBurndown({ sku });
  assert(typeof bd.budget === 'number' && bd.budget > 0, `${sku} budget: ${bd.budget}`);
  assert(typeof bd.consumed === 'number', `${sku} consumed: ${bd.consumed.toFixed(1)}`);
  assert(bd.dailyConsumption.labels.length > 0, `${sku} daily labels: ${bd.dailyConsumption.labels.length}`);
  assert(['on-track', 'warning', 'over-budget'].includes(bd.status), `${sku} status: ${bd.status}`);
  assert(typeof bd.recommendation === 'string' && bd.recommendation.length > 0, `${sku} recommendation present`);
}

// Custom budget
const bdCustom = analyzer.getBurndown({ sku: 'pro', customBudget: 500 });
assert(bdCustom.budget === 500, `Custom budget: ${bdCustom.budget}`);

// ---- 3i. getTimelineData ----
section('getTimelineData');
const tl = prepareTimeline(analyzer.getTimelineData());
assert(tl.sessions.length > 0, `Timeline sessions: ${tl.sessions.length}`);
assert(tl.sessions.every(s => !/[\\/]/.test(s.repo)), 'Timeline repositories are never paths');
const tlDay = tl.days[tl.days.length - 1];
const tlLanes = buildLanes(tl, ...timelineWindow('day', tlDay));
const tlKpis = timelineKpis(tlLanes, buildViewFamilies(tlLanes, tl));
assert(tlKpis.sessions > 0, `${tlDay}: ${tlKpis.sessions} sessions, ${tlKpis.typed} of ${tlKpis.turns} turns typed, peak ${tlKpis.peak.count}`);
const tlFamilies = buildFamilies(tl);
assert(tlFamilies.totals.families >= 0, `Families: ${tlFamilies.totals.families}, children: ${tlFamilies.totals.children}`);
// ---- 3j. getSessions ----
section('getSessions');
const sessList = analyzer.getSessions(1, 20);
assert(sessList.total > 0, `Total sessions: ${sessList.total}`);
assert(sessList.page === 1, 'Page 1');
assert(sessList.sessions.length > 0, `Page 1 has ${sessList.sessions.length} items`);
assert(sessList.sessions.length <= 20, 'Page size respected');

const si = sessList.sessions[0];
assert(typeof si.sessionId === 'string', 'Session item has sessionId');
assert(typeof si.workspaceName === 'string', `Session item workspace: ${si.workspaceName}`);
assert(typeof si.requestCount === 'number', `Session item requests: ${si.requestCount}`);
assert(si.lastMessageDate === null || typeof si.lastMessageDate === 'number', 'lastMessageDate valid');

// Page 2
if (sessList.total > 20) {
  const page2 = analyzer.getSessions(2, 20);
  assert(page2.page === 2, 'Page 2 returned');
  assert(page2.sessions.length > 0, `Page 2 has ${page2.sessions.length} items`);
  assert(page2.sessions[0].sessionId !== sessList.sessions[0].sessionId, 'Page 2 has different sessions');
}

// ---- 3k. getSessionDetail ----
section('getSessionDetail');
const detail = analyzer.getSessionDetail(si.sessionId);
assert(detail !== null, 'Session detail found');
if (detail) {
  assert(detail.sessionId === si.sessionId, 'Correct session returned');
  assert(detail.requests.length === si.requestCount, `Requests match: ${detail.requests.length}`);
  if (detail.requests.length > 0) {
    const dr = detail.requests[0];
    assert(typeof dr.requestId === 'string', 'Detail request has requestId');
    assert(typeof dr.messageText === 'string', 'Detail request has messageText');
    assert(typeof dr.responseText === 'string', 'Detail request has responseText');
    assert(typeof dr.modelId === 'string', `Model: ${dr.modelId}`);
    assert(Array.isArray(dr.toolsUsed), 'toolsUsed is array');
    assert(Array.isArray(dr.editedFiles), 'editedFiles is array');
    assert(Array.isArray(dr.aiCode), 'aiCode is array');
    assert(Array.isArray(dr.userCode), 'userCode is array');
    assert(typeof dr.isCanceled === 'boolean', 'isCanceled is boolean');
    assert(Array.isArray(dr.toolConfirmations), 'toolConfirmations is array');
    assert(Array.isArray(dr.customInstructions), 'customInstructions is array');
    assert(Array.isArray(dr.skillsUsed), 'skillsUsed is array');
  }
}

// Non-existent session
const noDetail = analyzer.getSessionDetail('nonexistent-id-12345');
assert(noDetail === null, 'Non-existent session returns null');

// ---- 3l. getRecommendations ----
section('getRecommendations');
const recs = analyzer.getRecommendations();
assert(recs.length === 12, `Recommendations count: ${recs.length}`);
for (const rec of recs) {
  assert(typeof rec.checkId === 'string', `Check: ${rec.checkId}`);
  assert(typeof rec.name === 'string', `  name: ${rec.name}`);
  assert(typeof rec.category === 'string', `  category: ${rec.category}`);
  assert(typeof rec.score === 'number' && rec.score >= 0 && rec.score <= 100, `  score: ${rec.score}`);
  assert(['good', 'needs-improvement', 'critical'].includes(rec.status), `  status: ${rec.status}`);
  assert(typeof rec.finding === 'string' && rec.finding.length > 0, '  finding present');
  assert(typeof rec.recommendation === 'string' && rec.recommendation.length > 0, '  recommendation present');
}

// ---- 4. Harness presence ----
section('Harness Presence');
const harnesses = analyzer.getHarnesses();
assert(harnesses.length > 0, `Harnesses found: ${harnesses.length}`);
for (const h of harnesses) {
  console.log(`    harness: ${h}`);
}
// Expect at least Local Agent or Local Agent (Insiders)
const hasVSCode = harnesses.some(h => h.toLowerCase().includes('local agent') || h.toLowerCase().includes('vs code'));
assert(hasVSCode, 'At least one VS Code harness present');

// Tally sessions by harness
const harnessCounts = new Map<string, number>();
for (const s of result.sessions) {
  harnessCounts.set(s.harness, (harnessCounts.get(s.harness) || 0) + 1);
}
for (const [h, c] of [...harnessCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${h}: ${c} sessions`);
}

// ---- 5. Harness filtering ----
section('Harness Filtering');
for (const h of harnesses) {
  const filteredDaily = analyzer.getDailyActivity({ harness: h });
  const filteredReqs = filteredDaily.values.reduce((a, b) => a + b, 0);
  assert(filteredReqs > 0, `${h}: ${filteredReqs} requests with filter`);

  // Verify filtering actually reduces results (unless this is the only harness)
  if (harnesses.length > 1) {
    const allReqs = daily.values.reduce((a, b) => a + b, 0);
    assert(filteredReqs <= allReqs, `${h}: filtered (${filteredReqs}) <= total (${allReqs})`);
  }
}

// ---- 6. Workspace deduplication ----
section('Workspace Deduplication');
const wsNames = workspaces.map(w => w.name);
const uniqueNames = new Set(wsNames);
assert(wsNames.length === uniqueNames.size, `No duplicate workspace names: ${wsNames.length} entries, ${uniqueNames.size} unique`);
// Verify id === name (name-based indexing)
for (const ws of workspaces) {
  assert(ws.id === ws.name, `Workspace id matches name: ${ws.name}`);
}

// ---- 7. Workspace filtering uses name ----
section('Workspace Filtering by Name');
if (workspaces.length > 0) {
  const testWs = workspaces[0];
  const wsFiltered = analyzer.getDailyActivity({ workspace: testWs.id });
  const wsFilteredReqs = wsFiltered.values.reduce((a, b) => a + b, 0);
  assert(wsFilteredReqs > 0, `Workspace '${testWs.name}': ${wsFilteredReqs} filtered requests`);
  assert(wsFilteredReqs <= totalDailyReqs, `Workspace filtered (${wsFilteredReqs}) <= total (${totalDailyReqs})`);
}

// ---- 8. Combined harness + workspace filter ----
section('Combined Harness + Workspace Filter');
if (harnesses.length > 0 && workspaces.length > 0) {
  const testHarness = harnesses[0];
  const testWs = workspaces[0];
  const combinedDaily = analyzer.getDailyActivity({ harness: testHarness, workspace: testWs.id });
  const combinedReqs = combinedDaily.values.reduce((a, b) => a + b, 0);
  console.log(`  ${testHarness} + ${testWs.name}: ${combinedReqs} requests`);
  assert(combinedReqs >= 0, 'Combined filter returns valid result');
}

// ---- 9. Workflow Optimization ----
section('Workflow Optimization');
const wf = analyzer.getWorkflowOptimization();
assert(typeof wf.totalRepetitions === 'number', `Total repetitions: ${wf.totalRepetitions}`);
assert(typeof wf.estimatedTimeSavedMins === 'number', `Estimated time saved: ${wf.estimatedTimeSavedMins} mins`);
assert(Array.isArray(wf.clusters), `Clusters: ${wf.clusters.length}`);
if (wf.clusters.length > 0) {
  const c = wf.clusters[0];
  assert(typeof c.label === 'string' && c.label.length > 0, `Top cluster: ${c.label}`);
  assert(c.occurrences >= 3, `Top cluster occurrences: ${c.occurrences}`);
  assert(c.sessions > 0, `Top cluster sessions: ${c.sessions}`);
  assert(c.workspaces.length > 0, 'Top cluster has workspaces');
  assert(c.examples.length > 0, `Top cluster examples: ${c.examples.length}`);
  assert(typeof c.skillDraft === 'string' && c.skillDraft.includes('# Skill:'), 'Skill draft generated');
  assert(typeof c.cancelRate === 'number', `Cancel rate: ${c.cancelRate}%`);
  console.log(`  Top 5 clusters:`);
  for (const cl of wf.clusters.slice(0, 5)) {
    console.log(`    - [${cl.occurrences}x] ${cl.label}`);
  }
}
assert(Array.isArray(wf.topWorkspaces), `Top workspaces: ${wf.topWorkspaces.length}`);

// With filter
if (harnesses.length > 0) {
  const wfFiltered = analyzer.getWorkflowOptimization({ harness: harnesses[0] });
  assert(Array.isArray(wfFiltered.clusters), `Filtered clusters (${harnesses[0]}): ${wfFiltered.clusters.length}`);
}

// ---- Summary ----
section('Summary');
console.log(`  Sessions: ${sessionCount}`);
console.log(`  Workspaces: ${wsCount}`);
console.log(`  Total requests: ${totalReqs}`);
console.log(`  Models: ${Object.keys(cons.modelTotals).join(', ')}`);
console.log(`  Languages: ${prod.byLanguage.labels.join(', ')}`);
console.log(`  AI LoC: ${prod.summary.totalAiLoc} | User LoC: ${prod.summary.totalUserLoc}`);
console.log(`  Parse time: ${elapsed}s`);

// ---- 10. Flow State (Learning, Peers, session data) ----
section('Flow State');
const flowState = analyzer.getFlowState();
assert(typeof flowState.overallFlowScore === 'number', `Overall flow score: ${flowState.overallFlowScore}`);
assert(typeof flowState.avgFollowUpSec === 'number', `Avg follow-up: ${flowState.avgFollowUpSec.toFixed(1)}s`);
assert(Array.isArray(flowState.days), `Flow days: ${flowState.days.length}`);
assert(typeof flowState.deepFlowDays === 'number', `Deep flow days: ${flowState.deepFlowDays}`);
assert(typeof flowState.totalDays === 'number', `Total days: ${flowState.totalDays}`);
if (flowState.days.length > 0) {
  const fd = flowState.days[0];
  assert(typeof fd.date === 'string', `Flow day: ${fd.date}`);
  assert(typeof fd.avgFlowScore === 'number', `Flow day score: ${fd.avgFlowScore}`);
  assert(typeof fd.longestBlockMin === 'number', 'Flow day has longestBlockMin');
  assert(Array.isArray(fd.sessions), `Flow day sessions: ${fd.sessions.length}`);
  if (fd.sessions.length > 0) {
    const fs = fd.sessions[0];
    assert(typeof fs.sessionId === 'string', 'Flow session has sessionId');
    assert(typeof fs.flowScore === 'number', `Flow session flowScore: ${fs.flowScore}`);
  }
}
if (harnesses.length > 0) {
  const flowFiltered = analyzer.getFlowState({ harness: harnesses[0] });
  assert(typeof flowFiltered.overallFlowScore === 'number', `Filtered flow score (${harnesses[0]}): ${flowFiltered.overallFlowScore}`);
}

// ---- 11. Config Health (SDLC) ----
section('Config Health');
const configHealth = analyzer.getConfigHealth();
assert(typeof configHealth.overallScore === 'number', `Config overall score: ${configHealth.overallScore}`);
assert(configHealth.overallScore >= 0 && configHealth.overallScore <= 100, `Score in range: ${configHealth.overallScore}`);
assert(Array.isArray(configHealth.workspaces), `Config workspaces: ${configHealth.workspaces.length}`);
assert(Array.isArray(configHealth.suggestions), `Config suggestions: ${configHealth.suggestions.length}`);
// Agentic readiness
assert(typeof configHealth.agenticReadiness === 'object', 'Config has agenticReadiness');
assert(typeof configHealth.agenticReadiness.score === 'number', `Agentic readiness: ${configHealth.agenticReadiness.score}`);
assert(Array.isArray(configHealth.agenticReadiness.signals), `Agentic signals: ${configHealth.agenticReadiness.signals.length}`);
if (configHealth.agenticReadiness.signals.length > 0) {
  const sig = configHealth.agenticReadiness.signals[0];
  assert(typeof sig.id === 'string', `Signal id: ${sig.id}`);
  assert(typeof sig.label === 'string', `Signal label: ${sig.label}`);
  assert(typeof sig.present === 'boolean', `Signal present: ${sig.present}`);
  assert(typeof sig.detail === 'string', 'Signal has detail');
}

// ---- 12. Work-Life Balance (Achievements, Peers) ----
section('Work-Life Balance');
const wlb = analyzer.getWorkLifeBalance();
if (wlb !== null) {
  assert(typeof wlb.maxStreak === 'number', `Max streak: ${wlb.maxStreak}`);
  assert(typeof wlb.weekendReqs === 'number', `Weekend requests: ${wlb.weekendReqs}`);
  assert(typeof wlb.timeDistribution === 'object', 'Has time distribution');
  assert(typeof wlb.timeDistribution.lateNight === 'number', `Late night: ${wlb.timeDistribution.lateNight}`);
  assert(typeof wlb.timeDistribution.earlyMorning === 'number', `Early morning: ${wlb.timeDistribution.earlyMorning}`);
  assert(typeof wlb.score === 'number', `WLB score: ${wlb.score}`);
  assert(typeof wlb.activeDays === 'number', `Active days: ${wlb.activeDays}`);
  assert(typeof wlb.avgSpanHours === 'number', `Avg span hours: ${wlb.avgSpanHours.toFixed(1)}`);
  assert(wlb.hours.length === 24, `Hours array: ${wlb.hours.length}`);
} else {
  console.log('  Work-life balance returned null (insufficient data)');
}

// ---- 13. Anti-Patterns with group scores (SDLC quality) ----
section('Anti-Patterns (expanded)');
const ap = analyzer.getAntiPatterns();
assert(typeof ap.totalOccurrences === 'number', `Total anti-pattern occurrences: ${ap.totalOccurrences}`);
assert(Array.isArray(ap.groupScores), `Group scores: ${ap.groupScores.length}`);
if (ap.groupScores.length > 0) {
  const gs = ap.groupScores[0];
  assert(typeof gs.group === 'string', `Group: ${gs.group}`);
  assert(typeof gs.score === 'number', `Group score: ${gs.score}`);
}

// ---- 14. Calendar Activity (Achievements) ----
section('Calendar Activity');
const cal = analyzer.getCalendarActivity();
assert(Array.isArray(cal.days), `Calendar days: ${cal.days.length}`);
assert(typeof cal.maxRequests === 'number', `Calendar max requests: ${cal.maxRequests}`);
if (cal.days.length > 0) {
  const ce = cal.days[0];
  assert(typeof ce.date === 'string', `Calendar date: ${ce.date}`);
  assert(typeof ce.requests === 'number', `Calendar requests: ${ce.requests}`);
  assert(typeof ce.focusScore === 'number', `Calendar focusScore: ${ce.focusScore}`);
  assert(typeof ce.dow === 'number', `Calendar dow: ${ce.dow}`);
}

// ---- 15. Sessions with pagination ----
section('Sessions Pagination');
const sessPage1 = analyzer.getSessions(1, 5);
assert(sessPage1.sessions.length <= 5, `Page 1 (size 5): ${sessPage1.sessions.length} sessions`);
if (sessPage1.total > 5) {
  const sessPage2 = analyzer.getSessions(2, 5);
  assert(sessPage2.page === 2, 'Got page 2');
  assert(sessPage2.sessions[0].sessionId !== sessPage1.sessions[0].sessionId, 'Different sessions on page 2');
}

// ---- 16. Data integrity for feature pages ----
section('Feature Page Data Integrity');

// Daily activity has LoC for achievement date estimation
const dailyForAch = analyzer.getDailyActivity();
assert(dailyForAch.loc.length === dailyForAch.labels.length, 'Daily LoC aligned with labels');
const cumulativeLoc = dailyForAch.loc.reduce((acc: number[], val: number, i: number) => {
  acc.push((acc[i - 1] || 0) + val);
  return acc;
}, [] as number[]);
assert(cumulativeLoc.length === dailyForAch.labels.length, 'Cumulative LoC computation works');
const totalCumLoc = cumulativeLoc[cumulativeLoc.length - 1] || 0;
console.log(`  Cumulative LoC (achievement dates): ${totalCumLoc}`);

// Sessions have firstMessage for SDLC work-type classification
const sdlcSessions = analyzer.getSessions(1, 200);
const withFirstMsg = sdlcSessions.sessions.filter(s => s.firstMessage && s.firstMessage.length > 0);
assert(withFirstMsg.length > 0, `Sessions with firstMessage: ${withFirstMsg.length}/${sdlcSessions.sessions.length}`);

// Code production by language for peer comparison & learning skills
const prodForPeers = analyzer.getCodeProduction();
assert(prodForPeers.byLanguage.labels.length > 0, `Languages for peer comparison: ${prodForPeers.byLanguage.labels.length}`);

// Harnesses for learning skill tree tools
const harnessesForLearn = analyzer.getHarnesses();
assert(harnessesForLearn.length > 0, `Harnesses for learning skill tree: ${harnessesForLearn.length}`);

// Flow data for session-level breakdowns
const totalFlowSessions = flowState.days.reduce((sum, d) => sum + d.sessions.length, 0);
console.log(`  Flow sessions for session breakdowns: ${totalFlowSessions}`);

// ---- 17. getSessions with filter & search (SDLC / Achievements / general views) ----
section('getSessions with Filter & Search');
// Filter by harness
if (harnesses.length > 0) {
  const sessFilt = analyzer.getSessions(1, 10, { harness: harnesses[0] } as Record<string, unknown>);
  assert(sessFilt.total >= 0, `Sessions filtered by ${harnesses[0]}: ${sessFilt.total}`);
  assert(sessFilt.sessions.every(s => s.requestCount >= 0), 'All filtered sessions have valid requestCount');
}
// Filter by workspace
if (workspaces.length > 0) {
  const sessWs = analyzer.getSessions(1, 10, { workspace: workspaces[0].id } as Record<string, unknown>);
  assert(sessWs.total >= 0, `Sessions filtered by workspace ${workspaces[0].name}: ${sessWs.total}`);
  if (sessWs.total > 0) {
    assert(sessWs.sessions[0].workspaceName === workspaces[0].name, 'Filtered session matches workspace');
  }
}
// Search
const sessSearch = analyzer.getSessions(1, 10, undefined, 'fix');
console.log(`  Sessions matching "fix": ${sessSearch.total}`);
assert(sessSearch.total >= 0, 'Search returns valid count');

// ---- 18. Work-type classification from firstMessage (SDLC) ----
section('Work-Type Classification (SDLC)');
const allSess = analyzer.getSessions(1, 500);
const classifiedSessions = allSess.sessions.filter(s => s.firstMessage && s.firstMessage.length > 0);
const classifyWorkType = (msg: string): string => {
  const lower = msg.toLowerCase();
  if (/\b(fix|bug|error|issue|broken|crash|fail|debug)\b/.test(lower)) return 'fix';
  if (/\b(refactor|clean|reorganize|rename|move|extract)\b/.test(lower)) return 'refactor';
  if (/\b(test|spec|assert|coverage|unit test)\b/.test(lower)) return 'test';
  if (/\b(doc|readme|comment|jsdoc|explain)\b/.test(lower)) return 'docs';
  if (/\b(review|check|audit|analyze)\b/.test(lower)) return 'review';
  return 'feature';
};
const typeCounts = new Map<string, number>();
for (const s of classifiedSessions) {
  const t = classifyWorkType(s.firstMessage!);
  typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
}
assert(typeCounts.size > 0, `Work types found: ${[...typeCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', ')}`);
// The SDLC page relies on at least 2 distinct work types to render a meaningful chart
assert(typeCounts.size >= 2, `At least 2 distinct work types: ${typeCounts.size}`);
console.log(`  Classified ${classifiedSessions.length} sessions into ${typeCounts.size} work types`);

// ---- 19. Achievement data validation (Achievements) ----
section('Achievement Data Validation');
// Achievements depend on cumulative daily LoC, streak, workspace count, model diversity
const dailyAch = analyzer.getDailyActivity();
const totalLoc = dailyAch.loc.reduce((a, b) => a + b, 0);
assert(totalLoc > 0, `Total LoC for achievement thresholds: ${totalLoc}`);

// Streak computation
const activeDates = new Set(dailyAch.labels.filter((_, i) => dailyAch.values[i] > 0));
let maxStreak = 0; let currStreak = 0;
const sortedDateStrs = [...activeDates].sort();
for (let i = 0; i < sortedDateStrs.length; i++) {
  if (i === 0) { currStreak = 1; } else {
    const prev = new Date(sortedDateStrs[i - 1]);
    const cur = new Date(sortedDateStrs[i]);
    currStreak = (cur.getTime() - prev.getTime() === 86400000) ? currStreak + 1 : 1;
  }
  maxStreak = Math.max(maxStreak, currStreak);
}
assert(maxStreak > 0, `Max streak for achievements: ${maxStreak}`);
console.log(`  Active dates: ${activeDates.size}, Max streak: ${maxStreak}`);

// Model diversity for achievement unlocks
const modelSet = new Set<string>();
for (const s of result.sessions) {
  for (const r of s.requests) {
    if (r.modelId) modelSet.add(r.modelId);
  }
}
assert(modelSet.size > 0, `Distinct models for achievements: ${modelSet.size}`);
console.log(`  Models: ${[...modelSet].join(', ')}`);

// Workspace count for achievements
assert(workspaces.length > 0, `Workspaces for achievements: ${workspaces.length}`);

// ---- 20. Peer comparison baseline data (Peers) ----
section('Peer Comparison Baseline');
const prod2 = analyzer.getCodeProduction();
assert(prod2.summary.totalLoc > 0, `Total LoC baseline for peers: ${prod2.summary.totalLoc}`);
assert(prod2.byLanguage.labels.length > 0, `Language diversity for peers: ${prod2.byLanguage.labels.length}`);
const flow2 = analyzer.getFlowState();
assert(typeof flow2.overallFlowScore === 'number', `Flow score baseline for peers: ${flow2.overallFlowScore}`);
// Calculate daily activity variability (peers needs this for rankings)
const nonZeroDays = dailyAch.values.filter(v => v > 0);
const avgDaily = nonZeroDays.reduce((a, b) => a + b, 0) / (nonZeroDays.length || 1);
assert(avgDaily > 0, `Avg daily requests for peer rankings: ${avgDaily.toFixed(1)}`);
console.log(`  Active days: ${nonZeroDays.length}, Avg requests/day: ${avgDaily.toFixed(1)}`);

// ---- 21. Cross-harness data for all feature pages ----
section('Cross-Harness Feature Data');
for (const h of harnesses) {
  const hFlow = analyzer.getFlowState({ harness: h });
  const hConfig = analyzer.getConfigHealth({ harness: h });
  const hWlb = analyzer.getWorkLifeBalance({ harness: h });
  const hAp = analyzer.getAntiPatterns({ harness: h });
  const hCal = analyzer.getCalendarActivity({ harness: h });
  assert(typeof hFlow.overallFlowScore === 'number', `${h} flow: ${hFlow.overallFlowScore}`);
  assert(typeof hConfig.overallScore === 'number', `${h} config: ${hConfig.overallScore}`);
  assert(typeof hAp.totalOccurrences === 'number', `${h} anti-patterns: ${hAp.totalOccurrences}`);
  assert(Array.isArray(hCal.days), `${h} calendar days: ${hCal.days.length}`);
  console.log(`  ${h}: flow=${hFlow.overallFlowScore} config=${hConfig.overallScore} ap=${hAp.totalOccurrences} cal=${hCal.days.length}d wlb=${hWlb?.score ?? 'null'}`);
}

console.log(`\n========================================`);
console.log(`  ${passes} passed, ${failures} failed`);
console.log(`========================================\n`);

process.exit(failures > 0 ? 1 : 0);
