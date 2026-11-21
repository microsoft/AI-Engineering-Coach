/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline + session detail analytics */

import {
  Session, SessionRequest, DateFilter, SessionList, SessionListItem, WorkLifeBalanceResult,
  NonHumanKind, TimelineDataset, TimelineSessionRecord, TimelineTurn, TurnSender,
} from './types';
import { toDateStr, isoWeek } from './helpers';
import { AnalyzerBase } from './analyzer-base';
import { harnessLabel, scrubBranch, scrubLabel, scrubRepository, type ScrubContext } from './session-labels';
import { localScrubContext } from './session-workspace-meta';
import { resolveForkLinks, resolveParentLinks, type ForkLink, type ParentLink } from './timeline-links';

/** The sender marker a turn gets on the Timeline. */
export function turnSender(kind: NonHumanKind | undefined): TurnSender {
  if (!kind) return 'you';
  if (kind === 'agent' || kind === 'relayed' || kind === 'subagent') return 'agent';
  if (kind === 'autopilot') return 'autopilot';
  if (kind === 'compaction') return 'compaction';
  return 'other';
}

/** Claude Code's sub-agent tool (`Agent`, `Task` before): each call runs a sub-agent in a sidechain transcript. */
const CLAUDE_SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

function timelineTurn(r: SessionRequest): TimelineTurn {
  const t = r.timestamp ?? 0;
  const d = Math.max(0, r.totalElapsed ?? 0);
  const waits = (r.userWaits ?? []).filter(w => w.end > w.start).map(w => ({ s: w.start, e: w.end, k: w.kind }));
  return {
    t,
    d,
    k: turnSender(r.nonHumanKind),
    sub: r.subagentRuns?.length ?? (r.agentName === 'Claude' ? r.toolsUsed.filter(t => CLAUDE_SUBAGENT_TOOLS.has(t)).length : 0),
    comp: Boolean(r.compaction || r.compactions?.length),
    cr: r.aiCredits ?? 0,
    tok: r.loggedTokens ?? Math.max(0, (r.promptTokens ?? 0) + (r.completionTokens ?? 0)),
    ...(r.totalElapsed == null ? { noDuration: true } : {}),
    ...(waits.length ? { w: waits } : {}),
  };
}

