/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Context management analyzer — tracks token utilization, compaction events,
 * and produces per-workspace context health scores + anti-patterns. */

import { AnalyzerBase } from './analyzer-base';
import {
  DateFilter,
  Session,
  AntiPattern,
  OccurrenceDetail,
  ContextManagementData,
  ContextVerdictThresholds,
  WorkspaceContextScore,
  ContextTrend,
  WorkspaceTrendSeries,
  SessionContextDetail,
  SessionTimelineEvent,
  WorkspaceContextSessionsData,
} from './types';
import { toDateStr } from './helpers';
import { analyzeComposition, buildSessionCompositionDetail } from './analyzer-composition';
import {
  CONTEXT_WINDOW_DEFAULT,
  CONTEXT_OPTIMAL_UTILIZATION,
  CONTEXT_LIMITED_UTILIZATION,
  CONTEXT_SATURATION_THRESHOLD,
  CONTEXT_COMPACTION_STORM_MIN,
  CONTEXT_MIN_TOKEN_REQUESTS,
  CONTEXT_GROWING_SESSION_MIN_REQS,
  CONTEXT_GROWING_SESSION_GROWTH_RATE,
} from './constants';

const ADAPTIVE_CONTEXT_THRESHOLD_MIN_SAMPLES = 20;

export class ContextAnalyzer extends AnalyzerBase {
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const weight = idx - lo;
    return sorted[lo] * (1 - weight) + sorted[hi] * weight;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private computeVerdictThresholds(sessions: Session[]): ContextVerdictThresholds {
    const avgUtils: number[] = [];

    for (const s of sessions) {
      const sessionTokens = this.estimateSessionTokens(s).filter(t => t > 0);
      if (sessionTokens.length < CONTEXT_MIN_TOKEN_REQUESTS) continue;
      const sessionCtx = this.estimateSessionContextWindow(s);
      const avgUtil = sessionTokens.reduce((a, b) => a + b, 0) / sessionTokens.length / sessionCtx * 100;
      avgUtils.push(avgUtil);
    }

    if (avgUtils.length < ADAPTIVE_CONTEXT_THRESHOLD_MIN_SAMPLES) {
      return {
        optimalUtilization: CONTEXT_OPTIMAL_UTILIZATION,
        limitedUtilization: CONTEXT_LIMITED_UTILIZATION,
        adaptive: false,
        sampleSize: avgUtils.length,
      };
    }

    const optimal = Math.round(this.clamp(
      Math.max(CONTEXT_OPTIMAL_UTILIZATION, this.percentile(avgUtils, 0.6)),
      CONTEXT_OPTIMAL_UTILIZATION,
      75,
    ));
    const limited = Math.round(this.clamp(
      Math.max(CONTEXT_LIMITED_UTILIZATION, this.percentile(avgUtils, 0.9)),
      optimal + 10,
      95,
    ));

    return {
      optimalUtilization: optimal,
      limitedUtilization: limited,
      adaptive: optimal !== CONTEXT_OPTIMAL_UTILIZATION || limited !== CONTEXT_LIMITED_UTILIZATION,
      sampleSize: avgUtils.length,
    };
  }

  private computeVerdict(
    avgUtil: number,
    peakUtil: number,
    saturation: number,
    compactionCount: number,
    requestCount: number,
    thresholds: ContextVerdictThresholds,
  ): 'optimal' | 'degraded' | 'limited' {
    const compactionRate = requestCount > 0 ? compactionCount / requestCount : 0;
    const degradedPeak = Math.min(95, Math.max(thresholds.optimalUtilization + 12, CONTEXT_SATURATION_THRESHOLD + 10));
    const limitedPeak = Math.min(100, Math.max(thresholds.limitedUtilization + 10, degradedPeak + 10));
    const degradedSaturation = 20;
    const limitedSaturation = 80;
    const degradedCompactions = compactionCount > 0;
    const limitedCompactions = compactionRate >= 0.12 || (requestCount <= 20 && compactionCount >= CONTEXT_COMPACTION_STORM_MIN);

    if (
      avgUtil > thresholds.limitedUtilization
      || peakUtil >= limitedPeak
      || (saturation >= limitedSaturation && avgUtil >= thresholds.limitedUtilization - 5)
      || limitedCompactions
    ) {
      return 'limited';
    }
    if (avgUtil > thresholds.optimalUtilization || peakUtil >= degradedPeak || saturation >= degradedSaturation || degradedCompactions) {
      return 'degraded';
    }
    return 'optimal';
  }

  private verdictSeverity(verdict: 'optimal' | 'degraded' | 'limited'): number {
    return verdict === 'limited' ? 2 : verdict === 'degraded' ? 1 : 0;
  }

