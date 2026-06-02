/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Insights analyzer -- learning velocity, intent classification, spec-driven,
   production/review ratio, sustainable pace, prompt maturity, migration readiness */

import {
  Session, DateFilter, SessionIntent, SESSION_INTENTS,
  LearningVelocityData, IntentClassificationData, SpecDrivenData,
  ProductionReviewData, SustainablePaceData, PromptMaturityData,
  MigrationReadinessData, InsightsData,
} from './types';
import { toDateStr, isoWeek, classifyWorkType } from './helpers';
import {
  REVIEW_GAP_THRESHOLD_MS, LATE_NIGHT_START, LATE_NIGHT_END,
  BURNOUT_STREAK_DAYS, BURNOUT_LATE_NIGHT_RATE, BURNOUT_WEEKEND_RATE,
  PROMPT_MATURITY_SAMPLE_SIZE,
} from './constants';
import { AnalyzerBase } from './analyzer-base';

/* ════════════════════════════════════════════════════════════════════
   Intent classification helpers
   ════════════════════════════════════════════════════════════════════ */

const PLANNING_RE = /\b(plan|architect|design|outline|approach|strategy|scope|breakdown|roadmap|RFC|spec|proposal)\b/i;
const DEBUG_RE = /\b(fix|bug|error|exception|crash|debug|stacktrace|trace|issue|broken|fail|wrong|not working|undefined is not|cannot read|segfault|panic)\b/i;
const REVIEW_RE = /\b(review|explain|understand|what does|how does|walk me through|read|audit|analyze|inspect|clarify|describe)\b/i;
const EXPLORE_RE = /\b(how to|what is|can I|learn|explore|example|tutorial|demo|try|experiment|compare|research|playground)\b/i;

function classifyIntent(session: Session): SessionIntent {
  const scores: Record<SessionIntent, number> = {
    Planning: 0, Implementation: 0, Debugging: 0, Review: 0, Exploration: 0,
  };

  for (const r of session.requests) {
    const msg = r.messageText;
    if (r.agentMode.includes('plan') || r.slashCommand === 'plan' || PLANNING_RE.test(msg)) scores.Planning++;
    if (DEBUG_RE.test(msg) || r.slashCommand === 'fix') scores.Debugging++;
    if (REVIEW_RE.test(msg) || r.slashCommand === 'explain') scores.Review++;
    if (EXPLORE_RE.test(msg)) scores.Exploration++;
    // Implementation signals: code output, edits, build keywords
    if (r.aiCode.length > 0 || r.editedFiles.length > 0) scores.Implementation++;
    const wt = r.workType || classifyWorkType(msg);
    if (wt === 'feature' || wt === 'refactor' || wt === 'test' || wt === 'config' || wt === 'style') scores.Implementation++;
  }

  let best: SessionIntent = 'Implementation';
  let max = 0;
  for (const intent of SESSION_INTENTS) {
    if (scores[intent] > max) { max = scores[intent]; best = intent; }
  }
  return best;
}

/* ════════════════════════════════════════════════════════════════════
   Spec-driven detection helpers
   ════════════════════════════════════════════════════════════════════ */

const SPEC_FILE_RE = /\.(md|txt|spec|prd|design|plan|rfc|adoc)$/i;
const SPEC_KEYWORD_RE = /\b(spec|requirements?|acceptance criteria|design doc|PRD|RFC|plan file|constraint|must|should|ensure)\b/i;

function isSpecDriven(session: Session): boolean {
  if (session.requests.length === 0) return false;
  const first = session.requests[0];
  // References a spec-like file
  if (first.referencedFiles.some(f => SPEC_FILE_RE.test(f))) return true;
  // First prompt has structured format
  const msg = first.messageText;
  if (SPEC_KEYWORD_RE.test(msg)) return true;
  if (/^[-*]\s/m.test(msg) && msg.split('\n').filter(l => l.trim()).length >= 3) return true;
  if (/^\d+[.)]\s/m.test(msg) && msg.split('\n').filter(l => l.trim()).length >= 3) return true;
  if (/^#+\s/m.test(msg)) return true;
  // Uses plan mode
  if (first.agentMode.includes('plan') || first.slashCommand === 'plan') return true;
  return false;
}

/* ════════════════════════════════════════════════════════════════════
   Prompt maturity helpers
   ════════════════════════════════════════════════════════════════════ */

