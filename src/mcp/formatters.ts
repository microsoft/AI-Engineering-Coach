/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Formatters that transform raw Analyzer output into concise, LLM-friendly JSON.
 * Each formatter strips large arrays, computes key ratios, and adds narrative hints
 * so the LLM can synthesize rather than parse.
 */

import { exportedOriginName } from '../core/prompt-cache-causes';
import type { Analyzer } from '../core/analyzer';
import {
  buildFamilies, buildLanes, buildViewFamilies, createNamer, familiesInsights, prepareTimeline, timelineKpis, timelineWindow, VERDICTS, viewInsights,
} from '../core/timeline-model';
import type { AntiPatternData, ContextCompositionData, DateFilter, PromptCacheData, TokenTypesData, TurnBasis } from '../core/types';

/** What a time-based measure counts: the prompts the user typed, not the turns agents or the harness sent. */
function typedPromptBasis(basis: TurnBasis): { counts: string; typedPrompts: number; automatedTurnsLeftOut: number } {
  return { counts: 'prompts the user typed', typedPrompts: basis.humanTurns, automatedTurnsLeftOut: basis.automatedTurns };
}

function sustainablePace(insights: ReturnType<Analyzer['getInsights']>) {
  const pace = insights.sustainablePace;
  return {
    counts: 'prompts the user typed',
    burnoutRisk: pace.burnoutRisk,
    alerts: pace.alerts,
    currentStreak: pace.currentStreak,
    weekendTrending: pace.weekendTrending,
    lateNightTrending: pace.lateNightTrending,
  };
}

/* ---- helpers ---- */

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function trend(values: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (values.length < 2) return 'stable';
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const second = values.slice(half).reduce((a, b) => a + b, 0) / (values.length - half);
  const delta = second - first;
  if (first === 0 && second === 0) return 'stable';
  const pctChange = first === 0 ? (second > 0 ? 100 : 0) : (delta / first) * 100;
  if (pctChange > 10) return 'increasing';
  if (pctChange < -10) return 'decreasing';
  return 'stable';
}

function topN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

function sparkline(values: number[], maxLen = 14): string {
  const chars = '▁▂▃▄▅▆▇█';
  const v = values.length > maxLen ? values.slice(-maxLen) : values;
  if (v.length === 0) return '';
  const max = Math.max(...v);
  if (max === 0) return chars[0].repeat(v.length);
  return v.map(n => chars[Math.min(Math.floor((n / max) * 7), 7)]).join('');
}

/** Rules that couldn't be evaluated: the anti-patterns and group scores leave them out, so they're incomplete. */
function notEvaluated(ap: AntiPatternData) {
  return ap.failedRules.map(rule => ({ rule: rule.ruleName, group: rule.group, error: rule.error }));
}

/* ---- tool formatters ---- */

export function formatSummary(analyzer: Analyzer, f?: DateFilter) {
  const stats = analyzer.getStats(f);
  const recs = analyzer.getRecommendations(f);
  const ap = analyzer.getAntiPatterns(f);

  const critical = recs.filter(r => r.status === 'critical');
  const needsImprovement = recs.filter(r => r.status === 'needs-improvement');
  const good = recs.filter(r => r.status === 'good');

  return {
    overview: {
      totalSessions: stats.totalSessions,
      totalRequests: stats.totalRequests,
      totalWorkspaces: stats.totalWorkspaces,
    },
    recommendations: {
      summary: `${good.length} good, ${needsImprovement.length} need improvement, ${critical.length} critical`,
      critical: critical.map(r => ({ check: r.name, score: r.score, finding: r.finding, recommendation: r.recommendation })),
      needsImprovement: needsImprovement.map(r => ({ check: r.name, score: r.score, finding: r.finding, recommendation: r.recommendation })),
    },
    antiPatterns: {
      totalOccurrences: ap.totalOccurrences,
      count: ap.patterns.length,
      topByOccurrence: topN(
        [...ap.patterns].sort((a, b) => b.occurrences - a.occurrences),
        5,
      ).map(p => ({ name: p.name, severity: p.severity, occurrences: p.occurrences, group: p.group, suggestion: p.suggestion })),
      groupScores: ap.groupScores.map(g => ({ group: g.group, score: g.score, topIssue: g.topIssue })),
      notEvaluated: notEvaluated(ap),
    },
  };
}

