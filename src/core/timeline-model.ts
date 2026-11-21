/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Timeline model: the Day, Week and Families views derived from a `TimelineDataset`. Pure and browser-safe, so the
 * webview recomputes a view instantly when a filter changes, and the analyzer, chat tools and tests share the rules.
 *
 *   Agent time         per turn, its span (prompt → last assistant message) minus the time it waited for your answer
 *                      to a question or a permission prompt. A day or week counts the part inside it.
 *   Waiting on you     per session, over the whole range: from the end of a turn to your next typed prompt (2–120 min;
 *                      longer gaps are time away), and every question or permission prompt you answered inside a
 *                      turn. A day or week counts the part inside it; a wait is counted on the day it started.
 *   Your input         a prompt you typed, or your answer to a question or a permission prompt.
 *   Unattended         per family: from one of your inputs, for as long as agent work the family started before your
 *                      next input kept running (pauses under 2 min don't end it). Work stops at a question, so it can
 *                      only outlast your next input in a session that didn't get it. Computed over the whole range,
 *                      then clipped to the day or week.
 *   Peak parallel      most turns doing agent work at once (waits excluded).
 *   Family             a coordinator session and every session it started, directly or through its children. */

import { toDateStr } from './helpers';
import type { TimelineDataset, TimelineSessionRecord, TimelineTurn } from './types/timeline-types';

export const WAIT_MIN_MS = 2 * 60_000;
export const WAIT_MAX_MS = 120 * 60_000;
export const LONG_WAIT_MS = 30 * 60_000;
/** Children from which a family counts as a wide fan-out. */
export const WIDE_FAN_OUT = 8;
/** Unattended stretches shorter than this aren't called out. */
const UNATTENDED_CALLOUT_MS = 5 * 60_000;
const MAX_DEPTH = 64;

export type TimelineView = 'day' | 'week' | 'families';

export type Interval = [number, number];

/** A time a session waited on you: after a turn, for your next prompt (`idle`), or inside a turn, for your answer. */
export interface TimelineWait {
  start: number;
  end: number;
  kind: 'idle' | 'question' | 'permission';
}

export interface PreparedSession extends TimelineSessionRecord {
  index: number;
  /** Index of the family's coordinator (itself for a top-level session). */
  root: number;
  /** 0 for a coordinator or lone session, 1 for a child, 2 for a grandchild… */
  depth: number;
  /** Sessions it started directly. */
  children: number;
  /** Turns before the range it needs for waits and work crossing into it (never counted as turns). */
  context: TimelineTurn[];
  /** Every time it waited on you, in order (ones that started before the range included; windows clip them). */
  waits: TimelineWait[];
  /** Gaps of more than 2 h between the end of a turn and your next prompt: time away, not waiting. */
  away: Interval[];
}

export interface DayTotals {
  typed: number;
  automated: number;
  agentMs: number;
}

export interface PreparedTimeline {
  sessions: PreparedSession[];
  /** Days with a turn or agent work, in order. */
  days: string[];
  dayTotals: Map<string, DayTotals>;
  /** Sessions per family, keyed by the family's root index. */
  familySize: Map<number, number>;
  totalCredits: number;
  harnesses: string[];
  forkedSessions: number;
  /** The range: agent work and waits outside it never count. */
  bounds: Interval;
}

/* ---- turns ---- */

/** When the turn's agent was working: its span minus the time it waited on you. Empty without a logged duration. */
export function workSegments(t: TimelineTurn): Interval[] {
  if (t.d <= 0) return [];
  const end = t.t + t.d;
  const out: Interval[] = [];
  let from = t.t;
  for (const w of t.w ?? []) {
    const s = Math.min(Math.max(w.s, from), end);
    if (s > from) out.push([from, s]);
    from = Math.max(from, Math.min(w.e, end));
  }
  if (end > from) out.push([from, end]);
  return out;
}

/** Agent time of a turn, or of the part of it inside [start, end). */
export function workMs(t: TimelineTurn, start = -Infinity, end = Infinity): number {
  return sum(workSegments(t), ([a, b]) => overlap(a, b, start, end));
}

/** Questions and permission prompts the turn waited on you for. */
export function answersOf(t: TimelineTurn): number {
  return t.w?.length ?? 0;
}

function overlap(a: number, b: number, start: number, end: number): number {
  return Math.max(0, Math.min(b, end) - Math.max(a, start));
}

/** The session's waits over all its turns: the gaps from the end of a turn to your next typed prompt (2–120 min), and
 *  the questions and permission prompts it waited on inside turns. After a turn without a logged duration, when the
 *  work ended is unknown, so no gap is counted until the next timed turn. */
export function sessionWaits(turns: readonly TimelineTurn[]): { waits: TimelineWait[]; away: Interval[] } {
  const waits: TimelineWait[] = [];
  const away: Interval[] = [];
  let busyUntil = -1;
  for (const t of [...turns].sort((a, b) => a.t - b.t)) {
    if (t.k === 'you' && busyUntil > 0) {
      const gap = t.t - busyUntil;
      if (gap >= WAIT_MIN_MS && gap <= WAIT_MAX_MS) waits.push({ start: busyUntil, end: t.t, kind: 'idle' });
      else if (gap > WAIT_MAX_MS) away.push([busyUntil, t.t]);
    }
    for (const w of t.w ?? []) waits.push({ start: w.s, end: w.e, kind: w.k });
    busyUntil = t.noDuration ? -1 : Math.max(busyUntil, t.t + t.d);
  }
  return { waits: waits.sort((a, b) => a.start - b.start), away };
}

/** Links each session to its family, finds its waits and counts turns and agent time per day. */
export function prepareTimeline(data: TimelineDataset): PreparedTimeline {
  const records = data.sessions;
  const bounds: Interval = [data.from ?? -Infinity, data.to ?? Infinity];
  const sessions: PreparedSession[] = records.map((s, index) => ({
    ...s, index, root: index, depth: 0, children: 0, context: s.context ?? [], ...sessionWaits([...(s.context ?? []), ...s.turns]),
  }));
  for (const s of sessions) {
    let at = s.index;
    let depth = 0;
    while (records[at].parent >= 0 && depth < MAX_DEPTH) {
      at = records[at].parent;
      depth++;
    }
    s.root = at;
    s.depth = depth;
    if (s.parent >= 0) sessions[s.parent].children++;
  }
  const familySize = new Map<number, number>();
  const dayTotals = new Map<string, DayTotals>();
  const totalsOf = (day: string): DayTotals => {
    let totals = dayTotals.get(day);
    if (!totals) dayTotals.set(day, totals = { typed: 0, automated: 0, agentMs: 0 });
    return totals;
  };
  let totalCredits = 0;
  for (const s of sessions) {
    familySize.set(s.root, (familySize.get(s.root) ?? 0) + 1);
    for (const t of s.turns) {
      const totals = totalsOf(toDateStr(t.t));
      if (t.k === 'you') totals.typed++;
      else totals.automated++;
      totalCredits += t.cr;
    }
    for (const t of [...s.context, ...s.turns]) {
      for (const [a, b] of workSegments(t)) forEachDay(Math.max(a, bounds[0]), Math.min(b, bounds[1]), (day, ms) => { totalsOf(day).agentMs += ms; });
    }
  }
  return {
    sessions,
    days: [...dayTotals.keys()].sort(),
    dayTotals,
    familySize,
    totalCredits,
    harnesses: [...new Set(sessions.map(s => s.harness))].sort(),
    forkedSessions: data.forkedSessions,
    bounds,
  };
}

/** Splits [a, b) at local midnights (23 or 25 h on daylight-saving days). */
function forEachDay(a: number, b: number, add: (day: string, ms: number) => void): void {
  let from = a;
  while (from < b) {
    const day = toDateStr(from);
    const next = Math.min(b, addDays(dayStart(day), 1));
    if (next <= from) return;
    add(day, next - from);
    from = next;
  }
}

/* ---- windows and navigation ---- */

export function dayStart(date: string): number {
  return new Date(date + 'T00:00:00').getTime();
}

/** `days` calendar days later, at the same local clock time (not `days × 24 h`, which daylight saving breaks). */
export function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Monday 00:00 of the week holding `date`. */
export function weekStart(date: string): number {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d.getTime();
}

/** The [start, end) of the day or week holding `date`. */
export function timelineWindow(view: 'day' | 'week', date: string): Interval {
  const start = view === 'week' ? weekStart(date) : dayStart(date);
  return [start, addDays(start, view === 'week' ? 7 : 1)];
}

/** The active day `dir` days or weeks from `date`, or null at either end. */
export function stepDate(view: 'day' | 'week', date: string, dir: -1 | 1, days: readonly string[]): string | null {
  if (view === 'week') {
    const [start, end] = timelineWindow('week', date);
    return dir < 0
      ? [...days].reverse().find(d => dayStart(d) < start) ?? null
      : days.find(d => dayStart(d) >= end) ?? null;
  }
  const i = days.indexOf(date);
  if (i < 0) return dir < 0 ? [...days].reverse().find(d => d < date) ?? null : days.find(d => d > date) ?? null;
  return days[i + dir] ?? null;
}

/** Local midnights from `start` up to `end`, one per day (on daylight-saving days the hours between differ). */
export function dayTicks(start: number, end: number): number[] {
  const ticks: number[] = [];
  for (let at = start; at < end && ticks.length < 400; at = addDays(at, 1)) ticks.push(at);
  return ticks;
}

/** Each local full hour from `start` up to `end`, in steps of `step` hours of the clock. */
export function hourTicks(start: number, end: number, step: number): number[] {
  const ticks: number[] = [];
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  if (d.getTime() < start) d.setHours(d.getHours() + 1);
  for (; d.getTime() < end && ticks.length < 400; d.setTime(d.getTime() + 3_600_000)) {
    if (d.getHours() % step === 0) ticks.push(d.getTime());
  }
  return ticks;
}

/* ---- lanes ---- */

export interface TimelineLane {
  s: PreparedSession;
  /** Turns that started in the window, in time order: what the counts count. */
  turns: TimelineTurn[];
  /** Turns that started before the window and were still running in it: drawn, not counted. */
  carried: TimelineTurn[];
  typed: number;
  automated: number;
  /** Questions and permission prompts you answered in the window's turns. */
  answered: number;
  /** Agent time inside the window. */
  agentMs: number;
  credits: number;
  tokens: number;
  first: number;
  /** End of the last turn's span. */
  last: number;
  subagents: number;
  /** The session's waits that overlap the window (whole spans; `clippedMs` gives the part inside). */
  waits: TimelineWait[];
  /** Gaps over 2 h before one of your prompts in the window. */
  away: number;
  /** Nearest ancestor shown in the same view, -1 when none is. */
  visibleParent: number;
  /** The window the lane was built for. */
  win: Interval;
}

/** The part of a wait inside the window. */
export function clippedMs(w: TimelineWait, win: Interval): number {
  return overlap(w.start, w.end, win[0], win[1]);
}

/** One lane per session with a turn that started in [start, end) or ran into it. The window is clipped to the range. */
export function buildLanes(p: PreparedTimeline, from: number, to: number): TimelineLane[] {
  const start = Math.max(from, p.bounds[0]);
  const end = Math.min(to, p.bounds[1]);
  const lanes: TimelineLane[] = [];
  if (start >= end) return lanes;
  for (const s of p.sessions) {
    const turns = s.turns.filter(t => t.t >= start && t.t < end);
    const carried = [...s.context, ...s.turns].filter(t => t.t < start && t.t + t.d > start);
    if (turns.length === 0 && carried.length === 0) continue;
    const typed = turns.filter(t => t.k === 'you').length;
    const drawn = [...carried, ...turns];
    lanes.push({
      s,
      turns,
      carried,
      typed,
      automated: turns.length - typed,
      answered: sum(turns, answersOf),
      agentMs: sum(drawn, t => workMs(t, start, end)),
      credits: sum(turns, t => t.cr),
      tokens: sum(turns, t => t.tok),
      first: turns[0]?.t ?? start,
      last: Math.max(...drawn.map(t => t.t + t.d)),
      subagents: sum(turns, t => t.sub),
      waits: s.waits.filter(w => w.start < end && w.end > start),
      away: s.away.filter(([, b]) => b >= start && b < end).length,
      visibleParent: -1,
      win: [start, end],
    });
  }
  return lanes;
}

export interface LaneFilters {
  /** Short harness label; empty for every harness. */
  harness: string;
  /** Matches the repository or model. */
  query: string;
  onlyFamilies: boolean;
  youTyped: boolean;
  waitedOnYou: boolean;
  usedSubagents: boolean;
  hideOneTurn: boolean;
}

export const NO_LANE_FILTERS: LaneFilters = {
  harness: '', query: '', onlyFamilies: false, youTyped: false, waitedOnYou: false, usedSubagents: false, hideOneTurn: false,
};

export function hasLaneFilters(f: LaneFilters): boolean {
  return f.harness !== '' || f.query.trim() !== '' || f.onlyFamilies || f.youTyped || f.waitedOnYou || f.usedSubagents || f.hideOneTurn;
}

/** The lanes the filters keep. `repoLabel` is the repository as shown (masked or not), so search matches the screen. */
export function filterLanes(
  lanes: readonly TimelineLane[], f: LaneFilters, p: PreparedTimeline, repoLabel: (s: PreparedSession) => string = s => s.repo,
): TimelineLane[] {
  const q = f.query.trim().toLowerCase();
  return lanes.filter(l => (!f.harness || l.s.harness === f.harness)
    && (!q || repoLabel(l.s).toLowerCase().includes(q) || l.s.model.toLowerCase().includes(q))
    && (!f.onlyFamilies || (p.familySize.get(l.s.root) ?? 1) > 1)
    && (!f.youTyped || l.typed > 0)
    && (!f.waitedOnYou || l.waits.length > 0)
    && (!f.usedSubagents || l.subagents > 0)
    && (!f.hideOneTurn || l.turns.length > 1));
}

/* ---- families within a view ---- */

export interface ViewFamily {
  root: number;
  lanes: TimelineLane[];
  /** Lanes in tree order with their depth under the family's top shown session. */
  ordered: { lane: TimelineLane; depth: number }[];
  first: number;
  /** Sessions in the whole family over the range, shown or not. */
  size: number;
  typed: number;
  automated: number;
  answered: number;
  agentMs: number;
  credits: number;
  tokens: number;
  unattendedMs: number;
  /** Share of the shown sessions' credits (%). */
  share: number;
  /** Color slot for families of 2+ sessions in the range; -1 for a lone session. */
  color: number;
}

/** The longest stretch the agents kept working after one of your inputs (a typed prompt or an answer): from the
 *  input, through the agent work the lanes' sessions started before your next input, for as long as some of that work
 *  is running (pauses under 2 min don't end it). Over all their turns in the range, clipped to `win`. */
export function unattendedMs(lanes: readonly TimelineLane[], win: Interval = [-Infinity, Infinity]): number {
  const turns = lanes.flatMap(l => [...l.s.context, ...l.s.turns]);
  const inputs = [...new Set([
    ...turns.filter(t => t.k === 'you').map(t => t.t),
    ...turns.flatMap(t => (t.w ?? []).map(w => w.e)),
  ])].sort((a, b) => a - b);
  const segments = turns.flatMap(workSegments).sort((a, b) => a[0] - b[0]);
  let best = 0;
  let j = 0;
  for (let i = 0; i < inputs.length; i++) {
    const from = inputs[i];
    const until = inputs[i + 1] ?? Infinity;
    while (j < segments.length && segments[j][0] < from) j++;
    let reach = from;
    let chained = true;
    for (; j < segments.length && segments[j][0] < until; j++) {
      if (chained && segments[j][0] <= reach + WAIT_MIN_MS) reach = Math.max(reach, segments[j][1]);
      else chained = false;
    }
    if (reach > from) best = Math.max(best, overlap(from, reach, win[0], win[1]));
  }
  return best;
}

/** Most turns doing agent work at once inside the lanes' window, and when that first happened. */
export function peakParallel(lanes: readonly TimelineLane[]): { count: number; at: number | null } {
  const events: [number, number][] = [];
  for (const l of lanes) {
    for (const t of [...l.carried, ...l.turns]) {
      for (const [a, b] of workSegments(t)) {
        const from = Math.max(a, l.win[0]);
        const to = Math.min(b, l.win[1]);
        if (to > from) events.push([from, 1], [to, -1]);
      }
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let count = 0;
  let at: number | null = null;
  for (const [time, delta] of events) {
    current += delta;
    if (current > count) {
      count = current;
      at = time;
    }
  }
  return { count, at };
}

/** Groups lanes by family, in order of first activity; a lane's tree parent is its nearest shown ancestor. */
export function buildViewFamilies(lanes: TimelineLane[], p: PreparedTimeline): ViewFamily[] {
  const byRoot = new Map<number, TimelineLane[]>();
  for (const l of lanes) {
    const list = byRoot.get(l.s.root) ?? [];
    list.push(l);
    byRoot.set(l.s.root, list);
  }
  const totalCredits = sum(lanes, l => l.credits);
  const families: ViewFamily[] = [];
  for (const [root, members] of byRoot) {
    const shown = new Map(members.map(l => [l.s.index, l]));
    const kids = new Map<number, TimelineLane[]>();
    for (const l of members) {
      let at = l.s.parent;
      let guard = 0;
      l.visibleParent = -1;
      while (at >= 0 && guard++ < MAX_DEPTH) {
        if (shown.has(at)) {
          l.visibleParent = at;
          break;
        }
        at = p.sessions[at].parent;
      }
      const list = kids.get(l.visibleParent) ?? [];
      list.push(l);
      kids.set(l.visibleParent, list);
    }
    for (const list of kids.values()) list.sort((a, b) => a.first - b.first);
    const ordered: ViewFamily['ordered'] = [];
    const walk = (l: TimelineLane, depth: number): void => {
      ordered.push({ lane: l, depth });
      for (const child of kids.get(l.s.index) ?? []) walk(child, depth + 1);
    };
    for (const top of kids.get(-1) ?? []) walk(top, 0);
    const credits = sum(members, l => l.credits);
    families.push({
      root,
      lanes: members,
      ordered,
      first: Math.min(...members.map(l => l.first)),
      size: p.familySize.get(root) ?? members.length,
      typed: sum(members, l => l.typed),
      automated: sum(members, l => l.automated),
      answered: sum(members, l => l.answered),
      agentMs: sum(members, l => l.agentMs),
      credits,
      tokens: sum(members, l => l.tokens),
      unattendedMs: unattendedMs(members, members[0].win),
      share: totalCredits > 0 ? 100 * credits / totalCredits : 0,
      color: -1,
    });
  }
  families.sort((a, b) => a.first - b.first);
  let slot = 0;
  for (const f of families) if (f.size > 1) f.color = slot++;
  return families;
}

export interface TimelineKpis {
  sessions: number;
  turns: number;
  typed: number;
  /** Questions and permission prompts you answered. */
  answered: number;
  agentMs: number;
  /** Agent time per typed prompt (ms); null without typed prompts. */
  agentMsPerPrompt: number | null;
  unattendedMs: number;
  /** Waits that started in the window: after a turn (`idleWaits`) or for an answer inside one. */
  waits: number;
  idleWaits: number;
  /** Time waiting on you inside the window. */
  waitMs: number;
  longWaits: number;
  /** Gaps over 2 h before your next prompt: time away, not counted as waiting. */
  away: number;
  peak: { count: number; at: number | null };
  credits: number;
  /** Share of the shown credits in child sessions (%). */
  childCreditShare: number;
  childLanes: number;
}

export function timelineKpis(lanes: readonly TimelineLane[], families: readonly ViewFamily[]): TimelineKpis {
  const win = lanes[0]?.win ?? [-Infinity, Infinity];
  const all = lanes.flatMap(l => l.waits);
  const started = all.filter(w => w.start >= win[0] && w.start < win[1]);
  const typed = sum(lanes, l => l.typed);
  const agentMs = sum(lanes, l => l.agentMs);
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  return {
    sessions: lanes.length,
    turns: sum(lanes, l => l.turns.length),
    typed,
    answered: sum(lanes, l => l.answered),
    agentMs,
    agentMsPerPrompt: typed > 0 ? agentMs / typed : null,
    unattendedMs: Math.max(0, ...families.map(f => f.unattendedMs)),
    waits: started.length,
    idleWaits: started.filter(w => w.kind === 'idle').length,
    waitMs: sum(all, w => clippedMs(w, win)),
    longWaits: started.filter(w => w.end - w.start >= LONG_WAIT_MS).length,
    away: sum(lanes, l => l.away),
    peak: peakParallel(lanes),
    credits,
    childCreditShare: credits > 0 ? 100 * sum(children, l => l.credits) / credits : 0,
    childLanes: children.length,
  };
}

/* ---- names ---- */

/** Display names. With `masked`, names say only what the session was, and repositories become letters. */
export interface Namer {
  name(s: PreparedSession): string;
  repo(s: PreparedSession): string;
  branch(s: PreparedSession): string;
}

function letters(n: number): string {
  return (n >= 26 ? letters(Math.floor(n / 26) - 1) : '') + String.fromCharCode(65 + (n % 26));
}

/** Shown for a session that logged no repository or folder. */
export const NO_REPOSITORY = 'no repository';

export function createNamer(p: PreparedTimeline, masked: boolean): Namer {
  const repoCredits = new Map<string, number>();
  for (const s of p.sessions) repoCredits.set(s.repo, (repoCredits.get(s.repo) ?? 0) + sum(s.turns, t => t.cr));
  const repoMask = new Map<string, string>();
  for (const [i, [repo]] of [...repoCredits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).entries()) repoMask.set(repo, `Repository ${letters(i)}`);
  return {
    name: s => {
      if (masked) return `${s.parent < 0 ? 'Session' : 'Child session'} ${s.index + 1}`;
      if (s.name) return s.name;
      const first = s.turns[0]?.t ?? s.context[0]?.t;
      const when = first ? new Date(first).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      return `Untitled ${s.harness} session${when ? ' · ' + when : ''}`;
    },
    repo: s => (masked ? repoMask.get(s.repo) ?? 'Repository' : s.repo || NO_REPOSITORY),
    branch: s => (masked ? '' : s.branch),
  };
}

/** What the session was in its family: `coordinator · 3 children`, `child`, `grandchild` or `session`. */
export function roleOf(s: PreparedSession): string {
  if (s.parent < 0) return s.children > 0 ? `coordinator · ${s.children} ${s.children === 1 ? 'child' : 'children'}` : 'session';
  return s.depth === 1 ? 'child' : 'grandchild';
}

/* ---- formatting ---- */

/** `2 h 05 m`, `12 min`, `<1 min`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} m`;
  if (ms > 0 && minutes < 1) return '<1 min';
  return `${minutes} min`;
}

/** `8.5 h` above an hour, `12 min` below. */
export function formatHours(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(minutes >= 600 ? 0 : 1)} h`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Clock time in a day view, weekday and clock time in a week view. */
export function formatWhen(ts: number, view: 'day' | 'week'): string {
  return view === 'week'
    ? `${new Date(ts).toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(ts)}`
    : formatClock(ts);
}

/** Whole AI credits, `1,234`. */
export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('en-US');
}

/** A count of things (prompts, sessions), `1,234`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/* ---- coaching callouts (H) ---- */

/** The three findings of a day or week, as plain sentences. */
export function viewInsights(
  lanes: readonly TimelineLane[], families: readonly ViewFamily[], namer: Namer, period: 'day' | 'week', p?: PreparedTimeline,
): string[] {
  const when = period === 'week' ? 'this week' : 'on this day';
  return [unattendedInsight(families, namer, when, p), creditsInsight(lanes, namer, when), waitsInsight(lanes)];
}

function unattendedInsight(families: readonly ViewFamily[], namer: Namer, when: string, p?: PreparedTimeline): string {
  const top = [...families].sort((a, b) => b.unattendedMs - a.unattendedMs)[0];
  if (!top || top.unattendedMs < UNATTENDED_CALLOUT_MS) {
    return `No agent worked more than 5 min on its own after one of your prompts or answers ${when}.`;
  }
  const span = formatDuration(top.unattendedMs);
  const counts = `(${plural(top.typed, 'typed', 'typed')}, ${plural(top.automated, 'automated turn', 'automated turns')} shown)`;
  const tail = ' Reuse the brief that made this work.';
  const rootLane = top.lanes.find(l => l.s.index === top.root);
  if (rootLane && top.lanes.length > 1) {
    return `Your coordinator “${namer.name(rootLane.s)}” and ${plural(top.lanes.length - 1, 'session', 'sessions')} of its family kept working ${span} after one of your prompts or answers, with no further input into the session doing that work ${counts}.${tail}`;
  }
  if (rootLane) {
    return `Your session “${namer.name(rootLane.s)}” kept working ${span} after one of your prompts or answers, with no further input from you ${counts}.${tail}`;
  }
  const coordinator = p ? `the coordinator “${namer.name(p.sessions[top.root])}”` : 'their coordinator';
  const who = top.lanes.length === 1
    ? `The child session “${namer.name(top.lanes[0].s)}” of ${coordinator}`
    : `${plural(top.lanes.length, 'session', 'sessions')} started by ${coordinator}`;
  return `${who} (not shown here) kept working ${span} after one of your prompts or answers, with no further input into the session doing that work ${counts}.${tail}`;
}

function creditsInsight(lanes: readonly TimelineLane[], namer: Namer, when: string): string {
  const credits = sum(lanes, l => l.credits);
  const children = lanes.filter(l => l.s.parent >= 0);
  if (credits <= 0) return `No AI credits were logged ${when}. Only Copilot logs credits; other harnesses show time and turns.`;
  if (children.length === 0) {
    return `None of the ${plural(lanes.length, 'session', 'sessions')} shown was started by another session, so no credits went to child sessions.`;
  }
  const share = 100 * sum(children, l => l.credits) / credits;
  const big = [...children].sort((a, b) => b.credits - a.credits)[0];
  const input = [big.typed > 0 ? `typed ${plural(big.typed, 'prompt', 'prompts')} into it` : '',
    big.answered > 0 ? `answered ${plural(big.answered, 'question or permission prompt', 'questions or permission prompts')} in it` : '']
    .filter(Boolean).join(' and ');
  return `Child sessions used ${share.toFixed(1)}% of the credits shown. The child “${namer.name(big.s)}” alone used ${Math.round(100 * big.credits / credits)}%`
    + (input ? `, and you ${input}: open it to see why it needed you.` : ', with no prompt or answer from you.');
}

function waitsInsight(lanes: readonly TimelineLane[]): string {
  const win = lanes[0]?.win ?? [-Infinity, Infinity];
  const all = lanes.flatMap(l => l.waits);
  const started = all.filter(w => w.start >= win[0] && w.start < win[1]);
  const away = sum(lanes, l => l.away);
  if (started.length === 0 && all.length === 0) {
    return away > 0
      ? `No agent waited 2–120 min for your next prompt or on a question; ${plural(away, 'gap was', 'gaps were')} longer than 2 h, counted as time away rather than waiting.`
      : 'No agent waited on you for more than 2 min, and none stopped for a question or a permission prompt.';
  }
  const idle = started.filter(w => w.kind === 'idle').length;
  const asked = started.length - idle;
  const long = started.filter(w => w.end - w.start >= LONG_WAIT_MS).length;
  const parts = [idle > 0 ? `${plural(idle, 'time', 'times')} after finishing a turn` : '',
    asked > 0 ? `${plural(asked, 'time', 'times')} on a question or permission prompt` : ''].filter(Boolean).join(' and ');
  return `Agents waited on you ${parts || 'from an earlier day'}, ${formatDuration(sum(all, w => clippedMs(w, win)))} in total`
    + (long > 0
      ? `; ${plural(long, 'wait was', 'waits were')} longer than 30 min. Answer from the session list, or let autopilot carry on with routine steps.`
      : '.');
}

/* ---- families over the whole range ---- */

export type FamilyVerdict = 'alone' | 'needed';

export const VERDICTS: Record<FamilyVerdict | 'wide', { label: string; habit: string }> = {
  alone: {
    label: 'Worked alone',
    habit: 'Reuse this brief: copy the coordinator’s opening prompt into a prompt file or skill, so the next delegation starts the same way.',
  },
  needed: {
    label: 'Needed you',
    habit: 'Open the child sessions you stepped into (marked ✋) and note what was missing. Put that context, files or acceptance criteria into the coordinator’s brief next time.',
  },
  wide: {
    label: 'Wide fan-out',
    habit: 'Check whether the child sessions overlap. Give each one a narrow scope and the cheapest model that works.',
  },
};

export interface FamilyNode {
  s: PreparedSession;
  /** Depth below the coordinator. */
  depth: number;
  typed: number;
  automated: number;
  /** Questions and permission prompts you answered in it. */
  answered: number;
  agentMs: number;
  credits: number;
  tokens: number;
  first: number;
  last: number;
  subagents: number;
}

export interface FamilySummary {
  root: number;
  s: PreparedSession;
  /** Every session of the family in tree order, the coordinator first. */
  nodes: FamilyNode[];
  sessions: number;
  children: number;
  depth: number;
  fanOut: number;
  repos: number;
  harnesses: string[];
  typed: number;
  coordinatorTyped: number;
  /** Prompts you typed into child sessions. */
  childTyped: number;
  /** Questions and permission prompts you answered in child sessions. */
  childAnswered: number;
  /** Child sessions you typed into or answered in: the ones that needed you. */
  steppedInto: number;
  automated: number;
  agentMs: number;
  credits: number;
  childCredits: number;
  tokens: number;
  /** Share of all credits in range (%). */
  creditShare: number;
  /** Share of the family's credits in its children (%). */
  childShare: number;
  perChild: number;
  verdict: FamilyVerdict;
  wide: boolean;
  from: string;
  to: string;
  /** The day with most of the family's turns. */
  busiest: string;
  /** 1 for the family that used most credits. */
  rank: number;
}

export interface FamiliesTotals {
  sessions: number;
  families: number;
  sessionsInFamilies: number;
  children: number;
  creditShare: number;
  childCreditShare: number;
  tokenShare: number;
  agentMs: number;
  agentShare: number;
  typed: number;
  automated: number;
  childTyped: number;
  childAnswered: number;
  childrenNeedingYou: number;
  maxDepth: number;
  maxFanOut: number;
  top3Share: number;
  alone: { families: number; creditShare: number; avgCredits: number };
  needed: { families: number; creditShare: number; avgCredits: number };
  wide: { families: number; creditShare: number };
  totalCredits: number;
}

export interface FamiliesOverview {
  families: FamilySummary[];
  totals: FamiliesTotals;
}

/** Agent time of a session inside the range: its turns, and the part of earlier turns that ran into the range. */
function sessionAgentMs(s: PreparedSession, bounds: Interval): number {
  return sum([...s.context, ...s.turns], t => workMs(t, bounds[0], bounds[1]));
}

function familyNode(s: PreparedSession, depth: number, bounds: Interval): FamilyNode {
  const typed = s.turns.filter(t => t.k === 'you').length;
  return {
    s,
    depth,
    typed,
    automated: s.turns.length - typed,
    answered: sum(s.turns, answersOf),
    agentMs: sessionAgentMs(s, bounds),
    credits: sum(s.turns, t => t.cr),
    tokens: sum(s.turns, t => t.tok),
    first: s.turns[0]?.t ?? 0,
    last: Math.max(0, ...s.turns.map(t => t.t + t.d)),
    subagents: sum(s.turns, t => t.sub),
  };
}

/** A child session needed you: you typed into it, or answered one of its questions or permission prompts. */
export function neededYou(n: Pick<FamilyNode, 'typed' | 'answered'>): boolean {
  return n.typed > 0 || n.answered > 0;
}

function groupBy<K>(sessions: readonly PreparedSession[], key: (s: PreparedSession) => K | null): Map<K, PreparedSession[]> {
  const groups = new Map<K, PreparedSession[]>();
  for (const s of sessions) {
    const k = key(s);
    if (k === null) continue;
    const list = groups.get(k) ?? [];
    list.push(s);
    groups.set(k, list);
  }
  return groups;
}

/** The family's sessions in tree order: each session followed by its children, oldest first. */
function familyNodes(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>, bounds: Interval): FamilyNode[] {
  const nodes: FamilyNode[] = [];
  const walk = (s: PreparedSession, depth: number): void => {
    nodes.push(familyNode(s, depth, bounds));
    const kids = [...(kidsOf.get(s.index) ?? [])].sort((a, b) => (a.turns[0]?.t ?? 0) - (b.turns[0]?.t ?? 0));
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(root, 0);
  return nodes;
}

function busiestDayOf(nodes: readonly FamilyNode[]): string {
  const days = new Map<string, number>();
  for (const n of nodes) for (const t of n.s.turns) days.set(toDateStr(t.t), (days.get(toDateStr(t.t)) ?? 0) + 1);
  return [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function summarizeFamily(root: PreparedSession, kidsOf: Map<number, PreparedSession[]>, p: PreparedTimeline): FamilySummary {
  const totalCredits = p.totalCredits;
  const nodes = familyNodes(root, kidsOf, p.bounds);
  const kids = nodes.filter(n => n.depth > 0);
  const credits = sum(nodes, n => n.credits);
  const childCredits = sum(kids, n => n.credits);
  const steppedInto = kids.filter(neededYou).length;
  const firsts = nodes.map(n => n.first).filter(t => t > 0);
  const lasts = nodes.map(n => n.s.turns[n.s.turns.length - 1]?.t ?? 0).filter(t => t > 0);
  return {
    root: root.index,
    s: root,
    nodes,
    sessions: nodes.length,
    children: kids.length,
    depth: Math.max(...nodes.map(n => n.depth)),
    fanOut: Math.max(0, ...nodes.map(n => kidsOf.get(n.s.index)?.length ?? 0)),
    repos: new Set(nodes.map(n => n.s.repo)).size,
    harnesses: [...new Set(nodes.map(n => n.s.harness))],
    typed: sum(nodes, n => n.typed),
    coordinatorTyped: nodes[0].typed,
    childTyped: sum(kids, n => n.typed),
    childAnswered: sum(kids, n => n.answered),
    steppedInto,
    automated: sum(nodes, n => n.automated),
    agentMs: sum(nodes, n => n.agentMs),
    credits,
    childCredits,
    tokens: sum(nodes, n => n.tokens),
    creditShare: totalCredits > 0 ? 100 * credits / totalCredits : 0,
    childShare: credits > 0 ? 100 * childCredits / credits : 0,
    perChild: kids.length > 0 ? childCredits / kids.length : 0,
    verdict: steppedInto > 0 ? 'needed' : 'alone',
    wide: kids.length >= WIDE_FAN_OUT,
    from: firsts.length > 0 ? toDateStr(Math.min(...firsts)) : '',
    to: lasts.length > 0 ? toDateStr(Math.max(...lasts)) : '',
    busiest: busiestDayOf(nodes),
    rank: 0,
  };
}

function familiesTotals(p: PreparedTimeline, families: FamilySummary[]): FamiliesTotals {
  const totalCredits = p.totalCredits;
  const totalTokens = sum(p.sessions, s => sum(s.turns, t => t.tok));
  const totalAgent = sum(p.sessions, s => sessionAgentMs(s, p.bounds));
  const share = (part: number, whole: number) => (whole > 0 ? 100 * part / whole : 0);
  const group = (list: FamilySummary[]) => ({
    families: list.length,
    creditShare: sum(list, f => f.creditShare),
    avgCredits: list.length > 0 ? sum(list, f => f.credits) / list.length : 0,
  });
  const wide = families.filter(f => f.wide);
  return {
    sessions: p.sessions.length,
    families: families.length,
    sessionsInFamilies: sum(families, f => f.sessions),
    children: sum(families, f => f.children),
    creditShare: share(sum(families, f => f.credits), totalCredits),
    childCreditShare: share(sum(families, f => f.childCredits), totalCredits),
    tokenShare: share(sum(families, f => f.tokens), totalTokens),
    agentMs: sum(families, f => f.agentMs),
    agentShare: share(sum(families, f => f.agentMs), totalAgent),
    typed: sum(families, f => f.typed),
    automated: sum(families, f => f.automated),
    childTyped: sum(families, f => f.childTyped),
    childAnswered: sum(families, f => f.childAnswered),
    childrenNeedingYou: sum(families, f => f.steppedInto),
    maxDepth: Math.max(0, ...families.map(f => f.depth)),
    maxFanOut: Math.max(0, ...families.map(f => f.fanOut)),
    top3Share: sum(families.slice(0, 3), f => f.creditShare),
    alone: group(families.filter(f => f.verdict === 'alone')),
    needed: group(families.filter(f => f.verdict === 'needed')),
    wide: { families: wide.length, creditShare: sum(wide, f => f.creditShare) },
    totalCredits,
  };
}

/** Every family of two or more sessions in range, ranked by credits, and what they add up to. */
export function buildFamilies(p: PreparedTimeline): FamiliesOverview {
  const members = groupBy(p.sessions, s => s.root);
  const kidsOf = groupBy(p.sessions, s => (s.parent >= 0 ? s.parent : null));
  const families = [...members.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([root]) => summarizeFamily(p.sessions[root], kidsOf, p))
    .sort((a, b) => b.credits - a.credits || b.agentMs - a.agentMs || b.sessions - a.sessions);
  for (const [i, f] of families.entries()) f.rank = i + 1;
  return { families, totals: familiesTotals(p, families) };
}

/** What you put into child sessions: `3 prompts` and/or `2 answers`. */
function childInput(typed: number, answered: number): string {
  return [typed > 0 ? `typed ${plural(typed, 'prompt', 'prompts')} into` : '',
    answered > 0 ? `answered ${plural(answered, 'question or permission prompt', 'questions or permission prompts')} in` : '']
    .filter(Boolean).join(' and ');
}

/** The verdict in words, for the selected family. */
export function verdictText(f: FamilySummary): string {
  const coordinator = f.coordinatorTyped > 0
    ? `You typed ${plural(f.coordinatorTyped, 'prompt', 'prompts')}, all in the coordinator.`
    : 'You typed no prompt in the coordinator either.';
  const base = f.verdict === 'alone'
    ? `${f.children === 1 ? 'The child session' : `All ${formatCount(f.children)} child sessions`} needed no prompt or answer from you. ${coordinator}`
    : `You ${childInput(f.childTyped, f.childAnswered)} ${formatCount(f.steppedInto)} of ${formatCount(f.children)} child sessions (marked ✋): they needed more than the coordinator’s brief.`;
  if (!f.wide) return base;
  return `${base} It fanned out to ${formatCount(f.children)} children` + (f.childCredits > 0 ? `, ${formatCredits(f.perChild)} credits each on average.` : '.');
}

/** What the families add up to, as plain sentences. */
export function familiesInsights(t: FamiliesTotals): string[] {
  if (t.families === 0) return [];
  const tips: string[] = [];
  const families = (n: number) => plural(n, 'family', 'families');
  if (t.needed.families === 0) {
    tips.push(`${t.families === 1 ? 'The family' : `All ${families(t.families)}`} worked alone: no child session needed a prompt or answer from you.`
      + (t.totalCredits > 0 ? ` ${t.families === 1 ? 'It' : 'They'} used ${t.alone.creditShare.toFixed(0)}% of all credits.` : ' No AI credits were logged: only Copilot logs credits.'));
  } else if (t.totalCredits <= 0) {
    tips.push(`${t.needed.families === 1 ? '1 family needed' : `${formatCount(t.needed.families)} families needed`} you in a child session and ${formatCount(t.alone.families)} worked alone. No AI credits were logged: only Copilot logs credits.`);
  } else if (t.alone.families === 0) {
    tips.push(`Every family needed you in at least one child session (${families(t.needed.families)}, ${t.needed.creditShare.toFixed(0)}% of all credits). Clearer briefs would let them run alone.`);
  } else {
    const compare = `Families where you stepped into a child used ${t.needed.creditShare.toFixed(0)}% of all credits (${families(t.needed.families)}, ${formatCredits(t.needed.avgCredits)} credits on average), against ${t.alone.creditShare.toFixed(0)}% for the ${formatCount(t.alone.families)} that worked alone (${formatCredits(t.alone.avgCredits)} on average).`;
    tips.push(t.needed.creditShare > t.alone.creditShare ? `${compare} Clearer briefs are the biggest lever.` : compare);
  }
  tips.push(t.childrenNeedingYou > 0
    ? `${formatCount(t.childrenNeedingYou)} of ${formatCount(t.children)} child sessions needed you: you ${childInput(t.childTyped, t.childAnswered)} them. Show Needed you and open the ✋ children to see what their brief was missing.`
    : t.children === 1 ? 'The child session needed no prompt or answer from you.' : `None of the ${formatCount(t.children)} child sessions needed a prompt or answer from you.`);
  tips.push(t.wide.families > 0
    ? `${plural(t.wide.families, 'wide fan-out', 'wide fan-outs')} (${WIDE_FAN_OUT}+ children) used ${t.wide.creditShare.toFixed(0)}% of all credits. Check them for children doing overlapping work.`
    : `No family started ${WIDE_FAN_OUT} or more children.`);
  return tips;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += value(item);
  return total;
}