const CONSTRAINT_RE = /\b(must|should|shall|only|no more than|at most|at least|limit|constraint|require|restrict)\b/i;
const SUCCESS_CRITERIA_RE = /\b(expect|success|criteria|acceptance|verify|assert|should return|should output|output should|result should)\b/i;
const VERIFICATION_RE = /\b(test|verify|validate|check|confirm|ensure|assert|prove)\b/i;

function gradePrompt(msg: string, hasFileRefs: boolean, hasCode: boolean): {
  constraints: number; successCriteria: number; verificationSteps: number;
  contextProvision: number; specificity: number; total: number;
  issues: string[];
} {
  const issues: string[] = [];
  const constraints = CONSTRAINT_RE.test(msg) ? 100 : 0;
  if (!constraints) issues.push('No constraints specified');

  const successCriteria = SUCCESS_CRITERIA_RE.test(msg) ? 100 : 0;
  if (!successCriteria) issues.push('No success criteria');

  const verificationSteps = VERIFICATION_RE.test(msg) ? 100 : 0;
  if (!verificationSteps) issues.push('No verification steps');

  let contextProvision = 0;
  if (hasFileRefs) contextProvision += 50;
  if (hasCode) contextProvision += 30;
  if (msg.split('\n').length >= 3) contextProvision += 20;
  if (contextProvision === 0) issues.push('No context provided (no file refs, no code)');

  let specificity = 0;
  if (msg.length >= 100) specificity += 40;
  else if (msg.length >= 50) specificity += 20;
  if (/^[-*]\s/m.test(msg) || /^\d+[.)]\s/m.test(msg)) specificity += 30;
  if (msg.split('\n').filter(l => l.trim()).length >= 4) specificity += 30;
  if (specificity === 0) issues.push('Very short/vague prompt');

  const total = Math.round((constraints + successCriteria + verificationSteps + contextProvision + specificity) / 5);
  return { constraints, successCriteria, verificationSteps, contextProvision, specificity, total, issues };
}

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

/* ════════════════════════════════════════════════════════════════════
   Trend direction helper
   ════════════════════════════════════════════════════════════════════ */

function trendDirection(values: number[]): 'stable' | 'increasing' | 'decreasing' {
  if (values.length < 3) return 'stable';
  const recent = values.slice(-3);
  const older = values.slice(-6, -3);
  if (older.length === 0) return 'stable';
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const change = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg : 0;
  if (change > 0.2) return 'increasing';
  if (change < -0.2) return 'decreasing';
  return 'stable';
}

/* ════════════════════════════════════════════════════════════════════
   Main Analyzer
   ════════════════════════════════════════════════════════════════════ */

export class InsightsAnalyzer extends AnalyzerBase {

  getInsights(f?: DateFilter): InsightsData {
    return {
      learningVelocity: this.getLearningVelocity(f),
      intentClassification: this.getIntentClassification(f),
      specDriven: this.getSpecDriven(f),
      productionReview: this.getProductionReview(f),
      sustainablePace: this.getSustainablePace(f),
      promptMaturity: this.getPromptMaturity(f),
      migrationReadiness: this.getMigrationReadiness(f),
    };
  }

  /* ── Learning Velocity ──────────────────────────────────────────── */