/** The model most of the turns used, ignoring placeholders such as `<synthetic>`. */
function mainModel(requests: readonly SessionRequest[]): string {
  const counts = new Map<string, number>();
  for (const r of requests) if (r.modelId && !r.modelId.startsWith('<')) counts.set(r.modelId, (counts.get(r.modelId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

/** A linked fork's source (when it has turns in range) and how many prompts it copied from it. */
function forkFields(link: ForkLink | undefined, index: ReadonlyMap<string, number>, copied: number): Pick<TimelineSessionRecord, 'fork' | 'copiedTurns'> {
  if (!link) return {};
  return { fork: index.get(link.source) ?? -1, ...(copied > 0 ? { copiedTurns: copied } : {}) };
}

export class TimelineAnalyzer extends AnalyzerBase {
  private links?: Map<string, ParentLink>;
  private forks?: Map<string, ForkLink>;

  /** Every session with a turn in range, with its turns as counts and timings, its family link, and its logged
   *  name, branch and repository (never a path). No prompt or response text. */
  getTimelineData(f?: DateFilter, labels: ScrubContext = localScrubContext()): TimelineDataset {
    this.links ??= resolveParentLinks(this.sessions);
    this.forks ??= resolveForkLinks(this.sessions);
    const forks = this.forks;
    const inRange = this.sessionsWithRequestsInRange(f)
      .map(s => {
        const copied = forks.get(s.sessionId)?.copied;
        return { s, requests: s.requests.filter(r => this.requestInRange(r, f) && !(r.userEventId && copied?.has(r.userEventId))).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)) };
      })
      .filter(({ requests }) => requests.length > 0)
      .sort((a, b) => (a.requests[0].timestamp ?? 0) - (b.requests[0].timestamp ?? 0) || a.s.sessionId.localeCompare(b.s.sessionId));
    const index = new Map(inRange.map(({ s }, i) => [s.sessionId, i]));
    const sessions: TimelineSessionRecord[] = inRange.map(({ s, requests }) => {
      const link = this.links?.get(s.sessionId);
      const parent = link ? index.get(link.parent) ?? -1 : -1;
      return {
        id: s.sessionId,
        name: s.displayName ? scrubLabel(s.displayName, labels) : '',
        branch: s.branch ? scrubBranch(s.branch, labels) : '',
        repo: scrubRepository(s.repository || s.workspaceName || '', labels),
        harness: harnessLabel(s.harness),
        model: mainModel(requests),
        parent,
        via: parent >= 0 && link ? link.via : null,
        ...forkFields(forks.get(s.sessionId), index, s.requests.length - s.requests.filter(r => !(r.userEventId && forks.get(s.sessionId)?.copied.has(r.userEventId))).length),
        turns: requests.map(timelineTurn),
      };
    });
    return { sessions, forkedSessions: inRange.filter(({ s }) => (s.forkCount ?? 0) > 0).length };
  }

  getSessions(page: number, pageSize: number, f?: DateFilter, search?: string): SessionList {
    let filtered = this.filteredSessions(f);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(s =>
        s.workspaceName.toLowerCase().includes(q) ||
        s.requests.some(r => r.messageText.toLowerCase().includes(q))
      );
    }
    filtered.sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);

    const sessions: SessionListItem[] = slice.map(s => ({
      sessionId: s.sessionId,
      workspaceName: s.workspaceName,
      workspaceId: s.workspaceId,
      creationDate: s.creationDate,
      lastMessageDate: s.lastMessageDate,
      requestCount: s.requestCount,
      firstMessage: s.requests[0]?.messageText?.substring(0, 120) || '',
    }));

    return { total, page, pageSize, sessions };
  }

  getSessionDetail(sessionId: string): Session | null {
    return this.sessions.find(s => s.sessionId === sessionId) || null;
  }

  /** The user's working hours, days and streaks, from the turns they typed (automated turns are left out). */
  getWorkLifeBalance(f?: DateFilter): WorkLifeBalanceResult | null {
    const { reqs, basis } = this.humanFilter(f);
    if (reqs.length === 0) return null;

    const timeDist = computeTimeDistribution(reqs);
    const streaks = computeStreaks(timeDist.sortedDays);
    const daySpans = computeDaySpans(reqs);
    const weeklyTrend = computeWeeklyVolume(reqs);
    const score = computeBalanceScore(timeDist, streaks, daySpans.avgSpan);

    return {
      score,
      totalRequests: reqs.length,
      weekdayReqs: timeDist.weekdayReqs,
      weekendReqs: timeDist.weekendReqs,
      weekendRatio: timeDist.weekendRatio,
      timeDistribution: timeDist.timeDistribution,
      hours: timeDist.hours,
      weekdayHours: timeDist.weekdayHours,
      weekendHours: timeDist.weekendHours,
      avgStartHour: daySpans.avgStart,
      avgEndHour: daySpans.avgEnd,
      avgSpanHours: daySpans.avgSpan,
      maxStreak: streaks.maxStreak,
      maxBreak: streaks.maxBreak,
      activeDays: timeDist.sortedDays.length,
      weeklyTrend,
      turnBasis: basis,
    };
  }
}

function computeTimeDistribution(reqs: SessionRequest[]) {
  const hours = Array<number>(24).fill(0);
  const weekdayHours = Array<number>(24).fill(0);
  const weekendHours = Array<number>(24).fill(0);
  let weekdayReqs = 0, weekendReqs = 0;
  let lateNight = 0, earlyMorning = 0, workHoursCount = 0, evening = 0;
  const dailyTotals = new Map<string, number>();

  for (const r of reqs) {
    if (!r.timestamp) continue;
    const d = new Date(r.timestamp);
    const h = d.getHours();
    const dow = d.getDay();
    const dayKey = toDateStr(r.timestamp);

    hours[h]++;
    dailyTotals.set(dayKey, (dailyTotals.get(dayKey) || 0) + 1);

    if (dow === 0 || dow === 6) { weekendHours[h]++; weekendReqs++; }
    else { weekdayHours[h]++; weekdayReqs++; }

    if (h >= 0 && h < 6) lateNight++;
    else if (h >= 6 && h < 9) earlyMorning++;
    else if (h >= 9 && h < 18) workHoursCount++;
    else evening++;
  }

  const sortedDays = Array.from(dailyTotals.keys()).sort();
  const weekendRatio = reqs.length > 0 ? weekendReqs / reqs.length : 0;
  const lateRatio = reqs.length > 0 ? lateNight / reqs.length : 0;

  return {
    hours, weekdayHours, weekendHours,
    weekdayReqs, weekendReqs, weekendRatio, lateRatio,
    timeDistribution: { lateNight, earlyMorning, workHours: workHoursCount, evening },
    sortedDays,
  };
}