export function formatActivity(analyzer: Analyzer, f?: DateFilter) {
  const daily = analyzer.getDailyActivity(f);
  const cal = analyzer.getCalendarActivity(f);

  const totalRequests = daily.values.reduce((a, b) => a + b, 0);
  const totalLoc = daily.loc.reduce((a, b) => a + b, 0);
  const totalSessions = daily.sessions.reduce((a, b) => a + b, 0);
  const activeDays = daily.values.filter(v => v > 0).length;

  return {
    summary: {
      totalRequests,
      totalLoc,
      totalSessions,
      activeDays,
      totalDays: daily.labels.length,
      avgRequestsPerActiveDay: activeDays > 0 ? Math.round(totalRequests / activeDays) : 0,
    },
    activityTrend: trend(daily.values),
    sparkline: sparkline(daily.values),
    harnessBreakdown: daily.byHarness.map(h => ({
      harness: h.harness,
      totalRequests: h.requests.reduce((a, b) => a + b, 0),
      totalSessions: h.sessions.reduce((a, b) => a + b, 0),
      totalLoc: h.loc.reduce((a, b) => a + b, 0),
    })),
    recentDays: topN(
      [...cal.days].sort((a, b) => b.date.localeCompare(a.date)),
      7,
    ).map(d => ({ date: d.date, requests: d.requests, focusScore: d.focusScore })),
    recentDaysBasis: typedPromptBasis(cal.turnBasis),
  };
}

export function formatCredits(analyzer: Analyzer, f?: DateFilter) {
  const credits = analyzer.getAiCredits(f);
  const coverage = analyzer.getTokenCoverage(f);

  const sortedModels = Object.entries(credits.costByModel)
    .sort(([, a], [, b]) => b.credits - a.credits);

  return {
    summary: {
      totalCredits: Math.round(credits.totalCredits * 100) / 100,
      totalRequests: credits.totalRequests,
      countedRequests: credits.countedRequests,
      avgCreditsPerRequest: Math.round(credits.avgCreditsPerRequest * 100) / 100,
      avgCreditsPerDay: Math.round(credits.avgCreditsPerDay * 100) / 100,
      missingPct: credits.missingPct,
    },
    topModels: topN(sortedModels, 5).map(([model, data]) => ({
      model,
      credits: Math.round(data.credits * 100) / 100,
      requests: data.requests,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    })),
    creditTrend: trend(credits.daily.credits),
    sparkline: sparkline(credits.daily.credits),
    tokenCoverage: {
      totalSessions: coverage.totalSessions,
      totalRequests: coverage.totalRequests,
      countedRequests: coverage.countedRequests,
      missingPct: coverage.missingPct,
      byHarness: coverage.byHarness.map(h => ({
        harness: h.harness,
        requests: h.requests,
        countedRequests: h.countedRequests,
        missingPct: h.missingPct,
        source: h.source,
      })),
    },
    topCostlyRequests: topN(credits.topRequests, 5).map(r => ({
      model: r.model,
      credits: Math.round(r.credits * 100) / 100,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      preview: r.preview.slice(0, 120),
      workspace: r.workspace,
    })),
  };
}