  /**
   * Infer the model's context window for a session from the largest native
   * `promptTokens` value observed, rounded up to the nearest 32K bucket.
   * Falls back to `CONTEXT_WINDOW_DEFAULT` when no native data exists.
   * (This is *not* token approximation — it's a model-window heuristic
   * derived from real harness data.)
   */
  private estimateSessionContextWindow(session: Session): number {
    let maxNative = 0;
    for (const r of session.requests) {
      if (r.promptTokens != null && r.promptTokens > maxNative) maxNative = r.promptTokens;
    }
    return maxNative > 0
      ? Math.max(CONTEXT_WINDOW_DEFAULT, Math.ceil(maxNative / 32_000) * 32_000)
      : CONTEXT_WINDOW_DEFAULT;
  }

  /**
   * Per-request prompt-token series for a session.
   *
   * Returns *only* native promptTokens reported by the harness — `0` for any
   * request without native data. (Token approximation has been removed; see
   * helpers.ts for rationale.)
   *
   * Compaction events still reset accumulators conceptually, but since this
   * function no longer accumulates anything beyond reading the per-request
   * native value, the reset is a no-op.
   */
  private estimateSessionTokens(session: Session): number[] {
    const out: number[] = [];
    for (const r of session.requests) {
      out.push(r.promptTokens != null && r.promptTokens > 0 ? r.promptTokens : 0);
    }
    return out;
  }

  getContextManagement(f?: DateFilter): ContextManagementData {
    const sessions = this.filteredSessions(f);
    const thresholds = this.computeVerdictThresholds(sessions);
    const workspaceAnalyses = Array.from(this.groupSessionsByWorkspace(sessions).values())
      .map(group => this.analyzeWorkspace(group.ws, group.sessions, thresholds))
      .filter((analysis): analysis is NonNullable<typeof analysis> => analysis !== null);

    const workspaces = workspaceAnalyses
      .map(analysis => analysis.workspace)
      .sort((a, b) => a.score - b.score);
    const totalCompactions = workspaceAnalyses.reduce((sum, analysis) => sum + analysis.compactionCount, 0);
    const fullCompactions = workspaceAnalyses.reduce((sum, analysis) => sum + analysis.fullCompactions, 0);
    const simpleCompactions = workspaceAnalyses.reduce((sum, analysis) => sum + analysis.simpleCompactions, 0);
    const sessionsWithTokenData = workspaceAnalyses.reduce((sum, analysis) => sum + analysis.sessionCount, 0);
    const overallScore = this.computeOverallWorkspaceScore(workspaces);
    const trend = this.buildWeeklyTrend(sessions, thresholds);
    const workspaceTrend = this.buildWorkspaceTrend(sessions, trend.map(t => t.label), workspaces);
    const antiPatterns = this.detectContextAntiPatterns(sessions, thresholds);
    const requests = this.filter(f);
    const composition = analyzeComposition(requests, request => this.requestSessionMap.get(request));
    const tips = [
      ...this.generateTips(workspaces, totalCompactions, overallScore, thresholds),
      ...composition.tips,
    ];

    return {
      overallScore,
      estimatedContextWindow: this.estimateContextWindowFromRequests(requests),
      thresholds,
      workspaces,
      trend,
      workspaceTrend,
      totalCompactions,
      fullCompactions,
      simpleCompactions,
      sessionsWithTokenData,
      totalSessions: sessions.length,
      antiPatterns,
      tips,
      composition: composition.data,
    };
  }

  private estimateContextWindowFromRequests(requests: Array<{ promptTokens: number | null }>): number {
    let maxObserved = 0;
    for (const request of requests) {
      if (request.promptTokens != null && request.promptTokens > maxObserved) maxObserved = request.promptTokens;
    }
    return maxObserved > 0
      ? Math.max(CONTEXT_WINDOW_DEFAULT, Math.ceil(maxObserved / 32_000) * 32_000)
      : CONTEXT_WINDOW_DEFAULT;
  }

  private groupSessionsByWorkspace(sessions: Session[]): Map<string, { ws: Session; sessions: Session[] }> {
    const wsMap = new Map<string, { ws: Session; sessions: Session[] }>();
    for (const session of sessions) {
      const key = session.workspaceName;
      if (!wsMap.has(key)) wsMap.set(key, { ws: session, sessions: [] });
      wsMap.get(key)!.sessions.push(session);
    }
    return wsMap;
  }