  private getLearningVelocity(f?: DateFilter): LearningVelocityData {
    const reqs = this.filter(f);
    // Group languages by week
    const weekLangs = new Map<string, Set<string>>();
    for (const r of reqs) {
      if (!r.timestamp) continue;
      const week = isoWeek(new Date(r.timestamp));
      if (!weekLangs.has(week)) weekLangs.set(week, new Set());
      const s = weekLangs.get(week)!;
      for (const block of r.aiCode) if (block.language) s.add(block.language.toLowerCase());
      for (const block of r.userCode) if (block.language) s.add(block.language.toLowerCase());
    }

    const sortedWeeks = Array.from(weekLangs.keys()).sort();
    const seenBefore = new Set<string>();
    const weeklyData: LearningVelocityData['weeklyLanguages'] = [];
    const newLangCounts: number[] = [];
    const cumulativeCounts: number[] = [];

    // Track first-seen per language
    const langFirstSeen = new Map<string, string>();
    const langWeekCount = new Map<string, number>();

    for (const week of sortedWeeks) {
      const langs = Array.from(weekLangs.get(week)!);
      const newLangs = langs.filter(l => !seenBefore.has(l));
      for (const l of newLangs) {
        if (!langFirstSeen.has(l)) langFirstSeen.set(l, week);
      }
      for (const l of langs) {
        langWeekCount.set(l, (langWeekCount.get(l) || 0) + 1);
        seenBefore.add(l);
      }
      weeklyData.push({ week, languages: langs, newLanguages: newLangs });
      newLangCounts.push(newLangs.length);
      cumulativeCounts.push(seenBefore.size);
    }

    const topLanguages = Array.from(langFirstSeen.entries())
      .map(([language, firstSeen]) => ({
        language,
        firstSeen,
        weekCount: langWeekCount.get(language) || 0,
      }))
      .sort((a, b) => b.weekCount - a.weekCount)
      .slice(0, 20);

    return {
      weeklyLanguages: weeklyData,
      totalLanguagesEncountered: seenBefore.size,
      totalNewLanguagesLearned: newLangCounts.reduce((a, b) => a + b, 0),
      velocityTrend: {
        labels: sortedWeeks,
        newLanguages: newLangCounts,
        cumulativeLanguages: cumulativeCounts,
      },
      topLanguages,
    };
  }

  /* ── Intent Classification ──────────────────────────────────────── */

  private getIntentClassification(f?: DateFilter): IntentClassificationData {
    const sessions = this.filteredSessions(f);
    const dist: Record<SessionIntent, number> = { Planning: 0, Implementation: 0, Debugging: 0, Review: 0, Exploration: 0 };
    const reqsByIntent: Record<SessionIntent, number[]> = { Planning: [], Implementation: [], Debugging: [], Review: [], Exploration: [] };
    const weeklyBuckets = new Map<string, Record<SessionIntent, number>>();

    const sessionIntents: IntentClassificationData['sessionIntents'] = [];
    for (const s of sessions) {
      const intent = classifyIntent(s);
      dist[intent]++;
      reqsByIntent[intent].push(s.requestCount);

      const ts = s.lastMessageDate || s.creationDate;
      const date = ts != null ? toDateStr(ts) : '';
      sessionIntents.push({
        sessionId: s.sessionId,
        workspaceName: s.workspaceName,
        intent,
        requestCount: s.requestCount,
        date,
      });

      if (ts != null) {
        const week = isoWeek(new Date(ts));
        if (!weeklyBuckets.has(week)) {
          weeklyBuckets.set(week, { Planning: 0, Implementation: 0, Debugging: 0, Review: 0, Exploration: 0 });
        }
        weeklyBuckets.get(week)![intent]++;
      }
    }

    const sortedWeeks = Array.from(weeklyBuckets.keys()).sort();
    const series: Record<SessionIntent, number[]> = { Planning: [], Implementation: [], Debugging: [], Review: [], Exploration: [] };
    for (const week of sortedWeeks) {
      const d = weeklyBuckets.get(week)!;
      for (const intent of SESSION_INTENTS) series[intent].push(d[intent]);
    }

    const avgByIntent: Record<SessionIntent, number> = {} as Record<SessionIntent, number>;
    for (const intent of SESSION_INTENTS) {
      const arr = reqsByIntent[intent];
      avgByIntent[intent] = arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    }

    return {
      sessionIntents,
      distribution: dist,
      weeklyDistribution: { labels: sortedWeeks, series },
      avgRequestsByIntent: avgByIntent,
    };
  }

  /* ── Spec-Driven Flag ───────────────────────────────────────────── */