export function formatCodeProduction(analyzer: Analyzer, f?: DateFilter) {
  const prod = analyzer.getCodeProduction(f);

  return {
    summary: {
      totalAiLoc: prod.summary.totalAiLoc,
      totalUserLoc: prod.summary.totalUserLoc,
      totalLoc: prod.summary.totalLoc,
      aiRatio: Math.round(prod.summary.aiRatio * 1000) / 10,
      locCost2010: prod.summary.locCost2010,
    },
    topLanguages: prod.byLanguage.labels.map((lang, i) => ({
      language: lang,
      aiLoc: prod.byLanguage.aiLoc[i],
      userLoc: prod.byLanguage.userLoc[i],
    })).sort((a, b) => (b.aiLoc + b.userLoc) - (a.aiLoc + a.userLoc)).slice(0, 10),
    productionTrend: trend(prod.dailyTimeline.aiLoc),
    sparkline: sparkline(prod.dailyTimeline.aiLoc),
    topWorkspaces: prod.byWorkspace.labels.map((ws, i) => ({
      workspace: ws,
      aiLoc: prod.byWorkspace.aiLoc[i],
      userLoc: prod.byWorkspace.userLoc[i],
    })).sort((a, b) => (b.aiLoc + b.userLoc) - (a.aiLoc + a.userLoc)).slice(0, 5),
  };
}

export function formatFlow(analyzer: Analyzer, f?: DateFilter) {
  const flow = analyzer.getFlowState(f);
  const heatmap = analyzer.getHeatmap(f);

  const bestHours = flow.hourlyFlow
    .map((score, hour) => ({ hour, score }))
    .sort((a, b) => b.score - a.score)
    .filter(h => h.score > 0)
    .slice(0, 5);

  // Find peak activity hours from heatmap
  const hourlyTotals = Array.from({ length: 24 }, (_, h) =>
    heatmap.heatmap.reduce((sum, dayRow) => sum + (dayRow[h] ?? 0), 0),
  );
  const peakActivityHours = hourlyTotals
    .map((total, hour) => ({ hour, total }))
    .sort((a, b) => b.total - a.total)
    .filter(h => h.total > 0)
    .slice(0, 5);

  return {
    basis: typedPromptBasis(heatmap.turnBasis),
    summary: {
      overallFlowScore: flow.overallFlowScore,
      avgFollowUpSec: Math.round(flow.avgFollowUpSec),
      avgBlockMin: Math.round(flow.avgBlockMin),
      deepFlowDays: flow.deepFlowDays,
      totalDays: flow.totalDays,
      deepFlowRate: pct(flow.deepFlowDays, flow.totalDays),
    },
    bestHoursForDeepWork: bestHours.map(h => ({
      hour: `${h.hour}:00`,
      flowScore: Math.round(h.score),
    })),
    peakActivityHours: peakActivityHours.map(h => ({
      hour: `${h.hour}:00`,
      totalRequests: h.total,
    })),
    flowTrend: trend(flow.weeklyTrend.scores),
    sparkline: sparkline(flow.weeklyTrend.scores),
    suggestions: flow.suggestions,
    recentDays: topN(
      [...flow.days].sort((a, b) => b.date.localeCompare(a.date)),
      7,
    ).map(d => ({
      date: d.date,
      flowScore: Math.round(d.avgFlowScore),
      flowLabel: d.flowLabel,
      longestBlockMin: d.longestBlockMin,
      totalHours: Math.round(d.totalHours * 10) / 10,
    })),
  };
}

export function formatPatterns(analyzer: Analyzer, f?: DateFilter) {
  const ap = analyzer.getAntiPatterns(f);
  const recs = analyzer.getRecommendations(f);

  return {
    antiPatterns: {
      total: ap.patterns.length,
      totalOccurrences: ap.totalOccurrences,
      bySeverity: {
        high: ap.patterns.filter(p => p.severity === 'high').length,
        medium: ap.patterns.filter(p => p.severity === 'medium').length,
        low: ap.patterns.filter(p => p.severity === 'low').length,
      },
      patterns: [...ap.patterns]
        .sort((a, b) => {
          const sev = { high: 3, medium: 2, low: 1 };
          return (sev[b.severity] - sev[a.severity]) || (b.occurrences - a.occurrences);
        })
        .map(p => ({
          name: p.name,
          severity: p.severity,
          group: p.group,
          occurrences: p.occurrences,
          description: p.description,
          suggestion: p.suggestion,
          trend: trend(p.weeklyHist.counts),
        })),
      notEvaluated: notEvaluated(ap),
    },
    recommendations: recs.map(r => ({
      check: r.name,
      category: r.category,
      score: r.score,
      status: r.status,
      finding: r.finding,
      recommendation: r.recommendation,
    })),
    groupScores: ap.groupScores.map(g => ({
      group: g.group,
      score: g.score,
      weekOverWeekChange: g.wowPct,
      topIssue: g.topIssue,
      improvements: g.improvements,
    })),
  };
}

