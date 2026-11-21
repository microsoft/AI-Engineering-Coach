/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline + session detail analytics */

import {
  Session, SessionRequest, DateFilter, DayTimeline, TimelineSession, TimelineRequest,
  SessionList, SessionListItem, WorkLifeBalanceResult,
} from './types';
import { toDateStr, startOfDay, endOfDay, classifyWorkType, isoWeek } from './helpers';
import { AnalyzerBase } from './analyzer-base';

export class TimelineAnalyzer extends AnalyzerBase {

  getDayTimeline(dateStr?: string, mode?: string, f?: DateFilter): DayTimeline {
    const allSessions = this.filteredSessions(f);
    const sortedDates = this.getSortedActiveDates(allSessions);
    const targetDate = this.resolveTimelineDate(dateStr, sortedDates);
    const dayStartTs = startOfDay(new Date(targetDate + 'T00:00:00').getTime());
    const dayEndTs = endOfDay(dayStartTs);
    const tlSessions = allSessions
      .map(session => this.buildTimelineSession(session, dayStartTs, dayEndTs))
      .filter((session): session is TimelineSession => session !== null)
      .sort((a, b) => a.firstActivity - b.firstActivity);
    const { prevDay, nextDay, firstDay } = this.getDateNavigation(targetDate, sortedDates);

    return {
      date: targetDate,
      mode: mode || 'day',
      rangeLabel: targetDate,
      dayStart: dayStartTs,
      dayEnd: dayEndTs,
      sessions: tlSessions,
      sessionCount: tlSessions.length,
      maxConcurrent: this.getMaxConcurrent(tlSessions),
      prevDay,
      nextDay,
      firstDay,
      activeDates: this.getActiveDateCounts(allSessions, sortedDates),
    };
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

  private getSortedActiveDates(sessions: Session[]): string[] {
    const activeDates = new Set<string>();
    for (const session of sessions) {
      for (const request of session.requests) {
        if (request.timestamp != null && request.timestamp > 0) activeDates.add(toDateStr(request.timestamp));
      }
    }
    return Array.from(activeDates).sort();
  }

  private resolveTimelineDate(dateStr: string | undefined, sortedDates: string[]): string {
    if (dateStr) return dateStr;
    if (sortedDates.length > 0) return sortedDates[sortedDates.length - 1];
    return toDateStr(Date.now());
  }

  private buildTimelineSession(session: Session, dayStartTs: number, dayEndTs: number): TimelineSession | null {
    const dayReqs = session.requests.filter(r => r.timestamp != null && r.timestamp >= dayStartTs && r.timestamp <= dayEndTs);
    if (dayReqs.length === 0) return null;

    const firstMsg = dayReqs[0].messageText || '';
    const sessionName = firstMsg.length > 60 ? firstMsg.substring(0, 60) + '...' : firstMsg || 'Untitled';
    const requests: TimelineRequest[] = dayReqs.map(r => ({
      timestamp: r.timestamp!,
      messageText: r.messageText,
      responseText: r.responseText,
      messageLength: r.messageLength,
      responseLength: r.responseLength,
      agentName: r.agentName,
      modelId: r.modelId,
      toolsUsed: r.toolsUsed,
      editedFiles: r.editedFiles,
      referencedFiles: r.referencedFiles,
      preview: r.messageText.substring(0, 100),
      loc: this.requestLoc(r),
      workType: r.workType || classifyWorkType(r.messageText),
    }));
    const timestamps = dayReqs.map(r => r.timestamp!);

    return {
      sessionId: session.sessionId,
      workspaceName: session.workspaceName,
      sessionName,
      firstActivity: Math.min(...timestamps),
      lastActivity: Math.max(...timestamps),
      requestCount: dayReqs.length,
      totalRequestCount: session.requests.length,
      requests,
    };
  }

  private getMaxConcurrent(sessions: TimelineSession[]): number {
    const events: Array<{ time: number; type: 'start' | 'end' }> = [];
    for (const session of sessions) {
      events.push({ time: session.firstActivity, type: 'start' });
      events.push({ time: session.lastActivity, type: 'end' });
    }
    events.sort((a, b) => a.time - b.time || (a.type === 'start' ? -1 : 1));

    let maxConcurrent = 0;
    let current = 0;
    for (const event of events) {
      current += event.type === 'start' ? 1 : -1;
      if (current > maxConcurrent) maxConcurrent = current;
    }
    return maxConcurrent;
  }

  private getDateNavigation(dateStr: string, sortedDates: string[]): Pick<DayTimeline, 'prevDay' | 'nextDay' | 'firstDay'> {
    const idx = sortedDates.indexOf(dateStr);
    return {
      prevDay: idx > 0 ? sortedDates[idx - 1] : (sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null),
      nextDay: idx >= 0 && idx < sortedDates.length - 1 ? sortedDates[idx + 1] : (sortedDates.length > 0 ? sortedDates[0] : null),
      firstDay: sortedDates.length > 0 ? sortedDates[0] : null,
    };
  }

  private getActiveDateCounts(sessions: Session[], sortedDates: string[]): DayTimeline['activeDates'] {
    const dateCountMap = new Map<string, number>();
    for (const session of sessions) {
      for (const request of session.requests) {
        if (request.timestamp == null) continue;
        const date = toDateStr(request.timestamp);
        dateCountMap.set(date, (dateCountMap.get(date) || 0) + 1);
      }
    }
    return sortedDates.map(date => ({ date, count: dateCountMap.get(date) || 0 }));
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