  private getSpecDriven(f?: DateFilter): SpecDrivenData {
    const sessions = this.filteredSessions(f).filter(s => s.requestCount >= 3);
    const specDriven = sessions.filter(isSpecDriven);
    const weekBuckets = new Map<string, { spec: number; unstructured: number }>();

    for (const s of sessions) {
      const ts = s.lastMessageDate || s.creationDate;
      if (ts == null) continue;
      const week = isoWeek(new Date(ts));
      if (!weekBuckets.has(week)) weekBuckets.set(week, { spec: 0, unstructured: 0 });
      const b = weekBuckets.get(week)!;
      if (isSpecDriven(s)) b.spec++; else b.unstructured++;
    }

    const sortedWeeks = Array.from(weekBuckets.keys()).sort();
    const unstructuredExamples = sessions
      .filter(s => !isSpecDriven(s))
      .slice(0, 10)
      .map(s => ({
        workspaceName: s.workspaceName,
        firstPrompt: s.requests[0]?.messageText.substring(0, 120) || '',
        date: s.lastMessageDate != null ? toDateStr(s.lastMessageDate) : '',
      }));

    return {
      totalSessions: sessions.length,
      specDrivenCount: specDriven.length,
      specDrivenRate: sessions.length > 0 ? specDriven.length / sessions.length : 0,
      weeklyTrend: {
        labels: sortedWeeks,
        specDriven: sortedWeeks.map(w => weekBuckets.get(w)!.spec),
        unstructured: sortedWeeks.map(w => weekBuckets.get(w)!.unstructured),
      },
      unstructuredExamples,
    };
  }

  /* ── Production vs Review Ratio ─────────────────────────────────── */

  private getProductionReview(f?: DateFilter): ProductionReviewData {
    const sessions = this.filteredSessions(f);
    let totalAiLoc = 0;
    let reviewedLoc = 0;
    const reviewGaps: number[] = [];
    let sessionsNoReview = 0;

    const weekBuckets = new Map<string, { produced: number; reviewed: number }>();

    for (const s of sessions) {
      let sessionReviewedLoc = 0;
      let sessionAiLoc = 0;
      const ts = s.lastMessageDate || s.creationDate;
      const week = ts != null ? isoWeek(new Date(ts)) : null;
      if (week && !weekBuckets.has(week)) weekBuckets.set(week, { produced: 0, reviewed: 0 });

      for (let i = 0; i < s.requests.length; i++) {
        const r = s.requests[i];
        const aiLoc = r.aiCode.reduce((sum, b) => sum + b.loc, 0);
        sessionAiLoc += aiLoc;

        const gap = aiLoc > 0 && i < s.requests.length - 1
          ? this.getReviewGap(r, s.requests[i + 1])
          : null;
        if (gap != null && gap >= REVIEW_GAP_THRESHOLD_MS) {
          sessionReviewedLoc += aiLoc;
          reviewGaps.push(gap);
        }
      }

      totalAiLoc += sessionAiLoc;
      reviewedLoc += sessionReviewedLoc;
      if (sessionAiLoc > 0 && sessionReviewedLoc === 0) sessionsNoReview++;

      if (week) {
        const b = weekBuckets.get(week)!;
        b.produced += sessionAiLoc;
        b.reviewed += sessionReviewedLoc;
      }
    }

    const sortedWeeks = Array.from(weekBuckets.keys()).sort();
    const avgGap = reviewGaps.length > 0
      ? Math.round(reviewGaps.reduce((a, b) => a + b, 0) / reviewGaps.length / 1000)
      : 0;

    return {
      totalAiLoc,
      estimatedReviewedLoc: reviewedLoc,
      reviewRatio: totalAiLoc > 0 ? reviewedLoc / totalAiLoc : 0,
      weeklyTrend: {
        labels: sortedWeeks,
        produced: sortedWeeks.map(w => weekBuckets.get(w)!.produced),
        estimated_reviewed: sortedWeeks.map(w => weekBuckets.get(w)!.reviewed),
      },
      sessionsWithoutReview: sessionsNoReview,
      avgReviewGapSec: avgGap,
    };
  }

  /* ── Sustainable Pace ───────────────────────────────────────────── */

  private getSustainablePace(f?: DateFilter): SustainablePaceData {
    const reqs = this.filter(f);
    const sessions = this.filteredSessions(f);
    const weekBuckets = this.buildSustainablePaceBuckets(reqs, sessions);
    const sortedWeeks = Array.from(weekBuckets.keys()).sort();
    const lateNightReqs = sortedWeeks.map(w => weekBuckets.get(w)!.lateNight);
    const weekendReqs = sortedWeeks.map(w => weekBuckets.get(w)!.weekend);
    const totalReqs = sortedWeeks.map(w => weekBuckets.get(w)!.total);
    const avgSessionLength = sortedWeeks.map(w => {
      const lengths = weekBuckets.get(w)!.sessionLengths;
      return lengths.length > 0 ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
    });
    const currentStreak = this.getCurrentActiveDayStreak(reqs);
    const lateNightTrending = trendDirection(lateNightReqs);
    const weekendTrending = trendDirection(weekendReqs);
    const alerts = this.getSustainablePaceAlerts(reqs, currentStreak, lateNightReqs, weekendReqs, lateNightTrending, weekendTrending);

    return {
      weeklyTrend: { labels: sortedWeeks, lateNightReqs, weekendReqs, totalReqs, avgSessionLength },
      burnoutRisk: this.getBurnoutRisk(alerts, currentStreak, lateNightTrending),
      alerts,
      currentStreak,
      weekendTrending,
      lateNightTrending,
    };
  }