export function formatInsights(analyzer: Analyzer, f?: DateFilter) {
  const insights = analyzer.getInsights(f);

  return {
    learningVelocity: {
      totalLanguages: insights.learningVelocity.totalLanguagesEncountered,
      newLanguagesLearned: insights.learningVelocity.totalNewLanguagesLearned,
      topLanguages: topN(insights.learningVelocity.topLanguages, 10).map(l => ({
        language: l.language,
        firstSeen: l.firstSeen,
        weekCount: l.weekCount,
      })),
      trend: trend(insights.learningVelocity.velocityTrend.newLanguages),
    },
    intentClassification: {
      distribution: insights.intentClassification.distribution,
      avgRequestsByIntent: insights.intentClassification.avgRequestsByIntent,
    },
    specDriven: {
      totalSessions: insights.specDriven.totalSessions,
      specDrivenRate: Math.round(insights.specDriven.specDrivenRate * 1000) / 10,
      trend: trend(insights.specDriven.weeklyTrend.specDriven),
    },
    productionReview: {
      totalAiLoc: insights.productionReview.totalAiLoc,
      estimatedReviewedLoc: insights.productionReview.estimatedReviewedLoc,
      reviewRatio: Math.round(insights.productionReview.reviewRatio * 1000) / 10,
    },
    promptMaturity: {
      overallGrade: insights.promptMaturity.overallGrade,
      score: insights.promptMaturity.score,
      dimensions: insights.promptMaturity.dimensions,
      trend: trend(insights.promptMaturity.weeklyTrend.scores),
      weakestPrompts: topN(
        insights.promptMaturity.samplePrompts.filter(p => p.grade === 'D' || p.grade === 'F'),
        3,
      ).map(p => ({
        grade: p.grade,
        issues: p.issues,
        promptPreview: p.text.slice(0, 150),
      })),
    },
    sustainablePace: sustainablePace(insights),
  };
}

export function formatWellbeing(analyzer: Analyzer, f?: DateFilter) {
  const wlb = analyzer.getWorkLifeBalance(f);
  const insights = analyzer.getInsights(f);

  if (!wlb) {
    return { status: 'no-data', message: 'Not enough data to assess work-life balance: no prompts the user typed in range.' };
  }

  return {
    basis: typedPromptBasis(wlb.turnBasis),
    workLifeBalance: {
      score: wlb.score,
      weekendRatio: Math.round(wlb.weekendRatio * 1000) / 10,
      timeDistribution: wlb.timeDistribution,
      avgStartHour: Math.round(wlb.avgStartHour * 10) / 10,
      avgEndHour: Math.round(wlb.avgEndHour * 10) / 10,
      avgSpanHours: Math.round(wlb.avgSpanHours * 10) / 10,
      maxStreak: wlb.maxStreak,
      maxBreak: wlb.maxBreak,
      activeDays: wlb.activeDays,
    },
    sustainablePace: sustainablePace(insights),
  };
}

export function formatWorkflows(analyzer: Analyzer, f?: DateFilter) {
  const wf = analyzer.getWorkflowOptimization(f);

  return {
    summary: {
      totalClusters: wf.clusters.length,
      totalRepetitions: wf.totalRepetitions,
      estimatedTimeSavedMins: wf.estimatedTimeSavedMins,
    },
    topClusters: topN(
      [...wf.clusters].sort((a, b) => b.occurrences - a.occurrences),
      10,
    ).map(c => ({
      label: c.label,
      canonicalPrompt: c.canonicalPrompt.slice(0, 120),
      occurrences: c.occurrences,
      sessions: c.sessions,
      workspaces: c.workspaces.length,
      harnesses: c.harnesses,
      cancelRate: Math.round(c.cancelRate * 1000) / 10,
      skillDraft: c.skillDraft.slice(0, 200),
    })),
    topWorkspaces: topN(wf.topWorkspaces, 5),
  };
}

