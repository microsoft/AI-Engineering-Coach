/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Formatters that transform raw Analyzer output into concise, LLM-friendly JSON.
 * Each formatter strips large arrays, computes key ratios, and adds narrative hints
 * so the LLM can synthesize rather than parse.
 */

import type { Analyzer } from '../core/analyzer';
import type { DateFilter } from '../core/types';

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
    sustainablePace: {
      burnoutRisk: insights.sustainablePace.burnoutRisk,
      alerts: insights.sustainablePace.alerts,
      currentStreak: insights.sustainablePace.currentStreak,
      weekendTrending: insights.sustainablePace.weekendTrending,
      lateNightTrending: insights.sustainablePace.lateNightTrending,
    },
  };
}

export function formatWellbeing(analyzer: Analyzer, f?: DateFilter) {
  const wlb = analyzer.getWorkLifeBalance(f);
  const insights = analyzer.getInsights(f);

  if (!wlb) {
    return { status: 'no-data', message: 'Not enough data to assess work-life balance.' };
  }

  return {
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
    sustainablePace: {
      burnoutRisk: insights.sustainablePace.burnoutRisk,
      alerts: insights.sustainablePace.alerts,
      currentStreak: insights.sustainablePace.currentStreak,
      weekendTrending: insights.sustainablePace.weekendTrending,
      lateNightTrending: insights.sustainablePace.lateNightTrending,
    },
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

export function formatContextHealth(analyzer: Analyzer, f?: DateFilter) {
  const ctx = analyzer.getContextManagement(f);
  const cfg = analyzer.getConfigHealth(f);

  return {
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
        compactions: w.compactionCount,
      })),
    },
    configHealth: {
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
    },
  };
}