  /* ── Prompt Engineering Maturity ────────────────────────────────── */

  private getPromptMaturity(f?: DateFilter): PromptMaturityData {
    const reqs = this.filter(f).filter(r => r.messageLength > 10);
    if (reqs.length === 0) {
      return {
        overallGrade: 'F', score: 0,
        dimensions: { constraints: 0, successCriteria: 0, verificationSteps: 0, contextProvision: 0, specificity: 0 },
        weeklyTrend: { labels: [], scores: [] },
        samplePrompts: [],
      };
    }

    // Sample prompts evenly
    const step = Math.max(1, Math.floor(reqs.length / PROMPT_MATURITY_SAMPLE_SIZE));
    const sampled = reqs.filter((_, i) => i % step === 0).slice(0, PROMPT_MATURITY_SAMPLE_SIZE);

    const totals = { constraints: 0, successCriteria: 0, verificationSteps: 0, contextProvision: 0, specificity: 0 };

    const graded = sampled.map(r => {
      const hasFileRefs = r.referencedFiles.length > 0 || (r.variableKinds['file'] > 0);
      const hasCode = r.userCode.length > 0;
      const g = gradePrompt(r.messageText, hasFileRefs, hasCode);
      totals.constraints += g.constraints;
      totals.successCriteria += g.successCriteria;
      totals.verificationSteps += g.verificationSteps;
      totals.contextProvision += g.contextProvision;
      totals.specificity += g.specificity;
      return { text: r.messageText.substring(0, 150), grade: scoreToGrade(g.total), issues: g.issues, total: g.total, timestamp: r.timestamp };
    });

    const n = sampled.length;
    const dims = {
      constraints: Math.round(totals.constraints / n),
      successCriteria: Math.round(totals.successCriteria / n),
      verificationSteps: Math.round(totals.verificationSteps / n),
      contextProvision: Math.round(totals.contextProvision / n),
      specificity: Math.round(totals.specificity / n),
    };
    const overall = Math.round((dims.constraints + dims.successCriteria + dims.verificationSteps + dims.contextProvision + dims.specificity) / 5);

    // Weekly trend
    const weekScores = new Map<string, number[]>();
    for (const r of reqs) {
      if (!r.timestamp) continue;
      const week = isoWeek(new Date(r.timestamp));
      if (!weekScores.has(week)) weekScores.set(week, []);
      const hasFileRefs = r.referencedFiles.length > 0 || (r.variableKinds['file'] > 0);
      const hasCode = r.userCode.length > 0;
      weekScores.get(week)!.push(gradePrompt(r.messageText, hasFileRefs, hasCode).total);
    }
    const sortedWeeks = Array.from(weekScores.keys()).sort();
    const weeklyScores = sortedWeeks.map(w => {
      const arr = weekScores.get(w)!;
      return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    });

    // Pick worst prompts as examples
    const samplePrompts = graded
      .sort((a, b) => a.total - b.total)
      .slice(0, 5)
      .map(g => ({ text: g.text, grade: g.grade, issues: g.issues }));

    return {
      overallGrade: scoreToGrade(overall),
      score: overall,
      dimensions: dims,
      weeklyTrend: { labels: sortedWeeks, scores: weeklyScores },
      samplePrompts,
    };
  }

  /* ── Migration Readiness ────────────────────────────────────────── */