function computeStreaks(sortedDays: string[]) {
  let maxStreak = 0, currentStreak = 0, maxBreak = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    if (i === 0) { currentStreak = 1; continue; }
    const prev = new Date(sortedDays[i - 1] + 'T00:00:00');
    const curr = new Date(sortedDays[i] + 'T00:00:00');
    const gap = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (gap === 1) {
      currentStreak++;
    } else {
      if (currentStreak > maxStreak) maxStreak = currentStreak;
      if (gap - 1 > maxBreak) maxBreak = gap - 1;
      currentStreak = 1;
    }
  }
  if (currentStreak > maxStreak) maxStreak = currentStreak;
  return { maxStreak, maxBreak };
}

function computeDaySpans(reqs: SessionRequest[]) {
  const dayGroups = new Map<string, number[]>();
  for (const r of reqs) {
    if (!r.timestamp) continue;
    const dk = toDateStr(r.timestamp);
    if (!dayGroups.has(dk)) dayGroups.set(dk, []);
    dayGroups.get(dk)!.push(new Date(r.timestamp).getHours() + new Date(r.timestamp).getMinutes() / 60);
  }
  const dayStartHours: number[] = [];
  const dayEndHours: number[] = [];
  for (const [, hrs] of dayGroups) {
    hrs.sort((a, b) => a - b);
    dayStartHours.push(hrs[0]);
    dayEndHours.push(hrs[hrs.length - 1]);
  }
  const avgStart = dayStartHours.length > 0 ? dayStartHours.reduce((a, b) => a + b, 0) / dayStartHours.length : 9;
  const avgEnd = dayEndHours.length > 0 ? dayEndHours.reduce((a, b) => a + b, 0) / dayEndHours.length : 17;
  return { avgStart, avgEnd, avgSpan: avgEnd - avgStart };
}

function computeWeeklyVolume(reqs: SessionRequest[]) {
  const weeklyVol = new Map<string, { weekday: number; weekend: number }>();
  for (const r of reqs) {
    if (!r.timestamp) continue;
    const d = new Date(r.timestamp);
    const week = isoWeek(d);
    const e = weeklyVol.get(week) || { weekday: 0, weekend: 0 };
    if (d.getDay() === 0 || d.getDay() === 6) e.weekend++;
    else e.weekday++;
    weeklyVol.set(week, e);
  }
  const sortedWeeks = Array.from(weeklyVol.keys()).sort();
  return {
    labels: sortedWeeks,
    weekday: sortedWeeks.map(w => weeklyVol.get(w)?.weekday || 0),
    weekend: sortedWeeks.map(w => weeklyVol.get(w)?.weekend || 0),
  };
}

function computeBalanceScore(
  timeDist: ReturnType<typeof computeTimeDistribution>,
  streaks: ReturnType<typeof computeStreaks>,
  avgSpan: number,
): number {
  let score = 100;
  if (timeDist.weekendRatio > 0.2) score -= 20;
  else if (timeDist.weekendRatio > 0.1) score -= 10;
  if (timeDist.lateRatio > 0.1) score -= 20;
  else if (timeDist.lateRatio > 0.05) score -= 10;
  if (streaks.maxStreak > 14) score -= 15;
  else if (streaks.maxStreak > 7) score -= 5;
  if (avgSpan > 12) score -= 15;
  else if (avgSpan > 10) score -= 5;
  return Math.max(0, Math.min(100, score));
}
