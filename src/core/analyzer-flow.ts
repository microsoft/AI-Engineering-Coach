/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Flow State analyzer -- measures developer flow depth per session and per day */

import { DateFilter, Session, SessionRequest, FlowSession, FlowDay, FlowStateData } from './types';
import { toDateStr, isoWeek } from './helpers';
import { humanFollowUpGaps, isHumanTurn } from './human-turns';
import {
  FLOW_RAPID_FOLLOWUP_SEC, FLOW_SESSION_MIN_REQS,
  FLOW_BLOCK_GAP_MIN, FLOW_DEEP_SCORE, FLOW_MODERATE_SCORE,
  FLOW_SHALLOW_SCORE,
} from './constants';
import { AnalyzerBase } from './analyzer-base';

/* ── Helpers ──────────────────────────────────────────────────────── */

function flowLabel(score: number): FlowSession['flowLabel'] {
  if (score >= FLOW_DEEP_SCORE) return 'deep';
  if (score >= FLOW_MODERATE_SCORE) return 'moderate';
  if (score >= FLOW_SHALLOW_SCORE) return 'shallow';
  return 'fragmented';
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Compute flow score for a session based on follow-up latencies and session structure.
 *  0-100 where 100 = perfect deep flow.
 *
 *  Components:
 *  - rapidRate (40%): fraction of follow-ups under 30s → rapid iteration = flow
 *  - medianLatency (30%): lower median latency = deeper flow (0 at 5min+, 100 at <10s)
 *  - sessionLength (15%): longer sustained sessions = flow (peaks at ~40 min)
 *  - requestDensity (15%): more requests per minute = engaged flow */
function computeSessionFlowScore(
  followUpGaps: number[], durationMin: number, requestCount: number,
): number {
  if (followUpGaps.length === 0) return 0;

  // Rapid follow-up rate (gaps under threshold)
  const rapidCount = followUpGaps.filter(g => g <= FLOW_RAPID_FOLLOWUP_SEC).length;
  const rapidRate = rapidCount / followUpGaps.length;
  const rapidScore = Math.min(100, rapidRate * 100);

  // Median latency score (inverse — lower is better)
  const med = median(followUpGaps);
  const latencyScore = med <= 10 ? 100 : med <= 30 ? 80 : med <= 60 ? 60 : med <= 120 ? 40 : med <= 300 ? 20 : 0;

  // Session duration score (peaks at ~40 min, drops off above 120)
  let durationScore: number;
  if (durationMin <= 5) durationScore = 20;
  else if (durationMin <= 15) durationScore = 50;
  else if (durationMin <= 40) durationScore = 90;
  else if (durationMin <= 90) durationScore = 80;
  else durationScore = 60; // very long sessions may be unfocused

  // Request density (requests per minute, capped at 2/min = 100)
  const rpm = durationMin > 0 ? requestCount / durationMin : 0;
  const densityScore = Math.min(100, rpm * 50);

  return Math.round(rapidScore * 0.4 + latencyScore * 0.3 + durationScore * 0.15 + densityScore * 0.15);
}

/* ── FlowAnalyzer ─────────────────────────────────────────────────── */

export class FlowAnalyzer extends AnalyzerBase {

  getFlowState(f?: DateFilter): FlowStateData {
    const flowSessions = this.filteredSessions(f)
      .map(session => this.buildFlowSession(session, f))
      .filter((session): session is FlowSession => session !== null);
    const days = this.buildFlowDays(flowSessions);
    const totalDays = days.length;
    const deepFlowDays = days.filter(d => d.flowLabel === 'deep').length;
    const allFollowUps = flowSessions.map(s => s.medianFollowUpSec);
    const avgFollowUpSec = allFollowUps.length > 0 ? Math.round(allFollowUps.reduce((s, v) => s + v, 0) / allFollowUps.length) : 0;
    const allBlocks = days.map(d => d.longestBlockMin);
    const avgBlockMin = allBlocks.length > 0 ? Math.round(allBlocks.reduce((s, v) => s + v, 0) / allBlocks.length) : 0;
    const overallFlowScore = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.avgFlowScore, 0) / days.length) : 0;
    const weeklyTrend = this.buildWeeklyTrend(days);
    const hourlyFlow = this.buildHourlyFlow(flowSessions);
    const suggestions = generateFlowSuggestions(days, flowSessions, hourlyFlow, overallFlowScore);

    return {
      days,
      overallFlowScore,
      avgFollowUpSec,
      avgBlockMin,
      deepFlowDays,
      totalDays,
      weeklyTrend,
      hourlyFlow,
      suggestions,
    };
  }

  private buildFlowSession(session: Session, f?: DateFilter): FlowSession | null {
    const timedReqs = session.requests.filter(r => r.timestamp != null);
    timedReqs.sort((a, b) => a.timestamp! - b.timestamp!);
    // Flow is the user's: count the prompts they typed. Automated turns only extend the assistant's work.
    const typed = timedReqs.filter(isHumanTurn);
    if (typed.length < FLOW_SESSION_MIN_REQS) return null;
    if (!this.matchesDateRange(typed, f)) return null;

    const startTs = typed[0].timestamp!;
    const endTs = typed[typed.length - 1].timestamp!;
    const durationMin = (endTs - startTs) / 60_000;
    const followUpGaps = this.getFollowUpGaps(timedReqs);
    const medianFollowUpSec = median(followUpGaps);
    const rapidFollowUpRate = followUpGaps.length > 0
      ? followUpGaps.filter(g => g <= FLOW_RAPID_FOLLOWUP_SEC).length / followUpGaps.length
      : 0;
    const flowScore = computeSessionFlowScore(followUpGaps, durationMin, typed.length);

    return {
      sessionId: session.sessionId,
      workspaceName: session.workspaceName,
      harness: session.harness,
      date: toDateStr(startTs),
      startTs,
      endTs,
      durationMin: Math.round(durationMin * 10) / 10,
      requestCount: typed.length,
      medianFollowUpSec: Math.round(medianFollowUpSec),
      rapidFollowUpRate: Math.round(rapidFollowUpRate * 100) / 100,
      flowScore,
      flowLabel: flowLabel(flowScore),
    };
  }

  private matchesDateRange(timedReqs: Array<{ timestamp: number | null }>, f?: DateFilter): boolean {
    if (f?.fromDate && timedReqs.every(r => toDateStr(r.timestamp!) < f.fromDate!)) return false;
    if (f?.toDate && timedReqs.every(r => toDateStr(r.timestamp!) > f.toDate!)) return false;
    return true;
  }

  /** Seconds from the end of the assistant's work to each prompt the user typed (see humanFollowUpGaps). */
  private getFollowUpGaps(timedReqs: SessionRequest[]): number[] {
    return humanFollowUpGaps(timedReqs, r => r.timestamp!, r => r.timestamp! + (r.totalElapsed || 0), isHumanTurn)
      .map(gapMs => gapMs / 1000)
      .filter(gapSec => gapSec >= 0);
  }

  private buildFlowDays(flowSessions: FlowSession[]): FlowDay[] {
    const dayMap = new Map<string, FlowSession[]>();
    for (const flowSession of flowSessions) {
      const arr = dayMap.get(flowSession.date) ?? [];
      arr.push(flowSession);
      dayMap.set(flowSession.date, arr);
    }

    const days = Array.from(dayMap.entries()).map(([date, daySessions]) => {
      const blocks = this.buildBlocks(daySessions);
      const longestBlockMin = Math.round(Math.max(...blocks.map(b => (b.end - b.start) / 60_000)));
      const totalHours = Math.round(blocks.reduce((sum, block) => sum + (block.end - block.start), 0) / 3_600_000 * 10) / 10;
      const avgFlowScore = Math.round(daySessions.reduce((sum, flowSession) => sum + flowSession.flowScore, 0) / daySessions.length);

      return {
        date,
        longestBlockMin,
        totalHours,
        blockCount: blocks.length,
        avgFlowScore,
        flowLabel: flowLabel(avgFlowScore),
        sessions: daySessions,
      };
    });

    days.sort((a, b) => a.date.localeCompare(b.date));
    return days;
  }

  private buildBlocks(daySessions: FlowSession[]): Array<{ start: number; end: number }> {
    const sorted = [...daySessions].sort((a, b) => a.startTs - b.startTs);
    const blocks: Array<{ start: number; end: number }> = [];
    let currentBlock = { start: sorted[0].startTs, end: sorted[0].endTs };

    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].startTs - currentBlock.end) / 60_000;
      if (gap > FLOW_BLOCK_GAP_MIN) {
        blocks.push(currentBlock);
        currentBlock = { start: sorted[i].startTs, end: sorted[i].endTs };
      } else {
        currentBlock.end = Math.max(currentBlock.end, sorted[i].endTs);
      }
    }
    blocks.push(currentBlock);
    return blocks;
  }

  private buildWeeklyTrend(days: FlowDay[]): FlowStateData['weeklyTrend'] {
    const weekMap = new Map<string, { total: number; count: number }>();
    for (const day of days) {
      const wk = isoWeek(new Date(day.date));
      const entry = weekMap.get(wk) ?? { total: 0, count: 0 };
      entry.total += day.avgFlowScore;
      entry.count++;
      weekMap.set(wk, entry);
    }
    const labels = Array.from(weekMap.keys()).sort();
    const scores = labels.map(label => Math.round(weekMap.get(label)!.total / weekMap.get(label)!.count));
    return { labels, scores };
  }

  private buildHourlyFlow(flowSessions: FlowSession[]): number[] {
    const hourTotals = Array<number>(24).fill(0);
    const hourCounts = Array<number>(24).fill(0);
    for (const flowSession of flowSessions) {
      const hour = new Date(flowSession.startTs).getHours();
      hourTotals[hour] += flowSession.flowScore;
      hourCounts[hour]++;
    }
    return hourTotals.map((total, index) => hourCounts[index] > 0 ? Math.round(total / hourCounts[index]) : 0);
  }
}