export function formatHarnessComparison(analyzer: Analyzer, f?: DateFilter) {
  const comp = analyzer.getHarnessComparison(f);

  return {
    harnesses: comp.harnesses.map(h => ({
      harness: h.harness,
      sessions: h.sessions,
      requests: h.requests,
      avgRequestsPerSession: Math.round(h.avgRequestsPerSession * 10) / 10,
      totalAiLoc: h.totalAiLoc,
      avgResponseLength: Math.round(h.avgResponseLength),
      topModels: topN(h.topModels, 3).map(m => `${m.name} (${m.count})`),
      topTools: topN(h.topTools, 3).map(t => `${t.name} (${t.count})`),
      cancelRate: Math.round(h.cancelRate * 1000) / 10,
      activeDays: h.activeDays,
      firstSeen: h.firstSeen,
      lastSeen: h.lastSeen,
    })),
  };
}

export function formatSessions(
  analyzer: Analyzer,
  params: { sessionId?: string; page?: number; pageSize?: number; search?: string },
  f?: DateFilter,
) {
  if (params.sessionId) {
    const session = analyzer.getSessionDetail(params.sessionId);
    if (!session) return { error: 'Session not found' };
    return {
      sessionId: session.sessionId,
      workspaceName: session.workspaceName,
      harness: session.harness,
      creationDate: session.creationDate,
      lastMessageDate: session.lastMessageDate,
      requestCount: session.requests.length,
      requests: session.requests.slice(0, 30).map(r => ({
        timestamp: r.timestamp,
        prompt: r.messageText?.slice(0, 200) ?? '',
        responsePreview: r.responseText?.slice(0, 200) ?? '',
        model: r.modelId,
        toolsUsed: r.toolsUsed,
        agentName: r.agentName,
        workType: r.workType,
      })),
      truncated: session.requests.length > 30,
    };
  }

  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 20, 50);
  const list = analyzer.getSessions(page, pageSize, f, params.search);

  return {
    total: list.total,
    page: list.page,
    pageSize: list.pageSize,
    sessions: list.sessions.map(s => ({
      sessionId: s.sessionId,
      workspaceName: s.workspaceName,
      creationDate: s.creationDate,
      lastMessageDate: s.lastMessageDate,
      requestCount: s.requestCount,
      firstMessage: s.firstMessage?.slice(0, 120) ?? '',
    })),
  };
}

/** A real calendar date, `YYYY-MM-DD` (not 2026-11-31). */
function isCivilDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(y, m - 1, d);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d;
}

/** Autonomy and delegation: how much agents worked on their own, where they waited on the user, and the session
 *  families (a coordinator and the sessions it started) with what the logs show about them. No prompt text. Sessions
 *  and repositories are always masked (Session 12, Repository A), with no branches: this result goes to a language
 *  model. `date` picks the day (default: the latest active day). */