  private analyzeWorkspace(
    workspace: Session,
    sessions: Session[],
    thresholds: ContextVerdictThresholds,
  ): {
    workspace: WorkspaceContextScore;
    sessionCount: number;
    compactionCount: number;
    fullCompactions: number;
    simpleCompactions: number;
  } | null {
    const effectiveTokens: number[] = [];
    const utilizationSamples: number[] = [];
    let compactionCount = 0;
    let fullCompactions = 0;
    let simpleCompactions = 0;
    let sessionCount = 0;

    for (const session of sessions) {
      const sessionTokens = this.estimateSessionTokens(session);
      const hasPerReqTokens = this.hasTokenData(sessionTokens);

      if (!hasPerReqTokens) {
        // Include session if it has session-level modelUsage (so it appears)
        // but don't compute utilization — modelUsage totals are billing sums,
        // not context window sizes.
        const avgFromUsage = this.getSessionLevelAvgTokens(session);
        if (avgFromUsage === 0) continue;
        sessionCount++;
        continue;
      }

      sessionCount++;
      const sessionCtx = this.estimateSessionContextWindow(session);
      for (let i = 0; i < session.requests.length; i++) {
        const tokens = sessionTokens[i];
        if (tokens > 0) {
          effectiveTokens.push(tokens);
          utilizationSamples.push((tokens / sessionCtx) * 100);
        }
        const compaction = session.requests[i].compaction;
        if (!compaction) continue;
        compactionCount++;
        if (compaction.mode === 'full') fullCompactions++;
        else simpleCompactions++;
      }
    }

    if (effectiveTokens.length === 0) return null;

    const avg = effectiveTokens.reduce((a, b) => a + b, 0) / effectiveTokens.length;
    const max = Math.max(...effectiveTokens);
    const avgUtil = utilizationSamples.reduce((a, b) => a + b, 0) / utilizationSamples.length;
    const peakUtil = Math.max(...utilizationSamples);
    const saturatedCount = utilizationSamples.filter(u => u >= CONTEXT_SATURATION_THRESHOLD).length;
    const saturation = Math.round((saturatedCount / utilizationSamples.length) * 1000) / 10;
    const verdict = this.computeVerdict(avgUtil, peakUtil, saturation, compactionCount, effectiveTokens.length, thresholds);

    return {
      workspace: {
        workspaceId: workspace.workspaceName,
        workspaceName: workspace.workspaceName,
        harness: workspace.harness,
        sessionCount,
        requestsWithTokens: effectiveTokens.length,
        avgPromptTokens: Math.round(avg),
        maxPromptTokens: max,
        avgUtilization: Math.round(avgUtil * 10) / 10,
        peakUtilization: Math.round(peakUtil * 10) / 10,
        saturation,
        compactionCount,
        costEfficiency: null,
        score: this.computeContextScore(avgUtil, saturation, fullCompactions, simpleCompactions, thresholds),
        verdict,
      },
      sessionCount,
      compactionCount,
      fullCompactions,
      simpleCompactions,
    };
  }

  private hasTokenData(sessionTokens: number[]): boolean {
    return sessionTokens.some(tokens => tokens > 0);
  }

  /** Compute average input tokens per request from session-level modelUsage.
   *  Returns 0 if no modelUsage data is available.
   *  NOTE: This is the billing-total average, NOT the context window size.
   *  Used only to determine whether a session has *any* token data at all,
   *  not for utilization computation. */
  private getSessionLevelAvgTokens(session: Session): number {
    if (!session.modelUsage || session.requests.length === 0) return 0;
    let totalInput = 0;
    for (const usage of Object.values(session.modelUsage)) {
      totalInput += usage.inputTokens + usage.cacheReadTokens;
    }
    return totalInput > 0 ? Math.round(totalInput / session.requests.length) : 0;
  }

  private computeContextScore(
    avgUtil: number,
    saturation: number,
    fullCompactions: number,
    simpleCompactions: number,
    thresholds: ContextVerdictThresholds,
  ): number {
    let utilizationScore: number;
    if (avgUtil <= thresholds.optimalUtilization) {
      utilizationScore = 100;
    } else if (avgUtil <= thresholds.limitedUtilization) {
      const span = Math.max(1, thresholds.limitedUtilization - thresholds.optimalUtilization);
      const fraction = (avgUtil - thresholds.optimalUtilization) / span;
      utilizationScore = 100 - fraction * 55;
    } else {
      const excess = avgUtil - thresholds.limitedUtilization;
      utilizationScore = Math.max(0, 45 - excess * 2);
    }

    const saturationPenalty = Math.min(saturation * 0.3, 25);
    const compactionPenalty = Math.min(fullCompactions * 5 + simpleCompactions * 2, 40);
    return Math.max(0, Math.round(utilizationScore - saturationPenalty - compactionPenalty));
  }

  private computeOverallWorkspaceScore(workspaces: WorkspaceContextScore[]): number {
    const totalWeightedScore = workspaces.reduce((sum, workspace) => sum + workspace.score * workspace.requestsWithTokens, 0);
    const totalWeight = workspaces.reduce((sum, workspace) => sum + workspace.requestsWithTokens, 0);
    return totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 0;
  }