  private getMigrationReadiness(f?: DateFilter): MigrationReadinessData {
    const sessions = this.filteredSessions(f);
    if (sessions.length === 0) {
      return { primaryHarness: '', missingFeatures: [], readinessScore: 0, featureUsage: [] };
    }

    const harnessCounts = new Map<string, number>();
    for (const session of sessions) harnessCounts.set(session.harness, (harnessCounts.get(session.harness) || 0) + 1);
    const sortedHarnesses = Array.from(harnessCounts.entries()).sort((a, b) => b[1] - a[1]);
    const primaryHarness = sortedHarnesses[0][0];
    const allHarnesses = sortedHarnesses.map(([harness]) => harness);
    const featureMatrix = this.getMigrationFeatureMatrix();
    const usedFeatures = this.getUsedMigrationFeatures(this.filter(f), sessions);
    const missingFeatures = featureMatrix
      .filter(feature => !usedFeatures.has(feature.feature))
      .map(feature => ({
        feature: feature.feature,
        availableIn: feature.harnesses.filter(harness => harness !== primaryHarness && allHarnesses.includes(harness)),
        description: feature.description,
      }))
      .filter(feature => feature.availableIn.length > 0);
    const featureUsage = featureMatrix
      .filter(feature => feature.harnesses.some(harness => allHarnesses.includes(harness)))
      .map(feature => ({
        feature: feature.feature,
        used: usedFeatures.has(feature.feature),
        harnesses: feature.harnesses.filter(harness => allHarnesses.includes(harness)),
      }));
    const readinessScore = featureMatrix.length > 0 ? Math.round((usedFeatures.size / featureMatrix.length) * 100) : 0;

    return { primaryHarness, missingFeatures, readinessScore, featureUsage };
  }

  private getReviewGap(current: Session['requests'][number], next: Session['requests'][number]): number | null {
    if (!current.timestamp || !next.timestamp || !current.totalElapsed) return null;
    return next.timestamp - (current.timestamp + current.totalElapsed);
  }