export function formatTimeline(analyzer: Analyzer, f?: DateFilter, date?: string) {
  if (date !== undefined && !isCivilDate(date)) return { error: `Not a calendar date: ${date}. Use YYYY-MM-DD.` };
  for (const bound of [f?.fromDate, f?.toDate]) {
    if (bound && !isCivilDate(bound)) return { error: `Not a calendar date: ${bound}. Use YYYY-MM-DD.` };
  }
  const p = prepareTimeline(analyzer.getTimelineData(f));
  const requested = { from: f?.fromDate ?? null, to: f?.toDate ?? null };
  const active = p.sessions.filter(s => !s.ctx);
  if (active.length === 0) return { requested, sessions: 0, note: 'No sessions in this range.' };
  const day = date ?? p.days[p.days.length - 1];
  const outside = (requested.from && day < requested.from) || (requested.to && day > requested.to);
  const lanes = outside ? [] : buildLanes(p, ...timelineWindow('day', day));
  const families = buildViewFamilies(lanes, p);
  const kpis = timelineKpis(lanes, families);
  const namer = createNamer(p, true);
  const overview = buildFamilies(p);
  const totals = overview.totals;
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const turns = sum(p.days, d => { const x = p.dayTotals.get(d); return x ? x.typed + x.automated : 0; });
  const credits = totals.totalCredits > 0;
  const share = (value: number) => (credits ? Math.round(value) : null);
  return {
    requested,
    observed: { firstActiveDay: p.days[0], lastActiveDay: p.days[p.days.length - 1], activeDays: p.days.length, sessions: active.length },
    automatedTurnPct: turns > 0 ? pct(sum(p.days, d => p.dayTotals.get(d)?.automated ?? 0), turns) : null,
    day: lanes.length === 0 ? { date: day, sessions: 0, note: outside ? 'This day is outside the requested range.' : 'No activity on this day in the selected range.' } : {
      date: day,
      sessions: kpis.sessions,
      turns: kpis.turns,
      typedTurns: kpis.typed,
      agentHours: Math.round(kpis.agentMs / 360_000) / 10,
      agentMinutesPerTypedPrompt: kpis.agentMsPerPrompt == null ? null : minutes(kpis.agentMsPerPrompt),
      longestUnattendedMinutes: minutes(kpis.unattendedMs),
      waitsOnUser: { started: kpis.waits, onQuestionOrPermission: kpis.waits - kpis.idleWaits, minutes: minutes(kpis.waitMs), atLeast30Min: kpis.longWaits },
      questionsAndPermissionsAnswered: kpis.answered,
      peakParallelSessions: kpis.peak.count,
      childSessions: kpis.childLanes,
      childCreditSharePct: kpis.credits > 0 ? Math.round(kpis.childCreditShare * 10) / 10 : null,
      insights: viewInsights(lanes, families, namer, 'day', p),
    },
    families: {
      count: totals.families,
      sessionsInFamilies: totals.sessionsInFamilies,
      childSessions: totals.children,
      childSessionsWithYourInput: totals.childrenNeedingYou,
      promptsTypedIntoChildren: totals.childTyped,
      answersInChildren: totals.childAnswered,
      creditSharePct: share(totals.creditShare),
      childCreditSharePct: share(totals.childCreditShare),
      verdicts: {
        noInputInChildren: { families: totals.alone.families, creditSharePct: share(totals.alone.creditShare) },
        youSteppedIn: { families: totals.needed.families, creditSharePct: share(totals.needed.creditShare) },
        wideFanOut: { families: totals.wide.families, creditSharePct: share(totals.wide.creditShare) },
      },
      insights: familiesInsights(totals),
      top: overview.families.slice(0, 5).map(fam => ({
        name: namer.name(fam.s),
        repository: namer.repo(fam.s),
        sessions: fam.sessions,
        children: fam.children,
        verdict: VERDICTS[fam.verdict].label,
        wideFanOut: fam.wide,
        promptsTypedIntoChildren: fam.childTyped,
        answersInChildren: fam.childAnswered,
        agentHours: Math.round(fam.agentMs / 360_000) / 10,
        creditSharePct: credits ? Math.round(fam.creditShare * 10) / 10 : null,
        habitToConsider: fam.wide ? `${VERDICTS[fam.verdict].habit} ${VERDICTS.wide.habit}` : VERDICTS[fam.verdict].habit,
      })),
    },
    notes: [
      'Agent time: per session, the time from each prompt to the turn\'s last logged agent activity, merged, minus the time the turn was stopped on a question or a permission prompt.',
      'Waits on the user: per session, gaps of 2-120 min from the end of its work to the next typed prompt, plus answered questions and user-decided permission prompts, counted once where they overlap. "started" counts waits that began on the day.',
      'Unattended: per family, from one of the user\'s prompts or answers, for as long as the family\'s agent work kept running (pauses under 2 min don\'t end it), up to the user\'s next prompt or answer anywhere in the family.',
      'A child session has the user\'s input when the user typed into it or answered one of its questions or permission prompts. This is what the logs show, not a judgment of the brief.',
      'Session and repository names are always masked here; the Timeline page shows them locally.',
      'Credits are logged only by Copilot CLI and Copilot App; credit shares are null when none were logged.',
    ],
  };
}
function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/** What fills the prompt, per harness — shares in percent of the prompt. */
function formatComposition(composition: ContextCompositionData) {
  return {
    coverage: composition.coverage,
    harnesses: composition.harnesses.map(h => ({
      harness: h.harness,
      reported: h.source !== null,
      requestsWithData: h.requestsWithData,
      totalRequests: h.totalRequests,
      weighting: h.breakdown?.weighting,
      avgPromptTokens: h.breakdown?.avgPromptTokens ?? null,
      sharePct: h.breakdown ? Object.fromEntries(h.breakdown.slices.map(s => [s.category, s.pct])) : null,
      toolHeavyPct: h.toolHeavyPct,
      avgToolDefinitionTokens: h.avgToolDefinitionTokens,
      maxAvailableTools: h.maxAvailableTools,
    })),
    topSystemSegments: composition.systemSegments.slice(0, 5),
  };
}

