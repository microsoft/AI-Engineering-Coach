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
import { resolveParentLinks, type ParentLink } from './timeline-links';
import { addDays, dayStart } from './timeline-model';

/** The sender marker a turn gets on the Timeline. */
export function turnSender(kind: NonHumanKind | undefined): TurnSender {
  if (!kind) return 'you';
  if (kind === 'agent' || kind === 'relayed' || kind === 'subagent') return 'agent';
  if (kind === 'autopilot') return 'autopilot';
  if (kind === 'compaction') return 'compaction';
  return 'other';
}

/** Tools that launch a sub-agent: Claude Code's `Agent` (`Task` before), each running in a sidechain transcript, and
 *  Codex's `spawn_agent` (a child thread). */
const SUBAGENT_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  Claude: new Set(['Agent', 'Task']),
  Codex: new Set(['spawn_agent']),
};

function subagentLaunches(r: SessionRequest): number {
  if (r.subagentRuns) return r.subagentRuns.length;
  const tools = SUBAGENT_TOOLS[r.agentName];
  return tools ? r.toolsUsed.filter(t => tools.has(t)).length : 0;
}

function timelineTurn(r: SessionRequest): TimelineTurn {
  const t = r.timestamp ?? 0;
  const d = Math.max(0, r.totalElapsed ?? 0);
  const waits = (r.userWaits ?? []).filter(w => w.end >= w.start).map(w => ({ s: w.start, e: w.end, k: w.kind, a: w.answered }));
  return {
    t,
    d,
    k: turnSender(r.nonHumanKind),
    sub: subagentLaunches(r),
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

/** The session's repository or folder name. Xcode's workspace name is the conversation's title, often your first
 *  prompt, so an Xcode session has none. */
function repositoryOf(s: Session): string {
  if (s.repository) return s.repository;
  return s.harness === 'Xcode' ? '' : s.workspaceName || '';
}

const turnEnd = (r: SessionRequest) => (r.timestamp ?? 0) + Math.max(0, r.totalElapsed ?? 0);
/** When the turn last held anything: its work, or a question or permission still open after it. */
const turnReach = (r: SessionRequest) => Math.max(turnEnd(r), ...(r.userWaits ?? []).map(w => w.end));
/** The turn holds an input from you: you typed it, or you answered a question or a permission in it. */
const hasInput = (r: SessionRequest, before: number) =>
  (!r.nonHumanKind && (r.timestamp ?? 0) < before) || (r.userWaits ?? []).some(w => w.answered && w.end < before);

/** A session's turns in time order, split by the range: those in it, and the context its totals need (see
 *  `TimelineSessionRecord.context`). */
function splitByRange(s: Session, from: number | undefined, to: number | undefined) {
  const own = s.requests.filter(r => r.timestamp != null && r.timestamp > 0).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const inside = own.filter(r => (from === undefined || (r.timestamp ?? 0) >= from) && (to === undefined || (r.timestamp ?? 0) < to));
  const before = from === undefined ? [] : own.filter(r => (r.timestamp ?? 0) < from);
  let lastInput = -1;
  for (let i = before.length - 1; i >= 0 && lastInput < 0; i--) if (hasInput(before[i], from ?? 0)) lastInput = i;
  // No input from you before the range: all of it, since a stretch that a parent's prompt started can run through it.
  const context = before.filter((r, i) => i >= lastInput || turnReach(r) > (from ?? 0));
  const after = to === undefined ? undefined : own.find(r => (r.timestamp ?? 0) >= to);
  if (after) context.push(after);
  const reachesIn = before.some(r => turnReach(r) > (from ?? 0));
  return { all: own, inside, context, active: inside.length > 0 || reachesIn };
}

export class TimelineAnalyzer extends AnalyzerBase {
  private links?: Map<string, ParentLink>;

  /** Every session with activity in range, with its turns as counts and timings, its family link, and its logged
   *  name, branch and repository (never a path). No prompt or response text. Turns just outside the range that its
   *  totals need come as `context`, with the range bounds, so every total can be clipped to the range and a range gives
   *  the same per-day values as its days one at a time. Every other member of a shown family comes as a context
   *  record, so the family keeps its structure and its inputs whatever the range or the sidebar filters. */
  getTimelineData(f?: DateFilter, labels: ScrubContext = localScrubContext()): TimelineDataset {
    const links = (this.links ??= resolveParentLinks(this.sessions));
    const from = f?.fromDate ? dayStart(f.fromDate) : undefined;
    const to = f?.toDate ? addDays(dayStart(f.toDate), 1) : undefined;
    const byId = new Map(this.sessions.map(s => [s.sessionId, s]));
    const shown = this.sessions
      .filter(s => this.matchesWorkspaceFilter(s, f?.workspaceId) && (!f?.harness || s.harness === f.harness))
      .map(s => ({ s, ...splitByRange(s, from, to), ctx: false }))
      .filter(x => x.active);
    // Whole families of the shown sessions: the other members, hidden by the range or the filters, as context.
    const children = new Map<string, string[]>();
    for (const [child, link] of links) {
      if (!children.has(link.parent)) children.set(link.parent, []);
      children.get(link.parent)?.push(child);
    }
    const root = (id: string) => {
      const seen = new Set<string>();
      let at = id;
      while (links.has(at) && !seen.has(at)) { seen.add(at); at = links.get(at)?.parent ?? at; }
      return at;
    };
    const included = new Set(shown.map(x => x.s.sessionId));
    const members: typeof shown = [];
    const visit = (id: string) => {
      for (const child of children.get(id) ?? []) {
        if (included.has(child)) { visit(child); continue; }
        included.add(child);
        const s = byId.get(child);
        if (s) members.push({ s, ...splitByRange(s, undefined, undefined), ctx: true });
        visit(child);
      }
    };
    for (const id of new Set(shown.filter(x => links.has(x.s.sessionId) || children.has(x.s.sessionId)).map(x => root(x.s.sessionId)))) {
      if (!included.has(id) && byId.has(id)) {
        included.add(id);
        const s = byId.get(id);
        if (s) members.push({ s, ...splitByRange(s, undefined, undefined), ctx: true });
      }
      visit(id);
    }
    const firstAt = (x: (typeof shown)[number]) => x.inside[0]?.timestamp ?? x.context[0]?.timestamp ?? x.all[0]?.timestamp ?? 0;
    const order = (a: (typeof shown)[number], b: (typeof shown)[number]) => firstAt(a) - firstAt(b) || a.s.sessionId.localeCompare(b.s.sessionId);
    const records = [...shown.sort(order), ...members.sort(order)];
    const index = new Map(records.map((x, i) => [x.s.sessionId, i]));
    const sessions: TimelineSessionRecord[] = records.map(x => {
      const { s } = x;
      const link = links.get(s.sessionId);
      const parent = link ? index.get(link.parent) ?? -1 : -1;
      const created = parent >= 0 && link?.via === 'create' ? byId.get(link.parent)?.childSessionCreatedAt?.[s.sessionId.toLowerCase()] : undefined;
      const turns = x.ctx ? [] : x.inside;
      const context = x.ctx ? x.all : x.context;
      const source = s.forkedFromId;
      const sourceAt = source ? index.get(source) : undefined;
      return {
        id: s.sessionId,
        name: s.displayName ? scrubLabel(s.displayName, labels) : '',
        branch: s.branch ? scrubBranch(s.branch, labels) : '',
        repo: scrubRepository(repositoryOf(s), labels),
        harness: harnessLabel(s.harness),
        model: scrubLabel(mainModel(turns.length ? turns : context), labels),
        parent,
        via: parent >= 0 && link ? link.via : null,
        ...(created !== undefined ? { created } : {}),
        // A Claude Code fork whose source isn't in these logs is still a fork: its copied turns were left out.
        ...(source || s.inheritedTurns ? {
          fork: sourceAt !== undefined && !records[sourceAt].ctx ? sourceAt : -1,
          forkSource: source && byId.has(source) ? 'loaded' as const : 'missing' as const,
        } : {}),
        ...(s.inheritedTurns ? { inheritedTurns: s.inheritedTurns } : {}),
        turns: turns.map(timelineTurn),
        ...(context.length ? { context: context.map(timelineTurn) } : {}),
        ...(x.ctx ? { ctx: true } : {}),
      };
    });
    return {
      sessions,
      forkedSessions: shown.filter(({ s }) => (s.forkCount ?? 0) > 0).length,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
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