  private buildSustainablePaceBuckets(
    reqs: Session['requests'],
    sessions: Session[],
  ): Map<string, { total: number; lateNight: number; weekend: number; sessionLengths: number[] }> {
    const weekBuckets = new Map<string, { total: number; lateNight: number; weekend: number; sessionLengths: number[] }>();
    for (const request of reqs) {
      if (!request.timestamp) continue;
      const date = new Date(request.timestamp);
      const week = isoWeek(date);
      if (!weekBuckets.has(week)) weekBuckets.set(week, { total: 0, lateNight: 0, weekend: 0, sessionLengths: [] });
      const bucket = weekBuckets.get(week)!;
      bucket.total++;
      const hour = date.getHours();
      if (hour >= LATE_NIGHT_START || hour < LATE_NIGHT_END) bucket.lateNight++;
      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) bucket.weekend++;
    }
    for (const session of sessions) {
      const ts = session.lastMessageDate || session.creationDate;
      if (ts == null) continue;
      const week = isoWeek(new Date(ts));
      if (!weekBuckets.has(week)) weekBuckets.set(week, { total: 0, lateNight: 0, weekend: 0, sessionLengths: [] });
      weekBuckets.get(week)!.sessionLengths.push(session.requestCount);
    }
    return weekBuckets;
  }

  private getCurrentActiveDayStreak(reqs: Session['requests']): number {
    const activeDays = new Set<string>();
    for (const request of reqs) {
      if (request.timestamp) activeDays.add(toDateStr(request.timestamp));
    }
    const sortedDays = Array.from(activeDays).sort().reverse();
    let currentStreak = 0;
    let checkDate = toDateStr(Date.now());
    for (const day of sortedDays) {
      if (day !== checkDate) break;
      currentStreak++;
      const date = new Date(checkDate + 'T00:00:00');
      date.setDate(date.getDate() - 1);
      checkDate = toDateStr(date.getTime());
    }
    return currentStreak;
  }

  private getSustainablePaceAlerts(
    reqs: Session['requests'],
    currentStreak: number,
    lateNightReqs: number[],
    weekendReqs: number[],
    lateNightTrending: 'stable' | 'increasing' | 'decreasing',
    weekendTrending: 'stable' | 'increasing' | 'decreasing',
  ): string[] {
    const alerts: string[] = [];
    if (currentStreak >= BURNOUT_STREAK_DAYS) {
      alerts.push(`Working ${currentStreak} consecutive days without a break. Consider taking a day off.`);
    }
    if (lateNightTrending === 'increasing') {
      alerts.push('Late-night sessions are increasing week over week. This is a burnout risk factor.');
    }
    if (weekendTrending === 'increasing') {
      alerts.push('Weekend work is creeping up. Monitor your work-life boundaries.');
    }

    const totalReqs = reqs.length;
    const lateNightRate = totalReqs > 0 ? lateNightReqs.reduce((a, b) => a + b, 0) / totalReqs : 0;
    const weekendRate = totalReqs > 0 ? weekendReqs.reduce((a, b) => a + b, 0) / totalReqs : 0;
    if (lateNightRate > BURNOUT_LATE_NIGHT_RATE) {
      alerts.push(`${(lateNightRate * 100).toFixed(0)}% of requests happen during late-night hours (${LATE_NIGHT_START}:00-${LATE_NIGHT_END}:00).`);
    }
    if (weekendRate > BURNOUT_WEEKEND_RATE) {
      alerts.push(`${(weekendRate * 100).toFixed(0)}% of requests happen on weekends.`);
    }
    return alerts;
  }

  private getBurnoutRisk(
    alerts: string[],
    currentStreak: number,
    lateNightTrending: 'stable' | 'increasing' | 'decreasing',
  ): 'low' | 'medium' | 'high' {
    if (alerts.length >= 3 || (currentStreak >= BURNOUT_STREAK_DAYS && lateNightTrending === 'increasing')) {
      return 'high';
    }
    if (alerts.length >= 1) return 'medium';
    return 'low';
  }

  private getMigrationFeatureMatrix(): Array<{ feature: string; description: string; harnesses: string[] }> {
    return [
      { feature: 'Sub-agents', description: 'Delegate sub-tasks to specialized agents', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude'] },
      { feature: 'MCP Tools', description: 'Model Context Protocol tool integration', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude'] },
      { feature: 'Custom Instructions', description: 'Project-level AI instructions (.instructions.md)', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude'] },
      { feature: 'Plan Mode', description: 'Separate planning step before implementation', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude'] },
      { feature: 'Skills', description: 'Domain-specific knowledge modules', harnesses: ['Local Agent', 'Local Agent (Insiders)'] },
      { feature: 'Slash Commands', description: '/fix, /explain, /tests, /doc', harnesses: ['Local Agent', 'Local Agent (Insiders)'] },
      { feature: 'Multi-file Edits', description: 'Edit multiple files in a single turn', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude', 'Codex', 'Pi Coding Agent'] },
      { feature: 'Terminal Access', description: 'Run commands as part of agent workflow', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude', 'Codex', 'OpenCode', 'Pi Coding Agent'] },
      { feature: 'File References', description: 'Reference specific files in prompts', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude'] },
      { feature: 'Parallel Sessions', description: 'Run multiple conversations simultaneously', harnesses: ['Local Agent', 'Local Agent (Insiders)', 'Claude', 'Codex', 'Pi Coding Agent'] },
    ];
  }

  private getUsedMigrationFeatures(reqs: Session['requests'], sessions: Session[]): Set<string> {
    const usedFeatures = new Set<string>();
    for (const request of reqs) {
      if (request.agentName && request.agentName !== 'copilot') usedFeatures.add('Sub-agents');
      if (request.toolsUsed.some(tool => tool.startsWith('mcp_'))) usedFeatures.add('MCP Tools');
      if (request.customInstructions.length > 0) usedFeatures.add('Custom Instructions');
      if (request.agentMode.includes('plan') || request.slashCommand === 'plan') usedFeatures.add('Plan Mode');
      if (request.skillsUsed.length > 0) usedFeatures.add('Skills');
      if (request.slashCommand) usedFeatures.add('Slash Commands');
      if (request.editedFiles.length > 1) usedFeatures.add('Multi-file Edits');
      if (request.toolsUsed.some(tool => tool.includes('terminal') || tool.includes('runCommand'))) usedFeatures.add('Terminal Access');
      if (request.referencedFiles.length > 0 || (request.variableKinds['file'] > 0)) usedFeatures.add('File References');
    }
    const daySessions = new Map<string, number>();
    for (const session of sessions) {
      const ts = session.lastMessageDate || session.creationDate;
      if (ts == null) continue;
      const day = toDateStr(ts);
      daySessions.set(day, (daySessions.get(day) || 0) + 1);
    }
    if (Array.from(daySessions.values()).some(count => count >= 2)) usedFeatures.add('Parallel Sessions');
    return usedFeatures;
  }
}