/* ── Suggestion generation ────────────────────────────────────────── */

function generateFlowSuggestions(
  days: FlowDay[], sessions: FlowSession[], hourlyFlow: number[], overallScore: number,
): string[] {
  const suggestions: string[] = [];

  // Best hours
  const peakHour = hourlyFlow.indexOf(Math.max(...hourlyFlow));
  const peakScore = hourlyFlow[peakHour];
  if (peakScore > 0) {
    suggestions.push(`Your deepest flow tends to happen around ${peakHour}:00 (score ${peakScore}). Block this time for uninterrupted work.`);
  }

  // Short blocks
  const shortBlockDays = days.filter(d => d.longestBlockMin < 30 && d.blockCount > 2);
  if (shortBlockDays.length > days.length * 0.3) {
    suggestions.push(`${shortBlockDays.length} days had no work block longer than 30 minutes. Meeting-heavy days fragment flow. Try batching meetings.`);
  }

  // Fragmented sessions
  const fragmented = sessions.filter(s => s.flowLabel === 'fragmented');
  if (fragmented.length > sessions.length * 0.3) {
    suggestions.push(`${fragmented.length} sessions were fragmented (long pauses between prompts). Close distractions — Slack, email, tabs — during coding sessions.`);
  }

  // High follow-up latency
  const slowSessions = sessions.filter(s => s.medianFollowUpSec > 120);
  if (slowSessions.length > sessions.length * 0.2) {
    suggestions.push(`${slowSessions.length} sessions had >2 minute median follow-up time. Pre-plan your next prompt while the agent works.`);
  }

  // Overall score
  if (overallScore < FLOW_MODERATE_SCORE) {
    suggestions.push('Your overall flow score is low. The #1 lever: protect 2-hour uninterrupted blocks. Even one per day transforms output.');
  } else if (overallScore >= FLOW_DEEP_SCORE) {
    suggestions.push('Strong flow patterns detected. Maintain your current work blocks and keep distractions at bay.');
  }

  // Deep flow days
  const deepDays = days.filter(d => d.flowLabel === 'deep');
  if (deepDays.length > 0 && days.length > 0) {
    const deepPct = Math.round((deepDays.length / days.length) * 100);
    if (deepPct < 30) {
      suggestions.push(`Only ${deepPct}% of your days reach deep flow. Aim for at least 3 deep-flow days per week.`);
    }
  }

  return suggestions.slice(0, 5);
}