/** Prompt-cache efficiency per harness and, where logged, why the cache broke. Percentages, not amounts. */
export function formatPromptCache(data: PromptCacheData) {
  const a = data.attribution;
  const r = data.returnsWithoutCacheData;
  return {
    harnesses: data.harnesses.map(h => ({
      harness: h.harness,
      // Whether requests in range carried cache data; `granularity` is how the harness logs it when it does.
      reported: h.requestsWithData > 0,
      granularity: h.reporting,
      hitPct: h.all?.hitPct ?? null,
      writtenPct: h.all?.writePct ?? null,
      inputCostSavedPct: h.cost?.savedPct ?? null,
      ...(h.cost && h.cost.savedPct < 0 ? { costNote: 'Caching cost more than it saved: cache writes, billed above the input price, outweighed what cache reads saved.' } : {}),
      inputCostOnMissesPct: h.cost?.missCostPct ?? null,
      breaksPer100Calls: h.breaksPer100,
      requestsWithData: h.requestsWithData,
      totalRequests: h.totalRequests,
    })),
    cacheBreaks: a ? {
      harnesses: a.label,
      breaks: a.breaks,
      per100Calls: a.breaksPer100,
      rebuiltTokens: a.rebuiltTokens,
      rebuiltYouCanChangePct: a.controlPct.you,
      rebuiltPartlyYoursPct: a.controlPct.partly,
      causes: a.causes.slice(0, 6).map(c => ({ cause: c.key, who: c.control, breaks: c.breaks, rebuiltPct: c.pctOfRebuilt, inputCostPct: c.costPct })),
      cacheMissOrigins: a.origins.map(o => ({ origin: exportedOriginName(o.origin), pct: o.pct, inputCostPct: o.costPct })),
      cacheLifetimes: a.idle.ttlByModel.map(t => ({ model: t.model, seconds: t.ttlSeconds })),
      returnsAfterExpiry: { expired: a.idle.expiredReturns, of: a.idle.returns, notMeasured: a.idle.unmeasuredReturns },
      medianMinutesSinceCacheRefreshAtExpiry: a.idle.medianIdleMinutes,
    } : null,
    // Copilot harnesses with no call in range that logged cache tokens: their breaks and misses are unknown, so they
    // aren't in cacheBreaks, which covers only the harnesses it names. Prompts you sent there still returned to earlier
    // calls, which can be outside the range.
    returnsWithoutCacheData: r ? {
      harnesses: r.label,
      returnsAfterExpiry: { expired: r.expiredReturns, of: r.returns, notMeasured: r.unmeasuredReturns },
    } : null,
    tips: data.tips,
  };
}