  private buildWeeklyTrend(sessions: Session[], thresholds: ContextVerdictThresholds): ContextTrend[] {
    // Group by ISO week — compute utilization per request using per-session context windows
    const weekMap = new Map<string, { utils: number[]; compactions: number; overThreshold: number }>();

    for (const s of sessions) {
      const sessionTokens = this.estimateSessionTokens(s);
      const sessionCtx = this.estimateSessionContextWindow(s);
      // Skip wholly-tokenless sessions — Context Management hides them so
      // they must not contribute to the trend chart either.
      let sessionHasTokens = false;
      for (let i = 0; i < s.requests.length; i++) {
        if (sessionTokens[i] > 0) { sessionHasTokens = true; break; }
      }
      if (!sessionHasTokens) continue;
      for (let i = 0; i < s.requests.length; i++) {
        const r = s.requests[i];
        if (r.timestamp == null) continue;
        const d = new Date(r.timestamp);
        // Get Monday-based ISO week label
        const day = d.getDay() || 7;
        const monday = new Date(d);
        monday.setDate(d.getDate() - day + 1);
        const label = toDateStr(monday.getTime());

        if (!weekMap.has(label)) weekMap.set(label, { utils: [], compactions: 0, overThreshold: 0 });
        const week = weekMap.get(label)!;

        const tokens = sessionTokens[i];
        if (tokens > 0) {
          const util = (tokens / sessionCtx) * 100;
          week.utils.push(util);
          if (util > thresholds.limitedUtilization) week.overThreshold++;
        }
        if (r.compaction) week.compactions++;
      }
    }

    const labels = [...weekMap.keys()].sort();
    return labels
      // Drop weeks that ended up with no token-bearing samples — emitting
      // a 0% utilization point for such a week would visually misrepresent
      // missing data as zero usage.
      .filter(label => weekMap.get(label)!.utils.length > 0)
      .map(label => {
      const w = weekMap.get(label)!;
      const avgUtil = w.utils.length > 0
        ? Math.round(w.utils.reduce((a, b) => a + b, 0) / w.utils.length * 10) / 10
        : 0;
      return {
        label,
        avgUtilization: avgUtil,
        compactions: w.compactions,
        sessionsOverThreshold: w.overThreshold,
      };
    });
  }

  /**
   * Build per-workspace weekly utilization series for the top 10 workspaces
   * (sorted by total request count). Each series is aligned to the global
   * week labels from the aggregate trend.
   */
  private buildWorkspaceTrend(
    sessions: Session[],
    weekLabels: string[],
    workspaces: WorkspaceContextScore[],
  ): WorkspaceTrendSeries[] {
    if (weekLabels.length === 0) return [];

    // Pick top 10 workspaces by request count
    const top = [...workspaces]
      .sort((a, b) => b.requestsWithTokens - a.requestsWithTokens)
      .slice(0, 10);
    const topNames = new Set(top.map(w => w.workspaceName));

    // week label → index for fast lookup
    const weekIdx = new Map<string, number>();
    for (let i = 0; i < weekLabels.length; i++) weekIdx.set(weekLabels[i], i);

    // workspace name → week index → utilization values
    const wsWeekUtils = new Map<string, Map<number, number[]>>();
    for (const name of topNames) wsWeekUtils.set(name, new Map());

    for (const s of sessions) {
      if (!topNames.has(s.workspaceName)) continue;
      const utilMap = wsWeekUtils.get(s.workspaceName)!;
      const sessionTokens = this.estimateSessionTokens(s);
      const sessionCtx = this.estimateSessionContextWindow(s);

      for (let i = 0; i < s.requests.length; i++) {
        const r = s.requests[i];
        if (r.timestamp == null) continue;
        const d = new Date(r.timestamp);
        const day = d.getDay() || 7;
        const monday = new Date(d);
        monday.setDate(d.getDate() - day + 1);
        const label = toDateStr(monday.getTime());
        const idx = weekIdx.get(label);
        if (idx == null) continue;

        const tokens = sessionTokens[i];
        if (tokens > 0) {
          if (!utilMap.has(idx)) utilMap.set(idx, []);
          utilMap.get(idx)!.push((tokens / sessionCtx) * 100);
        }
      }
    }

    return top.map(ws => {
      const utilMap = wsWeekUtils.get(ws.workspaceName)!;
      const data: (number | null)[] = Array<number | null>(weekLabels.length).fill(null);
      for (const [idx, vals] of utilMap) {
        data[idx] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
      }
      return { workspaceName: ws.workspaceName, data };
    });
  }