/** Token types beyond input and output, one entry per source (never pooled). Counts, ratios and times only. */
export function formatTokenTypes(data: TokenTypesData) {
  return {
    sources: data.sources.map(s => ({
      source: s.label,
      requests: s.requests,
      reasoning: s.reasoning ? {
        basis: s.reasoning.basis,
        mainPctOfOutput: s.reasoning.main?.sharePct ?? null,
        subagentPctOfOutput: s.reasoning.subagent?.sharePct ?? null,
        byEffort: s.reasoning.byEffort.map(e => ({ effort: e.effort, stream: e.stream, pctOfOutput: e.sharePct, calls: e.calls })),
      } : null,
      compaction: s.compaction ? {
        count: s.compaction.count,
        automatic: s.compaction.automatic,
        failed: s.compaction.failed,
        avgTokensBefore: s.compaction.avgTokensBefore,
        avgTokensAfter: s.compaction.avgTokensAfter,
        removedPct: s.compaction.yieldPct,
        compactionCallInputPctOfMainInput: s.compaction.shareOfMainInputPct,
        modelMinutes: Math.round(s.compaction.modelTimeMs / 60_000),
      } : null,
      subagents: s.subagents ? {
        runs: s.subagents.runs,
        totalTokens: s.subagents.totalTokens,
        pctOfAllTokens: s.subagents.shareOfAllTokensPct,
        byType: s.subagents.byType.slice(0, 6).map(t => ({ type: t.agentType, runs: t.runs, tokens: t.totalTokens })),
      } : null,
      truncation: s.truncation,
      latency: s.latency?.slice(0, 5).map(l => ({
        model: l.model, calls: l.calls, firstTokenP50Ms: l.ttftP50Ms, firstTokenP90Ms: l.ttftP90Ms, callP50Ms: l.durationP50Ms, callP90Ms: l.durationP90Ms,
      })) ?? null,
    })),
    harnessesWithoutTokenTypes: data.harnesses.filter(h => h.source == null).map(h => h.harness),
    tips: data.tips,
  };
}

function formatConfigHealth(cfg: ReturnType<Analyzer['getConfigHealth']>) {
  return {
    overallScore: cfg.overallScore,
    suggestions: cfg.suggestions,
    agenticReadiness: {
      score: cfg.agenticReadiness.score,
      missingSignals: cfg.agenticReadiness.signals
        .filter(s => !s.present)
        .map(s => ({ label: s.label, detail: s.detail })),
    },
    workspaceSummary: topN(
      [...cfg.workspaces].sort((a, b) => a.instructionQualityScore - b.instructionQualityScore),
      5,
    ).map(w => ({
      workspace: w.workspaceName,
      hasInstructions: w.hasInstructions,
      hasPrompts: w.hasPrompts,
      hasAgents: w.hasAgents,
      qualityScore: w.instructionQualityScore,
      staleContext: w.staleContext,
      suggestions: w.suggestions.slice(0, 3),
    })),
  };
}

export function formatContextHealth(analyzer: Analyzer, f?: DateFilter) {
  const ctx = analyzer.getContextManagement(f);

  return {
    promptCache: formatPromptCache(analyzer.getPromptCache(f)),
    tokenTypes: formatTokenTypes(analyzer.getTokenTypes(f)),
    contextManagement: {
      overallScore: ctx.overallScore,
      estimatedContextWindow: ctx.estimatedContextWindow,
      totalCompactions: ctx.totalCompactions,
      fullCompactions: ctx.fullCompactions,
      simpleCompactions: ctx.simpleCompactions,
      sessionsWithTokenData: ctx.sessionsWithTokenData,
      totalSessions: ctx.totalSessions,
      tips: ctx.tips,
      workspaces: topN(
        [...ctx.workspaces].sort((a, b) => a.score - b.score),
        5,
      ).map(w => ({
        workspace: w.workspaceName,
        score: w.score,
        verdict: w.verdict,
        avgUtilization: Math.round(w.avgUtilization),
        peakUtilization: Math.round(w.peakUtilization),
        contextWindow: w.windowSource,
        compactions: w.compactionCount,
      })),
      composition: ctx.composition ? formatComposition(ctx.composition) : undefined,
    },
    configHealth: formatConfigHealth(analyzer.getConfigHealth(f)),
  };
}