  private detectContextAntiPatterns(sessions: Session[], thresholds: ContextVerdictThresholds): AntiPattern[] {
    const patterns: AntiPattern[] = [];

    // 1. Context Bloat — sessions that consistently run near/above the context limit
    const bloatedSessions: { name: string; session: Session; avgUtil: number }[] = [];
    for (const s of sessions) {
      const sessionTokens = this.estimateSessionTokens(s);
      if (sessionTokens.length < CONTEXT_MIN_TOKEN_REQUESTS) continue;
      const sessionCtx = this.estimateSessionContextWindow(s);
      const avgUtil = sessionTokens.reduce((a, b) => a + b, 0) / sessionTokens.length / sessionCtx * 100;
      if (avgUtil > thresholds.limitedUtilization) {
        bloatedSessions.push({ name: s.workspaceName, session: s, avgUtil });
      }
    }
    if (bloatedSessions.length > 0) {
      const details: OccurrenceDetail[] = bloatedSessions.slice(0, 200).map(b => ({
        timestamp: b.session.creationDate ?? 0,
        workspace: b.name,
        sessionId: b.session.sessionId,
        message: `${Math.round(b.avgUtil)}% avg context utilization`,
        model: '',
        kind: 'session' as const,
        stats: { avgUtilPct: Math.round(b.avgUtil), requests: b.session.requestCount },
      }));
      patterns.push({
        id: 'context-bloat',
        name: 'Context Bloat',
        severity: 'high',
        group: 'context-management',
        occurrences: bloatedSessions.length,
        description: `${bloatedSessions.length} session(s) run above ${thresholds.limitedUtilization}% average context utilization. The model is working with a nearly-full context window, which degrades response quality.`,
        suggestion: 'Start new sessions more frequently. Break large tasks into smaller scoped sessions instead of continuing in one long thread.',
        examples: bloatedSessions.slice(0, 3).map(b => b.name),
        details,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    // 2. Compaction Storm — sessions with frequent compaction events
    const compactionStormSessions: { session: Session; compactions: number }[] = [];
    for (const s of sessions) {
      const compactions = s.requests.filter(r => r.compaction != null).length;
      if (compactions >= CONTEXT_COMPACTION_STORM_MIN) {
        compactionStormSessions.push({ session: s, compactions });
      }
    }
    if (compactionStormSessions.length > 0) {
      const details: OccurrenceDetail[] = compactionStormSessions.slice(0, 200).map(c => ({
        timestamp: c.session.creationDate ?? 0,
        workspace: c.session.workspaceName,
        sessionId: c.session.sessionId,
        message: `${c.compactions} compaction events`,
        model: '',
        kind: 'session' as const,
        stats: { compactions: c.compactions, requests: c.session.requestCount },
      }));
      patterns.push({
        id: 'compaction-storm',
        name: 'Compaction Storm',
        severity: 'high',
        group: 'context-management',
        occurrences: compactionStormSessions.length,
        description: `${compactionStormSessions.length} session(s) triggered ${CONTEXT_COMPACTION_STORM_MIN}+ compaction events. Repeated compaction means important context is being lost and re-summarized.`,
        suggestion: 'Start fresh sessions before context becomes too large. Use @workspace or file references selectively rather than letting the context accumulate.',
        examples: compactionStormSessions.slice(0, 3).map(c => `${c.session.workspaceName} (${c.compactions} compactions)`),
        details,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    // 3. Context Amnesia — sessions where compaction caused a large context drop (>80% loss)
    const amnesiaEvents: { session: Session; tokensBefore: number }[] = [];
    for (const s of sessions) {
      for (const r of s.requests) {
        if (r.compaction && r.compaction.contextLengthBefore > 0) {
          const sessionCtx = this.estimateSessionContextWindow(s);
          const beforeUtil = (r.compaction.contextLengthBefore / sessionCtx) * 100;
          if (beforeUtil > 85) {
            amnesiaEvents.push({ session: s, tokensBefore: r.compaction.contextLengthBefore });
          }
        }
      }
    }
    if (amnesiaEvents.length > 0) {
      const details: OccurrenceDetail[] = amnesiaEvents.slice(0, 200).map(a => ({
        timestamp: a.session.creationDate ?? 0,
        workspace: a.session.workspaceName,
        sessionId: a.session.sessionId,
        message: `${Math.round(a.tokensBefore / 1000)}K tokens compacted`,
        model: '',
        kind: 'session' as const,
        stats: { tokensK: Math.round(a.tokensBefore / 1000), requests: a.session.requestCount },
      }));
      patterns.push({
        id: 'context-amnesia',
        name: 'Context Amnesia Risk',
        severity: 'medium',
        group: 'context-management',
        occurrences: amnesiaEvents.length,
        description: `${amnesiaEvents.length} compaction event(s) occurred when context was above 85% capacity. Large context drops risk losing important earlier instructions and decisions.`,
        suggestion: 'Summarize key decisions in a markdown file or use custom instructions so they survive compaction. Consider starting a new session with explicit context instead.',
        examples: amnesiaEvents.slice(0, 3).map(a => `${a.session.workspaceName}: ${Math.round(a.tokensBefore / 1000)}K tokens compacted`),
        details,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    // 4. Runaway Context Growth — sessions where token count grows steadily without stabilizing
    const runawayEntries: { session: Session; first: number; last: number }[] = [];
    for (const s of sessions) {
      const sessionTokens = this.estimateSessionTokens(s);
      if (sessionTokens.length < CONTEXT_GROWING_SESSION_MIN_REQS) continue;
      let increasing = 0;
      for (let i = 1; i < sessionTokens.length; i++) {
        if (sessionTokens[i] > sessionTokens[i - 1]) increasing++;
      }
      const growthRate = increasing / (sessionTokens.length - 1);
      if (growthRate > CONTEXT_GROWING_SESSION_GROWTH_RATE) {
        runawayEntries.push({ session: s, first: sessionTokens[0], last: sessionTokens[sessionTokens.length - 1] });
      }
    }
    if (runawayEntries.length > 0) {
      const details: OccurrenceDetail[] = runawayEntries.slice(0, 200).map(r => ({
        timestamp: r.session.creationDate ?? 0,
        workspace: r.session.workspaceName,
        sessionId: r.session.sessionId,
        message: `${Math.round(r.first / 1000)}K \u2192 ${Math.round(r.last / 1000)}K tokens`,
        model: '',
        kind: 'session' as const,
        stats: { startK: Math.round(r.first / 1000), endK: Math.round(r.last / 1000), requests: r.session.requestCount },
      }));
      patterns.push({
        id: 'runaway-context',
        name: 'Runaway Context Growth',
        severity: 'medium',
        group: 'context-management',
        occurrences: runawayEntries.length,
        description: `${runawayEntries.length} session(s) show steadily growing context without stabilization. This indicates the session is accumulating context faster than it should.`,
        suggestion: 'Reference only the files you need per request. Use /clear or start a new session periodically to reset context.',
        examples: runawayEntries.slice(0, 3).map(r => `${r.session.workspaceName}: ${Math.round(r.first / 1000)}K \u2192 ${Math.round(r.last / 1000)}K tokens`),
        details,
        weeklyHist: { labels: [], counts: [] },
      });
    }

    return patterns;
  }

  getWorkspaceContextSessions(workspaceId: string, f?: DateFilter): WorkspaceContextSessionsData {
    const sessions = this.filteredSessions(f).filter(s => this.matchesWorkspaceFilter(s, workspaceId));
    const workspaceName = sessions[0]?.workspaceName ?? workspaceId;
    const thresholds = this.computeVerdictThresholds(sessions);
    const estimatedContextWindow = this.estimateContextWindowFromRequests(
      sessions.flatMap(session => session.requests),
    );
    const details = sessions
      .map(session => this.buildSessionContextDetail(session, thresholds))
      .filter((detail): detail is SessionContextDetail => detail !== null)
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

    return { workspaceName, estimatedContextWindow, thresholds, sessions: details };
  }

  private buildSessionContextDetail(
    session: Session,
    thresholds: ContextVerdictThresholds,
  ): SessionContextDetail | null {
    const sessionTokens = this.estimateSessionTokens(session);
    const tokensWithData = sessionTokens.filter(t => t > 0);
    const hasPerRequestTokens = tokensWithData.length > 0;
    const composition = buildSessionCompositionDetail(session);

    if (!hasPerRequestTokens) {
      // Fall back to session-level modelUsage — include the session but
      // don't compute utilization (modelUsage totals are cumulative billing
      // sums across all internal LLM calls, not context window sizes).
      const avgFromUsage = this.getSessionLevelAvgTokens(session);
      if (avgFromUsage === 0 && !composition) return null;

      const compactionCount = session.requests.filter(r => r.compaction != null).length;

      return {
        sessionId: session.sessionId,
        date: this.getSessionDisplayDate(session),
        harness: session.harness,
        requestCount: session.requests.length,
        requestsWithTokens: 0,
        avgPromptTokens: 0,
        maxPromptTokens: 0,
        avgUtilization: 0,
        peakUtilization: 0,
        contextWindow: 0,
        compactionCount,
        tokenCurve: session.requests.map(() => null),
        saturation: 0,
        costEfficiency: null,
        verdict: compactionCount > 0 ? 'degraded' : 'optimal',
        events: this.buildSessionTimelineEvents(session),
        requestQueries: session.requests.map(r => this.getRequestQueryPreview(r.messageText)),
        hasPerRequestTokens: false,
        ...(composition ? { composition } : {}),
      };
    }

    const sessionCtx = this.estimateSessionContextWindow(session);
    const avg = tokensWithData.reduce((a, b) => a + b, 0) / tokensWithData.length;
    const max = Math.max(...tokensWithData);
    const avgUtil = (avg / sessionCtx) * 100;
    const peakUtil = (max / sessionCtx) * 100;
    const compactionCount = session.requests.filter(r => r.compaction != null).length;
    const saturatedCount = tokensWithData.filter(t => (t / sessionCtx) * 100 >= CONTEXT_SATURATION_THRESHOLD).length;
    const saturation = Math.round((saturatedCount / tokensWithData.length) * 1000) / 10;

    return {
      sessionId: session.sessionId,
      date: this.getSessionDisplayDate(session),
      harness: session.harness,
      requestCount: session.requests.length,
      requestsWithTokens: tokensWithData.length,
      avgPromptTokens: Math.round(avg),
      maxPromptTokens: max,
      avgUtilization: Math.round(avgUtil * 10) / 10,
      peakUtilization: Math.round(peakUtil * 10) / 10,
      contextWindow: sessionCtx,
      compactionCount,
      tokenCurve: sessionTokens.map(t => t > 0 ? t : null),
      saturation,
      costEfficiency: null,
      verdict: this.computeVerdict(avgUtil, peakUtil, saturation, compactionCount, tokensWithData.length, thresholds),
      events: this.buildSessionTimelineEvents(session),
      requestQueries: session.requests.map(r => this.getRequestQueryPreview(r.messageText)),
      hasPerRequestTokens: true,
      ...(composition ? { composition } : {}),
    };
  }

  private getSessionDisplayDate(session: Session): string {
    if (session.creationDate != null) return toDateStr(session.creationDate);
    if (session.lastMessageDate != null) return toDateStr(session.lastMessageDate);
    return 'Unknown';
  }

  private getRequestQueryPreview(messageText: string): string {
    const text = messageText.trim();
    if (text.length === 0) return '(empty)';
    const firstLine = text.split('\n')[0];
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '\u2026' : firstLine;
  }

  private buildSessionTimelineEvents(session: Session): SessionTimelineEvent[] {
    const events: SessionTimelineEvent[] = [];
    let prevSnapshot: Map<number, string> | null = null;

    for (let i = 0; i < session.requests.length; i++) {
      const request = session.requests[i];
      if (request.compaction != null) {
        events.push({ requestIndex: i, type: 'compaction', label: `Compaction (${request.compaction.mode})` });
      }
      if (request.todoSnapshot && request.todoSnapshot.length > 0) {
        prevSnapshot = this.addTodoSnapshotEvents(events, request.todoSnapshot, prevSnapshot, i);
        continue;
      }
      if (prevSnapshot == null) {
        this.addToolFallbackTodoEvents(events, request.toolsUsed, i);
      }
    }

    return events;
  }

  private addTodoSnapshotEvents(
    events: SessionTimelineEvent[],
    snapshot: NonNullable<Session['requests'][number]['todoSnapshot']>,
    prevSnapshot: Map<number, string> | null,
    requestIndex: number,
  ): Map<number, string> {
    const currentSnapshot = new Map(snapshot.map(item => [item.id, item.status]));
    if (prevSnapshot == null) {
      for (const item of snapshot) {
        events.push({ requestIndex, type: 'todo-add', label: item.title });
      }
      return currentSnapshot;
    }

    for (const item of snapshot) {
      const previousStatus = prevSnapshot.get(item.id);
      if (previousStatus == null) {
        events.push({ requestIndex, type: 'todo-add', label: item.title });
        continue;
      }
      if (previousStatus !== item.status) {
        this.addTodoStatusChangeEvent(events, item.title, item.status, requestIndex);
      }
    }
    return currentSnapshot;
  }

  private addTodoStatusChangeEvent(
    events: SessionTimelineEvent[],
    title: string,
    status: string,
    requestIndex: number,
  ): void {
    if (status === 'completed') {
      events.push({ requestIndex, type: 'todo-complete', label: title });
    } else if (status === 'in-progress') {
      events.push({ requestIndex, type: 'todo-progress', label: title });
    }
  }

  private addToolFallbackTodoEvents(events: SessionTimelineEvent[], toolsUsed: string[], requestIndex: number): void {
    for (const tool of toolsUsed) {
      const toolName = tool.toLowerCase();
      if (!toolName.includes('todo')) continue;
      const isComplete = toolName.includes('complete') || toolName === 'todoread';
      events.push({
        requestIndex,
        type: isComplete ? 'todo-complete' : 'todo-add',
        label: tool,
      });
    }
  }

  private generateTips(
    workspaces: WorkspaceContextScore[],
    totalCompactions: number,
    overallScore: number,
    thresholds: ContextVerdictThresholds,
  ): string[] {
    const tips: string[] = [];

    if (overallScore >= 80) {
      tips.push('Excellent context management. Sessions stay within optimal utilization and avoid auto-compaction.');
    } else if (overallScore >= 60) {
      tips.push(`Good context hygiene. A few workspaces could start fresh sessions earlier to stay under ${thresholds.optimalUtilization}% utilization.`);
    } else if (overallScore >= 40) {
      tips.push('Context is running high in some workspaces. Start new sessions before auto-compaction kicks in.');
    } else {
      tips.push(`Context is frequently at its limit. Start new sessions proactively and keep context under ${thresholds.optimalUtilization}% utilization.`);
    }

    const limited = workspaces.filter(w => w.verdict === 'limited');
    if (limited.length > 0) {
      tips.push(`${limited.length} workspace(s) have limited context capacity. Start fresh sessions before auto-compaction kicks in: ${limited.map(w => w.workspaceName).slice(0, 3).join(', ')}.`);
    }

    // Saturation warning — workspaces where many requests are pinned near the ceiling
    const highSaturation = workspaces.filter(w => w.saturation > 30);
    if (highSaturation.length > 0) {
      tips.push(`${highSaturation.length} workspace(s) spend >30% of requests near the context ceiling. Even if averages look acceptable, sustained high utilization degrades quality.`);
    }

    if (totalCompactions > 10) {
      tips.push(`${totalCompactions} compaction events detected. Auto-compaction means sessions ran too long — and mid-task compaction loses important context. Manually compact (or start a fresh session) at natural breakpoints: after a major research phase, a completed feature, or before switching focus.`);
    } else if (totalCompactions > 0) {
      tips.push(`${totalCompactions} compaction event(s) detected. Monitor whether key instructions survive compaction.`);
    }

    const optimal = workspaces.filter(w => w.verdict === 'optimal');
    if (optimal.length > 0 && optimal.length < workspaces.length) {
      tips.push(`${optimal.length} workspace(s) are in the optimal range — study what makes them efficient and apply those patterns elsewhere.`);
    }

    return tips;
  }

  /**
   * Returns which time-range buttons are useful in the Context Management
   * sub-tab — a range is included only if it captures *strictly more*
   * token-bearing requests than the smaller ranges before it. The smallest
   * non-empty range is always included so the bar isn't empty when data exists.
   *
   * Honours non-date filter dimensions (workspace, harness) so the available
   * ranges accurately mirror what the user would see after applying them.
   *
   * Also returns diagnostic info so the UI can explain *why* there is no
   * data when a filter combination yields an empty result. This matters
   * because some harnesses (e.g. GitHub Copilot CLI) only emit
   * session-aggregated tokens — they have data but not the per-request
   * granularity that Context Management requires.
   */
  getContextRangeAvailability(f?: DateFilter): {
    rangesWithTokens: number[];
    /** Number of sessions matching the non-date filter dimensions. */
    matchingSessions: number;
    /** Number of those sessions that have at least one per-request token sample. */
    sessionsWithRequestTokens: number;
    /** Harnesses among the matching sessions whose requests never carry per-request tokens. */
    harnessesWithoutRequestTokens: string[];
  } {
    const candidateRanges = [30, 90, 180, 365, 0];
    const now = Date.now();

    const timestamps: number[] = [];
    let matchingSessions = 0;
    let sessionsWithRequestTokens = 0;
    const harnessHasTokens = new Map<string, boolean>();
    for (const s of this.sessions) {
      if (!this.matchesWorkspaceFilter(s, f?.workspaceId)) continue;
      if (f?.harness && s.harness !== f.harness) continue;
      matchingSessions++;
      let sessionHasReqTokens = false;
      for (const r of s.requests) {
        if (r.timestamp == null) continue;
        if (r.promptTokens == null || r.promptTokens <= 0) continue;
        timestamps.push(r.timestamp);
        sessionHasReqTokens = true;
      }
      if (sessionHasReqTokens) sessionsWithRequestTokens++;
      const prev = harnessHasTokens.get(s.harness);
      harnessHasTokens.set(s.harness, prev === true ? true : sessionHasReqTokens);
    }

    const harnessesWithoutRequestTokens = [...harnessHasTokens.entries()]
      .filter(([, has]) => !has)
      .map(([h]) => h)
      .sort();

    if (timestamps.length === 0) {
      return { rangesWithTokens: [], matchingSessions, sessionsWithRequestTokens, harnessesWithoutRequestTokens };
    }

    const result: number[] = [];
    let prevCount = 0;
    for (const r of candidateRanges) {
      const cutoff = r === 0 ? -Infinity : now - r * 86_400_000;
      let count = 0;
      for (const t of timestamps) if (t >= cutoff) count++;
      if (count > prevCount) {
        result.push(r);
        prevCount = count;
      }
    }
    return { rangesWithTokens: result, matchingSessions, sessionsWithRequestTokens, harnessesWithoutRequestTokens };
  }
}
